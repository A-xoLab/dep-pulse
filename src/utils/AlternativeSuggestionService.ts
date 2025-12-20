import type * as vscode from 'vscode';
import { GeminiClient, type NpmRegistryClient, OpenAIClient, OpenRouterClient } from '../api';
import type { LLMAlternativeRequest, LLMClient, LlmEcosystem } from '../api/LLMClient';
import {
  type AlternativeSuggestion,
  ErrorCode,
  type LLMAlternativeCandidate,
  type LLMProvider,
} from '../types';
import { NetworkStatusService } from './NetworkStatusService';

type PackageManager = 'npm' | 'pnpm' | 'yarn';
type PackageCategory = 'framework' | 'runtime' | 'library' | 'utility' | 'unknown';
const npmNameRegex = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i;

export interface AlternativeSuggestionServiceOptions {
  provider?: LLMProvider;
  apiKey?: string;
  model?: string;
  outputChannel: vscode.OutputChannel;
  clientOverride?: LLMClient;
  ecosystem?: LlmEcosystem;
  categoryHint?: string;
}

export class LLMAlternativeSuggestionService {
  private readonly client?: LLMClient;

  constructor(
    private readonly registryClient: NpmRegistryClient,
    private readonly options: AlternativeSuggestionServiceOptions
  ) {
    this.client = options.clientOverride ?? this.createClient(options);
  }

  public isConfigured(): boolean {
    return Boolean(this.client && this.options.apiKey && this.options.provider);
  }

  public getProvider(): LLMProvider | undefined {
    return this.options.provider;
  }

  async getSuggestions(
    packageName: string,
    packageManager: PackageManager,
    description?: string
  ): Promise<AlternativeSuggestion[]> {
    const networkService = NetworkStatusService.getInstance();
    if (networkService.isSimulatingOffline()) {
      throw new Error('No response from server: simulated offline mode');
    }

    if (!this.isConfigured() || !this.client) {
      throw new Error(
        'LLM alternatives are disabled. Configure OpenRouter, OpenAI, or Gemini API keys in settings.'
      );
    }

    let targetDescription = (description ?? '').trim();
    let targetCategory: PackageCategory = 'unknown';
    try {
      const info = await this.registryClient.getPackageInfo(packageName);
      if (info?.description) {
        targetDescription = info.description;
      }
      targetCategory = this.inferCategory(packageName, info?.description ?? description);
    } catch {
      targetCategory = this.inferCategory(packageName, description);
    }

    const effectiveDescription = targetDescription || description || undefined;
    const categoryHint =
      this.options.categoryHint ?? (targetCategory !== 'unknown' ? targetCategory : undefined);

    const request: LLMAlternativeRequest = {
      packageName,
      description: effectiveDescription,
      packageManager,
      limit: 8,
      ecosystem: this.options.ecosystem ?? 'npm',
      categoryHint,
    };

    this.options.outputChannel.appendLine(
      `[LLM Alternative Package Search] provider=${this.options.provider ?? 'unknown'} model=${this.options.model ?? ''} endpoint=/v1/chat/completions request=${JSON.stringify(
        request
      )}`
    );

    let llmSuggestions: LLMAlternativeCandidate[] = [];
    try {
      llmSuggestions = await this.client.generateAlternatives(request);
      if (!llmSuggestions || llmSuggestions.length < 3) {
        // Single retry to reduce variance when models return sparse/invalid responses
        llmSuggestions = await this.client.generateAlternatives(request);
      }
      const parsedNames = (llmSuggestions ?? []).map((c) => c.name).filter(Boolean);
      this.options.outputChannel.appendLine(
        `[LLM Alternative Package Search] parsed candidates: ${JSON.stringify(parsedNames)}`
      );
    } catch (error) {
      const message = this.normalizeLlmError(error);
      throw new Error(message);
    }
    const filtered = this.filterCandidates(packageName, llmSuggestions);
    this.options.outputChannel.appendLine(
      `[LLM Alternative Package Search] filtered candidates: ${JSON.stringify(filtered.map((c) => c.name))}`
    );

    // STRICT: Only accept candidates that actually exist on npm with exact name match
    // Do NOT search npm - this prevents garbage substitution (e.g., "name" → "set-function-name")
    const validated = await Promise.all(
      filtered.map(async (suggestion) => {
        const name = suggestion.name.trim();
        const info = await this.tryGetPackageInfo(name);
        if (!info) {
          // Package doesn't exist on npm - discard entirely
          this.options.outputChannel.appendLine(
            `[LLM Alternative Package Search] discarded (not on npm): ${name}`
          );
          return undefined;
        }
        return { suggestion, info };
      })
    );

    const existing = validated.filter(
      (v): v is { suggestion: LLMAlternativeCandidate; info: NonNullable<typeof v>['info'] } =>
        v !== undefined
    );

    // Semantic relevance check: reject candidates with zero keyword overlap with target
    const targetKeywords = this.extractKeywords(packageName, effectiveDescription);
    const skipKeywordOverlap = targetCategory === 'framework' || targetCategory === 'runtime';

    const relevant = skipKeywordOverlap
      ? existing
      : existing.filter(({ info }) => {
          const candidateKeywords = this.extractKeywords(info.name, info.description);
          const overlap = this.keywordOverlap(targetKeywords, candidateKeywords);
          if (overlap === 0) {
            this.options.outputChannel.appendLine(
              `[LLM Alternative Package Search] discarded (no keyword overlap): ${info.name}`
            );
            return false;
          }
          return true;
        });

    if (skipKeywordOverlap) {
      this.options.outputChannel.appendLine(
        `[LLM Alternative Package Search] keyword overlap relaxed for category=${targetCategory}`
      );
    }

    const enriched = await Promise.all(
      relevant.map(async ({ suggestion, info }) => {
        const downloads = await this.registryClient
          .getDownloadStats(info.name)
          .then((stats) => stats.weekly)
          .catch(() => 0);

        return {
          name: info.name,
          description: info.description ?? suggestion.description ?? '',
          weeklyDownloads: downloads,
          npmUrl: `https://www.npmjs.com/package/${info.name}`,
          installCommand: this.buildInstallCommand(packageManager, info.name),
        } satisfies AlternativeSuggestion;
      })
    );

    const compatible =
      targetCategory === 'framework'
        ? enriched
        : enriched.filter((item) =>
            this.isCategoryCompatible(
              targetCategory,
              this.inferCategory(item.name, item.description)
            )
          );

    const uniqueByName = new Map<string, AlternativeSuggestion>();
    compatible.forEach((item) => {
      const key = item.name.toLowerCase();
      const existing = uniqueByName.get(key);
      if (!existing || item.weeklyDownloads > existing.weeklyDownloads) {
        uniqueByName.set(key, item);
      }
    });

    const final = Array.from(uniqueByName.values())
      .sort((a, b) => b.weeklyDownloads - a.weeklyDownloads)
      .slice(0, 3);

    return final;
  }

  private createClient(options: AlternativeSuggestionServiceOptions): LLMClient | undefined {
    const { provider, apiKey, outputChannel, model } = options;
    if (!provider || !apiKey) {
      return undefined;
    }

    // All providers now require an explicit model - no defaults
    if (!model || model.trim().length === 0) {
      return undefined;
    }

    switch (provider) {
      case 'openrouter':
        return new OpenRouterClient(apiKey, outputChannel, model);
      case 'openai':
        return new OpenAIClient(apiKey, outputChannel, model);
      case 'gemini':
        return new GeminiClient(apiKey, outputChannel, model);
      default:
        return undefined;
    }
  }

  private filterCandidates(
    originalPackage: string,
    candidates: { name: string; description?: string }[]
  ) {
    const seen = new Set<string>([originalPackage.toLowerCase()]);
    const unique: { name: string; description?: string }[] = [];

    candidates.forEach((candidate) => {
      const normalized = candidate.name?.trim().toLowerCase();
      if (!normalized || seen.has(normalized) || !this.isValidPackageName(candidate.name)) {
        return;
      }
      seen.add(normalized);
      unique.push(candidate);
    });

    return unique.slice(0, 5);
  }

  private async tryGetPackageInfo(name: string) {
    try {
      return await this.registryClient.getPackageInfo(name);
    } catch {
      return undefined;
    }
  }

  private buildInstallCommand(packageManager: PackageManager, packageName: string): string {
    switch (packageManager) {
      case 'pnpm':
        return `pnpm add ${packageName}`;
      case 'yarn':
        return `yarn add ${packageName}`;
      default:
        return `npm install ${packageName}`;
    }
  }

  private normalizeLlmError(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error);
    const lower = raw.toLowerCase();
    const status =
      (error as { response?: { status?: number } })?.response?.status ??
      (error as { context?: { status?: number } })?.context?.status ??
      (error as { status?: number })?.status;
    const code = (error as { code?: string })?.code;

    const isAuth =
      status === 401 ||
      status === 403 ||
      lower.includes('401') ||
      lower.includes('403') ||
      lower.includes('unauthorized') ||
      lower.includes('forbidden') ||
      lower.includes('invalid api key') ||
      lower.includes('invalid key') ||
      lower.includes('auth');

    const isQuota =
      status === 429 ||
      code === ErrorCode.RATE_LIMIT ||
      lower.includes('quota') ||
      lower.includes('limit') ||
      lower.includes('exceeded') ||
      lower.includes('insufficient') ||
      lower.includes('rate limit');

    const isModelNotFound =
      status === 404 ||
      (lower.includes('model') &&
        (lower.includes('not found') ||
          lower.includes('unknown') ||
          lower.includes('does not exist') ||
          lower.includes('resource not found') ||
          lower.includes('404')));

    const isUnsupportedEcosystem =
      lower.includes('unsupported llm ecosystem') || lower.includes('unsupported ecosystem');

    if (isAuth) {
      // Include \"authentication failed\" so tests and users see a clear cause.
      return 'Authentication failed for the LLM provider. Please verify your LLM API key and model in DepPulse settings.';
    }

    if (isQuota) {
      return 'LLM request was rejected due to quota/credit limits. Check your provider usage or plan.';
    }

    if (isModelNotFound) {
      return 'The selected LLM model could not be found. Please set a valid model name in DepPulse settings.';
    }

    if (isUnsupportedEcosystem) {
      return 'Unsupported LLM ecosystem. DepPulse currently only supports npm alternatives.';
    }

    // For all other errors, avoid leaking low-level API details into the UI.
    // Show a single friendly message and let the dashboard offer key/model fix actions.
    return 'The AI provider returned an unexpected error. Please review your LLM API key and model in DepPulse settings.';
  }

  private inferCategory(name: string, description?: string): PackageCategory {
    const text = `${name} ${description ?? ''}`.toLowerCase();

    const frameworkHints = [
      'framework',
      'meta framework',
      'fullstack',
      'full-stack',
      'ssr',
      'ssg',
      'static site',
      'router',
      'next',
      'nuxt',
      'remix',
      'sveltekit',
      'astro',
      'gatsby',
      'redwood',
      'blitz',
    ];
    if (frameworkHints.some((kw) => text.includes(kw))) {
      return 'framework';
    }

    const runtimeHints = ['runtime', 'serverless', 'edge runtime', 'bun', 'deno'];
    if (runtimeHints.some((kw) => text.includes(kw))) {
      return 'runtime';
    }

    const utilityHints = [
      'helper',
      'polyfill',
      'shim',
      'utils',
      'utility',
      'babel',
      'lint',
      'eslint',
      'config',
      'preset',
      'plugin',
      'loader',
      'parser',
      'adapter',
      'types',
      '@types/',
    ];
    if (utilityHints.some((kw) => text.includes(kw))) {
      return 'utility';
    }

    const libraryHints = ['library', 'sdk', 'client', 'ui', 'component'];
    if (libraryHints.some((kw) => text.includes(kw))) {
      return 'library';
    }

    return 'unknown';
  }

  private isCategoryCompatible(target: PackageCategory, candidate: PackageCategory): boolean {
    if (target === 'unknown' || candidate === 'unknown') {
      return true;
    }
    if (target === candidate) {
      return true;
    }
    if (target === 'framework') {
      return candidate === 'framework' || candidate === 'runtime';
    }
    if (target === 'runtime') {
      return candidate === 'runtime' || candidate === 'framework';
    }
    if (target === 'library') {
      return candidate === 'library' || candidate === 'utility';
    }
    if (target === 'utility') {
      return candidate === 'utility' || candidate === 'library';
    }
    return false;
  }

  private isValidPackageName(name: string): boolean {
    return npmNameRegex.test(name.trim());
  }

  /**
   * Extract meaningful keywords from package name and description
   */
  private extractKeywords(name: string, description?: string): Set<string> {
    const text = `${name} ${description ?? ''}`.toLowerCase();
    // Remove common stop words and split into tokens
    const stopWords = new Set([
      'a',
      'an',
      'the',
      'and',
      'or',
      'but',
      'in',
      'on',
      'at',
      'to',
      'for',
      'of',
      'with',
      'by',
      'from',
      'is',
      'it',
      'as',
      'be',
      'are',
      'was',
      'were',
      'been',
      'being',
      'have',
      'has',
      'had',
      'do',
      'does',
      'did',
      'will',
      'would',
      'could',
      'should',
      'may',
      'might',
      'must',
      'can',
      'this',
      'that',
      'these',
      'those',
      'your',
      'you',
      'we',
      'they',
      'its',
      'npm',
      'package',
      'module',
      'library',
    ]);

    const tokens = text
      .replace(/[^a-z0-9\s-]/g, ' ')
      .replace(/-/g, ' ') // Split on hyphens as well
      .split(/\s+/)
      .filter((t) => t.length > 2 && !stopWords.has(t));

    return new Set(tokens);
  }

  /**
   * Count keyword overlap between target and candidate
   */
  private keywordOverlap(target: Set<string>, candidate: Set<string>): number {
    let overlap = 0;
    for (const kw of candidate) {
      if (target.has(kw)) {
        overlap++;
      }
    }
    return overlap;
  }
}

// Backwards-compatible export name for existing imports
export { LLMAlternativeSuggestionService as AlternativeSuggestionService };

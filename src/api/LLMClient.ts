import type { LLMAlternativeCandidate } from '../types';

export interface LLMAlternativeRequest {
  packageName: string;
  description?: string;
  packageManager: 'npm' | 'pnpm' | 'yarn';
  limit: number;
  ecosystem: LlmEcosystem;
  /**
   * Optional hint about solution type (e.g., framework, runtime, library, cli, tooling)
   * to help steer the model toward the correct category.
   */
  categoryHint?: string;
}

export interface LLMClient {
  generateAlternatives(request: LLMAlternativeRequest): Promise<LLMAlternativeCandidate[]>;
}

export type LlmEcosystem = 'npm' | 'pypi' | 'crates' | 'go' | 'maven';

// Characters that indicate garbage/schema fragments, not real package names
const INVALID_NAME_CHARS = /[{}[\]"'`,;:]/;

/**
 * Validate that a name looks like a real npm package name
 */
function isValidPackageName(name: string): boolean {
  if (!name || name.length < 2 || name.length > 214) return false;
  if (INVALID_NAME_CHARS.test(name)) return false;
  // Must match npm package name pattern: optional @scope/, then lowercase alphanumeric with . _ -
  return /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(name);
}

/**
 * Parse LLM text output into a list of candidates.
 * STRICT: Only accepts valid JSON arrays. Returns empty array if parsing fails.
 * This prevents garbage like schema fragments from being treated as package names.
 */
export function parseLLMAlternatives(text: string): LLMAlternativeCandidate[] {
  if (!text) return [];

  const cleaned = text.trim();
  // Extract JSON from code fences if present
  const fencedMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fencedMatch ? fencedMatch[1].trim() : cleaned;

  // Try to find a JSON array in the response (may have leading/trailing text)
  const arrayMatch = body.match(/\[[\s\S]*\]/);
  const candidates: LLMAlternativeCandidate[] = [];

  if (arrayMatch) {
    try {
      const parsed = JSON.parse(arrayMatch[0]);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (!item || typeof item !== 'object') continue;

          const name = ((item as { name?: string }).name ?? '').trim();
          if (!isValidPackageName(name)) continue;

          const key = name.toLowerCase();
          if (candidates.some((c) => c.name.toLowerCase() === key)) continue;

          candidates.push({
            name,
            description: ((item as { description?: string }).description ?? '').trim(),
            reason: ((item as { reason?: string }).reason ?? '').trim() || undefined,
          });

          if (candidates.length >= 10) break;
        }
      }
    } catch {
      // ignore and try fallback parsing below
    }
  }

  // Fallback: salvage names from imperfect output when strict JSON parsing fails
  if (candidates.length === 0) {
    const nameRegex = /"name"\s*:\s*"([^"]+)"/gi;
    const seen = new Set<string>();
    for (let match = nameRegex.exec(body); match !== null; match = nameRegex.exec(body)) {
      const name = match[1].trim();
      if (!isValidPackageName(name)) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ name, description: '', reason: undefined });
      if (candidates.length >= 10) break;
    }
  }

  return candidates;
}

import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  AnalysisEngine,
  CompatibilityAnalyzer,
  FreshnessAnalyzer,
  HealthScoreCalculator,
  SecurityAnalyzer,
  VulnerabilityAggregator,
} from './analyzer';
import { GitHubAdvisoryClient, NpmRegistryClient, OSVClient } from './api';

import { setupConfigurationListener } from './config/ConfigurationListener';
import { MemoryProfiler } from './performance';
import { NodeJsScanner } from './scanner';
import {
  type AnalysisResult,
  type AnalysisSummary,
  type Dependency,
  type DependencyAnalysis,
  DepPulseError,
  ErrorCode,
  type FailedPackage,
  type HealthScore,
  type PerformanceMetrics,
  type VulnerabilitySource,
} from './types';
import { DashboardController, StatusBarManager } from './ui';
import {
  CacheManager,
  type CleanupPlan,
  LLMAlternativeSuggestionService,
  Logger,
  NetworkStatusService,
  RequestQueue,
  UnusedPackageCleaner,
} from './utils';
import { evaluateLlmConfig, updateCachedLlmConfig } from './utils/LlmConfig';
import { getGitHubToken, setGitHubToken } from './utils/SecretCache';

export type { LlmConfigStatus } from './utils/LlmConfig';

type CleanupPlanSummary = {
  targetLabel: string;
  packageManager: 'npm' | 'pnpm' | 'yarn';
  packageRoot: string;
  workspaceFolder?: string;
  dependencies: string[];
  devDependencies: string[];
};

// Extension services
let dependencyScanner: NodeJsScanner;
let analysisEngine: AnalysisEngine;
let dashboardController: DashboardController;
let statusBarManager: StatusBarManager;
let cacheManager: CacheManager | undefined;

// Disposables for services that are re-initialized
let serviceDisposables: vscode.Disposable[] = [];

// Flag to prevent concurrent scans
let isScanInProgress = false;
// Promise-based lock to prevent concurrent scans
let scanLock: Promise<void> | null = null;

type OfflinePreflightResult =
  | { shouldContinue: true }
  | {
      shouldContinue: false;
      handled: 'no-cache' | 'missing-cache';
      message?: string;
    };

async function offlinePreflightCheck(params: {
  effectiveBypassCache: boolean;
  cacheManager?: CacheManager;
  previousResult: AnalysisResult | undefined | null;
  dependencyChanges: ReturnType<typeof findDependencyChanges>;
  projectInfo: { dependencies: Dependency[] };
  dashboardController: DashboardController;
}): Promise<OfflinePreflightResult> {
  const {
    effectiveBypassCache,
    cacheManager: cache,
    previousResult,
    dependencyChanges,
    projectInfo,
    dashboardController,
  } = params;

  if (effectiveBypassCache) {
    return { shouldContinue: true };
  }

  const networkService = NetworkStatusService.getInstance();
  networkService.reset();

  Logger.getInstance().info('Checking network connectivity (cache enabled)...');
  let isOnline: boolean;
  try {
    isOnline = await networkService.checkConnectivity();
  } catch (error) {
    Logger.getInstance().error('Error during connectivity check', error);
    // Fallback: assume online if check fails to avoid blocking scans
    return { shouldContinue: true };
  }

  if (isOnline) {
    networkService.markSuccess();
    return { shouldContinue: true };
  }

  Logger.getInstance().warn('Offline detected - evaluating cache coverage before proceeding');

  if (!cache) {
    const message = 'Offline detected and cache unavailable. Connect to the internet to scan.';
    networkService.markDegraded('npm-registry', message);
    networkService.markDegraded('osv', message);
    dashboardController.sendMessage({
      type: 'offlineStatus',
      data: { mode: 'partial', message },
    });
    dashboardController.sendMessage({
      type: 'loading',
      data: { isLoading: true, options: { text: 'Offline - waiting for connection' } },
    });
    return { shouldContinue: false, handled: 'no-cache', message };
  }

  const hasCachedAnalysis =
    !!previousResult &&
    !dependencyChanges.isFullScan &&
    dependencyChanges.changed.length === 0 &&
    dependencyChanges.removed.length === 0 &&
    projectInfo.dependencies.length === previousResult.dependencies.length;
  Logger.getInstance().debug(
    `Offline preflight: hasCachedAnalysis=${hasCachedAnalysis}, depCount=${projectInfo.dependencies.length}`
  );

  const directDeps = projectInfo.dependencies.filter((dep) => !dep.isTransitive);
  const missingCaches: string[] = [];

  const resource = getConfigResource();
  const vulnConfig = vscode.workspace.getConfiguration('depPulse.vulnerabilityDetection', resource);
  const primarySource = vulnConfig.get<'osv' | 'github'>('primarySource', 'osv');

  for (const dep of directDeps) {
    const npmCached = await cache.getCachedNpmInfo(dep.name);

    const vulnCached =
      primarySource === 'github'
        ? await cache.getCachedGitHubVulnerabilities(dep.name, dep.version)
        : await cache.getCachedOSVVulnerabilities(dep.name, dep.version);

    if (!npmCached || !vulnCached) {
      const identifier = dep.version ? `${dep.name}@${dep.version}` : dep.name;
      missingCaches.push(identifier);
    }
  }

  if (missingCaches.length === 0) {
    const message =
      'Offline detected. Serving analysis from cache. Connect to internet and refresh for the most accurate results.';
    networkService.markDegraded('npm-registry', message);
    networkService.markDegraded('osv', message);
    dashboardController.sendMessage({
      type: 'offlineStatus',
      data: { mode: 'full-cache', message },
    });
    Logger.getInstance().info(
      'Offline but full cache coverage found - proceeding with cached data'
    );
    return { shouldContinue: true };
  }

  const preview = missingCaches.slice(0, 3).join(', ');
  const message = `Offline detected. Missing cached data for ${missingCaches.length} packages${
    preview ? ` (e.g., ${preview})` : ''
  }. Connect to the internet and re-run the scan.`;
  networkService.markDegraded('npm-registry', message);
  networkService.markDegraded('osv', message);
  dashboardController.sendMessage({
    type: 'offlineStatus',
    data: { mode: 'partial', message },
  });
  dashboardController.sendMessage({
    type: 'loading',
    data: { isLoading: false },
  });
  void vscode.window.showErrorMessage(
    'DepPulse: Network is offline and required data is not cached. Connect to the internet and rerun the scan.'
  );

  return { shouldContinue: false, handled: 'missing-cache', message };
}

/**
 * Helper to get the configuration resource scope (first workspace folder)
 */
function getConfigResource(): vscode.Uri | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri;
}

/**
 * Gets the current cache enabled state from configuration
 */
export function isCacheEnabled(): boolean {
  const resource = getConfigResource();
  const config = vscode.workspace.getConfiguration('depPulse.analysis', resource);
  const value = config.get<boolean>('enableCache', true);

  // Debug logging
  const inspect = config.inspect<boolean>('enableCache');
  try {
    Logger.getInstance().debug(
      `isCacheEnabled: Value=${value}, Workspace=${inspect?.workspaceValue}, Global=${inspect?.globalValue}, Resource=${resource?.fsPath}`
    );
  } catch {
    // Logger might not be initialized yet
  }

  return value;
}

/**
 * Gets the current scan in progress state
 * Used by DashboardController to avoid sending cached data while a scan is running
 */
export function isScanningInProgress(): boolean {
  return isScanInProgress;
}

/**
 * Gets the current analysis status if a scan is in progress
 * Used by DashboardController to show progress modal when webview becomes ready during scan
 */
export function getCurrentAnalysisStatus(): { progress: number; message?: string } | null {
  if (!isScanInProgress || !analysisEngine) {
    return null;
  }
  try {
    const status = analysisEngine.getAnalysisStatus();
    if (!status.isRunning) {
      return null;
    }
    const message = status.currentDependency || 'Analyzing dependencies...';
    return {
      progress: status.progress,
      message,
    };
  } catch {
    return null;
  }
}

export async function setCacheEnabled(enabled: boolean): Promise<void> {
  try {
    // Determine target and resource
    const resource = getConfigResource();
    const target = resource
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;

    Logger.getInstance().info(
      `Updating cache setting to ${enabled}. Target: ${
        target === vscode.ConfigurationTarget.Workspace ? 'Workspace' : 'Global'
      }, Resource: ${resource ? resource.fsPath : 'None'}`
    );

    await vscode.workspace
      .getConfiguration('depPulse.analysis', resource)
      .update('enableCache', enabled, target);

    Logger.getInstance().info('Cache setting updated successfully.');

    if (!enabled) {
      Logger.getInstance().info('Note: Disabling cache will result in slower scans');
    }
  } catch (error) {
    Logger.getInstance().error('Error updating cache setting', error);
    // Re-throw to ensure caller knows it failed
    throw error;
  }
}

/**
 * Activates the DepPulse extension
 * @param context - The extension context provided by VS Code
 */
export async function activate(context: vscode.ExtensionContext) {
  // Wrap entire activation in try-catch to ensure commands are registered even if errors occur
  try {
    // Create output channel for logging
    Logger.initialize();
    const logger = Logger.getInstance();

    // Log activation event
    logger.info('DepPulse extension activated');
    logger.info(`Extension path: ${context.extensionPath}`);
    logger.info(`Workspace folders: ${vscode.workspace.workspaceFolders?.length || 0}`);

    // Array to hold all disposables for cleanup
    const disposables: vscode.Disposable[] = [];

    // Register commands FIRST to ensure they're available even if initialization fails
    // This ensures commands are always registered, even if service initialization throws errors
    const scanCommand = vscode.commands.registerCommand(
      'depPulse.scan',
      async (options?: { bypassCache?: boolean }) => {
        await handleScanCommand(context, options);
      }
    );

    disposables.push(scanCommand);

    const showDashboardCommand = vscode.commands.registerCommand('depPulse.showDashboard', () => {
      Logger.getInstance().info('Show dashboard command triggered');
      if (dashboardController) {
        dashboardController.show();
      } else {
        void vscode.window.showErrorMessage(
          'DepPulse: Dashboard is not initialized yet. Please wait a moment and try again.'
        );
        Logger.getInstance().warn(
          'Dashboard controller not initialized when showDashboard was called'
        );
      }
    });
    disposables.push(showDashboardCommand);

    const configureCommand = vscode.commands.registerCommand('depPulse.configure', () => {
      Logger.getInstance().info('Configure command triggered');
      vscode.commands.executeCommand('workbench.action.openSettings', 'depPulse');
    });
    disposables.push(configureCommand);

    const configureSecretsCommand = vscode.commands.registerCommand(
      'depPulse.configureSecrets',
      async (provider?: 'github' | 'openrouter' | 'openai' | 'gemini') => {
        Logger.getInstance().info('Configure secrets command triggered');

        const secrets = (context as { secrets?: vscode.SecretStorage }).secrets ?? context.secrets;
        if (!secrets || typeof secrets.store !== 'function') {
          void vscode.window.showErrorMessage(
            'DepPulse: Secret storage is not available in this environment.'
          );
          return;
        }

        const options = [
          {
            label: 'GitHub Token',
            description: 'GitHub Personal Access Token for advisory API',
            secretKey: 'depPulse.githubToken',
            provider: 'github' as const,
          },
          {
            label: 'OpenRouter API Key',
            description: 'API key for OpenRouter LLM alternatives',
            secretKey: 'depPulse.openRouterApiKey',
            provider: 'openrouter' as const,
          },
          {
            label: 'OpenAI API Key',
            description: 'API key for OpenAI LLM alternatives',
            secretKey: 'depPulse.openaiApiKey',
            provider: 'openai' as const,
          },
          {
            label: 'Gemini API Key',
            description: 'API key for Google Gemini LLM alternatives',
            secretKey: 'depPulse.geminiApiKey',
            provider: 'gemini' as const,
          },
        ];

        const defaultChoice = provider ? options.find((o) => o.provider === provider) : undefined;

        const choice =
          defaultChoice ||
          (await vscode.window.showQuickPick(options, {
            placeHolder: 'Select which DepPulse secret you want to configure',
          }));

        if (!choice) {
          return;
        }

        const value = await vscode.window.showInputBox({
          prompt: `Enter ${choice.label}`,
          password: true,
          ignoreFocusOut: true,
        });

        if (value === undefined) {
          return;
        }

        const trimmed = value.trim();
        if (!trimmed) {
          void vscode.window.showErrorMessage(`DepPulse: ${choice.label} cannot be empty.`);
          return;
        }

        try {
          await secrets.store(choice.secretKey, trimmed);
          Logger.getInstance().info(`Secret updated for ${choice.label}`);
          void vscode.window.showInformationMessage(
            `DepPulse: ${choice.label} updated in secure storage.`
          );

          // Refresh services to pick up new secrets
          if (choice.secretKey === 'depPulse.githubToken') {
            const vulnConfig = vscode.workspace.getConfiguration('depPulse.vulnerabilityDetection');
            const primarySource = vulnConfig.get<'osv' | 'github'>('primarySource', 'osv');
            await initializeServices(context);
            if (primarySource === 'github') {
              Logger.getInstance().info(`Re-triggering analysis after GitHub token update...`);
              void vscode.commands.executeCommand('depPulse.scan', { bypassCache: true });
            }
          } else {
            // LLM secrets: do a lightweight refresh of alternatives
            await initializeServices(context, { llmOnly: true });
          }
        } catch (error) {
          Logger.getInstance().error('Failed to store secret', error);
          void vscode.window.showErrorMessage(
            `DepPulse: Failed to update ${choice.label} in secure storage.`
          );
        }
      }
    );
    disposables.push(configureSecretsCommand);

    const resetLlmConfigCommand = vscode.commands.registerCommand(
      'depPulse.resetLlmConfig',
      async () => {
        Logger.getInstance().info('Reset LLM configuration command triggered');

        // Clear LLM API keys from secret storage
        try {
          const secrets =
            (context as { secrets?: vscode.SecretStorage }).secrets ?? context.secrets;
          if (secrets && typeof secrets.delete === 'function') {
            await Promise.all([
              secrets.delete('depPulse.openRouterApiKey'),
              secrets.delete('depPulse.openaiApiKey'),
              secrets.delete('depPulse.geminiApiKey'),
            ]);
            Logger.getInstance().info('Cleared LLM API keys from secret storage');
          }
        } catch (error) {
          Logger.getInstance().error('Failed to clear LLM API keys from secret storage', error);
        }

        // Clear LLM model settings
        try {
          const apiConfig = vscode.workspace.getConfiguration('depPulse.api');
          const clearModelKey = async (key: string) => {
            const inspect = apiConfig.inspect<string>(key);
            const targets: vscode.ConfigurationTarget[] = [];

            if (inspect?.workspaceFolderValue !== undefined) {
              targets.push(vscode.ConfigurationTarget.WorkspaceFolder);
            }
            if (inspect?.workspaceValue !== undefined) {
              targets.push(vscode.ConfigurationTarget.Workspace);
            }
            if (inspect?.globalValue !== undefined) {
              targets.push(vscode.ConfigurationTarget.Global);
            }

            for (const target of targets) {
              await apiConfig.update(key, undefined, target);
            }
          };

          await Promise.all([
            clearModelKey('openRouterModel'),
            clearModelKey('openaiModel'),
            clearModelKey('geminiModel'),
          ]);

          Logger.getInstance().info('Cleared LLM model settings');
        } catch (error) {
          Logger.getInstance().error('Failed to clear LLM model settings', error);
        }

        // Reinitialize services in LLM-only mode so dashboard updates
        await initializeServices(context, { llmOnly: true });

        void vscode.window.showInformationMessage(
          'DepPulse: LLM configuration has been reset. Configure a provider to enable alternatives again.'
        );
      }
    );
    disposables.push(resetLlmConfigCommand);

    // Register cache toggle command
    const toggleCacheCommand = vscode.commands.registerCommand('depPulse.toggleCache', async () => {
      const currentState = isCacheEnabled();
      const newState = !currentState;
      await setCacheEnabled(newState);

      // Notify dashboard of the change
      if (dashboardController) {
        dashboardController.sendMessage({
          type: 'cacheStatusChanged',
          data: { enabled: newState },
        });
      }
    });
    disposables.push(toggleCacheCommand);

    const cleanupUnusedPackagesCommand = vscode.commands.registerCommand(
      'depPulse.cleanupUnusedPackages',
      async () => {
        await handleCleanupUnusedPackages();
      }
    );
    disposables.push(cleanupUnusedPackagesCommand);

    const cleanupPreviewCommand = vscode.commands.registerCommand(
      'depPulse.cleanupUnusedPackages.preview',
      async () => {
        await handleCleanupUnusedPackagesPreviewRequest();
      }
    );
    disposables.push(cleanupPreviewCommand);

    const cleanupExecuteCommand = vscode.commands.registerCommand(
      'depPulse.cleanupUnusedPackages.execute',
      async () => {
        await handleCleanupUnusedPackagesExecuteRequest();
      }
    );
    disposables.push(cleanupExecuteCommand);

    // Development-only: Register debug command to simulate offline mode
    if (context.extensionMode === vscode.ExtensionMode.Development) {
      const simulateOfflineCommand = vscode.commands.registerCommand(
        'depPulse.dev.simulateOffline',
        () => {
          const networkService = NetworkStatusService.getInstance();
          const newState = !networkService.isSimulatingOffline();
          networkService.setSimulateOffline(newState);

          const message = newState
            ? '🔴 Offline simulation ENABLED - Network requests will fail'
            : '🟢 Offline simulation DISABLED - Normal network behavior';
          vscode.window.showInformationMessage(`DepPulse [DEV]: ${message}`);
          Logger.getInstance().info(`[DEV] Offline simulation: ${newState}`);
        }
      );
      disposables.push(simulateOfflineCommand);
      Logger.getInstance().info('[DEV] Debug commands registered (Development mode)');
    }

    // Add output channel to disposables
    disposables.push(Logger.getInstance().getOutputChannel());

    // Initialize services with error handling
    // This is done after command registration so commands are always available
    try {
      await initializeServices(context);
      logger.info('DepPulse services initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize DepPulse services', error);
      void vscode.window.showErrorMessage(
        'DepPulse: Failed to initialize some services. Commands are available but some features may not work. Check the output channel for details.'
      );
    }

    // Set up file watcher for auto-refresh
    setupFileWatcher(disposables);

    // Set up configuration change listener
    setupConfigurationListener(context, disposables, () => dashboardController, initializeServices);

    // Add all disposables to context subscriptions for automatic cleanup
    context.subscriptions.push(...disposables);

    // Register service disposables cleanup
    context.subscriptions.push(
      new vscode.Disposable(() => {
        disposeServices();
      })
    );
    // Trigger auto-scan if enabled
    triggerAutoScan();
  } catch (error) {
    // If activation fails completely, at least log the error
    // Commands should still be registered above, but log the error for debugging
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    console.error('DepPulse activation error:', errorMessage, errorStack);

    // Try to use Logger if it's available, otherwise use console
    try {
      const logger = Logger.getInstance();
      logger.error('Critical error during DepPulse activation', error);
    } catch {
      console.error('Failed to log activation error to Logger:', errorMessage);
    }

    // Show error to user
    void vscode.window.showErrorMessage(
      `DepPulse: Failed to activate extension. Some features may not work. Error: ${errorMessage}`
    );
  }
}

/**
 * Dispose of all services
 */
function disposeServices(options?: { preserveDashboard?: boolean }) {
  const preserveDashboard = options?.preserveDashboard ?? false;
  const retained: vscode.Disposable[] = [];
  if (serviceDisposables.length > 0) {
    serviceDisposables.forEach((d) => {
      if (preserveDashboard && d === dashboardController) {
        retained.push(d);
        return;
      }
      d.dispose();
    });
    serviceDisposables = retained;
  }
}

/**
 * Initialize all extension services
 */
type InitializeOptions = { preserveDashboard?: boolean; llmOnly?: boolean };

async function initializeServices(
  context: vscode.ExtensionContext,
  options?: InitializeOptions
): Promise<void> {
  const preserveDashboard = options?.preserveDashboard ?? false;
  const logger = Logger.getInstance();
  logger.info('Initializing DepPulse services...');

  // If this is an LLM-only refresh, update alternatives without tearing down other services
  if (options?.llmOnly) {
    const resource = getConfigResource();
    const apiConfig = vscode.workspace.getConfiguration('depPulse.api', resource);

    // Provider priority: OpenRouter > OpenAI > Gemini
    let llmProvider: 'openrouter' | 'openai' | 'gemini' | undefined;
    let llmApiKey: string | undefined;
    let llmModel: string | undefined;

    // Prefer SecretStorage for LLM API keys only
    let openRouterApiKey = '';
    let openaiApiKey = '';
    let geminiApiKey = '';
    try {
      const secrets = (context as { secrets?: vscode.SecretStorage }).secrets;
      if (secrets && typeof secrets.get === 'function') {
        openRouterApiKey = (await secrets.get('depPulse.openRouterApiKey')) || '';
        openaiApiKey = (await secrets.get('depPulse.openaiApiKey')) || '';
        geminiApiKey = (await secrets.get('depPulse.geminiApiKey')) || '';
      }
    } catch {
      openRouterApiKey = '';
      openaiApiKey = '';
      geminiApiKey = '';
    }

    const openRouterModel = apiConfig.get<string>('openRouterModel', '');
    const openaiModel = apiConfig.get<string>('openaiModel', '');
    const geminiModel = apiConfig.get<string>('geminiModel', '');

    updateCachedLlmConfig({
      openRouterApiKey,
      openRouterModel,
      openaiApiKey,
      openaiModel,
      geminiApiKey,
      geminiModel,
    });

    const configValidity = evaluateLlmConfig();
    if (configValidity.status === 'unconfigured' || configValidity.status === 'invalid') {
      logger.info('LLM-only update skipped (no usable provider/key/model)');
      dashboardController?.notifyLlmConfigChanged(configValidity);
      return;
    }

    if (
      openRouterApiKey &&
      openRouterApiKey.trim().length > 0 &&
      openRouterModel &&
      openRouterModel.trim().length > 0
    ) {
      llmProvider = 'openrouter';
      llmApiKey = openRouterApiKey;
      llmModel = openRouterModel;
    } else if (
      openaiApiKey &&
      openaiApiKey.trim().length > 0 &&
      openaiModel &&
      openaiModel.trim().length > 0
    ) {
      llmProvider = 'openai';
      llmApiKey = openaiApiKey;
      llmModel = openaiModel;
    } else if (
      geminiApiKey &&
      geminiApiKey.trim().length > 0 &&
      geminiModel &&
      geminiModel.trim().length > 0
    ) {
      llmProvider = 'gemini';
      llmApiKey = geminiApiKey;
      llmModel = geminiModel;
    }

    if (!llmProvider || !llmApiKey) {
      logger.info('LLM-only update skipped (no valid provider/key yet)');
      dashboardController?.notifyLlmConfigChanged(configValidity);
      return;
    }

    if (dashboardController) {
      const registryClient = new NpmRegistryClient(Logger.getInstance().getOutputChannel());
      const alternativeService = new LLMAlternativeSuggestionService(registryClient, {
        provider: llmProvider,
        apiKey: llmApiKey,
        model: llmModel,
        outputChannel: Logger.getInstance().getOutputChannel(),
      });
      dashboardController.updateAlternativeService(alternativeService);
      dashboardController.notifyLlmConfigChanged(configValidity);
      logger.info('LLM-only update applied (dashboard retained)');
      return;
    }

    // If no dashboard exists yet, fall through to full initialization
  }

  // Dispose of existing services first
  disposeServices({ preserveDashboard });

  try {
    // Read configuration
    const resource = getConfigResource();
    const apiConfig = vscode.workspace.getConfiguration('depPulse.api', resource);
    const freshnessConfig = vscode.workspace.getConfiguration('depPulse.freshness', resource);
    const analysisConfig = vscode.workspace.getConfiguration('depPulse.analysis', resource);
    const includeTransitiveDependencies = analysisConfig.get<boolean>(
      'includeTransitiveDependencies',
      true
    );

    // Initialize request queue for rate limiting (max 10 concurrent requests)
    const requestQueue = new RequestQueue(10);

    // Initialize API clients
    const registryClient = new NpmRegistryClient(Logger.getInstance().getOutputChannel());

    // Read vulnerability detection configuration
    const vulnConfig = vscode.workspace.getConfiguration(
      'depPulse.vulnerabilityDetection',
      resource
    );
    let primarySource = vulnConfig.get<'osv' | 'github'>('primarySource', 'osv');

    // Read GitHub API token from SecretStorage only
    let githubToken = '';
    try {
      const secrets = (context as { secrets?: vscode.SecretStorage }).secrets;
      if (secrets && typeof secrets.get === 'function') {
        githubToken = (await secrets.get('depPulse.githubToken')) || '';
      }
    } catch {
      githubToken = '';
    }
    setGitHubToken(githubToken);

    // Prefer SecretStorage for LLM API keys only
    let openRouterApiKey = '';
    let openaiApiKey = '';
    let geminiApiKey = '';
    try {
      const secrets = (context as { secrets?: vscode.SecretStorage }).secrets;
      if (secrets && typeof secrets.get === 'function') {
        openRouterApiKey = (await secrets.get('depPulse.openRouterApiKey')) || '';
        openaiApiKey = (await secrets.get('depPulse.openaiApiKey')) || '';
        geminiApiKey = (await secrets.get('depPulse.geminiApiKey')) || '';
      }
    } catch {
      openRouterApiKey = '';
      openaiApiKey = '';
      geminiApiKey = '';
    }
    const openRouterModel = apiConfig.get<string>('openRouterModel', '');
    const openaiModel = apiConfig.get<string>('openaiModel', '');
    const geminiModel = apiConfig.get<string>('geminiModel', '');

    // Cache resolved LLM config for validation/UI
    updateCachedLlmConfig({
      openRouterApiKey,
      openRouterModel,
      openaiApiKey,
      openaiModel,
      geminiApiKey,
      geminiModel,
    });

    // Provider priority: OpenRouter > OpenAI > Gemini
    let llmProvider: 'openrouter' | 'openai' | 'gemini' | undefined;
    let llmApiKey: string | undefined;
    let llmModel: string | undefined;

    if (
      openRouterApiKey &&
      openRouterApiKey.trim().length > 0 &&
      openRouterModel &&
      openRouterModel.trim().length > 0
    ) {
      llmProvider = 'openrouter';
      llmApiKey = openRouterApiKey;
      llmModel = openRouterModel;
    } else if (
      openaiApiKey &&
      openaiApiKey.trim().length > 0 &&
      openaiModel &&
      openaiModel.trim().length > 0
    ) {
      llmProvider = 'openai';
      llmApiKey = openaiApiKey;
      llmModel = openaiModel;
    } else if (
      geminiApiKey &&
      geminiApiKey.trim().length > 0 &&
      geminiModel &&
      geminiModel.trim().length > 0
    ) {
      llmProvider = 'gemini';
      llmApiKey = geminiApiKey;
      llmModel = geminiModel;
    }

    // Startup Check: Ensure we don't start with GitHub enabled if no token is present
    // This handles cases where settings might be synced or stale
    if (primarySource === 'github' && (!githubToken || githubToken.trim() === '')) {
      logger.warn('GitHub selected as source but no token found. Reverting to OSV.');

      // Revert configuration to ensure valid state
      // We use strict target detection to avoid creating unwanted settings
      const inspect = vulnConfig.inspect('primarySource');
      let target: vscode.ConfigurationTarget | undefined;

      if (inspect?.workspaceFolderValue !== undefined) {
        target = vscode.ConfigurationTarget.WorkspaceFolder;
      } else if (inspect?.workspaceValue !== undefined) {
        target = vscode.ConfigurationTarget.Workspace;
      } else if (inspect?.globalValue !== undefined) {
        target = vscode.ConfigurationTarget.Global;
      }

      // Update config asynchronously if a target is defined
      if (target !== undefined) {
        logger.info(`Reverting configuration at target: ${target}`);
        // We don't await this to avoid blocking initialization, but we do it to fix the UI
        vulnConfig.update('primarySource', 'osv', target).then(
          () => {
            logger.info('Configuration reverted successfully.');
          },
          (err) => {
            logger.error('Error reverting configuration', err);
          }
        );
      }

      // Force local variable to 'osv' so we initialize the correct client right now
      primarySource = 'osv';

      // Notify user - ONLY if we didn't update the config (or maybe just always? User said "it make scene to show... scan complete")
      // The user complained about "Reverted..." AND "Scan complete" AND "GitHub requires token".
      // The "GitHub requires token" is the annoying one.
      // The "Reverted" one is helpful but maybe redundant if we fix the UI.
      // Let's keep "Reverted" but make it a status bar message or less intrusive?
      // Or just keep it as info message, but ensure we don't show the "GitHub requires token" one.

      vscode.window.showInformationMessage(
        'DepPulse: Reverted vulnerability source to OSV.dev because no GitHub token was found.'
      );
    }

    logger.info(`Vulnerability detection - Selected source: ${primarySource}`);

    // Initialize vulnerability clients
    const vulnerabilityClients = new Map<VulnerabilitySource, GitHubAdvisoryClient | OSVClient>();

    // Initialize CacheManager
    // Initialize CacheManager
    const cacheConfig = vscode.workspace.getConfiguration('depPulse.cache', resource);
    const vulnerabilityTTLMinutes = cacheConfig.get<number>('vulnerabilityTTLMinutes', 60);
    const bypassCacheForCritical = cacheConfig.get<boolean>('bypassCacheForCritical', true);

    cacheManager = new CacheManager(
      context,
      (level, message, ..._args) => {
        const logger = Logger.getInstance();
        if (level === 'DEBUG') logger.debug(`[CacheManager] ${message}`);
        else if (level === 'INFO') logger.info(`[CacheManager] ${message}`);
        else if (level === 'WARN') logger.warn(`[CacheManager] ${message}`);
        else if (level === 'ERROR') logger.error(`[CacheManager] ${message}`);
      },
      {
        vulnerabilityTTLMinutes,
        bypassCacheForCritical,
      }
    );

    // Initialize client based on selection
    if (primarySource === 'osv') {
      const osvClient = new OSVClient(Logger.getInstance().getOutputChannel(), cacheManager);
      vulnerabilityClients.set('osv', osvClient);
      logger.info('OSV.dev client initialized');
    } else if (primarySource === 'github') {
      const githubClient = new GitHubAdvisoryClient(
        Logger.getInstance().getOutputChannel(),
        githubToken,
        cacheManager
      );
      vulnerabilityClients.set('github', githubClient);
      logger.info('GitHub Advisory client initialized');
    }

    // Initialize vulnerability aggregator
    const vulnerabilityAggregator = new VulnerabilityAggregator(
      vulnerabilityClients,
      requestQueue,
      Logger.getInstance().getOutputChannel(),
      undefined,
      primarySource
    );

    logger.info(`Vulnerability aggregator initialized with source: ${primarySource}`);

    // Read freshness configuration
    const unmaintainedThresholdDays = freshnessConfig.get<number>('unmaintainedThresholdDays', 730);
    const majorVersionGracePeriodDays = freshnessConfig.get<number>(
      'majorVersionGracePeriodDays',
      90
    );

    logger.info(
      `Freshness config - Unmaintained threshold: ${unmaintainedThresholdDays} days, Grace period: ${majorVersionGracePeriodDays} days`
    );

    // Initialize analyzers
    const securityAnalyzer = new SecurityAnalyzer(
      vulnerabilityAggregator,
      Logger.getInstance().getOutputChannel()
    );
    const freshnessAnalyzer = new FreshnessAnalyzer(
      registryClient,
      Logger.getInstance().getOutputChannel(),
      {
        unmaintainedThresholdDays,
        majorVersionGracePeriodDays,
      }
    );

    // Initialize compatibility analyzer
    const compatibilityAnalyzer = new CompatibilityAnalyzer(
      registryClient,
      Logger.getInstance().getOutputChannel()
    );

    // Initialize dependency scanner
    dependencyScanner = new NodeJsScanner(Logger.getInstance().getOutputChannel());

    // Read chunk size configuration for stream processing
    const chunkSize = analysisConfig.get<number>('chunkSize', 50);
    logger.info(`Analysis config - Chunk size: ${chunkSize} dependencies per chunk`);

    // Initialize analysis engine
    analysisEngine = new AnalysisEngine(
      securityAnalyzer,
      freshnessAnalyzer,
      registryClient,
      Logger.getInstance().getOutputChannel(),
      context,
      chunkSize,
      cacheManager,
      compatibilityAnalyzer
    );

    // Initialize alternative suggestion service
    const alternativeService = new LLMAlternativeSuggestionService(registryClient, {
      provider: llmProvider,
      apiKey: llmApiKey,
      model: llmModel,
      outputChannel: Logger.getInstance().getOutputChannel(),
    });

    // Initialize UI components (reuse dashboard when preserving)
    if (preserveDashboard && dashboardController) {
      dashboardController.updateAlternativeService(alternativeService);
      logger.info('Reusing existing dashboard controller');
    } else {
      dashboardController = new DashboardController(
        context.extensionUri,
        Logger.getInstance().getOutputChannel(),
        isCacheEnabled(),
        context.extensionMode,
        alternativeService
      );
      // Add to service disposables
      serviceDisposables.push(dashboardController);
    }

    statusBarManager = new StatusBarManager(Logger.getInstance().getOutputChannel());
    // Add to service disposables
    serviceDisposables.push(statusBarManager);

    logger.info('All services initialized successfully');

    // Restore status bar state from previous analysis if available
    // We now await the migration to ensure legacy state is cleared/moved before loading

    // Debug global state usage
    logGlobalStateUsage(context);

    const previousResult = loadPreviousAnalysisResult(context);
    if (previousResult) {
      statusBarManager.update(previousResult);
      // Restore dashboard state as well
      dashboardController.update(
        previousResult,
        undefined,
        {
          isCached: true,
          cacheAge: Date.now() - previousResult.timestamp.getTime(),
        },
        isCacheEnabled(),
        includeTransitiveDependencies
      );
      logger.info('Restored status bar and dashboard state from previous analysis');
    }
  } catch (error) {
    Logger.getInstance().error('Error initializing services', error);
    vscode.window.showErrorMessage(`DepPulse: Failed to initialize - ${error}`);
  }
}

/**
 * Log usage of global state to help debug large state warnings
 */
function logGlobalStateUsage(context: vscode.ExtensionContext): void {
  try {
    const keys = context.globalState.keys();
    Logger.getInstance().debug(`Global State Keys (${keys.length}):`);

    // We can't easily get the size of each item without reading it,
    // but we can list them to see if there are any obvious culprits.
    keys.forEach((key) => {
      // Just log the key name for now. Reading all values might be slow/heavy.
      Logger.getInstance().debug(`  - ${key}`);
    });
  } catch (_error) {
    // Ignore errors
  }
}

/**
 * Migrate legacy workspace state to disk
 */

/**
 * Handle the scan command - performs full or incremental dependency analysis
 */
async function handleScanCommand(
  context: vscode.ExtensionContext,
  options?: { bypassCache?: boolean }
): Promise<void> {
  const logger = Logger.getInstance();

  // Capture cache setting at scan start to ensure consistency throughout scan
  const cacheEnabledAtStart = isCacheEnabled();
  const effectiveBypassCache = options?.bypassCache ?? !cacheEnabledAtStart;

  logger.info(
    `Scan command triggered (bypassCache: ${effectiveBypassCache}, from option: ${options?.bypassCache}, from setting: ${!cacheEnabledAtStart})`
  );

  // Check if scan is already in progress using lock
  if (scanLock) {
    logger.info('Scan already in progress, ignoring request');
    return;
  }

  // Set flag to prevent concurrent scans
  isScanInProgress = true;
  logger.info('Starting scan (isScanInProgress = true)');

  try {
    // Create scan lock promise
    scanLock = (async () => {
      try {
        // Early offline detection when cache is disabled
        // If cache is disabled, we MUST have network connectivity to perform a valid scan
        if (effectiveBypassCache) {
          const { NetworkStatusService } = await import('./utils/NetworkStatusService');
          const networkService = NetworkStatusService.getInstance();
          networkService.reset();

          logger.info('Checking network connectivity (cache disabled, need live data)...');
          const isOnline = await networkService.checkConnectivity();

          if (!isOnline) {
            const cacheEnabledNow = isCacheEnabled();
            logger.warn(
              `Network connectivity check failed - cannot scan without cache (cacheEnabled=${cacheEnabledNow}, bypassCache=${effectiveBypassCache})`
            );
            isScanInProgress = false;

            // Hide the loading modal since we're aborting the scan
            dashboardController.sendMessage({
              type: 'loading',
              data: { isLoading: false },
            });

            if (!cacheEnabledNow) {
              void vscode.window
                .showErrorMessage(
                  'DepPulse: No internet connection detected. Enable caching to use previously saved data, or connect to the internet to scan.',
                  'Enable Cache',
                  'Cancel'
                )
                .then(async (selection) => {
                  if (selection === 'Enable Cache') {
                    await setCacheEnabled(true);
                    dashboardController.sendMessage({
                      type: 'cacheStatusChanged',
                      data: { enabled: true },
                    });
                    void vscode.commands.executeCommand('depPulse.scan', { bypassCache: false });
                  }
                });
            } else {
              void vscode.window.showErrorMessage(
                'DepPulse: No internet connection detected. Connect to the internet to scan, or rerun without force refresh to use cached data.'
              );
            }

            return;
          }
          logger.info('Network connectivity confirmed');
        }

        // Show progress in window (not as notification toast) to avoid duplicate toasts
        // The dashboard modal will show the progress instead
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Window,
            title: 'DepPulse: Analyzing dependencies',
            cancellable: false,
          },
          async (progress) => {
            // Declare progressInterval at the start of the callback
            let progressInterval: NodeJS.Timeout | undefined;

            try {
              // Step 1: Scan workspace for dependencies
              progress.report({ message: 'Scanning workspace for dependencies...' });
              logger.info('Starting workspace scan...');

              const projectInfo = await dependencyScanner.scanWorkspace();
              const resource = getConfigResource();
              const includeTransitiveDependencies = vscode.workspace
                .getConfiguration('depPulse.analysis', resource)
                .get<boolean>('includeTransitiveDependencies', true);
              logger.info(
                `Transitive dependency analysis enabled: ${includeTransitiveDependencies}`
              );

              if (!projectInfo.dependencies || projectInfo.dependencies.length === 0) {
                logger.info('No dependencies found in workspace');
                // Cleanup any intervals before returning
                if (progressInterval) {
                  clearInterval(progressInterval);
                  progressInterval = undefined;
                }

                // IMPORTANT: Hide the loading modal and notify webview that scan completed
                // This prevents the webview timeout from firing when scan completes quickly
                dashboardController.sendProgressUpdate(
                  100,
                  'Scan complete - No dependencies found'
                );
                // Small delay to ensure modal shows completion message
                await new Promise((resolve) => setTimeout(resolve, 300));

                // Send empty analysis result to webview to hide modal and show empty state
                const previousResult = loadPreviousAnalysisResult(context);
                if (previousResult) {
                  // Send previous result to maintain UI state
                  dashboardController.update(
                    previousResult,
                    undefined,
                    { isCached: true, cacheAge: Date.now() - previousResult.timestamp.getTime() },
                    cacheEnabledAtStart,
                    includeTransitiveDependencies
                  );
                } else {
                  // No previous result - send empty state to webview using sendMessage
                  dashboardController.sendMessage({
                    type: 'analysisUpdate',
                    data: {
                      dependencies: [],
                      healthScore: { overall: 0 },
                      metrics: {
                        totalDependencies: 0,
                        criticalIssues: 0,
                        highIssues: 0,
                        warnings: 0,
                      },
                      chartData: {
                        severity: {},
                        freshness: {},
                      },
                      packageManager: 'unknown',
                      transitiveEnabled: includeTransitiveDependencies,
                    },
                  });
                }

                vscode.window.showInformationMessage(
                  'DepPulse: No dependencies found in workspace'
                );
                return;
              }

              logger.info(`Found ${projectInfo.dependencies.length} dependencies`);

              // Load previous analysis and compute changes early (used by offline preflight)
              const previousResultRaw = loadPreviousAnalysisResult(context);
              const previousResult = previousResultRaw
                ? rehydrateWorkspaceMetadata(previousResultRaw, projectInfo.dependencies)
                : undefined;
              const dependencyChanges = findDependencyChanges(
                projectInfo.dependencies,
                previousResult
              );

              const offlineResult = await offlinePreflightCheck({
                effectiveBypassCache,
                cacheManager,
                previousResult,
                dependencyChanges,
                projectInfo,
                dashboardController,
              });

              if (!offlineResult.shouldContinue) {
                isScanInProgress = false;
                return;
              }

              // Step 2: Check for previous analysis and determine if incremental analysis is possible
              // (dependencyChanges computed earlier)
              const useIncrementalAnalysis =
                !effectiveBypassCache &&
                !dependencyChanges.isFullScan &&
                dependencyChanges.changed.length > 0 &&
                dependencyChanges.changed.length < projectInfo.dependencies.length;

              if (effectiveBypassCache) {
                logger.info(
                  `Cache bypass requested (${options?.bypassCache !== undefined ? 'explicit' : 'from setting'}), performing full scan`
                );
              } else if (useIncrementalAnalysis) {
                logger.info(
                  `Using incremental analysis: ${dependencyChanges.changed.length} changed, ${dependencyChanges.removed.length} removed`
                );
              } else if (dependencyChanges.isFullScan) {
                logger.info('No previous analysis found, performing full scan');
              } else {
                logger.info('No dependency changes detected, using previous results');
              }

              // Step 3: Analyze dependencies (full or incremental)
              let analysisMessage: string;
              if (useIncrementalAnalysis) {
                analysisMessage = includeTransitiveDependencies
                  ? `Analyzing ${dependencyChanges.changed.length} changed dependencies...`
                  : `Analyzing ${dependencyChanges.changed.length} changed dependencies (transitive disabled)...`;
              } else {
                const counts = getDependencyCounts(
                  projectInfo.dependencies,
                  includeTransitiveDependencies
                );
                analysisMessage = includeTransitiveDependencies
                  ? `Analyzing ${counts.direct} direct and ${counts.transitive} transitive dependencies...`
                  : `Analyzing ${counts.direct} direct dependencies (transitive disabled)...`;
              }

              progress.report({ message: analysisMessage });
              logger.info('Starting dependency analysis...');

              // Track performance metrics
              const memoryProfiler = new MemoryProfiler();
              const scanStartTime = Date.now();
              const _baselineMemory = memoryProfiler.setBaseline();

              // Start adaptive progress polling for dashboard updates with smooth interpolation
              let lastReportedProgress = 0;
              let targetProgress = 0;
              const progressStartTime = Date.now();
              const depsToAnalyze = useIncrementalAnalysis
                ? dependencyChanges.changed.length
                : projectInfo.dependencies.length;
              const estimatedDuration = Math.max(5000, depsToAnalyze * 200); // Estimate: 200ms per dependency, min 5s
              // progressInterval already declared above
              let lastProgressUpdate = Date.now();
              let isIdle = false;

              // Adaptive polling: 150ms during active analysis, 1000ms during idle
              const ACTIVE_POLL_INTERVAL = 150; // Increased from 100ms for efficiency
              const IDLE_POLL_INTERVAL = 1000; // Increased from 500ms for efficiency
              const IDLE_THRESHOLD_MS = 2000; // Consider idle if no progress update for 2 seconds
              const MAX_POLL_DURATION = 5 * 60 * 1000; // 5 minutes max polling duration
              const MIN_PROGRESS_UPDATE_INTERVAL = 2000; // Send progress update at least every 2 seconds to keep modal visible

              let lastProgressUpdateSent = 0; // Track when we last sent a progress update

              const pollProgress = () => {
                const status = analysisEngine.getAnalysisStatus();
                const now = Date.now();

                // Detect idle state: no progress change for threshold duration
                const timeSinceLastProgress = now - lastProgressUpdate;
                const wasIdle = isIdle;
                isIdle = timeSinceLastProgress > IDLE_THRESHOLD_MS && !status.isRunning;

                // Log if scan appears stuck (no progress for a while but still running)
                if (status.isRunning && timeSinceLastProgress > 10000 && !isIdle) {
                  logger.debug(
                    `Scan appears slow: no progress update for ${Math.floor(timeSinceLastProgress / 1000)}s, current: ${status.progress}%, dependency: ${status.currentDependency || 'none'}`
                  );
                }

                // Update target progress from engine
                if (status.isRunning && status.progress !== targetProgress) {
                  targetProgress = status.progress;
                  lastProgressUpdate = now;
                  isIdle = false;
                }

                // Calculate time-based progress (smooth forward movement)
                const elapsed = Date.now() - progressStartTime;
                // Derive a dynamic ETA from observed work:
                // If we have work-based progress, infer total duration from elapsed so far.
                const inferredTotalDuration =
                  targetProgress > 0
                    ? Math.max(elapsed, Math.floor(elapsed / (targetProgress / 100)))
                    : estimatedDuration;

                // Time-based progress based on inferred total duration to keep percent aligned with time.
                const timeBasedProgress = Math.min(
                  100,
                  Math.floor((elapsed / inferredTotalDuration) * 100)
                );

                // Combine:
                // - Never go backwards
                // - Don't outrun work-based progress by more than a small cushion (5%)
                // - Cap at 100%
                const allowedLead = 5;
                const cappedTime = Math.min(timeBasedProgress, targetProgress + allowedLead);
                const smoothProgress = Math.max(lastReportedProgress, Math.min(100, cappedTime));

                // Always send progress updates to keep modal visible and show activity
                // Even if progress hasn't changed, send update periodically to ensure modal stays visible
                // This is especially important when webview becomes ready during scan
                const shouldUpdate =
                  smoothProgress !== lastReportedProgress ||
                  status.currentDependency ||
                  now - lastProgressUpdateSent >= MIN_PROGRESS_UPDATE_INTERVAL;

                if (shouldUpdate) {
                  lastReportedProgress = smoothProgress;
                  lastProgressUpdateSent = now;
                  const message = status.currentDependency
                    ? status.currentDependency
                    : analysisMessage;
                  dashboardController.sendProgressUpdate(smoothProgress, message);
                }

                // Adjust polling interval based on activity
                const desiredInterval = isIdle ? IDLE_POLL_INTERVAL : ACTIVE_POLL_INTERVAL;

                // If state changed (idle <-> active), restart with new interval
                if (wasIdle !== isIdle && progressInterval) {
                  // Poll immediately before recreating to avoid gap
                  pollProgress();
                  clearInterval(progressInterval);
                  progressInterval = undefined; // Explicitly clear
                  progressInterval = setInterval(pollProgress, desiredInterval);
                }

                // Check if max polling duration exceeded
                const elapsedPolling = Date.now() - progressStartTime;
                if (elapsedPolling > MAX_POLL_DURATION && progressInterval) {
                  clearInterval(progressInterval);
                  progressInterval = undefined;
                  logger.warn('Progress polling exceeded maximum duration, stopping');
                }
              };

              try {
                // Send initial progress immediately to show modal
                dashboardController.sendProgressUpdate(0, 'Starting analysis...');

                // Small delay to ensure modal is visible before starting analysis
                await new Promise((resolve) => setTimeout(resolve, 100));

                // Start polling with active interval
                progressInterval = setInterval(pollProgress, ACTIVE_POLL_INTERVAL);

                const isMonorepoProject = (projectInfo.dependencyFiles?.length ?? 0) > 1;
                const dedupeKeys = <T>(
                  items: T[],
                  getKey: (item: T) => string,
                  shouldInclude?: (item: T) => boolean
                ): string[] => {
                  const seen = new Set<string>();
                  for (const item of items) {
                    if (!shouldInclude || shouldInclude(item)) {
                      seen.add(getKey(item));
                    }
                  }
                  return Array.from(seen);
                };

                let analysisResult: AnalysisResult;
                let isCached = false;
                let cacheAge = 0;
                // Tracks whether we explicitly ignored an existing cached result due to TTL expiry
                // and performed a fresh full analysis. In that case, the run should be treated as "Live"
                // for UI purposes, even though the result is written back to cache.
                let didExpireAndRefetch = false;

                if (useIncrementalAnalysis && previousResult) {
                  // Perform incremental analysis on changed dependencies
                  const incrementalResult = await analysisEngine.analyzeIncremental(
                    dependencyChanges.changed,
                    {
                      includeTransitiveDependencies,
                      bypassCache: effectiveBypassCache,
                    }
                  );

                  // Merge incremental results with previous results
                  analysisResult = mergeAnalysisResults(
                    previousResult,
                    incrementalResult,
                    dependencyChanges
                  );
                } else if (
                  !effectiveBypassCache &&
                  !dependencyChanges.isFullScan &&
                  previousResult &&
                  dependencyChanges.changed.length === 0
                ) {
                  // Check if cache has expired (24 hours)
                  const ANALYSIS_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
                  const cacheAgeMs = Date.now() - previousResult.timestamp.getTime();
                  const isCacheExpired = cacheAgeMs > ANALYSIS_CACHE_TTL_MS;

                  if (isCacheExpired) {
                    const cacheAgeHours = Math.floor(cacheAgeMs / (60 * 60 * 1000));
                    const cacheAgeDays = Math.floor(cacheAgeMs / (24 * 60 * 60 * 1000));
                    logger.info(
                      `Analysis cache expired (age: ${cacheAgeHours} hours / ${cacheAgeDays} days). Cache timestamp: ${previousResult.timestamp.toISOString()}, Current time: ${new Date().toISOString()}. Performing fresh scan.`
                    );
                    // Cache expired - perform fresh analysis
                    analysisResult = await analysisEngine.analyze(projectInfo, {
                      bypassCache: effectiveBypassCache,
                      includeTransitiveDependencies,
                    });
                    // We explicitly ignored the previous cached analysis due to TTL expiry and
                    // performed a new full analysis. For this run, treat the data as "Live" from
                    // the user's perspective (the cache will be updated afterwards).
                    didExpireAndRefetch = true;
                  } else {
                    // No changes detected - but verify the counts match to avoid stale data
                    const previousKeys = isMonorepoProject
                      ? dedupeKeys(
                          previousResult.dependencies,
                          (d) => {
                            const dep = d.dependency;
                            return `${dep.name}@${dep.resolvedVersion ?? dep.version ?? ''}`;
                          },
                          (d) => !d.dependency.isInternal
                        )
                      : previousResult.dependencies.map((d) => d.dependency.name);
                    const currentKeys = isMonorepoProject
                      ? dedupeKeys(
                          projectInfo.dependencies,
                          (dep) => `${dep.name}@${dep.resolvedVersion ?? dep.version ?? ''}`,
                          (dep) => !dep.isInternal
                        )
                      : projectInfo.dependencies.map((dep) => dep.name);

                    const previousCount = isMonorepoProject
                      ? previousKeys.length
                      : previousResult.dependencies.length;
                    const currentCount = isMonorepoProject
                      ? currentKeys.length
                      : projectInfo.dependencies.length;

                    if (previousCount !== currentCount) {
                      const prevSet = new Set(previousKeys);
                      const currSet = new Set(currentKeys);
                      const added = currentKeys.filter((k) => !prevSet.has(k));
                      const removed = previousKeys.filter((k) => !currSet.has(k));

                      // Count mismatch - previous result might be stale, do full scan
                      logger.warn(
                        `Dependency count mismatch (previous=${previousCount}, current=${currentCount}). Added=${added.length}, removed=${removed.length}. Sample added: ${
                          added.slice(0, 5).join(', ') || 'none'
                        }, sample removed: ${removed.slice(0, 5).join(', ') || 'none'}. Performing full scan to ensure accuracy.`
                      );
                      analysisResult = await analysisEngine.analyze(projectInfo, {
                        includeTransitiveDependencies,
                      });
                    } else {
                      // Counts match and no changes - safe to reuse previous result
                      logger.info(
                        `No changes detected (${currentCount} dependencies), reusing previous result`
                      );

                      // Calculate cache age before updating timestamp
                      isCached = true;
                      const now = new Date();
                      const cacheTimestamp = previousResult.timestamp;
                      const diffMs = now.getTime() - cacheTimestamp.getTime();
                      cacheAge = Math.floor(diffMs / 60000); // minutes
                      const cacheAgeHours = Math.floor(diffMs / (60 * 60 * 1000)); // hours
                      const cacheAgeDays = Math.floor(diffMs / (24 * 60 * 60 * 1000)); // days

                      logger.info(
                        `Cache hit: Reusing previous result (age: ${cacheAge} min / ${cacheAgeHours} hours / ${cacheAgeDays} days)`
                      );
                      logger.info(
                        `Cache timestamp: ${cacheTimestamp.toISOString()}, Current time: ${now.toISOString()}`
                      );

                      dashboardController.sendProgressUpdate(
                        50,
                        'No changes detected, reusing cached result...'
                      );
                      await new Promise((resolve) => setTimeout(resolve, 500)); // Small delay to show modal
                      // Keep original timestamp - don't update it when reusing cache
                      // This ensures the 24-hour expiration check works correctly
                      analysisResult = {
                        ...previousResult,
                        // timestamp remains unchanged to preserve actual cache age
                      };
                    }
                  }
                } else {
                  // Full analysis
                  analysisResult = await analysisEngine.analyze(projectInfo, {
                    bypassCache: effectiveBypassCache,
                    includeTransitiveDependencies,
                  });
                }

                // Calculate performance metrics
                const scanEndTime = Date.now();
                const scanDuration = scanEndTime - scanStartTime;
                const finalMemory = memoryProfiler.takeSnapshot();
                const performanceMetrics = {
                  scanDuration: Date.now() - scanStartTime,
                  memoryUsage: {
                    heapUsed: process.memoryUsage().heapUsed,
                    heapTotal: process.memoryUsage().heapTotal,
                    rss: process.memoryUsage().rss,
                  },
                  dependencyCount: analysisResult.summary.totalDependencies,
                  validDependencyCount: analysisResult.summary.analyzedDependencies,
                  invalidDependencyCount: analysisResult.summary.failedDependencies,
                  transitiveDependencyCount:
                    analysisResult.performanceMetrics?.transitiveDependencyCount ?? 0,
                };

                logger.info(
                  `Analysis complete - Health Score: ${analysisResult.healthScore.overall.toFixed(1)}`
                );
                logger.info(
                  `Performance: ${(scanDuration / 1000).toFixed(2)}s scan time, ${(finalMemory.heapUsed / 1024 / 1024).toFixed(2)} MB heap used`
                );

                // Clean up intermediate data: projectInfo is no longer needed after analysis
                // The analysisResult contains all necessary data, so we can help GC by clearing references
                // Note: projectInfo is a parameter, so we can't null it, but we can ensure
                // no other references are held unnecessarily

                // Stop progress polling BEFORE final update to prevent race condition
                // where polling continues during the 300ms delay and sends stale updates
                if (progressInterval) {
                  clearInterval(progressInterval);
                  progressInterval = undefined;
                }

                // Step 3: Send final progress update before updating UI
                dashboardController.sendProgressUpdate(100, 'Analysis complete');

                // Small delay to ensure modal is visible before hiding it
                await new Promise((resolve) => setTimeout(resolve, 300));

                // Determine cache status
                // If we reused the previous result entirely (no changes), it's cached.
                // If we did an incremental analysis but all items were hits in the AnalysisEngine cache, it's effectively cached.
                // Note: isCached and cacheAge are already declared in the outer scope.

                // If we explicitly expired the cache and refetched, this run is based on a fresh
                // full analysis even though the result is written back to cache. Treat it as "Live"
                // for UI purposes so the navbar tag shows Live rather than Cached.
                if (didExpireAndRefetch) {
                  isCached = false;
                  cacheAge = 0;
                } else if (effectiveBypassCache) {
                  // Forced refresh - ensure we report as not cached
                  isCached = false;
                  cacheAge = 0;
                } else if (
                  dependencyChanges.changed.length === 0 &&
                  dependencyChanges.removed.length === 0 &&
                  previousResult
                ) {
                  // Full reuse of previous result
                  isCached = true;
                  const lastScanTime = new Date(previousResult.timestamp).getTime();
                  const currentTime = Date.now();
                  cacheAge = Math.round((currentTime - lastScanTime) / (1000 * 60));
                } else if (analysisResult.metadata && analysisResult.metadata.cacheHits > 0) {
                  // Check if we had a high cache hit rate
                  // If we analyzed X dependencies and got X cache hits, it's cached.
                  // Note: incremental analysis only analyzes 'changed' dependencies.
                  // If all 'changed' dependencies were actually cache hits, then for the user, it was instant/cached.
                  const cacheHits = analysisResult.metadata.cacheHits;
                  const cacheRequests = analysisResult.metadata.cacheRequests ?? 0;

                  // If we have requests and hits equals requests, it's fully cached.
                  // We also check if cacheRequests > 0 to ensure we actually did something.
                  // If cacheRequests is 0 (e.g. no deps), it falls through and isCached remains false (or whatever default)
                  // But if no deps, we usually return early anyway.
                  if (cacheRequests > 0 && cacheHits >= cacheRequests) {
                    isCached = true;
                    // For partial/incremental cache hits, the age is effectively "now" (0) because we just re-verified them,
                    // but the data came from cache. However, showing "0 min ago" might be confusing if it says "Cached".
                    // Let's show the age of the *oldest* item? No, that's too complex.
                    // If it's a cache hit, it means the data hasn't changed since it was cached.
                    // Let's just show "Cached (just now)" or similar by setting age to 0.
                    cacheAge = 0;
                  }
                }

                logger.debug(
                  `Updating dashboard with cache status: isCached=${isCached}, age=${cacheAge}`
                );

                // Step 4: Update status bar
                progress.report({ message: 'Updating status bar...' });
                statusBarManager.update(analysisResult);

                // Step 5: Update dashboard if visible (this will hide the modal)
                // Pass performance metrics to dashboard
                progress.report({ message: 'Updating dashboard...' });

                // Use captured cache state from scan start for consistency
                const cacheEnabledState = cacheEnabledAtStart;
                logger.debug(`Sending cacheEnabled=${cacheEnabledState} to dashboard`);

                dashboardController.update(
                  analysisResult,
                  performanceMetrics,
                  { isCached, cacheAge },
                  cacheEnabledState,
                  includeTransitiveDependencies
                );

                // Step 6: Store analysis result in workspace state for incremental updates
                await storeAnalysisResult(analysisResult, context);

                // Show completion message
                const healthScore = analysisResult.healthScore.overall.toFixed(1);
                const criticalIssues = analysisResult.summary.criticalIssues;
                const highIssues = analysisResult.summary.highIssues;
                const warnings = analysisResult.summary.warnings;
                const analyzedDeps = analysisResult.summary.analyzedDependencies;
                const totalDeps = analysisResult.summary.totalDependencies;
                const failedDeps = analysisResult.summary.failedDependencies;

                let message = `DepPulse: Scan complete - Health Score: ${healthScore}`;

                // Show dependency split if there are failed packages
                if (failedDeps > 0) {
                  message += ` (${analyzedDeps}/${totalDeps} real packages, ${failedDeps} not found in NPM registry)`;
                }

                // Build issue summary
                const issues: string[] = [];
                if (criticalIssues > 0) {
                  issues.push(`${criticalIssues} critical`);
                }
                if (highIssues > 0) {
                  issues.push(`${highIssues} high`);
                }

                if (issues.length > 0) {
                  message += ` - ${issues.join(', ')}`;
                } else if (warnings > 0) {
                  message += ` - ${warnings} warnings`;
                }

                // Check if GitHub token is configured if GitHub is the selected source
                const githubToken = getGitHubToken();
                const vulnConfig = vscode.workspace.getConfiguration(
                  'depPulse.vulnerabilityDetection',
                  getConfigResource()
                );
                const primarySource = vulnConfig.get<'osv' | 'github'>('primarySource', 'osv');

                logger.debug(
                  `Scan completion check - Primary Source: ${primarySource}, Token configured: ${!!githubToken}`
                );

                // Only show GitHub token warning if GitHub is selected source AND no token configured
                const shouldWarnAboutToken = !githubToken && primarySource === 'github';

                // Only show completion message if there are issues or if scan took significant time
                // This prevents duplicate notifications (withProgress already shows a notification)
                // Show message only if there are critical/high issues or warnings
                if (criticalIssues > 0 || highIssues > 0 || warnings > 0) {
                  vscode.window.showInformationMessage(message);
                } else {
                  // For successful scans with no issues, just log (no toast)
                  logger.info(message);
                }

                if (shouldWarnAboutToken) {
                  // Warning handled by ConfigurationEnforcer and initializeServices
                  // We suppress it here to avoid duplicate/confusing notifications
                  logger.warn(
                    'GitHub Advisory scanning enabled but no token found. (Warning suppressed in scan completion)'
                  );
                } else if (!githubToken && primarySource === 'github') {
                  // Log informational note
                  logger.info('GitHub Advisory scanning enabled but no token found.');
                }

                logger.info('Scan workflow completed successfully');
              } finally {
                // Stop progress polling (even if error occurred)
                if (progressInterval) {
                  clearInterval(progressInterval);
                  progressInterval = undefined;
                }
                // Final progress update is sent before dashboard update (above)
              }
            } catch (error) {
              const errorMessage = error instanceof Error ? error.message : String(error);
              logger.error(`Error during scan: ${errorMessage}`, error);

              // Hide the loading modal since scan failed
              dashboardController.sendMessage({
                type: 'loading',
                data: { isLoading: false },
              });

              // Check if this is an authentication error
              if (error instanceof DepPulseError && error.code === ErrorCode.AUTH_ERROR) {
                vscode.window
                  .showErrorMessage(
                    'DepPulse: GitHub API authentication required. Configure a GitHub token via “DepPulse: Configure API Secrets” to enable vulnerability scanning.',
                    'Configure Secrets',
                    'View Logs'
                  )
                  .then((action) => {
                    if (action === 'Configure Secrets') {
                      vscode.commands.executeCommand('depPulse.configureSecrets');
                    } else if (action === 'View Logs') {
                      logger.show();
                    }
                  });
              } else {
                vscode.window
                  .showErrorMessage(`DepPulse: Scan failed - ${errorMessage}`, 'View Logs')
                  .then((action) => {
                    if (action === 'View Logs') {
                      logger.show();
                    }
                  });
              }
            } finally {
              // Stop progress polling (even if error occurred)
              if (progressInterval) {
                clearInterval(progressInterval);
                progressInterval = undefined;
              }
              // Final progress update is sent before dashboard update (above)
            }
          }
        );
      } finally {
        // Reset flag to allow future scans
        isScanInProgress = false;
        scanLock = null;
        logger.info('Scan completed (isScanInProgress = false)');
      }
    })();

    await scanLock;
  } catch (error) {
    // Ensure flag and lock are always reset even if scanLock throws
    isScanInProgress = false;
    scanLock = null;
    logger.error('Error in scan command wrapper', error);
    throw error;
  }
}

async function collectUnusedPackagePlans(
  cleaner = new UnusedPackageCleaner()
): Promise<{ plans: CleanupPlan[]; totalUnused: number; summaries: CleanupPlanSummary[] }> {
  const projectInfo = await dependencyScanner.scanWorkspace();
  const dependencyFiles = projectInfo.dependencyFiles ?? [];

  if (dependencyFiles.length === 0) {
    throw new DepPulseError(
      'No package.json files found to analyze.',
      ErrorCode.FILE_NOT_FOUND,
      true
    );
  }

  const targets = await cleaner.buildCleanupTargets(projectInfo);

  if (targets.length === 0) {
    return { plans: [], totalUnused: 0, summaries: [] };
  }

  const plans: CleanupPlan[] = [];

  for (const target of targets) {
    const result = await cleaner.findUnusedDependencies(target, projectInfo);

    if (result instanceof Map) {
      // Root scan result (monorepo): Map of packageRoot -> report
      for (const [packageRoot, report] of result.entries()) {
        if (report.dependencies.length > 0 || report.devDependencies.length > 0) {
          // Find the matching target info for this package
          const matchingDepFile = projectInfo.dependencyFiles?.find(
            (df) => (df.packageRoot ?? path.dirname(df.path)) === packageRoot
          );
          if (matchingDepFile) {
            const packageName =
              matchingDepFile.packageName ?? (await cleaner.readPackageName(packageRoot));
            const packageTarget = {
              packageRoot,
              packageName,
              workspaceFolder: matchingDepFile.workspaceFolder,
              packageManager: target.packageManager,
              internalPackageNames: target.internalPackageNames,
            };
            plans.push({ target: packageTarget, report });
          }
        }
      }
    } else {
      // Regular scan result (monolith): single report
      if (result.dependencies.length > 0 || result.devDependencies.length > 0) {
        plans.push({ target, report: result });
      }
    }
  }

  const totalUnused = plans.reduce(
    (acc, plan) => acc + plan.report.dependencies.length + plan.report.devDependencies.length,
    0
  );

  const summaries: CleanupPlanSummary[] = plans.map((plan) => ({
    targetLabel: cleaner.formatTargetLabel(plan.target),
    packageManager: plan.target.packageManager,
    packageRoot: plan.target.packageRoot,
    workspaceFolder: plan.target.workspaceFolder,
    dependencies: plan.report.dependencies,
    devDependencies: plan.report.devDependencies,
  }));

  return { plans, totalUnused, summaries };
}

async function removeUnusedPackages(
  plans: CleanupPlan[],
  cleaner = new UnusedPackageCleaner()
): Promise<void> {
  for (const plan of plans) {
    const commands = cleaner.buildRemovalCommands(plan.target, plan.report);
    for (const command of commands) {
      await cleaner.executeCommand(command, plan.target.packageRoot);
    }
  }
}

async function handleCleanupUnusedPackagesPreviewRequest(): Promise<void> {
  if (!dashboardController) return;
  const cleaner = new UnusedPackageCleaner();

  dashboardController.sendMessage({
    type: 'unusedPackagesPreview',
    data: { status: 'loading' },
  });

  try {
    const { totalUnused, summaries } = await collectUnusedPackagePlans(cleaner);
    if (totalUnused === 0) {
      dashboardController.sendMessage({
        type: 'unusedPackagesPreview',
        data: { status: 'empty' },
      });
      return;
    }

    dashboardController.sendMessage({
      type: 'unusedPackagesPreview',
      data: { status: 'ok', totalUnused, plans: summaries },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    dashboardController.sendMessage({
      type: 'unusedPackagesPreview',
      data: { status: 'error', message },
    });
  }
}

async function handleCleanupUnusedPackagesExecuteRequest(): Promise<void> {
  if (!dashboardController) return;

  const cleaner = new UnusedPackageCleaner();

  dashboardController.sendMessage({
    type: 'unusedPackagesResult',
    data: { status: 'executing' },
  });

  try {
    const { plans, totalUnused } = await collectUnusedPackagePlans(cleaner);

    if (totalUnused === 0) {
      dashboardController.sendMessage({
        type: 'unusedPackagesResult',
        data: { status: 'empty' },
      });
      return;
    }

    await removeUnusedPackages(plans, cleaner);

    dashboardController.sendMessage({
      type: 'unusedPackagesResult',
      data: { status: 'ok', removed: totalUnused },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    Logger.getInstance().error(`Unused dependency cleanup failed: ${message}`, error);
    dashboardController?.sendMessage({
      type: 'unusedPackagesResult',
      data: { status: 'error', message },
    });
  }
}

/**
 * Runs knip to discover unused dependencies and removes them after explicit confirmation.
 */
async function handleCleanupUnusedPackages(): Promise<void> {
  const logger = Logger.getInstance();
  const cleaner = new UnusedPackageCleaner();

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'DepPulse: Detecting unused dependencies',
        cancellable: false,
      },
      async (progress) => {
        progress.report({ message: 'Scanning workspace...' });

        const { plans, totalUnused, summaries } = await collectUnusedPackagePlans(cleaner);

        if (plans.length === 0) {
          void vscode.window.showInformationMessage(
            'DepPulse: No unused dependencies found (knip).'
          );
          return;
        }

        const summaryDetail = summaries
          .map((plan) => {
            const all = [...plan.dependencies, ...plan.devDependencies];
            const preview = all.slice(0, 5).join(', ');
            const more = all.length > 5 ? `, +${all.length - 5} more` : '';
            return `${plan.targetLabel}: ${preview}${more}`;
          })
          .join('\n');

        const choice = await vscode.window.showInformationMessage(
          `DepPulse: Found ${totalUnused} unused ${totalUnused === 1 ? 'dependency' : 'dependencies'} across ${plans.length} package.json file${plans.length === 1 ? '' : 's'}. Remove them now?`,
          { modal: true, detail: summaryDetail },
          'Remove',
          'Cancel'
        );

        if (choice !== 'Remove') {
          logger.info('Unused dependency cleanup cancelled by user.');
          return;
        }

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'DepPulse: Removing unused dependencies',
            cancellable: false,
          },
          async (removeProgress) => {
            const totalCommands = plans.reduce((acc, plan) => {
              return acc + cleaner.buildRemovalCommands(plan.target, plan.report).length;
            }, 0);

            let completedCommands = 0;

            for (const plan of plans) {
              const label = cleaner.formatTargetLabel(plan.target);
              const commands = cleaner.buildRemovalCommands(plan.target, plan.report);
              for (const command of commands) {
                removeProgress.report({ message: `${label}: ${command}` });
                await cleaner.executeCommand(command, plan.target.packageRoot);
                completedCommands += 1;
                removeProgress.report({
                  increment: totalCommands > 0 ? (completedCommands / totalCommands) * 100 : 100,
                });
              }
            }
          }
        );

        void vscode.window.showInformationMessage(
          `DepPulse: Removed ${totalUnused} unused ${totalUnused === 1 ? 'dependency' : 'dependencies'}.`
        );
      }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Unused dependency cleanup failed: ${message}`, error);
    void vscode.window.showErrorMessage(
      `DepPulse: Failed to remove unused dependencies - ${message}`
    );
  }
}

/**
 * Store analysis result in workspace state for incremental updates
 */
/**
 * Store analysis result in workspace storage (disk) for incremental updates
 */
async function storeAnalysisResult(
  analysisResult: AnalysisResult,
  context: vscode.ExtensionContext
): Promise<void> {
  try {
    // Serialize the analysis result for storage
    // Convert Date objects to ISO strings for JSON serialization
    const serialized = {
      ...analysisResult,
      timestamp: analysisResult.timestamp.toISOString(),
      dependencies: analysisResult.dependencies.map((dep) => ({
        ...dep,
        freshness: {
          ...dep.freshness,
          releaseDate: dep.freshness.releaseDate.toISOString(),
          maintenanceSignals: dep.freshness.maintenanceSignals
            ? {
                ...dep.freshness.maintenanceSignals,
                lastChecked: dep.freshness.maintenanceSignals.lastChecked.toISOString(),
              }
            : undefined,
        },
        packageInfo: dep.packageInfo
          ? {
              ...dep.packageInfo,
              publishedAt: dep.packageInfo.publishedAt.toISOString(),
            }
          : undefined,
        maintenanceSignals: dep.maintenanceSignals
          ? {
              ...dep.maintenanceSignals,
              lastChecked: dep.maintenanceSignals.lastChecked.toISOString(),
            }
          : undefined,
        security: {
          ...dep.security,
          vulnerabilities: dep.security.vulnerabilities.map((vuln) => ({
            ...vuln,
            publishedDate: vuln.publishedDate?.toISOString(),
            lastModifiedDate: vuln.lastModifiedDate?.toISOString(),
          })),
        },
      })),
    };

    // Use storageUri for persistent storage on disk
    if (context.storageUri) {
      try {
        // Ensure storage directory exists
        await vscode.workspace.fs.createDirectory(context.storageUri);

        const fileUri = vscode.Uri.joinPath(context.storageUri, 'analysis-result.json');
        const content = new TextEncoder().encode(JSON.stringify(serialized));

        await vscode.workspace.fs.writeFile(fileUri, content);

        Logger.getInstance().info(
          `Analysis result stored to disk at ${fileUri.fsPath} (${analysisResult.dependencies.length} dependencies)`
        );

        // Clear legacy workspace state if it exists to free up space
        const legacyState = context.workspaceState.get('lastAnalysisResult');
        if (legacyState) {
          await context.workspaceState.update('lastAnalysisResult', undefined);
          Logger.getInstance().info(`Cleared legacy analysis result from workspace state`);
        }
      } catch (fsError) {
        Logger.getInstance().error(`Error writing analysis result to disk: ${fsError}`);
        // Fallback to workspace state if disk write fails?
        // No, better to just log error to avoid the warning we're trying to fix.
      }
    } else {
      // Fallback for environments without storageUri (unlikely for workspace extensions)
      Logger.getInstance().warn(`WARNING: No storageUri available, falling back to workspaceState`);
      await context.workspaceState.update('lastAnalysisResult', serialized);
    }
  } catch (error) {
    Logger.getInstance().error(`Error storing analysis result: ${error}`);
  }
}

/**
 * Load previous analysis result from workspace state
 */
/**
 * Load previous analysis result from workspace storage (disk)
 */
function loadPreviousAnalysisResult(context: vscode.ExtensionContext): AnalysisResult | undefined {
  try {
    // Try to load from disk first (new method)
    if (context.storageUri) {
      try {
        // Use node:fs to read synchronously
        const fs = require('node:fs');
        const path = require('node:path');

        if (context.storageUri.scheme === 'file') {
          const filePath = path.join(context.storageUri.fsPath, 'analysis-result.json');
          if (fs.existsSync(filePath)) {
            const content = fs.readFileSync(filePath, 'utf8');
            const stored = JSON.parse(content);
            return deserializeAnalysisResult(stored);
          }
        }
      } catch (e) {
        // Ignore disk read errors, fall back to workspace state
        Logger.getInstance().error(`Error reading analysis result from disk: ${e}`);
      }
    }

    // Fallback to workspace state (legacy)
    const stored = context.workspaceState.get('lastAnalysisResult');
    if (stored) {
      return deserializeAnalysisResult(stored);
    }

    return undefined;
  } catch (error) {
    Logger.getInstance().error(`Error loading previous analysis result: ${error}`);
    return undefined;
  }
}

// Define interface for stored data to avoid 'any'
interface StoredAnalysisResult {
  timestamp: string;
  dependencies: Array<{
    freshness: {
      versionGap: 'major' | 'minor' | 'patch' | 'current';
      releaseDate: string;
      maintenanceSignals?: {
        lastChecked: string;
      };
    };
    packageInfo?: {
      publishedAt: string;
    };
    maintenanceSignals?: {
      lastChecked: string;
    };
    security: {
      vulnerabilities: Array<{
        publishedDate?: string;
        lastModifiedDate?: string;
      }>;
    };
    [key: string]: unknown; // Allow other properties (e.g., dependency, metadata)
  }>;
  healthScore: HealthScore;
  summary: AnalysisSummary;
  failedPackages?: FailedPackage[];
  performanceMetrics?: PerformanceMetrics;
  isMonorepo?: boolean;
  packageJsonCount?: number;
  metadata?: AnalysisResult['metadata'];
  networkStatus?: AnalysisResult['networkStatus'];
}

function deserializeAnalysisResult(stored: unknown): AnalysisResult {
  // Validate structure
  if (!stored || typeof stored !== 'object') {
    throw new Error('Invalid stored analysis result: not an object');
  }

  const typedStored = stored as StoredAnalysisResult;

  // Validate required fields
  if (typeof typedStored.timestamp !== 'string') {
    throw new Error('Invalid stored analysis result: missing or invalid timestamp');
  }

  if (!typedStored.dependencies || !Array.isArray(typedStored.dependencies)) {
    throw new Error('Invalid stored analysis result: missing or invalid dependencies array');
  }

  if (!typedStored.healthScore || typeof typedStored.healthScore !== 'object') {
    throw new Error('Invalid stored analysis result: missing or invalid healthScore');
  }

  if (!typedStored.summary || typeof typedStored.summary !== 'object') {
    throw new Error('Invalid stored analysis result: missing or invalid summary');
  }

  // Deserialize: convert ISO strings back to Date objects (with safe defaults)
  const dependencies = (typedStored.dependencies ?? []).map((dep) => {
    const freshness = dep.freshness ?? {
      versionGap: 'current',
      releaseDate: new Date(0).toISOString(),
      isOutdated: false,
      isUnmaintained: false,
    };
    const security = dep.security ?? { vulnerabilities: [], severity: 'none' };

    return {
      ...dep,
      freshness: {
        ...freshness,
        versionGap: freshness.versionGap ?? 'current',
        releaseDate: new Date(freshness.releaseDate ?? Date.now()),
        maintenanceSignals: freshness.maintenanceSignals
          ? {
              ...freshness.maintenanceSignals,
              lastChecked: new Date(freshness.maintenanceSignals.lastChecked),
            }
          : undefined,
      },
      packageInfo: dep.packageInfo
        ? {
            ...dep.packageInfo,
            publishedAt: new Date(dep.packageInfo.publishedAt),
          }
        : undefined,
      maintenanceSignals: dep.maintenanceSignals
        ? {
            ...dep.maintenanceSignals,
            lastChecked: new Date(dep.maintenanceSignals.lastChecked),
          }
        : undefined,
      security: {
        ...security,
        vulnerabilities: (security.vulnerabilities ?? []).map((vuln) => ({
          ...vuln,
          publishedDate: vuln.publishedDate ? new Date(vuln.publishedDate) : undefined,
          lastModifiedDate: vuln.lastModifiedDate ? new Date(vuln.lastModifiedDate) : undefined,
        })),
      },
    };
  }) as DependencyAnalysis[];

  const workspaceKeys = new Set(
    dependencies
      .map((d) => d.dependency.packageRoot || d.dependency.workspaceFolder)
      .filter(Boolean)
  );

  const packageJsonCount =
    typeof typedStored.packageJsonCount === 'number'
      ? typedStored.packageJsonCount
      : workspaceKeys.size;
  const isMonorepo =
    typeof typedStored.isMonorepo === 'boolean' ? typedStored.isMonorepo : workspaceKeys.size > 1;

  return {
    timestamp: typedStored.timestamp ? new Date(typedStored.timestamp) : new Date(0),
    dependencies,
    healthScore: typedStored.healthScore,
    summary: typedStored.summary,
    failedPackages: typedStored.failedPackages,
    performanceMetrics: typedStored.performanceMetrics,
    packageJsonCount,
    isMonorepo,
    metadata: typedStored.metadata,
    networkStatus: typedStored.networkStatus,
  };
}

function rehydrateWorkspaceMetadata(
  analysisResult: AnalysisResult,
  projectDependencies: Dependency[] | undefined
): AnalysisResult {
  if (!analysisResult || !projectDependencies || projectDependencies.length === 0) {
    return analysisResult;
  }

  const projectDepsByNameVersion = new Map<string, Dependency[]>();
  for (const dep of projectDependencies) {
    if (!dep) continue;
    const key = `${dep.name}@${dep.version}`;
    const list = projectDepsByNameVersion.get(key) ?? [];
    list.push(dep);
    projectDepsByNameVersion.set(key, list);
  }

  let updated = false;
  const enrichedDependencies = analysisResult.dependencies.map((analysisDep) => {
    const hasScope = analysisDep.dependency.packageRoot || analysisDep.dependency.workspaceFolder;
    if (hasScope) {
      return analysisDep;
    }

    const matches = projectDepsByNameVersion.get(
      `${analysisDep.dependency.name}@${analysisDep.dependency.version}`
    );

    if (matches && matches.length === 1) {
      updated = true;
      const match = matches[0];
      return {
        ...analysisDep,
        dependency: {
          ...analysisDep.dependency,
          packageRoot: match.packageRoot,
          workspaceFolder: match.workspaceFolder,
        },
      };
    }

    return analysisDep;
  });

  const workspaceKeys = new Set(
    enrichedDependencies
      .map((d) => d.dependency.packageRoot || d.dependency.workspaceFolder)
      .filter(Boolean)
  );

  const packageJsonCount =
    typeof analysisResult.packageJsonCount === 'number'
      ? analysisResult.packageJsonCount
      : workspaceKeys.size;
  const isMonorepo =
    typeof analysisResult.isMonorepo === 'boolean'
      ? analysisResult.isMonorepo
      : workspaceKeys.size > 1;

  if (
    !updated &&
    packageJsonCount === analysisResult.packageJsonCount &&
    isMonorepo === analysisResult.isMonorepo
  ) {
    return analysisResult;
  }

  return {
    ...analysisResult,
    dependencies: enrichedDependencies,
    packageJsonCount,
    isMonorepo,
  };
}

/**
 * Compare current dependencies with previous analysis to find changes
 * Returns dependencies that are new, modified, or removed
 */
function findDependencyChanges(
  currentDependencies: Dependency[],
  previousResult?: AnalysisResult
): {
  changed: Dependency[];
  removed: string[]; // Package names that were removed
  isFullScan: boolean; // True if no previous result exists
} {
  if (!previousResult) {
    // No previous result, all dependencies are "changed" (need full scan)
    return {
      changed: currentDependencies.filter((d) => !d.isInternal),
      removed: [],
      isFullScan: true,
    };
  }

  // Create maps for efficient lookup
  const currentMap = new Map<string, Dependency>();
  for (const dep of currentDependencies) {
    if (dep.isInternal) continue;
    currentMap.set(dep.name, dep);
  }

  const previousMap = new Map<string, DependencyAnalysis>();
  for (const analysis of previousResult.dependencies) {
    if (analysis.dependency.isInternal) continue;
    previousMap.set(analysis.dependency.name, analysis);
  }

  // Find changed dependencies (new or version changed)
  const changed: Dependency[] = [];
  const removed: string[] = [];

  // Check current dependencies against previous
  for (const currentDep of currentDependencies) {
    if (currentDep.isInternal) continue;
    const previous = previousMap.get(currentDep.name);
    if (!previous) {
      // New dependency
      changed.push(currentDep);
    } else if (previous.dependency.version !== currentDep.version) {
      // Version changed
      Logger.getInstance().debug(
        `Dependency changed: ${currentDep.name} (Previous: ${previous.dependency.version}, Current: ${currentDep.version})`
      );
      changed.push(currentDep);
    }
    // If name and version match, no change needed
  }

  // Find removed dependencies
  for (const previousDep of previousResult.dependencies) {
    if (previousDep.dependency.isInternal) continue;
    if (!currentMap.has(previousDep.dependency.name)) {
      removed.push(previousDep.dependency.name);
    }
  }

  return {
    changed,
    removed,
    isFullScan: false,
  };
}

/**
 * Merge incremental analysis results with previous results
 * Removes deleted dependencies, replaces changed ones, keeps unchanged ones
 */
function mergeAnalysisResults(
  previousResult: AnalysisResult,
  incrementalResult: AnalysisResult,
  changes: {
    changed: Dependency[];
    removed: string[];
    isFullScan: boolean;
  }
): AnalysisResult {
  Logger.getInstance().info(
    `Merging incremental results: ${incrementalResult.dependencies.length} changed, ${changes.removed.length} removed`
  );

  // Validate incremental result matches changed dependencies
  const incrementalNames = new Set(incrementalResult.dependencies.map((d) => d.dependency.name));
  const changedNames = new Set(changes.changed.map((d) => d.name));

  const missing = Array.from(changedNames).filter((n) => !incrementalNames.has(n));
  if (missing.length > 0) {
    Logger.getInstance().warn(`Incremental analysis missing dependencies: ${missing.join(', ')}`);
  }

  const extra = Array.from(incrementalNames).filter((n) => !changedNames.has(n));
  if (extra.length > 0) {
    Logger.getInstance().warn(
      `Incremental analysis includes unexpected dependencies: ${extra.join(', ')}`
    );
  }

  // Create map of previous analyses by package name
  const previousMap = new Map<string, DependencyAnalysis>();
  for (const analysis of previousResult.dependencies) {
    previousMap.set(analysis.dependency.name, analysis);
  }

  // Create map of incremental analyses by package name
  const incrementalMap = new Map<string, DependencyAnalysis>();
  for (const analysis of incrementalResult.dependencies) {
    incrementalMap.set(analysis.dependency.name, analysis);
  }

  // Build merged dependencies list
  const mergedDependencies: DependencyAnalysis[] = [];

  // Add all previous dependencies that weren't changed or removed
  for (const previousAnalysis of previousResult.dependencies) {
    const packageName = previousAnalysis.dependency.name;
    if (!changes.removed.includes(packageName) && !incrementalMap.has(packageName)) {
      // Keep unchanged dependency
      mergedDependencies.push(previousAnalysis);
    }
  }

  // Add all incremental (changed) dependencies
  // Use incremental result to replace or add new dependencies
  for (const incrementalAnalysis of incrementalResult.dependencies) {
    // Check if this dependency already exists in merged list (from previous)
    const existingIndex = mergedDependencies.findIndex(
      (d) => d.dependency.name === incrementalAnalysis.dependency.name
    );
    if (existingIndex >= 0) {
      // Replace existing with updated analysis
      mergedDependencies[existingIndex] = incrementalAnalysis;
    } else {
      // Add new dependency
      mergedDependencies.push(incrementalAnalysis);
    }
  }

  // Log merge details for debugging
  Logger.getInstance().info(
    `Merge details: previous=${previousResult.dependencies.length}, incremental=${incrementalResult.dependencies.length}, merged=${mergedDependencies.length}, removed=${changes.removed.length}`
  );

  // Merge failed packages
  const mergedFailedPackages: FailedPackage[] = [];
  if (previousResult.failedPackages) {
    for (const failed of previousResult.failedPackages) {
      if (!changes.removed.includes(failed.name)) {
        mergedFailedPackages.push(failed);
      }
    }
  }
  if (incrementalResult.failedPackages) {
    for (const failed of incrementalResult.failedPackages) {
      // Replace or add new failed packages
      const existingIndex = mergedFailedPackages.findIndex((f) => f.name === failed.name);
      if (existingIndex >= 0) {
        mergedFailedPackages[existingIndex] = failed;
      } else {
        mergedFailedPackages.push(failed);
      }
    }
  }

  // Create merged result
  const mergedResult: AnalysisResult = {
    timestamp: new Date(),
    dependencies: mergedDependencies,
    failedPackages: mergedFailedPackages.length > 0 ? mergedFailedPackages : undefined,
    metadata: incrementalResult.metadata,
    healthScore: {
      overall: 0,
      security: 0,
      freshness: 0,
      compatibility: 100,
      license: 100,
      breakdown: {
        totalDependencies: mergedDependencies.length,
        criticalIssues: 0,
        warnings: 0,
        healthy: 0,
      },
    },
    summary: {
      totalDependencies: mergedDependencies.length,
      analyzedDependencies: 0,
      failedDependencies: mergedFailedPackages.length,
      criticalIssues: 0,
      highIssues: 0,
      warnings: 0,
      healthy: 0,
    },
  };

  // Recalculate summary using the same logic as AnalysisEngine
  let criticalIssues = 0;
  let highIssues = 0;
  let warnings = 0;
  let healthy = 0;
  let analyzedDependencies = 0;

  for (const analysis of mergedDependencies) {
    if (analysis.isFailed) {
      continue; // Skip failed packages
    }
    analyzedDependencies++;

    if (!analysis.classification) {
      // Fallback classification
      if (analysis.security.severity === 'critical') {
        criticalIssues++;
      } else if (analysis.security.severity === 'high') {
        highIssues++;
      } else if (
        analysis.security.severity === 'medium' ||
        analysis.security.severity === 'low' ||
        analysis.freshness.isOutdated ||
        analysis.freshness.isUnmaintained
      ) {
        warnings++;
      } else {
        healthy++;
      }
      continue;
    }

    const { primary } = analysis.classification;
    if (primary.type === 'security') {
      if (primary.severity === 'critical') {
        criticalIssues++;
      } else if (primary.severity === 'high') {
        highIssues++;
      } else {
        warnings++;
      }
    } else if (primary.type === 'unmaintained') {
      warnings++;
    } else if (primary.type === 'outdated') {
      if (primary.gap === 'major') {
        warnings++;
      } else {
        healthy++;
      }
    } else {
      healthy++;
    }
  }

  mergedResult.summary = {
    totalDependencies: mergedDependencies.length,
    analyzedDependencies,
    failedDependencies: mergedFailedPackages.length,
    criticalIssues,
    highIssues,
    warnings,
    healthy,
  };

  // Recalculate health score using HealthScoreCalculator
  const healthScoreCalculator = new HealthScoreCalculator(Logger.getInstance().getOutputChannel());
  mergedResult.healthScore = healthScoreCalculator.calculate(mergedResult.dependencies);

  Logger.getInstance().info(
    `Merge complete: ${mergedDependencies.length} total dependencies, ${analyzedDependencies} analyzed`
  );

  return mergedResult;
}

/**
 * Trigger auto-scan on workspace open if enabled in configuration
 */
function triggerAutoScan(): void {
  Logger.getInstance().info(`Scheduling auto-scan check after 2-second delay...`);

  // Trigger scan after 2-second delay to avoid blocking activation and ensure config is loaded
  setTimeout(async () => {
    // Check if auto-scan is enabled (check inside timeout to ensure config is ready)
    const resource = getConfigResource();
    const config = vscode.workspace.getConfiguration('depPulse.analysis', resource);

    // Detailed debug logging for configuration
    const inspect = config.inspect<boolean>('autoScanOnStartup');
    Logger.getInstance().info(
      `DEBUG Auto-Scan Config: Resource=${resource?.fsPath}, Global=${inspect?.globalValue}, Workspace=${inspect?.workspaceValue}, WorkspaceFolder=${inspect?.workspaceFolderValue}, Default=${inspect?.defaultValue}, Effective=${config.get('autoScanOnStartup')}`
    );

    // Check for settings.json existence to help debug
    if (resource) {
      const settingsUri = vscode.Uri.joinPath(resource, '.vscode', 'settings.json');
      try {
        await vscode.workspace.fs.stat(settingsUri);
        Logger.getInstance().debug(`DEBUG: Found .vscode/settings.json at ${settingsUri.fsPath}`);
      } catch {
        Logger.getInstance().debug(
          `DEBUG: No .vscode/settings.json found at ${settingsUri.fsPath}`
        );
      }
    }

    const autoScanEnabled = config.get<boolean>('autoScanOnStartup', true);

    if (!autoScanEnabled) {
      Logger.getInstance().info(`Auto-scan disabled in configuration`);
      return;
    }

    Logger.getInstance().info(`Triggering auto-scan...`);
    vscode.commands.executeCommand('depPulse.scan');
  }, 2000);
}

/**
 * Set up file watcher for auto-refresh on dependency file changes
 */
function setupFileWatcher(disposables: vscode.Disposable[]): void {
  // Check if scan on save is enabled
  const resource = getConfigResource();
  const config = vscode.workspace.getConfiguration('depPulse.analysis', resource);
  const scanOnSave = config.get<boolean>('scanOnSave', true);

  if (!scanOnSave) {
    Logger.getInstance().info(`Scan on save disabled in configuration`);
    return;
  }

  Logger.getInstance().info(`Setting up file watcher for dependency files...`);

  // Debounce timer to avoid multiple scans in quick succession
  // Store in object to ensure it's accessible in dispose
  const timerState: { debounceTimer: NodeJS.Timeout | undefined } = {
    debounceTimer: undefined,
  };

  // Set up file watcher using the dependency scanner
  const watcher = dependencyScanner.watchForChanges((changes) => {
    Logger.getInstance().info(`Dependency file changes detected: ${changes.length} file(s)`);

    // Clear existing timer
    if (timerState.debounceTimer) {
      clearTimeout(timerState.debounceTimer);
      timerState.debounceTimer = undefined;
    }

    // Wait 1 second after last change before triggering scan
    timerState.debounceTimer = setTimeout(async () => {
      // Clear timer reference before executing
      timerState.debounceTimer = undefined;

      Logger.getInstance().info(`Triggering incremental scan after file changes...`);

      try {
        // For MVP, we'll trigger a full scan
        // In the future, we can use analyzeIncremental with the changed dependencies
        await vscode.commands.executeCommand('depPulse.scan');
      } catch (error) {
        Logger.getInstance().error(`Error during auto-refresh: ${error}`);
      }
    }, 1000);
  });

  // Create a disposable wrapper to clean up the debounce timer
  const watcherDisposable: vscode.Disposable = {
    dispose: () => {
      watcher.dispose();
      if (timerState.debounceTimer) {
        clearTimeout(timerState.debounceTimer);
        timerState.debounceTimer = undefined;
      }
    },
  };

  disposables.push(watcherDisposable);
  Logger.getInstance().info(`File watcher set up successfully`);
}

/**
 * Deactivates the DepPulse extension
 * Cleans up resources and logs deactivation
 */
export function deactivate() {
  Logger.getInstance().info(`DepPulse extension deactivated`);

  // Dispose of all services
  try {
    if (dashboardController) {
      dashboardController.dispose();
    }
  } catch (error) {
    Logger.getInstance().error(`Error disposing dashboard controller: ${error}`);
  }

  try {
    if (statusBarManager) {
      statusBarManager.dispose();
    }
  } catch (error) {
    Logger.getInstance().error(`Error disposing status bar manager: ${error}`);
  }

  // Output channel is disposed automatically via context.subscriptions
  // but we can dispose it explicitly here as well for safety
}

// Test-only hooks
export const __test__ = {
  offlinePreflightCheck,
};

/**
 * Helper to count direct and transitive dependencies
 */
function getDependencyCounts(
  deps: Dependency[],
  includeTransitive: boolean = true
): { direct: number; transitive: number } {
  // Use scope-aware keys so monorepo workspaces don't collapse duplicate packages
  const uniqueDeps = new Map<string, Dependency>();

  const makeKey = (dep: Dependency) => {
    const scope = dep.packageRoot || dep.workspaceFolder || '';
    return `${dep.name}@${dep.version}@${scope}`;
  };

  const traverse = (list: Dependency[]) => {
    for (const dep of list) {
      // Skip internal workspace packages to match dashboard metrics
      if (dep.isInternal) {
        continue;
      }
      const key = makeKey(dep);
      if (!uniqueDeps.has(key)) {
        uniqueDeps.set(key, dep);
      }
      if (includeTransitive && dep.children) {
        traverse(dep.children);
      }
    }
  };

  traverse(deps);

  let direct = 0;
  let transitive = 0;
  for (const dep of uniqueDeps.values()) {
    if (dep.isTransitive) {
      transitive++;
    } else {
      direct++;
    }
  }
  return { direct, transitive };
}

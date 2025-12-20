import * as vscode from 'vscode';
import type { DashboardController } from '../ui/DashboardController';
import { Logger, NetworkStatusService } from '../utils';
import { ConfigurationEnforcer } from './ConfigurationEnforcer';

/**
 * Sets up the configuration change listener to handle settings updates
 */
export function setupConfigurationListener(
  context: vscode.ExtensionContext,
  disposables: vscode.Disposable[],
  getDashboardController: () => DashboardController | undefined,
  initializeServices: (
    context: vscode.ExtensionContext,
    options?: { preserveDashboard?: boolean; llmOnly?: boolean }
  ) => void
): void {
  Logger.getInstance().info(`Setting up configuration change listener...`);

  // Track the current effective source to prevent redundant scans
  let currentEffectiveSource = vscode.workspace
    .getConfiguration('depPulse.vulnerabilityDetection')
    .get<'osv' | 'github'>('primarySource', 'osv');

  // Debounce timer for LLM model updates (keys are now secrets-only)
  let llmUpdateTimer: NodeJS.Timeout | undefined;
  // Debounce timer for service reinitialization to prevent multiple rapid reinitializations
  let reinitTimer: NodeJS.Timeout | null = null;
  // Track whether dashboard is visible so we can restore after re-init
  const isDashboardVisible = () => getDashboardController()?.isVisible() ?? false;

  const configListener = vscode.workspace.onDidChangeConfiguration(async (event) => {
    Logger.getInstance().info(`DepPulse configuration changed`);

    // Log every relevant setting change with its current value
    const watchedKeys = [
      'depPulse.analysis',
      'depPulse.analysis.strategy',
      'depPulse.analysis.autoScanOnStartup',
      'depPulse.analysis.scanOnSave',
      'depPulse.analysis.enableCache',
      'depPulse.vulnerabilityDetection.primarySource',
      'depPulse.api.openRouterModel',
      'depPulse.api.openaiModel',
      'depPulse.api.geminiModel',
      'depPulse.healthScore.weights',
      'depPulse.freshness.unmaintainedThresholdDays',
      'depPulse.freshness.majorVersionGracePeriodDays',
    ];

    for (const key of watchedKeys) {
      if (event.affectsConfiguration(key)) {
        const value = vscode.workspace.getConfiguration().get(key);
        const isSensitive =
          key.includes('ApiKey') || key.includes('githubToken') || key.endsWith('Token');
        const safeValue = isSensitive ? '<redacted>' : JSON.stringify(value);
        Logger.getInstance().info(`Setting changed: ${key} -> ${safeValue}`);
      }
    }

    // Handle health score weight changes
    if (event.affectsConfiguration('depPulse.healthScore.weights')) {
      Logger.getInstance().info(`Health score weights changed`);

      // Get new weights
      const config = vscode.workspace.getConfiguration('depPulse.healthScore.weights');
      const security = config.get<number>('security', 0.4);
      const freshness = config.get<number>('freshness', 0.3);
      const compatibility = config.get<number>('compatibility', 0.2);
      const license = config.get<number>('license', 0.1);

      Logger.getInstance().info(
        `New weights - Security: ${security}, Freshness: ${freshness}, Compatibility: ${compatibility}, License: ${license}`
      );

      // Reload health score calculator weights
      // Note: HealthScoreCalculator reads from config on each calculate() call,
      // so no explicit reload needed. Just re-trigger analysis.

      // Re-trigger analysis to apply new weights
      Logger.getInstance().info(`Re-triggering analysis to apply new weights...`);
      vscode.commands.executeCommand('depPulse.scan');
    }

    // Handle analysis settings changes
    if (event.affectsConfiguration('depPulse.analysis')) {
      Logger.getInstance().info(`Analysis settings changed`);

      const config = vscode.workspace.getConfiguration('depPulse.analysis');
      const autoScanOnStartup = config.get<boolean>('autoScanOnStartup', true);
      const scanOnSave = config.get<boolean>('scanOnSave', true);

      Logger.getInstance().info(
        `New settings - Auto-scan: ${autoScanOnStartup}, Scan on save: ${scanOnSave}`
      );

      // If scanOnSave changed, we need to re-setup the file watcher
      // For simplicity in MVP, we'll just log this
      // In a full implementation, we would dynamically enable/disable the watcher
      if (event.affectsConfiguration('depPulse.analysis.scanOnSave')) {
        Logger.getInstance().info(`Scan on save setting changed - restart extension to apply`);
        vscode.window.showInformationMessage(
          'DepPulse: Restart VS Code to apply scan on save setting change'
        );
      }
    }

    // If enableCache changed, notify dashboard
    if (event.affectsConfiguration('depPulse.analysis.enableCache')) {
      const config = vscode.workspace.getConfiguration('depPulse.analysis');
      const enabled = config.get<boolean>('enableCache', true);
      Logger.getInstance().info(`Cache setting changed to: ${enabled}`);

      const dashboardController = getDashboardController();
      if (dashboardController) {
        // Update controller's internal state first
        dashboardController.setCacheEnabled(enabled);

        // Then notify webview
        dashboardController.sendMessage({
          type: 'cacheStatusChanged',
          data: { enabled },
        });
      }
    }

    // Handle vulnerability detection settings changes
    if (event.affectsConfiguration('depPulse.vulnerabilityDetection.primarySource')) {
      Logger.getInstance().info(`Vulnerability detection settings changed`);

      const config = vscode.workspace.getConfiguration('depPulse.vulnerabilityDetection');
      const primarySource = config.get<'osv' | 'github'>('primarySource', 'osv');

      // Check if the source actually changed effectively
      if (primarySource === currentEffectiveSource) {
        Logger.getInstance().info(
          `Source unchanged (${primarySource}), skipping re-initialization.`
        );
        return;
      }

      const revertPrimarySource = async () => {
        const inspect = config.inspect('primarySource');
        let target: vscode.ConfigurationTarget | undefined;
        if (inspect?.workspaceFolderValue !== undefined) {
          target = vscode.ConfigurationTarget.WorkspaceFolder;
        } else if (inspect?.workspaceValue !== undefined) {
          target = vscode.ConfigurationTarget.Workspace;
        } else if (inspect?.globalValue !== undefined) {
          target = vscode.ConfigurationTarget.Global;
        }

        try {
          await config.update('primarySource', currentEffectiveSource, target);
          Logger.getInstance().info(
            `Reverted primarySource to ${currentEffectiveSource} (target: ${target ?? 'default'})`
          );
        } catch (err) {
          Logger.getInstance().error('Failed to revert primarySource after invalid change', err);
        }
      };

      const inspect = config.inspect('primarySource');
      Logger.getInstance().debug(
        `DEBUG: Inspect primarySource: Global=${inspect?.globalValue}, Workspace=${inspect?.workspaceValue}, WorkspaceFolder=${inspect?.workspaceFolderValue}, Default=${inspect?.defaultValue}`
      );
      Logger.getInstance().debug(`DEBUG: Resolved primarySource: ${primarySource}`);

      // If switching to GitHub while offline, surface offline notice first
      if (primarySource === 'github') {
        const networkService = NetworkStatusService.getInstance();
        networkService.reset();
        const isOnline = await networkService.checkConnectivity();
        if (!isOnline) {
          Logger.getInstance().warn(
            'Offline detected while switching to GitHub source. Prompting user to reconnect.'
          );
          vscode.window.showErrorMessage(
            'DepPulse: You are offline. Connect to the internet to validate your GitHub token and switch to GitHub Advisory.'
          );
          // Revert to previous effective source (likely OSV)
          await revertPrimarySource();
          return;
        }
      }

      // Enforce GitHub token requirement if GitHub is selected as source (only when online)
      if (primarySource === 'github') {
        const enforcer = new ConfigurationEnforcer(Logger.getInstance().getOutputChannel());
        const isValid = await enforcer.enforceGitHubToken();
        if (!isValid) {
          Logger.getInstance().warn(
            `Aborting switch to GitHub due to invalid token. Keeping previous source active.`
          );
          await revertPrimarySource();
          return;
        }
      }

      // Update effective source
      currentEffectiveSource = primarySource;
      Logger.getInstance().info(`New source selected: ${primarySource}`);

      // Reinitialize services to use new settings (no debounce to satisfy immediate switch)
      if (reinitTimer) {
        clearTimeout(reinitTimer);
      }
      Logger.getInstance().info(`Reinitializing services with new vulnerability settings...`);
      initializeServices(context);
      reinitTimer = null;

      // Re-trigger analysis with cache bypass to ensure fresh data from new source
      Logger.getInstance().info(
        `Re-triggering analysis (bypassCache: true) to apply new vulnerability settings...`
      );

      // Notify dashboard that we are fetching live data
      const dashboardController = getDashboardController();
      if (dashboardController) {
        // We can't easily force "Live" tag directly without a scan result,
        // but the scan will update it shortly.
        // We could send a message to clear current results or show loading.
      }

      vscode.commands.executeCommand('depPulse.scan', { bypassCache: true });
    }

    // Handle LLM (alternatives) settings changes
    if (
      event.affectsConfiguration('depPulse.api.openRouterModel') ||
      event.affectsConfiguration('depPulse.api.openaiModel') ||
      event.affectsConfiguration('depPulse.api.geminiModel')
    ) {
      Logger.getInstance().info(`LLM configuration changed (debouncing...)`);

      if (llmUpdateTimer) {
        clearTimeout(llmUpdateTimer);
      }

      llmUpdateTimer = setTimeout(() => {
        const wasVisible = isDashboardVisible();
        Logger.getInstance().info(`Reinitializing services with new LLM configuration...`);
        initializeServices(context, { preserveDashboard: true, llmOnly: true });
        if (wasVisible) {
          Logger.getInstance().info(`Restoring dashboard visibility after LLM config change`);
          vscode.commands.executeCommand('depPulse.showDashboard');
        }
      }, 500);
    }

    // Handle freshness settings changes
    if (
      event.affectsConfiguration('depPulse.freshness.unmaintainedThresholdDays') ||
      event.affectsConfiguration('depPulse.freshness.majorVersionGracePeriodDays')
    ) {
      Logger.getInstance().info(`Freshness settings changed`);

      const config = vscode.workspace.getConfiguration('depPulse.freshness');
      const unmaintainedThresholdDays = config.get<number>('unmaintainedThresholdDays', 730);
      const majorVersionGracePeriodDays = config.get<number>('majorVersionGracePeriodDays', 90);

      Logger.getInstance().info(
        `New settings - Unmaintained threshold: ${unmaintainedThresholdDays} days, Grace period: ${majorVersionGracePeriodDays} days`
      );

      // Debounce service reinitialization
      if (reinitTimer) {
        clearTimeout(reinitTimer);
      }
      reinitTimer = setTimeout(() => {
        // Reinitialize services to use new freshness configuration
        Logger.getInstance().info(`Reinitializing services with new freshness configuration...`);
        initializeServices(context);
        reinitTimer = null;
      }, 500);

      // Re-trigger analysis
      Logger.getInstance().info(`Re-triggering analysis to apply new freshness settings...`);
      vscode.commands.executeCommand('depPulse.scan');
    }
  });

  disposables.push(configListener);
  Logger.getInstance().info(`Configuration change listener set up successfully`);
}

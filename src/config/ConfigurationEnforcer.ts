import * as vscode from 'vscode';
import { GitHubAdvisoryClient } from '../api/GitHubAdvisoryClient';
import { getGitHubToken } from '../utils/SecretCache';

/**
 * Enforces configuration constraints for DepPulse
 */
export class ConfigurationEnforcer {
  private isValidatingGitHub = false;

  constructor(private readonly outputChannel: vscode.OutputChannel) {}

  /**
   * Enforces that a valid GitHub token is present if GitHub is selected as the primary source.
   * If not, it reverts the setting to 'osv' and shows a warning.
   */
  public async enforceGitHubToken(): Promise<boolean> {
    // Prevent re-entrant validation
    if (this.isValidatingGitHub) {
      return true;
    }

    this.isValidatingGitHub = true;

    try {
      const vulnConfig = vscode.workspace.getConfiguration('depPulse.vulnerabilityDetection');
      const primarySource = vulnConfig.get<'osv' | 'github'>('primarySource', 'osv');

      // Only check if GitHub is selected
      if (primarySource !== 'github') {
        return true;
      }

      const githubToken = getGitHubToken();

      let shouldRevert = false;
      let revertReason = '';

      if (!githubToken || githubToken.trim() === '') {
        shouldRevert = true;
        revertReason = 'GitHub scanning enabled without token';
      } else {
        // Validate token
        this.outputChannel.appendLine(`[${new Date().toISOString()}] Validating GitHub token...`);
        const tempClient = new GitHubAdvisoryClient(this.outputChannel, githubToken);
        const isValid = await tempClient.validateToken();

        if (!isValid) {
          shouldRevert = true;
          revertReason = 'Invalid GitHub token';
        } else {
          this.outputChannel.appendLine(
            `[${new Date().toISOString()}] GitHub token validated successfully`
          );
        }
      }

      if (shouldRevert) {
        await this.revertToOSV(vulnConfig, revertReason);
        return false;
      }

      return true;
    } catch (error) {
      this.outputChannel.appendLine(
        `[${new Date().toISOString()}] Error enforcing GitHub token: ${error}`
      );
      return false;
    } finally {
      this.isValidatingGitHub = false;
    }
  }

  /**
   * Reverts the primary source setting to 'osv' and shows a warning
   */
  private async revertToOSV(_config: vscode.WorkspaceConfiguration, reason: string): Promise<void> {
    const timestamp = new Date().toISOString();
    this.outputChannel.appendLine(`[${timestamp}] ERROR: ${reason}. Reverting setting.`);

    // Determine target to update based on where the value is defined
    const inspect = _config.inspect('primarySource');
    let target: vscode.ConfigurationTarget | undefined;

    if (inspect?.workspaceFolderValue !== undefined) {
      target = vscode.ConfigurationTarget.WorkspaceFolder;
    } else if (inspect?.workspaceValue !== undefined) {
      target = vscode.ConfigurationTarget.Workspace;
    } else if (inspect?.globalValue !== undefined) {
      target = vscode.ConfigurationTarget.Global;
    }

    // Only update if we found a defined target
    if (target !== undefined) {
      this.outputChannel.appendLine(`[${timestamp}] Reverting setting at target: ${target}`);
      await _config.update('primarySource', 'osv', target);
    } else {
      this.outputChannel.appendLine(`[${timestamp}] No explicit setting found to revert.`);
    }

    // Show warning modal
    const message =
      'GitHub integration requires a valid Personal Access Token. Please configure your token using “DepPulse: Configure API Secrets”.';

    vscode.window
      .showErrorMessage(message, { modal: true }, 'Configure Secrets')
      .then((selection) => {
        if (selection === 'Configure Secrets') {
          vscode.commands.executeCommand('depPulse.configureSecrets');
        }
      });
  }
}

import axios from 'axios';
import type * as vscode from 'vscode';
import {
  type CompatibilityAnalysis,
  type CompatibilityIssue,
  type Dependency,
  DepPulseError,
  type FreshnessAnalysis,
  type PackageInfo,
  type PackageRegistryClient,
  type UpgradeWarning,
} from '../types';

/**
 * Analyzes dependencies for compatibility issues
 * Detects deprecated versions and breaking changes in major version upgrades
 */
export class CompatibilityAnalyzer {
  private registryClient: PackageRegistryClient;
  private outputChannel: vscode.OutputChannel;

  constructor(registryClient: PackageRegistryClient, outputChannel: vscode.OutputChannel) {
    this.registryClient = registryClient;
    this.outputChannel = outputChannel;
  }

  /**
   * Analyzes a dependency for compatibility issues
   * @param dependency The dependency to analyze
   * @param packageInfo Optional pre-fetched package info (to avoid duplicate API calls)
   * @param freshnessAnalysis Optional freshness analysis for context (to detect major version gaps)
   * @returns Compatibility analysis results including status and issues
   */
  async analyze(
    dependency: Dependency,
    packageInfo?: PackageInfo,
    freshnessAnalysis?: FreshnessAnalysis
  ): Promise<CompatibilityAnalysis> {
    if (dependency.isInternal) {
      return {
        status: 'safe',
        issues: [],
      };
    }

    this.log('info', `Analyzing compatibility for ${dependency.name}@${dependency.version}`);

    try {
      const issues: CompatibilityIssue[] = [];
      const upgradeWarnings: UpgradeWarning[] = [];

      // Check version-specific deprecation
      const deprecationMessage = await this.checkVersionDeprecation(
        dependency.name,
        dependency.version
      );

      if (deprecationMessage) {
        issues.push({
          type: 'version-deprecated',
          severity: 'critical',
          message: deprecationMessage,
          affectedVersions: dependency.version,
          recommendation: 'Update to a non-deprecated version',
        });
      }

      // Check for breaking changes in major version upgrades
      if (freshnessAnalysis) {
        const breakingChangeInfo = await this.checkBreakingChanges(
          dependency,
          freshnessAnalysis,
          deprecationMessage,
          packageInfo
        );

        if (breakingChangeInfo) {
          issues.push(breakingChangeInfo.issue);
          if (breakingChangeInfo.warning) {
            upgradeWarnings.push(breakingChangeInfo.warning);
          }
        }
      }

      // Determine overall status
      let status: CompatibilityAnalysis['status'] = 'safe';
      if (issues.some((issue) => issue.type === 'version-deprecated')) {
        status = 'version-deprecated';
      } else if (issues.some((issue) => issue.type === 'breaking-change')) {
        status = 'breaking-changes';
      } else if (issues.length === 0) {
        status = 'safe';
      } else {
        status = 'unknown';
      }

      const analysis: CompatibilityAnalysis = {
        status,
        issues,
        upgradeWarnings: upgradeWarnings.length > 0 ? upgradeWarnings : undefined,
      };

      if (status !== 'safe') {
        this.log(
          'warn',
          `${dependency.name}@${dependency.version} has compatibility issues: ${status}`
        );
      } else {
        this.log('info', `${dependency.name}@${dependency.version} is compatible`);
      }

      return analysis;
    } catch (error: unknown) {
      // Log error but don't fail the entire analysis
      this.log(
        'error',
        `Failed to analyze compatibility for ${dependency.name}@${dependency.version}`,
        error
      );

      // Return unknown status on error (graceful degradation)
      if (error instanceof DepPulseError && error.recoverable) {
        return {
          status: 'unknown',
          issues: [],
        };
      }

      throw error;
    }
  }

  /**
   * Checks if a specific version is deprecated
   * @param packageName The package name
   * @param version The version to check
   * @returns Deprecation message if version is deprecated, null otherwise
   */
  private async checkVersionDeprecation(
    packageName: string,
    version: string
  ): Promise<string | null> {
    try {
      const deprecationMessage = await this.registryClient.getVersionDeprecationStatus(
        packageName,
        version
      );
      return deprecationMessage;
    } catch (error: unknown) {
      // Log but don't fail - version deprecation check is optional
      this.log('warn', `Failed to check version deprecation for ${packageName}@${version}`, error);
      return null;
    }
  }

  /**
   * Checks for breaking changes in major version upgrades
   * @param dependency The dependency to check
   * @param freshnessAnalysis Freshness analysis containing version gap information
   * @param deprecationMessage Optional deprecation message for current version
   * @param packageInfo Optional package info containing repository URL
   * @returns Compatibility issue and upgrade warning if breaking changes detected
   */
  private async checkBreakingChanges(
    dependency: Dependency,
    freshnessAnalysis: FreshnessAnalysis,
    deprecationMessage: string | null,
    packageInfo?: PackageInfo
  ): Promise<{ issue: CompatibilityIssue; warning?: UpgradeWarning } | null> {
    // Only flag breaking changes for major version gaps that are outdated
    if (
      freshnessAnalysis.versionGap === 'major' &&
      freshnessAnalysis.isOutdated &&
      !freshnessAnalysis.maintenanceSignals?.isLongTermUnmaintained
    ) {
      const migrationGuideUrl = await this.getMigrationGuideUrl(
        dependency.name,
        freshnessAnalysis.latestVersion,
        packageInfo
      );

      const issue: CompatibilityIssue = {
        type: 'breaking-change',
        severity: 'high',
        message: `Major version upgrade available (${dependency.version} → ${freshnessAnalysis.latestVersion}). Major versions typically include breaking changes.`,
        affectedVersions: `${dependency.version} → ${freshnessAnalysis.latestVersion}`,
        recommendation: `Review changelog before upgrading to ${freshnessAnalysis.latestVersion}`,
        migrationGuide: migrationGuideUrl,
      };

      const warning: UpgradeWarning = {
        breakingChange: 'Major version upgrade',
        description: `Upgrading ${dependency.name} from ${dependency.version} to ${freshnessAnalysis.latestVersion} may introduce breaking changes. Major version updates typically include API changes, removed features, or other incompatibilities.`,
        migrationGuide: migrationGuideUrl,
      };

      return { issue, warning };
    }

    // If version is deprecated and there's a major version available, it's more critical
    if (
      deprecationMessage &&
      freshnessAnalysis.versionGap === 'major' &&
      freshnessAnalysis.isOutdated
    ) {
      const migrationGuideUrl = await this.getMigrationGuideUrl(
        dependency.name,
        freshnessAnalysis.latestVersion,
        packageInfo
      );

      const issue: CompatibilityIssue = {
        type: 'breaking-change',
        severity: 'critical',
        message: `Current version is deprecated and major upgrade available. ${deprecationMessage}`,
        affectedVersions: dependency.version,
        recommendation: `Upgrade to ${freshnessAnalysis.latestVersion} (may require code changes)`,
        migrationGuide: migrationGuideUrl,
      };

      return { issue };
    }

    return null;
  }

  /**
   * Validates if a URL is accessible by making a HEAD request
   * @param url The URL to validate
   * @returns true if URL is accessible (status 200-399), false otherwise
   */
  private async validateUrl(url: string): Promise<boolean> {
    try {
      // Use HEAD request to check if URL exists without downloading content
      const response = await axios.head(url, { timeout: 5000, maxRedirects: 5 });
      const isValid = response.status >= 200 && response.status < 400;
      if (!isValid) {
        this.log('warn', `URL validation failed for ${url}: status ${response.status}`);
      }
      return isValid;
    } catch (error) {
      // URL is invalid or inaccessible
      this.log(
        'warn',
        `URL validation error for ${url}: ${error instanceof Error ? error.message : String(error)}`
      );
      return false;
    }
  }

  /**
   * Generates a potential migration guide URL with dynamic validation
   * Tries multiple URL sources and validates each before returning
   * @param packageName The package name
   * @param targetVersion The target version
   * @param packageInfo Optional package info containing repository URL
   * @returns Migration guide URL that is validated and accessible
   */
  private async getMigrationGuideUrl(
    packageName: string,
    targetVersion: string,
    packageInfo?: PackageInfo
  ): Promise<string> {
    const candidates: string[] = [];

    // Try GitHub releases if repository info available
    if (packageInfo?.repository) {
      const repoUrl = this.normalizeRepositoryUrl(packageInfo.repository);
      const githubInfo = this.extractGitHubInfo(repoUrl);
      if (githubInfo) {
        candidates.push(
          `https://github.com/${githubInfo.owner}/${githubInfo.repo}/releases/tag/v${targetVersion}`,
          `https://github.com/${githubInfo.owner}/${githubInfo.repo}/releases/tag/${targetVersion}`
        );
      }
    }

    // Try npm version-specific page
    candidates.push(`https://www.npmjs.com/package/${packageName}/v/${targetVersion}`);

    // Try npm main page (most reliable fallback)
    candidates.push(`https://www.npmjs.com/package/${packageName}`);

    // Validate each candidate and return first valid one
    for (const url of candidates) {
      this.log('info', `Validating migration guide URL candidate: ${url}`);
      if (await this.validateUrl(url)) {
        this.log('info', `Migration guide URL validated: ${url}`);
        return url;
      }
    }

    // Final fallback: npm main page (even if validation failed, it's most likely to work)
    this.log(
      'warn',
      `All migration guide URL candidates failed validation, using fallback: ${candidates[candidates.length - 1]}`
    );
    return candidates[candidates.length - 1];
  }

  /**
   * Normalizes a repository URL to a clean format
   * @param url The raw repository URL
   * @returns The normalized URL
   */
  private normalizeRepositoryUrl(url: string): string {
    if (!url) {
      return '';
    }

    // Remove git+ prefix
    let cleanUrl = url.replace(/^git\+/, '');

    // Remove .git suffix
    cleanUrl = cleanUrl.replace(/\.git$/, '');

    // Handle ssh://git@github.com style
    cleanUrl = cleanUrl.replace(/^ssh:\/\/git@/, 'https://');

    // Handle git@github.com:user/repo style
    cleanUrl = cleanUrl.replace(/^git@([^:]+):/, 'https://$1/');

    return cleanUrl;
  }

  /**
   * Extracts GitHub owner and repo from a repository URL
   * @param repoUrl The repository URL
   * @returns Object with owner and repo, or null if not a GitHub URL
   */
  private extractGitHubInfo(repoUrl: string): { owner: string; repo: string } | null {
    if (!repoUrl) {
      return null;
    }

    try {
      const url = new URL(repoUrl);
      if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') {
        return null;
      }

      const segments = url.pathname.split('/').filter(Boolean);
      if (segments.length < 2) {
        return null;
      }

      return {
        owner: segments[0],
        repo: segments[1],
      };
    } catch {
      // If URL parsing fails, try regex matching
      const match = repoUrl.match(/github\.com[/:]([^/]+)\/([^/]+)/);
      if (match) {
        return {
          owner: match[1],
          repo: match[2].replace(/\.git$/, ''),
        };
      }
    }

    return null;
  }

  /**
   * Logs messages to the output channel
   */
  private log(level: 'info' | 'warn' | 'error', message: string, data?: unknown): void {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${level.toUpperCase()}] CompatibilityAnalyzer: ${message}`;
    this.outputChannel.appendLine(logMessage);

    if (data) {
      this.outputChannel.appendLine(JSON.stringify(data, null, 2));
    }
  }
}

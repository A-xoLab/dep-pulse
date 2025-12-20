import * as semver from 'semver';
import type * as vscode from 'vscode';
import {
  type Dependency,
  DepPulseError,
  type FreshnessAnalysis,
  type MaintenanceReason,
  type MaintenanceSignals,
  type PackageInfo,
  type PackageRegistryClient,
} from '../types';

/**
 * Analyzes dependencies for version freshness and maintenance status
 * Compares installed versions with latest available versions
 */
export class FreshnessAnalyzer {
  private registryClient: PackageRegistryClient;
  private outputChannel: vscode.OutputChannel;
  private unmaintainedThresholdDays: number;
  private majorVersionGracePeriodDays: number;
  private static readonly README_PATTERNS = [
    /project\s+is\s+deprecated/i,
    /no\s+longer\s+maintained/i,
    /unmaintained/i,
    // Version-specific deprecation patterns
    /version\s+[\d.]+.*(?:deprecated|no longer|unmaintained|use\s+version\s+[\d.]+)/i,
    /(?:package|project|library).*version\s+[\d.]+.*(?:deprecated|no longer maintained|unmaintained)/i,
    // End of life patterns
    /end\s+of\s+life/i,
    /\bEOL\b/i,
  ];

  constructor(
    registryClient: PackageRegistryClient,
    outputChannel: vscode.OutputChannel,
    config?: { unmaintainedThresholdDays?: number; majorVersionGracePeriodDays?: number }
  ) {
    this.registryClient = registryClient;
    this.outputChannel = outputChannel;
    this.unmaintainedThresholdDays = config?.unmaintainedThresholdDays ?? 730; // 2 years default
    this.majorVersionGracePeriodDays = config?.majorVersionGracePeriodDays ?? 90; // 90 days default
  }

  /**
   * Analyzes a dependency for version freshness
   * @param dependency The dependency to analyze
   * @param packageInfo Optional pre-fetched package info (to avoid duplicate API calls)
   * @returns Freshness analysis results including version gap and maintenance status
   */
  async analyze(dependency: Dependency, packageInfo?: PackageInfo): Promise<FreshnessAnalysis> {
    if (dependency.isInternal) {
      return {
        currentVersion: dependency.version,
        latestVersion: dependency.version,
        versionGap: 'current',
        releaseDate: new Date(),
        isOutdated: false,
        isUnmaintained: false,
      };
    }
    this.log('info', `Analyzing freshness for ${dependency.name}@${dependency.version}`);

    try {
      // Fetch package info if not provided
      let pkgInfo = packageInfo;
      if (!pkgInfo) {
        pkgInfo = await this.getPackageInfo(dependency.name);
      }

      // Resolve "latest" version to actual version if needed
      let resolvedVersion = dependency.version;
      const cleanedVersion = this.cleanVersion(dependency.version);
      if (cleanedVersion.toLowerCase() === 'latest' || cleanedVersion === '') {
        this.log(
          'info',
          `Resolving "latest" version for ${dependency.name} to actual version ${pkgInfo.version}`
        );
        resolvedVersion = pkgInfo.version;
      }

      // Clean the current version for comparison
      const currentVersion = this.cleanVersion(resolvedVersion);
      const latestVersion = pkgInfo.version;

      // Validate versions
      if (!semver.valid(currentVersion)) {
        this.log('warn', `Invalid current version: ${resolvedVersion} for ${dependency.name}`);
        return this.createUnknownAnalysis(resolvedVersion, latestVersion, pkgInfo.publishedAt);
      }

      if (!semver.valid(latestVersion)) {
        this.log('warn', `Invalid latest version: ${latestVersion} for ${dependency.name}`);
        return this.createUnknownAnalysis(resolvedVersion, latestVersion, pkgInfo.publishedAt);
      }

      // Calculate outdated status with grace period
      const outdatedStatus = this.calculateOutdatedStatus(
        currentVersion,
        latestVersion,
        pkgInfo.publishedAt
      );

      // Build maintenance signals (deprecated, archived, README notices)
      const maintenanceSignals = await this.buildMaintenanceSignals(pkgInfo, currentVersion);

      // Check if unmaintained (no update in configured threshold, default: 730 days / 2 years)
      const isUnmaintained =
        this.checkUnmaintained(pkgInfo.publishedAt) || maintenanceSignals.isLongTermUnmaintained;

      const analysis: FreshnessAnalysis = {
        currentVersion: resolvedVersion,
        latestVersion,
        versionGap: outdatedStatus.reason,
        releaseDate: pkgInfo.publishedAt,
        isOutdated: outdatedStatus.isOutdated,
        isUnmaintained,
        maintenanceSignals,
      };

      if (outdatedStatus.isOutdated) {
        this.log(
          'info',
          `${dependency.name} is outdated: ${currentVersion} → ${latestVersion} (${outdatedStatus.reason} gap)`
        );
      } else if (outdatedStatus.gracePeriodActive) {
        this.log(
          'info',
          `${dependency.name} has newer major version but within grace period: ${currentVersion} → ${latestVersion}`
        );
      } else {
        this.log('info', `${dependency.name} is up to date at ${currentVersion}`);
      }

      if (isUnmaintained) {
        this.log(
          'warn',
          `${dependency.name} appears unmaintained (last update: ${pkgInfo.publishedAt.toISOString()})`
        );
      }

      return analysis;
    } catch (error: unknown) {
      // Log error but don't fail the entire analysis
      const resolvedVersion =
        this.cleanVersion(dependency.version).toLowerCase() === 'latest'
          ? 'latest'
          : dependency.version;
      this.log(
        'error',
        `Failed to analyze freshness for ${dependency.name}@${resolvedVersion}`,
        error
      );

      // Return default analysis on error (graceful degradation)
      if (error instanceof DepPulseError && error.recoverable) {
        return {
          currentVersion: resolvedVersion,
          latestVersion: resolvedVersion,
          versionGap: 'current',
          releaseDate: new Date(),
          isOutdated: false,
          isUnmaintained: false,
        };
      }

      throw error;
    }
  }

  /**
   * Fetches package info directly from registry
   */
  private async getPackageInfo(packageName: string): Promise<PackageInfo> {
    // Fetch from registry
    this.log('info', `Fetching package info from registry for ${packageName}`);
    const packageInfo = await this.registryClient.getPackageInfo(packageName);

    return packageInfo;
  }

  /**
   * Cleans a version string to make it semver-compatible
   * Removes common prefixes and suffixes
   */
  private cleanVersion(version: string): string {
    // Remove common prefixes like ^, ~, >=, <=, >, <, =
    let cleaned = version.replace(/^[\^~>=<]+/, '');

    // Remove any whitespace
    cleaned = cleaned.trim();

    // If version has a range (e.g., "1.0.0 - 2.0.0"), take the first part
    if (cleaned.includes(' - ')) {
      cleaned = cleaned.split(' - ')[0].trim();
    }

    // If version has || (OR), take the first part
    if (cleaned.includes('||')) {
      cleaned = cleaned.split('||')[0].trim();
    }

    return cleaned;
  }

  /**
   * Calculates the version gap between current and latest versions
   * Uses semver.diff to determine if it's a major, minor, or patch difference
   */
  private calculateVersionGap(
    currentVersion: string,
    latestVersion: string
  ): 'major' | 'minor' | 'patch' | 'current' {
    // Compare versions
    const comparison = semver.compare(currentVersion, latestVersion);

    // If current is same or newer, return 'current'
    if (comparison >= 0) {
      return 'current';
    }

    // Use semver.diff to determine the type of difference
    const diff = semver.diff(currentVersion, latestVersion);

    if (!diff) {
      return 'current';
    }

    // Map semver diff results to our version gap types
    if (diff === 'major' || diff === 'premajor') {
      return 'major';
    }

    if (diff === 'minor' || diff === 'preminor') {
      return 'minor';
    }

    if (diff === 'patch' || diff === 'prepatch' || diff === 'prerelease') {
      return 'patch';
    }

    // Default to patch for any other differences
    return 'patch';
  }

  /**
   * Determines if package is outdated with grace period consideration
   * Major versions get a configurable grace period (default: 90 days)
   */
  private calculateOutdatedStatus(
    currentVersion: string,
    latestVersion: string,
    latestReleaseDate: Date,
    gracePeriodDays?: number
  ): {
    isOutdated: boolean;
    reason: 'patch' | 'minor' | 'major' | 'current';
    gracePeriodActive: boolean;
  } {
    const versionGap = this.calculateVersionGap(currentVersion, latestVersion);

    if (versionGap === 'current') {
      return { isOutdated: false, reason: 'current', gracePeriodActive: false };
    }

    // For major version updates, check grace period
    if (versionGap === 'major') {
      const gracePeriod = gracePeriodDays ?? this.majorVersionGracePeriodDays;
      const now = new Date();
      const daysSinceRelease =
        (now.getTime() - latestReleaseDate.getTime()) / (1000 * 60 * 60 * 24);

      if (daysSinceRelease < gracePeriod) {
        // Grace period is active, not considered outdated yet
        return { isOutdated: false, reason: 'major', gracePeriodActive: true };
      }
    }

    return { isOutdated: true, reason: versionGap, gracePeriodActive: false };
  }

  /**
   * Checks if a package is unmaintained based on last publish date
   * A package is considered unmaintained if not updated in more than the configured threshold (default: 730 days / 2 years)
   */
  private checkUnmaintained(publishedAt: Date, threshold?: number): boolean {
    const now = new Date();
    const daysSincePublish = (now.getTime() - publishedAt.getTime()) / (1000 * 60 * 60 * 24);
    const thresholdToUse = threshold ?? this.unmaintainedThresholdDays;

    return daysSincePublish > thresholdToUse;
  }

  /**
   * Creates a default analysis when version information is invalid
   */
  private createUnknownAnalysis(
    currentVersion: string,
    latestVersion: string,
    releaseDate: Date
  ): FreshnessAnalysis {
    return {
      currentVersion,
      latestVersion,
      versionGap: 'current',
      releaseDate,
      isOutdated: false,
      isUnmaintained: false,
    };
  }

  private async buildMaintenanceSignals(
    pkgInfo: PackageInfo,
    currentVersion: string
  ): Promise<MaintenanceSignals> {
    const reasons: MaintenanceReason[] = [];

    // Check version-specific deprecation first (highest priority)
    try {
      const versionDeprecationMessage = await this.registryClient.getVersionDeprecationStatus(
        pkgInfo.name,
        currentVersion
      );
      if (versionDeprecationMessage) {
        reasons.push({
          source: 'npm',
          type: 'version-deprecated',
          message: versionDeprecationMessage,
        });
      }
    } catch (error: unknown) {
      // Log but don't fail - version deprecation check is optional
      this.log(
        'warn',
        `Failed to check version deprecation for ${pkgInfo.name}@${currentVersion}`,
        error
      );
    }

    // Check package-level deprecation (latest version)
    if (pkgInfo.deprecatedMessage) {
      reasons.push({
        source: 'npm',
        type: 'deprecated',
        message: pkgInfo.deprecatedMessage,
      });
    }

    // Check README for maintenance signals (only if no version-specific deprecation found)
    // This avoids showing confusing README excerpts when we have clear npm deprecation messages
    if (reasons.length === 0) {
      const readmeExcerpt = this.extractReadmeSignal(pkgInfo.readme);
      if (readmeExcerpt) {
        reasons.push({
          source: 'readme',
          type: 'notice',
          excerpt: readmeExcerpt,
        });
      }
    }

    return {
      isLongTermUnmaintained: reasons.length > 0,
      reasons,
      lastChecked: new Date(),
    };
  }

  private extractReadmeSignal(readme?: string): string | null {
    if (!readme) {
      return null;
    }

    for (const pattern of FreshnessAnalyzer.README_PATTERNS) {
      const match = readme.match(pattern);
      if (match && match.index !== undefined) {
        // Extract larger context (150 chars before/after instead of 60)
        const start = Math.max(match.index - 150, 0);
        const end = Math.min(match.index + match[0].length + 150, readme.length);
        let excerpt = readme.substring(start, end);

        // Try to extract complete sentences by finding sentence boundaries
        const beforeMatch = readme.substring(start, match.index);
        const afterMatch = readme.substring(match.index + match[0].length, end);

        // Find last sentence boundary before match
        const lastSentenceBefore = Math.max(
          beforeMatch.lastIndexOf('.'),
          beforeMatch.lastIndexOf('!'),
          beforeMatch.lastIndexOf('?'),
          beforeMatch.lastIndexOf('\n')
        );

        // Find first sentence boundary after match
        const firstSentenceAfter = afterMatch.search(/[.!?\n]/);
        const adjustedStart = lastSentenceBefore >= 0 ? start + lastSentenceBefore + 1 : start;
        const adjustedEnd =
          firstSentenceAfter >= 0 ? match.index + match[0].length + firstSentenceAfter + 1 : end;

        excerpt = readme.substring(adjustedStart, adjustedEnd).replace(/\s+/g, ' ').trim();

        // Validate the excerpt before returning
        if (this.isValidMaintenanceSignal(excerpt)) {
          return excerpt.length > 300 ? `${excerpt.slice(0, 297)}...` : excerpt;
        }
      }
    }

    return null;
  }

  /**
   * Validates if an excerpt is a valid maintenance signal
   * Filters out false positives like API documentation examples
   */
  private isValidMaintenanceSignal(excerpt: string): boolean {
    // Must have minimum length
    if (excerpt.length < 20) {
      return false;
    }

    // Reject if it looks like a code example
    // High ratio of special characters suggests code
    const specialCharCount = (excerpt.match(/[{}();=]/g) || []).length;
    const specialCharRatio = specialCharCount / excerpt.length;
    const looksLikeCode = specialCharRatio > 0.15;

    // Reject if it contains common code patterns or API documentation
    const codePatterns = [
      /\/\/\s*For\s+/i, // Comments like "// For Bearer tokens"
      /function\s*\(/i,
      /const\s+\w+\s*=/i,
      /=>\s*{/i,
      /auth:\s*{/i, // Common in API examples
      /^\s*\/\/\s+/m, // Lines starting with // (code comments)
      /^\s*const\s+/m, // Lines starting with const
      /^\s*let\s+/m, // Lines starting with let
      /^\s*var\s+/m, // Lines starting with var
      /For\s+\w+\s+and\s+such/i, // "For Bearer tokens and such"
      /This\s+is\s+just\s+an\s+example/i, // "This is just an example"
      /use\s+['"]\w+['"]\s+custom\s+headers/i, // "use 'Authorization' custom headers"
      /how\s+to\s+use\s+the\s+API/i, // "how to use the API"
      /API\s+Documentation/i, // "API Documentation" header
      /For\s+\w+.*use.*custom\s+headers/i, // "For Bearer tokens and such, use Authorization custom headers"
      /username.*password/i, // Contains username/password (API example)
      /Bearer\s+tokens/i, // "Bearer tokens" (API example)
      /Authorization.*custom\s+headers/i, // "Authorization custom headers"
      /#\s*API\s+Documentation/i, // "# API Documentation" header
      /For\s+.*tokens.*and\s+such.*use/i, // "For Bearer tokens and such, use"
      /custom\s+headers\s+instead/i, // "custom headers instead" (API example)
    ];
    const containsCodePattern = codePatterns.some((pattern) => pattern.test(excerpt));

    // If it looks like code, reject immediately
    if (looksLikeCode || containsCodePattern) {
      return false;
    }

    // Additional check: If excerpt contains "use" but no maintenance keywords, and has API-related terms, reject
    const hasUseWithoutMaintenance =
      /\buse\b/i.test(excerpt) &&
      !/deprecated|unmaintained|no longer maintained|end of life|EOL/i.test(excerpt) &&
      /\b(custom\s+headers|Authorization|Bearer|API|example)\b/i.test(excerpt);

    if (hasUseWithoutMaintenance) {
      return false;
    }

    // Check for deprecation/maintenance keywords
    const maintenanceKeywords = [
      'deprecated',
      'unmaintained',
      'no longer maintained',
      'end of life',
      'EOL',
      'end-of-life',
    ];
    const hasMaintenanceKeyword = maintenanceKeywords.some((keyword) =>
      excerpt.toLowerCase().includes(keyword)
    );

    // Check for version numbers (indicating version-specific deprecation)
    // But only if it's in context of deprecation/maintenance
    const hasVersionNumber = /\b\d+\.\d+\.\d+\b/.test(excerpt);
    const versionInMaintenanceContext =
      hasVersionNumber &&
      (hasMaintenanceKeyword ||
        /version\s+[\d.]+.*(?:deprecated|no longer|unmaintained|use\s+version)/i.test(excerpt));

    // Valid if it has maintenance keywords or version numbers in maintenance context, and doesn't look like code
    return hasMaintenanceKeyword || versionInMaintenanceContext;
  }

  /**
   * Logs messages to the output channel
   */
  private log(level: 'info' | 'warn' | 'error', message: string, data?: unknown): void {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${level.toUpperCase()}] FreshnessAnalyzer: ${message}`;
    this.outputChannel.appendLine(logMessage);

    if (data) {
      this.outputChannel.appendLine(JSON.stringify(data, null, 2));
    }
  }
}

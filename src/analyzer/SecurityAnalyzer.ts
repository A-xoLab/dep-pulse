import * as semver from 'semver';
import type * as vscode from 'vscode';
import {
  type Dependency,
  DepPulseError,
  type SecurityAnalysis,
  type Vulnerability,
  type VulnerabilityAggregator,
  type VulnerabilityClient,
} from '../types';

/**
 * Analyzes dependencies for security vulnerabilities
 * Uses vulnerability databases to identify known security issues
 * Supports both single-source (VulnerabilityClient) and multi-source (VulnerabilityAggregator)
 */
export class SecurityAnalyzer {
  private vulnerabilitySource: VulnerabilityClient | VulnerabilityAggregator;
  private outputChannel: vscode.OutputChannel;
  private useAggregator: boolean;

  constructor(
    vulnerabilitySource: VulnerabilityClient | VulnerabilityAggregator,
    outputChannel: vscode.OutputChannel
  ) {
    this.vulnerabilitySource = vulnerabilitySource;
    this.outputChannel = outputChannel;

    // Check if source is an aggregator (has configureSources method)
    this.useAggregator = 'configureSources' in vulnerabilitySource;

    if (this.useAggregator) {
      this.log('info', 'SecurityAnalyzer initialized with VulnerabilityAggregator (multi-source)');
    } else {
      this.log('info', 'SecurityAnalyzer initialized with VulnerabilityClient (single-source)');
    }
  }

  /**
   * Optimizes connection pool for vulnerability clients based on project size
   * Should be called before starting batch analysis
   * @param totalDependencies Total number of dependencies in project
   */
  optimizeConnectionPool(totalDependencies: number): void {
    if (this.useAggregator) {
      const aggregator = this.vulnerabilitySource as VulnerabilityAggregator & {
        optimizeConnectionPool?: (size: number) => void;
      };
      if (aggregator.optimizeConnectionPool) {
        aggregator.optimizeConnectionPool(totalDependencies);
      }
    } else {
      const client = this.vulnerabilitySource as VulnerabilityClient & {
        optimizeConnectionPool?: (size: number) => void;
      };
      if (client.optimizeConnectionPool) {
        client.optimizeConnectionPool(totalDependencies);
      }
    }
  }

  /**
   * Analyzes a dependency for security vulnerabilities
   * @param dependency The dependency to analyze
   * @returns Security analysis results including vulnerabilities and severity
   */
  async analyze(dependency: Dependency, bypassCache: boolean = false): Promise<SecurityAnalysis> {
    if (dependency.isInternal) {
      return { vulnerabilities: [], severity: 'none' };
    }

    // Resolve "latest" version to actual version if needed
    const resolvedVersion = dependency.version;
    const cleanedVersion = this.cleanVersion(dependency.version);
    if (cleanedVersion.toLowerCase() === 'latest' || cleanedVersion === '') {
      this.log(
        'warn',
        `Package ${dependency.name} uses "latest" version - vulnerability analysis may be incomplete. Consider using a specific version.`
      );
      // For "latest", we'll still try to analyze but note that version filtering won't work
      // The vulnerability source should handle this appropriately
    }

    this.log('info', `Analyzing security for ${dependency.name}@${resolvedVersion}`);

    try {
      // Fetch vulnerabilities directly from the vulnerability source (client or aggregator)
      this.log(
        'info',
        `Fetching vulnerabilities from ${this.useAggregator ? 'aggregator' : 'client'} for ${dependency.name}@${resolvedVersion}`
      );

      const allVulnerabilities: Vulnerability[] = this.useAggregator
        ? await (this.vulnerabilitySource as VulnerabilityAggregator).getAggregatedVulnerabilities(
            dependency.name,
            resolvedVersion,
            bypassCache
          )
        : await (this.vulnerabilitySource as VulnerabilityClient).getVulnerabilities(
            dependency.name,
            resolvedVersion,
            bypassCache
          );

      // Early filtering: Filter vulnerabilities that affect the current version
      // This reduces memory allocation and processing for non-applicable vulnerabilities
      const affectingVulnerabilities = this.filterAffectingVulnerabilities(
        allVulnerabilities,
        resolvedVersion,
        dependency.name
      );

      // Determine overall severity
      const overallSeverity = this.calculateOverallSeverity(affectingVulnerabilities);

      const analysis: SecurityAnalysis = {
        vulnerabilities: affectingVulnerabilities,
        severity: overallSeverity,
      };

      if (affectingVulnerabilities.length > 0) {
        this.log(
          'warn',
          `Found ${affectingVulnerabilities.length} vulnerabilities for ${dependency.name}@${resolvedVersion} (severity: ${overallSeverity})`
        );
      } else {
        this.log('info', `No vulnerabilities found for ${dependency.name}@${resolvedVersion}`);
      }

      return analysis;
    } catch (error: unknown) {
      // Log error but don't fail the entire analysis
      this.log(
        'error',
        `Failed to analyze security for ${dependency.name}@${resolvedVersion}`,
        error
      );

      // Return empty analysis on error (graceful degradation)
      if (error instanceof DepPulseError && error.recoverable) {
        return {
          vulnerabilities: [],
          severity: 'none',
        };
      }

      throw error;
    }
  }

  /**
   * Analyzes multiple dependencies for security vulnerabilities in batch
   * @param dependencies Array of dependencies to analyze
   * @returns Map of package names to their security analysis results
   */
  async analyzeBatch(
    dependencies: Dependency[],
    bypassCache: boolean = false
  ): Promise<Map<string, SecurityAnalysis>> {
    this.log('info', `Analyzing security for ${dependencies.length} dependencies in batch mode`);

    const results = new Map<string, SecurityAnalysis>();
    const externalDependencies = dependencies.filter((dep) => !dep.isInternal);

    // Short-circuit internal deps with empty vulnerability results
    for (const dep of dependencies) {
      if (dep.isInternal) {
        results.set(dep.name, {
          vulnerabilities: [],
          severity: 'none',
        });
      }
    }

    try {
      // Check if vulnerability source supports batch operations
      const supportsBatch = this.useAggregator
        ? typeof (this.vulnerabilitySource as VulnerabilityAggregator)
            .getBatchAggregatedVulnerabilities === 'function'
        : typeof (this.vulnerabilitySource as VulnerabilityClient).getBatchVulnerabilities ===
          'function';

      if (supportsBatch) {
        this.log('info', 'Using batch vulnerability fetching');

        // Fetch all vulnerabilities in batch
        let batchVulnerabilities: Map<string, Vulnerability[]>;

        if (this.useAggregator) {
          const aggregator = this.vulnerabilitySource as VulnerabilityAggregator;
          if (aggregator.getBatchAggregatedVulnerabilities) {
            // Aggregator returns AggregatedVulnerability[], but they extend Vulnerability
            const aggregatedResults = await aggregator.getBatchAggregatedVulnerabilities(
              externalDependencies,
              bypassCache
            );
            batchVulnerabilities = aggregatedResults as Map<string, Vulnerability[]>;
          } else {
            throw new Error('Batch method not available on aggregator');
          }
        } else {
          const client = this.vulnerabilitySource as VulnerabilityClient;
          if (client.getBatchVulnerabilities) {
            batchVulnerabilities = await client.getBatchVulnerabilities(
              externalDependencies,
              bypassCache
            );
          } else {
            throw new Error('Batch method not available on client');
          }
        }

        // Process each dependency
        for (const dep of externalDependencies) {
          const allVulnerabilities = batchVulnerabilities.get(dep.name) || [];

          // Resolve "latest" version if needed
          const resolvedVersion = dep.version;
          const cleanedVersion = this.cleanVersion(dep.version);
          if (cleanedVersion.toLowerCase() === 'latest' || cleanedVersion === '') {
            // For batch mode, we can't resolve "latest" individually, so we'll skip version filtering
            this.log(
              'warn',
              `Package ${dep.name} uses "latest" version - vulnerability filtering may be incomplete`
            );
          }

          // Early filtering: Filter vulnerabilities that affect the current version before full processing
          // This reduces memory allocation and processing for non-applicable vulnerabilities
          const affectingVulnerabilities = this.filterAffectingVulnerabilities(
            allVulnerabilities,
            resolvedVersion,
            dep.name
          );

          // Determine overall severity
          const overallSeverity = this.calculateOverallSeverity(affectingVulnerabilities);

          const analysis: SecurityAnalysis = {
            vulnerabilities: affectingVulnerabilities,
            severity: overallSeverity,
          };

          results.set(dep.name, analysis);

          if (affectingVulnerabilities.length > 0) {
            this.log(
              'warn',
              `Found ${affectingVulnerabilities.length} vulnerabilities for ${dep.name}@${resolvedVersion} (severity: ${overallSeverity})`
            );
          }
        }
      } else {
        // Fallback to individual analysis
        this.log('info', 'Batch not supported, falling back to individual analysis');
        for (const dep of dependencies) {
          const analysis = await this.analyze(dep);
          results.set(dep.name, analysis);
        }
      }

      this.log('info', `Batch security analysis complete for ${results.size} dependencies`);
      return results;
    } catch (error: unknown) {
      this.log('error', 'Batch security analysis failed', error);

      // Return empty analysis for all dependencies on complete failure
      for (const dep of dependencies) {
        results.set(dep.name, {
          vulnerabilities: [],
          severity: 'none',
        });
      }
      return results;
    }
  }

  /**
   * Filters vulnerabilities to only those affecting the specified version
   * Uses semver to match version ranges with improved accuracy
   */
  private filterAffectingVulnerabilities(
    vulnerabilities: Vulnerability[],
    version: string,
    packageName: string
  ): Vulnerability[] {
    const cleanVersion = this.cleanVersion(version);

    if (!semver.valid(cleanVersion)) {
      this.log('warn', `Invalid semver version: ${version}, cannot filter vulnerabilities`);
      // Return all vulnerabilities if we can't parse the version
      return vulnerabilities;
    }

    return vulnerabilities.filter((vuln) => {
      return this.isVersionAffected(cleanVersion, vuln.affectedVersions, vuln.id, packageName);
    });
  }

  /**
   * Checks if a version is affected by a vulnerability using proper semver range matching
   * Implements early exit optimizations to skip expensive parsing when possible
   * @param installedVersion Clean semver version (e.g., "4.17.1")
   * @param affectedRange Version range from vulnerability database
   * @param vulnId Vulnerability ID for logging
   * @returns true if the version is affected
   */
  private isVersionAffected(
    installedVersion: string,
    affectedRange: string,
    vulnId: string,
    _packageName: string
  ): boolean {
    // Early exit: If no range specified, assume it affects this version (safe default)
    if (!affectedRange || affectedRange.trim() === '' || affectedRange === 'Unknown') {
      return true;
    }

    // Early exit: Quick check for obviously non-matching ranges (e.g., ">= 5.0.0" when version is "1.0.0")
    // This is a heuristic optimization - we'll still do full parsing for accuracy
    const trimmedRange = affectedRange.trim();

    // Skip expensive parsing for clearly invalid or malformed ranges early
    if (trimmedRange.length > 5000) {
      // Very long ranges are likely malformed - skip expensive parsing
      this.log(
        'warn',
        `Suspiciously long version range for ${vulnId} (length: ${trimmedRange.length}), skipping`
      );
      return false;
    }

    try {
      // Normalize the version range to handle different database formats
      const normalizedRange = this.normalizeVersionRange(affectedRange);

      // Use semver.satisfies to check if version is in affected range
      const isAffected = semver.satisfies(installedVersion, normalizedRange);

      // Only log when affected to reduce logging overhead
      if (isAffected) {
        this.log(
          'info',
          `Version ${installedVersion} is affected by ${vulnId} (range: ${affectedRange})`
        );
      }

      return isAffected;
    } catch (error) {
      // If we can't parse the range, include the vulnerability to be safe
      this.log(
        'warn',
        `Failed to parse version range "${affectedRange}" for ${vulnId}, including vulnerability to be safe`,
        error
      );
      return true;
    }
  }

  /**
   * Normalizes version ranges from different database formats to semver format
   * Handles:
   * - GitHub: "< 4.17.2", ">= 4.0.0"
   * - NVD: "4.0.0 to 4.17.1", ">=4.0.0 <=4.17.1"
   * - Snyk: "[4.0.0, 4.17.2)", ">=4.0.0 <4.17.2"
   */
  private normalizeVersionRange(range: string): string {
    let normalized = range.trim();

    // Handle NVD "X to Y" format
    if (normalized.includes(' to ')) {
      const parts = normalized.split(' to ');
      if (parts.length === 2) {
        normalized = `>=${parts[0].trim()} <=${parts[1].trim()}`;
      }
    }

    // Handle Snyk interval notation: [X, Y) means >=X <Y
    if (normalized.match(/^\[.*,.*\)$/)) {
      const inner = normalized.slice(1, -1); // Remove [ and )
      const parts = inner.split(',').map((p) => p.trim());
      if (parts.length === 2) {
        normalized = `>=${parts[0]} <${parts[1]}`;
      }
    }

    // Handle Snyk interval notation: (X, Y] means >X <=Y
    if (normalized.match(/^\(.*,.*\]$/)) {
      const inner = normalized.slice(1, -1); // Remove ( and ]
      const parts = inner.split(',').map((p) => p.trim());
      if (parts.length === 2) {
        normalized = `>${parts[0]} <=${parts[1]}`;
      }
    }

    // Handle Snyk interval notation: [X, Y] means >=X <=Y
    if (normalized.match(/^\[.*,.*\]$/)) {
      const inner = normalized.slice(1, -1); // Remove [ and ]
      const parts = inner.split(',').map((p) => p.trim());
      if (parts.length === 2) {
        normalized = `>=${parts[0]} <=${parts[1]}`;
      }
    }

    // Handle Snyk interval notation: (X, Y) means >X <Y
    if (normalized.match(/^\(.*,.*\)$/)) {
      const inner = normalized.slice(1, -1); // Remove ( and )
      const parts = inner.split(',').map((p) => p.trim());
      if (parts.length === 2) {
        normalized = `>${parts[0]} <${parts[1]}`;
      }
    }

    // Ensure proper spacing around operators (but don't double-space)
    // First, replace commas with spaces (GitHub uses commas)
    normalized = normalized.replace(/,/g, ' ');

    // Then remove any existing spaces around operators
    normalized = normalized
      .replace(/\s*>=\s*/g, '>=')
      .replace(/\s*<=\s*/g, '<=')
      .replace(/\s*>\s*/g, '>')
      .replace(/\s*<\s*/g, '<');

    // Then add single spaces where needed
    normalized = normalized
      .replace(/>=(\S)/g, '>=$1')
      .replace(/<=(\S)/g, '<=$1')
      .replace(/>(\S)/g, '>$1')
      .replace(/<(\S)/g, '<$1')
      .replace(/(\d+)([<>])/g, '$1 $2'); // Add space between version and next operator

    return normalized;
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
   * Calculates the overall severity based on the highest severity found
   * Priority: critical > high > medium > low > none
   */
  private calculateOverallSeverity(
    vulnerabilities: Vulnerability[]
  ): 'critical' | 'high' | 'medium' | 'low' | 'none' {
    if (vulnerabilities.length === 0) {
      return 'none';
    }

    // Check for each severity level in order of priority
    const hasCritical = vulnerabilities.some((v) => v.severity === 'critical');
    if (hasCritical) {
      return 'critical';
    }

    const hasHigh = vulnerabilities.some((v) => v.severity === 'high');
    if (hasHigh) {
      return 'high';
    }

    const hasMedium = vulnerabilities.some((v) => v.severity === 'medium');
    if (hasMedium) {
      return 'medium';
    }

    const hasLow = vulnerabilities.some((v) => v.severity === 'low');
    if (hasLow) {
      return 'low';
    }

    // Default to medium if we have vulnerabilities but no recognized severity
    return 'medium';
  }

  /**
   * Logs messages to the output channel
   */
  private log(level: 'info' | 'warn' | 'error', message: string, data?: unknown): void {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${level.toUpperCase()}] SecurityAnalyzer: ${message}`;
    this.outputChannel.appendLine(logMessage);

    if (data) {
      this.outputChannel.appendLine(JSON.stringify(data, null, 2));
    }
  }
}

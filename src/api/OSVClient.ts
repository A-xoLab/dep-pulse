import { Agent as HttpsAgent } from 'node:https';
import { Cvss2, Cvss3P0, Cvss3P1, Cvss4P0 } from 'ae-cvss-calculator';
import type * as vscode from 'vscode';
import type {
  Dependency,
  OSVBatchRequest,
  OSVBatchResponse,
  OSVVulnerability,
  Vulnerability,
  VulnerabilityClient,
} from '../types';
import type { CacheManager } from '../utils/CacheManager';
import { BaseAPIClient } from './APIClient';

/**
 * Client for interacting with the OSV.dev (Open Source Vulnerabilities) API
 * Fetches vulnerability information using HTTP/2 batch queries
 */
export class OSVClient extends BaseAPIClient implements VulnerabilityClient {
  // Cache for CVSS scores by vector string to avoid recalculating
  private cvssScoreCache = new Map<string, number | null>();
  // Cache for vulnerability details by ID to avoid redundant fetches
  private vulnerabilityCache = new Map<string, Vulnerability>();
  private currentMaxSockets: number = 10;
  private cacheManager?: CacheManager;

  constructor(outputChannel: vscode.OutputChannel, cacheManager?: CacheManager) {
    // Increase default concurrency to 50 to speed up large batch processing
    // OSV.dev handles concurrent requests well
    super('https://api.osv.dev', outputChannel, 30000, 50);
    this.cacheManager = cacheManager;

    // Configure HTTP/2 agent with matching pool size
    this.updateConnectionPool(50);

    this.axiosInstance.defaults.headers.common['User-Agent'] = 'DepPulse-VSCode-Extension';

    this.log('info', 'OSVClient initialized with HTTP/2 support');
    this.log('info', 'OSVClient initialized (Version: Hybrid-Batching-Enabled)');
  }

  /**
   * Determines optimal connection pool size based on project size
   * Small projects (10-50 deps): 10 connections
   * Mid projects (50-200 deps): 25 connections
   * Large projects (200+ deps): 50 connections
   * @param totalDependencies Total number of dependencies in project
   * @returns Optimal connection pool size
   */
  getOptimalConnectionPoolSize(totalDependencies: number): number {
    if (totalDependencies <= 50) {
      return 10; // Small projects
    } else if (totalDependencies <= 200) {
      return 25; // Mid projects
    } else {
      return 50; // Large projects
    }
  }

  /**
   * Updates HTTP/2 connection pool settings
   * Recreates the agent with new maxSockets value
   * @param maxSockets Maximum number of sockets in the connection pool
   */
  updateConnectionPool(maxSockets: number): void {
    this.currentMaxSockets = maxSockets;

    // Configure HTTP/2 agent with updated settings
    const http2Agent = new HttpsAgent({
      // Enable HTTP/2
      ALPNProtocols: ['h2', 'http/1.1'],
      keepAlive: true,
      keepAliveMsecs: 30000,
      maxSockets,
    });

    // Update axios instance with new HTTP/2 agent
    this.axiosInstance.defaults.httpsAgent = http2Agent;

    this.log('info', `HTTP/2 connection pool updated: maxSockets=${maxSockets}`);
  }

  /**
   * Optimizes connection pool based on project size
   * Should be called before starting analysis for a project
   * @param totalDependencies Total number of dependencies in project
   */
  optimizeConnectionPool(totalDependencies: number): void {
    const optimalSize = this.getOptimalConnectionPoolSize(totalDependencies);
    if (optimalSize !== this.currentMaxSockets) {
      this.updateConnectionPool(optimalSize);
    }
  }

  /**
   * Gets vulnerabilities for a specific package and version
   * Uses batch method internally for consistency
   */
  async getVulnerabilities(
    packageName: string,
    version: string,
    bypassCache: boolean = false
  ): Promise<Vulnerability[]> {
    this.log('info', `Fetching vulnerabilities from OSV for ${packageName}@${version}`);

    // Use batch method with single package for consistency
    const dependency: Dependency = {
      name: packageName,
      version,
      versionConstraint: version,
      isDev: false,
    };

    const batchResults = await this.getBatchVulnerabilities([dependency], bypassCache);
    const vulnerabilities = batchResults.get(packageName) || [];

    this.log(
      'info',
      `Found ${vulnerabilities.length} vulnerabilities from OSV for ${packageName}@${version}`
    );

    return vulnerabilities;
  }

  /**
   * Gets vulnerabilities for multiple packages using "Hybrid Batching" strategy
   * Step 1: Query /v1/querybatch to get Vulnerability IDs (lightweight, single request)
   * Step 2: Fetch full details for unique IDs using /v1/vulns/{id} (cached)
   */
  async getBatchVulnerabilities(
    dependencies: Dependency[],
    bypassCache: boolean = false
  ): Promise<Map<string, Vulnerability[]>> {
    if (dependencies.length === 0) {
      return new Map();
    }

    // Clear caches if force refresh is requested
    if (bypassCache) {
      this.log('info', 'Force refresh requested - clearing OSV client caches');
      this.vulnerabilityCache.clear();
      this.cvssScoreCache.clear();
      if (this.cacheManager) {
        await this.cacheManager.clearOSVCache();
      }
    }

    this.log(
      'info',
      `Fetching vulnerabilities from OSV for ${dependencies.length} packages (Hybrid Batching)`
    );

    const results = new Map<string, Vulnerability[]>();
    const depsToFetch: Dependency[] = [];

    // Step 0: Check Persistent Cache (L2)
    if (this.cacheManager && !bypassCache) {
      for (const dep of dependencies) {
        const cachedVulns = await this.cacheManager.getCachedOSVVulnerabilities(
          dep.name,
          dep.version
        );
        if (cachedVulns) {
          results.set(dep.name, cachedVulns);
        } else {
          depsToFetch.push(dep);
        }
      }
    } else {
      depsToFetch.push(...dependencies);
    }

    if (depsToFetch.length === 0) {
      this.log('info', 'All dependencies found in persistent cache');
      return results;
    }

    if (depsToFetch.length < dependencies.length) {
      this.log(
        'info',
        `Resolved ${dependencies.length - depsToFetch.length} dependencies from persistent cache`
      );
    }

    const uniqueVulnIds = new Set<string>();
    const packageToVulnIds = new Map<string, string[]>();

    // Step 1: Batch Query for IDs (only for missing deps)
    try {
      const batchResponse = await this.executeBatchRequest(depsToFetch);

      if (!batchResponse.results || batchResponse.results.length !== depsToFetch.length) {
        this.log('warn', 'OSV batch response length mismatch, falling back to empty results');
        // Initialize empty results for all dependencies to avoid crashes
        for (const dep of depsToFetch) {
          results.set(dep.name, []);
        }
        return results;
      }

      // Map results to packages and collect unique IDs
      for (let i = 0; i < depsToFetch.length; i++) {
        const dep = depsToFetch[i];
        const result = batchResponse.results[i];
        const ids: string[] = [];

        if (result.vulns) {
          for (const vuln of result.vulns) {
            if (vuln.id) {
              ids.push(vuln.id);
              uniqueVulnIds.add(vuln.id);
            }
          }
        }
        packageToVulnIds.set(dep.name, ids);
      }
    } catch (error) {
      this.log('error', 'Failed to execute OSV batch query', error);
      // Fallback: Return empty map (or could throw depending on error policy)
      for (const dep of depsToFetch) {
        results.set(dep.name, []);
      }
      return results;
    }

    this.log(
      'info',
      `Found ${uniqueVulnIds.size} unique vulnerabilities across ${depsToFetch.length} packages`
    );

    // Step 2: Fetch Details for Unique IDs (with Caching)
    const vulnDetailsMap = new Map<string, Vulnerability>();
    const idsToFetch: string[] = [];

    for (const id of uniqueVulnIds) {
      const cachedVuln = this.vulnerabilityCache.get(id);
      if (cachedVuln) {
        vulnDetailsMap.set(id, cachedVuln);
      } else {
        idsToFetch.push(id);
      }
    }

    if (idsToFetch.length > 0) {
      this.log('info', `Fetching details for ${idsToFetch.length} new vulnerabilities`);

      // Fetch details in parallel with concurrency limit
      // We rely on BaseAPIClient's RequestQueue to handle concurrency
      const detailPromises = idsToFetch.map(async (id) => {
        try {
          const vuln = await this.getVulnerabilityById(id);
          if (vuln) {
            this.vulnerabilityCache.set(id, vuln);
            return { id, vuln };
          }
        } catch (error) {
          this.log('warn', `Failed to fetch details for vulnerability ${id}`, error);
        }
        return null;
      });

      const detailResults = await Promise.all(detailPromises);

      for (const res of detailResults) {
        if (res) {
          vulnDetailsMap.set(res.id, res.vuln);
        }
      }
    } else {
      this.log('info', 'All vulnerability details found in in-memory cache');
    }

    // Step 3: Map Details back to Packages and Cache to L2
    for (const dep of depsToFetch) {
      const ids = packageToVulnIds.get(dep.name) || [];
      const packageVulns: Vulnerability[] = [];

      for (const id of ids) {
        const details = vulnDetailsMap.get(id);
        if (details) {
          packageVulns.push(details);
        }
      }

      results.set(dep.name, packageVulns);

      // Cache to Persistent Storage (L2)
      if (this.cacheManager) {
        // Fire and forget - don't await to avoid slowing down response
        // Track cache failures for monitoring
        this.cacheManager
          .cacheOSVVulnerabilities(dep.name, dep.version, packageVulns)
          .catch((err) => {
            this.log('warn', `Failed to cache vulnerabilities for ${dep.name}@${dep.version}`, err);
            // Log additional context for persistent failures
            if (err instanceof Error) {
              this.log('debug', `Cache error details: ${err.message}`, { stack: err.stack });
            }
            // Consider: Add retry mechanism or user notification for persistent failures
          });
      }
    }

    const totalVulnerabilities = Array.from(results.values()).reduce(
      (sum, vulns) => sum + vulns.length,
      0
    );
    this.log(
      'info',
      `OSV Hybrid Batching complete: ${results.size} packages processed, ${totalVulnerabilities} vulnerabilities found`
    );

    return results;
  }

  /**
   * Fetches full details for a single vulnerability by ID
   */
  private async getVulnerabilityById(id: string): Promise<Vulnerability | null> {
    try {
      const osvVuln = await this.get<OSVVulnerability>(`/v1/vulns/${id}`, { timeout: 10000 });
      // We don't have package name context here, but it's less critical for the generic Vulnerability object
      // The convert method uses it mainly for logging or specific edge cases
      return this.convertOSVVulnerability(osvVuln, 'unknown');
    } catch (error) {
      this.log('warn', `Failed to fetch vulnerability ${id}`, error);
      return null;
    }
  }

  /**
   * Builds the request body for OSV batch query
   * We INCLUDE version now because we only want IDs relevant to the installed version.
   */
  private buildBatchRequestBody(dependencies: Dependency[]): OSVBatchRequest {
    return {
      queries: dependencies.map((dep) => ({
        package: {
          name: dep.name,
          ecosystem: 'npm',
        },
        version: dep.version,
      })),
    };
  }

  /**
   * Creates batches of dependencies based on size limit
   * Used for splitting large dependency sets into manageable chunks
   * @param dependencies Array of dependencies to batch
   * @param maxBatchSize Maximum number of dependencies per batch
   * @returns Array of dependency batches
   */
  public createBatches(dependencies: Dependency[], maxBatchSize: number): Dependency[][] {
    const batches: Dependency[][] = [];
    for (let i = 0; i < dependencies.length; i += maxBatchSize) {
      batches.push(dependencies.slice(i, i + maxBatchSize));
    }
    return batches;
  }

  /**
   * Executes a batch request to OSV.dev
   * Uses HTTP/2 POST to /v1/querybatch
   */
  private async executeBatchRequest(batch: Dependency[]): Promise<OSVBatchResponse> {
    const requestBody = this.buildBatchRequestBody(batch);
    const requestSize = JSON.stringify(requestBody).length;

    this.log('info', `Executing OSV batch request: ${batch.length} packages, ${requestSize} bytes`);

    const startTime = Date.now();
    const response = await this.post<OSVBatchResponse, OSVBatchRequest>(
      '/v1/querybatch',
      requestBody,
      {
        timeout: 30000,
      }
    );
    const duration = Date.now() - startTime;

    this.log('info', `OSV batch request completed in ${duration}ms`);

    return response;
  }

  /**
   * Converts OSV vulnerability to internal format
   * Extracts and calculates CVSS data
   */
  private convertOSVVulnerability(osvVuln: OSVVulnerability, _packageName: string): Vulnerability {
    // Extract ID (prefer CVE from aliases, fallback to OSV ID)
    let id = osvVuln.id;
    if (osvVuln.aliases) {
      const cveId = osvVuln.aliases.find((alias) => alias.startsWith('CVE-'));
      if (cveId) {
        id = cveId;
      }
    }

    // Get best CVSS data
    const cvssData = this.selectBestCVSS(osvVuln);

    // Normalize severity
    const severity = this.normalizeSeverity(osvVuln, cvssData?.score);

    // Convert affected ranges
    const affectedVersions = this.convertAffectedRanges(osvVuln.affected);

    // Extract references
    const references = osvVuln.references?.map((ref) => ref.url) || [];

    // Parse dates
    const publishedDate = osvVuln.published ? new Date(osvVuln.published) : undefined;
    const lastModifiedDate = osvVuln.modified ? new Date(osvVuln.modified) : undefined;

    return {
      id,
      title: osvVuln.summary,
      description: osvVuln.details,
      severity,
      cvssScore: cvssData?.score,
      cvssVersion: cvssData?.version,
      vectorString: cvssData?.vectorString,
      affectedVersions,
      references,
      publishedDate,
      lastModifiedDate,
      cweIds: osvVuln.database_specific?.cwe_ids,
      sources: ['osv'],
    };
  }

  /**
   * Selects the best CVSS data from OSV severity array
   * Prioritizes v4.0 > v3.1 > v3.0 > v2.0
   */
  private selectBestCVSS(
    osvVuln: OSVVulnerability
  ): { version: string; vectorString: string; score?: number } | null {
    if (!osvVuln.severity || osvVuln.severity.length === 0) {
      return null;
    }

    // Helper function to determine exact version from vector string
    const getExactVersion = (severity: { type: string; score: string }): string => {
      const vectorString = severity.score;
      if (vectorString.startsWith('CVSS:4.0/')) {
        return '4.0';
      } else if (vectorString.startsWith('CVSS:3.1/')) {
        return '3.1';
      } else if (vectorString.startsWith('CVSS:3.0/')) {
        return '3.0';
      } else if (severity.type === 'CVSS_V2') {
        return '2.0';
      }
      return '3.0'; // default
    };

    // Priority order: v4.0 > v3.1 > v3.0 > v2.0
    const versionPriority: Record<string, number> = {
      '4.0': 4,
      '3.1': 3,
      '3.0': 2,
      '2.0': 1,
    };

    // Sort by exact version priority (highest first)
    const sorted = [...osvVuln.severity].sort((a, b) => {
      const versionA = getExactVersion(a);
      const versionB = getExactVersion(b);
      const priorityA = versionPriority[versionA] || 0;
      const priorityB = versionPriority[versionB] || 0;
      return priorityB - priorityA;
    });

    const best = sorted[0];
    const vectorString = best.score;
    const version = getExactVersion(best);

    // Calculate score if not provided
    const score = this.calculateCVSSScore(vectorString, version);

    return { version, vectorString, score: score || undefined };
  }

  /**
   * Calculates CVSS base score from vector string
   * Uses ae-cvss-calculator library
   * Caches results by vector string to avoid redundant calculations
   */
  private calculateCVSSScore(vectorString: string, version: string): number | null {
    // Validate input
    if (!vectorString || vectorString.trim() === '') {
      return null;
    }

    // Check cache first
    const cacheKey = `${version}:${vectorString}`;
    if (this.cvssScoreCache.has(cacheKey)) {
      return this.cvssScoreCache.get(cacheKey) ?? null;
    }

    try {
      let score: number | null = null;

      switch (version) {
        case '2.0': {
          const result = new Cvss2(vectorString).calculateScores();
          score = result.base ?? result.overall;
          break;
        }
        case '3.0': {
          const result = new Cvss3P0(vectorString).calculateScores();
          score = result.base ?? result.overall;
          break;
        }
        case '3.1': {
          const result = new Cvss3P1(vectorString).calculateScores();
          score = result.base ?? result.overall;
          break;
        }
        case '4.0': {
          const result = new Cvss4P0(vectorString).calculateScores();
          score = result.base ?? result.overall;
          break;
        }
        default:
          this.log('warn', `Unknown CVSS version: ${version}`);
          // Cache null for unknown versions to avoid retrying
          this.cvssScoreCache.set(cacheKey, null);
          return null;
      }

      // Store in cache
      this.cvssScoreCache.set(cacheKey, score);

      if (score !== null) {
        this.log(
          'info',
          `Calculated CVSS v${version} score ${score.toFixed(1)} from vector: ${vectorString.substring(0, 40)}...`
        );
      }

      return score;
    } catch (error) {
      this.log('error', `Failed to calculate CVSS score for vector: ${vectorString}`, error);
      // Cache null for errors to avoid retrying failed calculations
      this.cvssScoreCache.set(cacheKey, null);
      return null;
    }
  }

  /**
   * Clear CVSS score cache
   * Useful for testing or memory management
   */
  public clearCVSSCache(): void {
    this.cvssScoreCache.clear();
    this.log('info', 'CVSS score cache cleared');
  }

  /**
   * Get CVSS cache statistics
   * @returns Cache size and hit rate information
   */
  public getCVSSCacheStats(): { size: number } {
    return {
      size: this.cvssScoreCache.size,
    };
  }

  /**
   * Normalizes OSV severity to internal format
   * Handles CVSS scores and qualitative severity
   */
  private normalizeSeverity(osvVuln: OSVVulnerability, cvssScore?: number): string {
    // Primary: Use CVSS score if available
    if (cvssScore !== undefined) {
      if (cvssScore >= 9.0) return 'critical';
      if (cvssScore >= 7.0) return 'high';
      if (cvssScore >= 4.0) return 'medium';
      return 'low';
    }

    // Fallback: Use qualitative severity
    const qualitativeSeverity = osvVuln.database_specific?.severity;
    if (qualitativeSeverity) {
      switch (qualitativeSeverity.toUpperCase()) {
        case 'CRITICAL':
          return 'critical';
        case 'HIGH':
          return 'high';
        case 'MODERATE':
          return 'medium';
        case 'LOW':
          return 'low';
      }
    }

    // Default to medium if no severity information
    return 'medium';
  }

  /**
   * Converts OSV affected ranges to semver format
   */
  private convertAffectedRanges(affected: OSVVulnerability['affected']): string {
    const ranges: string[] = [];

    // Check if affected exists and is iterable
    if (!affected || !Array.isArray(affected)) {
      return '*'; // Return wildcard if affected data is missing
    }

    for (const pkg of affected) {
      if (!pkg.ranges) continue;

      for (const range of pkg.ranges) {
        if (range.type !== 'SEMVER' && range.type !== 'ECOSYSTEM') continue;

        for (const event of range.events) {
          if (event.introduced && event.fixed) {
            ranges.push(`>=${event.introduced} <${event.fixed}`);
          } else if (event.introduced && event.last_affected) {
            ranges.push(`>=${event.introduced} <=${event.last_affected}`);
          } else if (event.introduced) {
            ranges.push(`>=${event.introduced}`);
          } else if (event.fixed) {
            ranges.push(`<${event.fixed}`);
          }
        }
      }
    }

    return ranges.length > 0 ? ranges.join(' || ') : '*';
  }
}

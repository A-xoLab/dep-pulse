import { Agent as HttpsAgent } from 'node:https';
import { Cvss2, Cvss3P0, Cvss3P1, Cvss4P0 } from 'ae-cvss-calculator';
import type * as vscode from 'vscode';
import {
  type Dependency,
  DepPulseError,
  ErrorCode,
  type Vulnerability,
  type VulnerabilityClient,
} from '../types';
import type { CacheManager } from '../utils/CacheManager';
import { BaseAPIClient } from './APIClient';

/**
 * Interface for GitHub Advisory Database API response
 */
export interface GitHubAdvisoryResponse {
  ghsa_id: string;
  summary: string;
  severity: string;
  cvss?: {
    score: number;
    vector_string: string;
  };
  cwe_ids?: string[];
  identifiers: Array<{
    type: string;
    value: string;
  }>;
  references: Array<{
    url: string;
  }>;
  published_at: string;
  updated_at: string;
  withdrawn_at?: string;
  vulnerabilities: Array<{
    package: {
      ecosystem: string;
      name: string;
    };
    vulnerable_version_range?: string;
    patched_versions?: string;
    first_patched_version?: {
      identifier: string;
    };
  }>;
}

/**
 * Client for interacting with the GitHub Security Advisory Database API
 * Fetches vulnerability information for npm packages
 */
export class GitHubAdvisoryClient extends BaseAPIClient implements VulnerabilityClient {
  private static readonly OPTIMAL_BATCH_SIZE = 500;
  private static readonly MAX_AFFECTS_URL_LENGTH = 8000;

  private githubToken?: string;
  private isRateLimited = false;
  private cacheManager?: CacheManager;
  // Cache for CVSS scores by vector string to avoid recalculating
  private cvssScoreCache = new Map<string, number | null>();
  private currentMaxSockets: number = 10;

  constructor(
    outputChannel: vscode.OutputChannel,
    githubToken?: string,
    cacheManager?: CacheManager
  ) {
    super('https://api.github.com', outputChannel);
    this.githubToken = githubToken;

    // Add GitHub token to headers if provided and not empty
    if (this.githubToken && this.githubToken.trim() !== '') {
      this.axiosInstance.defaults.headers.common.Authorization = `Bearer ${this.githubToken}`;
      this.log('info', 'GitHub token configured for enhanced rate limits');
    }
    this.cacheManager = cacheManager;

    // Initialize connection pool
    this.updateConnectionPool(10);
  }

  /**
   * Determines optimal connection pool size based on project size
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
    // GitHub API supports HTTP/2
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
   * Uses the batch method internally for consistency
   * @param packageName The name of the package (e.g., 'express')
   * @param version The version of the package (e.g., '4.17.1')
   * @returns Array of vulnerabilities affecting the package version
   */
  async getVulnerabilities(
    packageName: string,
    version: string,
    bypassCache: boolean = false
  ): Promise<Vulnerability[]> {
    this.log('info', `Fetching vulnerabilities for ${packageName}@${version}`);

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
      `Found ${vulnerabilities.length} vulnerabilities for ${packageName}@${version}`
    );

    return vulnerabilities;
  }

  /**
   * Gets vulnerabilities for multiple packages in a single batch request
   * @param dependencies Array of dependencies to check
   * @returns Map of package names to their vulnerabilities
   */
  async getBatchVulnerabilities(
    dependencies: Dependency[],
    _bypassCache: boolean = false
  ): Promise<Map<string, Vulnerability[]>> {
    this.log('info', `Fetching vulnerabilities for ${dependencies.length} packages in batch mode`);

    if (dependencies.length === 0) {
      return new Map();
    }

    // Clear cache if bypass is requested
    if (_bypassCache && this.cacheManager) {
      this.log('info', 'Bypassing and clearing GitHub cache');
      await this.cacheManager.clearGitHubCache();
    }

    const results = new Map<string, Vulnerability[]>();
    const depsToFetch: Dependency[] = [];

    // Step 0: Check Persistent Cache (L2)
    if (this.cacheManager && !_bypassCache) {
      for (const dep of dependencies) {
        const cachedVulns = await this.cacheManager.getCachedGitHubVulnerabilities(
          dep.name,
          dep.version
        );
        if (cachedVulns) {
          results.set(dep.name, cachedVulns);
        } else {
          depsToFetch.push(dep);
        }
      }

      if (depsToFetch.length === 0) {
        this.log('info', `Resolved all ${dependencies.length} dependencies from persistent cache`);
        return results;
      }

      this.log(
        'info',
        `Resolved ${results.size} dependencies from persistent cache, fetching ${depsToFetch.length} from API`
      );
    } else {
      depsToFetch.push(...dependencies);
    }

    if (depsToFetch.length === 0) {
      return results;
    }

    try {
      // Create batches based on URL length and size constraints
      const batches = this.createBatches(depsToFetch, GitHubAdvisoryClient.OPTIMAL_BATCH_SIZE);
      this.log(
        'info',
        `Processing ${batches.length} batch(es) for ${depsToFetch.length} dependencies`
      );

      // Execute all batches concurrently
      const batchPromises = batches.map((batch, index) =>
        this.executeBatchRequest(batch).catch(async (error) => {
          this.log('warn', `Batch ${index + 1} failed, attempting split`, error);
          // Try splitting the batch
          try {
            const splitResults = await this.executeBatchWithSplit(batch);
            // Convert map to advisories by looking up each package
            // Since we already have the map, we'll handle this differently
            // Store the map for later merging
            return { isMap: true, data: splitResults };
          } catch (splitError) {
            this.log('warn', `Batch split also failed for batch ${index + 1}`, splitError);
            return [];
          }
        })
      );

      const batchResults = await Promise.allSettled(batchPromises);

      // Collect all advisories from successful batches and merge split results
      const allAdvisories: GitHubAdvisoryResponse[] = [];
      let successfulBatches = 0;
      let failedBatches = 0;

      for (const result of batchResults) {
        if (result.status === 'fulfilled') {
          const value = result.value;
          // Check if this is a map from split results
          if (value && typeof value === 'object' && 'isMap' in value && value.isMap) {
            // Merge the map results
            const splitMap = value.data as Map<string, Vulnerability[]>;
            for (const [pkg, vulns] of splitMap) {
              const existing = results.get(pkg);
              if (existing) {
                existing.push(...vulns);
              } else {
                results.set(pkg, vulns);
              }
            }
            successfulBatches++;
          } else if (Array.isArray(value) && value.length > 0) {
            // Regular advisory array
            allAdvisories.push(...value);
            successfulBatches++;
          } else if (Array.isArray(value)) {
            // Empty array - batch succeeded but no results
            successfulBatches++;
          }
        } else {
          failedBatches++;
          this.log('warn', 'Batch request failed completely', result.reason);
        }
      }

      // Log summary of batch results
      if (failedBatches > 0) {
        this.log(
          'warn',
          `Partial failure: ${successfulBatches} batches succeeded, ${failedBatches} batches failed`
        );
      }

      // Create a set of queried package names for mapping
      const queriedPackages = new Set(depsToFetch.map((dep) => dep.name));

      // Map advisories back to packages (for non-split results)
      if (allAdvisories.length > 0) {
        const advisoryMap = this.mapAdvisoriesToPackages(allAdvisories, queriedPackages);
        for (const [pkg, vulns] of advisoryMap) {
          const existing = results.get(pkg);
          if (existing) {
            existing.push(...vulns);
          } else {
            results.set(pkg, vulns);
          }
        }
      }

      // Ensure all queried packages have an entry (even if empty)
      for (const dep of depsToFetch) {
        if (!results.has(dep.name)) {
          results.set(dep.name, []);
        }
      }

      // Cache the new results
      if (this.cacheManager) {
        for (const dep of depsToFetch) {
          const packageVulns = results.get(dep.name) || [];
          // Fire and forget - don't await to avoid slowing down response
          this.cacheManager
            .cacheGitHubVulnerabilities(dep.name, dep.version, packageVulns)
            .catch((err) =>
              this.log('warn', `Failed to cache vulnerabilities for ${dep.name}`, err)
            );
        }
      }

      this.log(
        'info',
        `Batch vulnerability scan complete: ${results.size} packages processed, ${allAdvisories.length} advisories found`
      );

      return results;
    } catch (error: unknown) {
      this.log('error', 'Batch vulnerability scan failed', error);

      // Return empty map on complete failure (graceful degradation)
      // We still return what we have in results (from cache) merged with empty results for failed fetches
      const emptyResults = new Map<string, Vulnerability[]>(results);
      for (const dep of depsToFetch) {
        emptyResults.set(dep.name, []);
      }
      return emptyResults;
    }
  }

  /**
   * Normalizes GitHub severity levels to our standard format
   */
  private normalizeSeverity(githubSeverity: string): string {
    const severity = githubSeverity.toLowerCase();
    switch (severity) {
      case 'critical':
        return 'critical';
      case 'high':
        return 'high';
      case 'moderate':
      case 'medium':
        return 'medium';
      case 'low':
        return 'low';
      default:
        return 'medium';
    }
  }

  /**
   * Updates the GitHub token for authentication
   * @param token GitHub Personal Access Token
   */
  updateToken(token: string): void {
    this.githubToken = token;
    this.axiosInstance.defaults.headers.common.Authorization = `Bearer ${token}`;
    this.log('info', 'GitHub token updated');
  }

  /**
   * Removes the GitHub token
   */
  clearToken(): void {
    this.githubToken = undefined;
    delete this.axiosInstance.defaults.headers.common.Authorization;
    this.log('info', 'GitHub token cleared');
  }

  /**
   * Validates the current GitHub token
   * @returns true if token is valid, false otherwise
   */
  async validateToken(): Promise<boolean> {
    if (!this.githubToken) {
      return false;
    }

    try {
      // Use /user endpoint to verify token validity
      // This endpoint requires authentication, so it will fail if token is invalid
      await this.axiosInstance.get('https://api.github.com/user');
      return true;
    } catch (error: unknown) {
      if (this.isAxiosError(error) && error.response) {
        // 401 Unauthorized or 403 Forbidden indicates invalid token/permissions
        if (error.response.status === 401 || error.response.status === 403) {
          return false;
        }
      }
      // For other errors (network, etc.), assume valid to avoid disabling on temporary issues
      // or re-throw if we want strict validation
      this.log('warn', 'Error validating GitHub token', error);
      return false;
    }
  }

  /**
   * Creates batches of dependencies for batch API requests
   * Splits dependencies into chunks based on URL length and batch size constraints
   */
  private createBatches(dependencies: Dependency[], maxBatchSize: number): Dependency[][] {
    const batches: Dependency[][] = [];
    let currentBatch: Dependency[] = [];
    let currentUrlLength = 0;

    const baseUrlLength = '/advisories?per_page=100&ecosystem=npm&affects='.length;

    for (const dep of dependencies) {
      // Calculate the length this dependency would add to the URL
      // Format: packageName@version,
      const depLength = encodeURIComponent(dep.name).length + 1 + dep.version.length + 1;

      // Check if adding this dependency would exceed limits
      const wouldExceedUrlLength =
        currentUrlLength + depLength > GitHubAdvisoryClient.MAX_AFFECTS_URL_LENGTH;
      const wouldExceedBatchSize = currentBatch.length >= maxBatchSize;

      if ((wouldExceedUrlLength || wouldExceedBatchSize) && currentBatch.length > 0) {
        // Start a new batch
        batches.push(currentBatch);
        currentBatch = [];
        currentUrlLength = baseUrlLength;
      }

      currentBatch.push(dep);
      currentUrlLength += depLength;
    }

    // Add the last batch if it has any dependencies
    if (currentBatch.length > 0) {
      batches.push(currentBatch);
    }

    this.log('info', `Created ${batches.length} batches from ${dependencies.length} dependencies`);
    return batches;
  }

  /**
   * Builds the affects parameter for batch API requests
   * Format: package1@version1,package2@version2,...
   */
  private buildBatchAffectsParameter(dependencies: Dependency[]): string {
    const affects = dependencies
      .map((dep) => `${encodeURIComponent(dep.name)}@${dep.version}`)
      .join(',');

    this.log(
      'info',
      `Built affects parameter with ${dependencies.length} packages (length: ${affects.length})`
    );
    return affects;
  }

  /**
   * Parses the Link header to extract pagination cursors
   * @param linkHeader The Link header from the API response
   * @returns Object with next and prev cursor values
   */
  private parseLinkHeader(linkHeader?: string): { next?: string; prev?: string } {
    if (!linkHeader) {
      return {};
    }

    const links: { next?: string; prev?: string } = {};
    const parts = linkHeader.split(',');

    for (const part of parts) {
      const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
      if (match) {
        const url = match[1];
        const rel = match[2];

        // Extract the cursor from the URL
        const cursorMatch = url.match(/[?&]after=([^&]+)/);
        if (cursorMatch && rel === 'next') {
          links.next = cursorMatch[1];
        }

        const prevCursorMatch = url.match(/[?&]before=([^&]+)/);
        if (prevCursorMatch && rel === 'prev') {
          links.prev = prevCursorMatch[1];
        }
      }
    }

    return links;
  }

  /**
   * Maps advisories from the API response back to specific packages
   * @param advisories Array of advisories from the API
   * @param queriedPackages Set of package names that were queried
   * @returns Map of package names to their vulnerabilities
   */
  private mapAdvisoriesToPackages(
    advisories: GitHubAdvisoryResponse[],
    queriedPackages: Set<string>
  ): Map<string, Vulnerability[]> {
    const results = new Map<string, Vulnerability[]>();

    // Process each advisory
    for (const advisory of advisories) {
      // Check each vulnerability entry in the advisory
      for (const packageVuln of advisory.vulnerabilities) {
        const packageName = packageVuln.package.name;

        // Only include if this package was in our query
        if (packageVuln.package.ecosystem === 'npm' && queriedPackages.has(packageName)) {
          // Extract CVE identifier if available
          const cveIdentifier = advisory.identifiers.find((id) => id.type === 'CVE');
          const id = cveIdentifier?.value || advisory.ghsa_id;

          // Map GitHub severity to our format
          let severity = this.normalizeSeverity(advisory.severity);

          // Extract CVSS details
          let cvssScore = advisory.cvss?.score;
          const vectorString = advisory.cvss?.vector_string;
          let cvssVersion: string | undefined;

          if (vectorString) {
            // Determine CVSS version from vector string
            if (vectorString.startsWith('CVSS:4.0/')) {
              cvssVersion = '4.0';
            } else if (vectorString.startsWith('CVSS:3.1/')) {
              cvssVersion = '3.1';
            } else if (vectorString.startsWith('CVSS:3.0/')) {
              cvssVersion = '3.0';
            } else if (vectorString.startsWith('AV:')) {
              // CVSS v2 usually starts with AV: or (AV:
              cvssVersion = '2.0';
            }

            // Calculate score if missing but vector is present
            if (cvssScore === undefined || cvssScore === null || cvssScore === 0) {
              const calculatedScore = this.calculateCVSSScore(
                vectorString,
                cvssVersion || '3.1' // Default to 3.1 if unknown
              );
              if (calculatedScore !== null) {
                cvssScore = calculatedScore;
              }
            }
          }

          // Re-normalize severity if we have a score (more accurate)
          if (cvssScore !== undefined) {
            if (cvssScore >= 9.0) severity = 'critical';
            else if (cvssScore >= 7.0) severity = 'high';
            else if (cvssScore >= 4.0) severity = 'medium';
            else severity = 'low';
          }

          const vulnerability: Vulnerability = {
            id,
            title: advisory.summary,
            severity,
            cvssScore,
            cvssVersion,
            vectorString,
            affectedVersions: packageVuln.vulnerable_version_range || 'Unknown',
            patchedVersions: packageVuln.patched_versions,
            description: advisory.summary,
            references: advisory.references.map((ref) => ref.url),
            cweIds: advisory.cwe_ids,
            publishedDate: new Date(advisory.published_at),
            lastModifiedDate: new Date(advisory.updated_at),
            sources: ['github'],
          };

          // Add to results map
          const packageVulns = results.get(packageName);
          if (packageVulns) {
            packageVulns.push(vulnerability);
          } else {
            results.set(packageName, [vulnerability]);
          }
        }
      }
    }

    this.log('info', `Mapped ${advisories.length} advisories to ${results.size} packages`);

    return results;
  }

  /**
   * Executes a batch request for the given dependencies
   * Handles pagination automatically to fetch all results
   * @param batch Array of dependencies to query
   * @returns Array of advisories from the API
   */
  private async executeBatchRequest(batch: Dependency[]): Promise<GitHubAdvisoryResponse[]> {
    const affectsParam = this.buildBatchAffectsParameter(batch);
    const baseUrl = `/advisories?per_page=100&ecosystem=npm&affects=${affectsParam}`;

    this.log('info', `Executing batch request for ${batch.length} packages`);
    this.log(
      'info',
      `Request URL: ${baseUrl.substring(0, 200)}${baseUrl.length > 200 ? '...' : ''}`
    );

    // Circuit breaker: don't attempt if already rate limited
    if (this.isRateLimited) {
      this.log('warn', 'Skipping request due to active rate limit');
      return [];
    }

    try {
      // Fetch all pages of results
      const allAdvisories = await this.fetchAllPages(baseUrl);

      if (allAdvisories.length === 0) {
        this.log('info', `No vulnerabilities found for batch of ${batch.length} packages`);
        return [];
      }

      this.log(
        'info',
        `Batch request returned ${allAdvisories.length} advisories for ${batch.length} packages`
      );
      return allAdvisories;
    } catch (error: unknown) {
      // Check for Axios error to identify 403/429 specifically
      if (this.isAxiosError(error) && error.response) {
        const status = error.response.status;

        if (status === 403 || status === 401) {
          // Check if it's a rate limit error (secondary rate limit)
          const isRateLimit =
            error.response.headers['x-ratelimit-remaining'] === '0' ||
            (error.response.data && JSON.stringify(error.response.data).includes('rate limit'));

          if (isRateLimit) {
            this.log('error', 'GitHub API rate limit exceeded (403). Stopping further requests.');
            this.isRateLimited = true;
            throw new DepPulseError(
              'GitHub API rate limit exceeded',
              ErrorCode.RATE_LIMIT,
              false, // Not recoverable immediately
              { status, originalError: error }
            );
          }

          this.log(
            'error',
            `GitHub API authentication failed (${status}). Stopping further requests.`
          );
          this.isRateLimited = true; // Treat auth failure as rate limit to stop requests
          throw new DepPulseError(
            'GitHub API authentication failed',
            ErrorCode.AUTH_ERROR,
            false, // Not recoverable
            { status, originalError: error }
          );
        }

        if (status === 429) {
          this.log('error', 'GitHub API rate limit exceeded (429). Stopping further requests.');
          this.isRateLimited = true;
          throw new DepPulseError(
            'GitHub API rate limit exceeded',
            ErrorCode.RATE_LIMIT,
            false, // Not recoverable immediately
            { status, originalError: error }
          );
        }
      }

      if (error instanceof DepPulseError) {
        // Check for authentication errors
        if (error.code === ErrorCode.AUTH_ERROR) {
          this.log(
            'error',
            'GitHub API authentication failed. Please set a GitHub Personal Access Token via “DepPulse: Configure API Secrets” to enable vulnerability scanning.'
          );
          this.log(
            'info',
            'To create a token: https://github.com/settings/tokens (no scopes required for public API access)'
          );
        }
        // Check for rate limiting
        else if (error.code === ErrorCode.RATE_LIMIT) {
          this.log(
            'warn',
            'GitHub API rate limit exceeded. Consider adding a GitHub token for higher limits.'
          );
        }
        throw error;
      }

      this.log(
        'error',
        `Failed to fetch vulnerabilities for batch of ${batch.length} packages`,
        error
      );
      throw new DepPulseError(
        `Failed to fetch vulnerabilities for batch of ${batch.length} packages`,
        ErrorCode.API_ERROR,
        true,
        {
          batchSize: batch.length,
          originalError: error,
        }
      );
    }
  }

  /**
   * Executes a batch request with automatic splitting on failure
   * If a batch fails, splits it in half and retries each half
   * @param batch Array of dependencies to query
   * @returns Map of package names to their vulnerabilities
   */
  private async executeBatchWithSplit(batch: Dependency[]): Promise<Map<string, Vulnerability[]>> {
    const results = new Map<string, Vulnerability[]>();

    // Base case: single package
    if (batch.length === 1) {
      const dep = batch[0];
      this.log('warn', `Single package ${dep.name}@${dep.version} failed, returning empty result`);
      results.set(dep.name, []);
      return results;
    }

    // Split batch in half
    const midpoint = Math.floor(batch.length / 2);
    const firstHalf = batch.slice(0, midpoint);
    const secondHalf = batch.slice(midpoint);

    this.log(
      'info',
      `Splitting batch of ${batch.length} into two batches of ${firstHalf.length} and ${secondHalf.length}`
    );

    // Try each half separately
    const halfPromises = [
      this.executeBatchRequest(firstHalf).catch(async (error) => {
        if (error instanceof DepPulseError && !error.recoverable) {
          throw error;
        }
        this.log('error', `First half (${firstHalf.length} packages) failed, splitting further`);
        return this.executeBatchWithSplit(firstHalf);
      }),
      this.executeBatchRequest(secondHalf).catch(async (error) => {
        if (error instanceof DepPulseError && !error.recoverable) {
          throw error;
        }
        this.log('error', `Second half (${secondHalf.length} packages) failed, splitting further`);
        return this.executeBatchWithSplit(secondHalf);
      }),
    ];

    const [firstResult, secondResult] = await Promise.all(halfPromises);

    // Create a set of queried package names for mapping
    const queriedPackages = new Set(batch.map((dep) => dep.name));

    // Handle first half results
    if (firstResult instanceof Map) {
      // Recursive split returned a map
      for (const [pkg, vulns] of firstResult) {
        results.set(pkg, vulns);
      }
    } else if (Array.isArray(firstResult) && firstResult.length > 0) {
      // Regular advisory array
      const firstMap = this.mapAdvisoriesToPackages(firstResult, queriedPackages);
      for (const [pkg, vulns] of firstMap) {
        results.set(pkg, vulns);
      }
    }

    // Handle second half results
    if (secondResult instanceof Map) {
      // Recursive split returned a map
      for (const [pkg, vulns] of secondResult) {
        results.set(pkg, vulns);
      }
    } else if (Array.isArray(secondResult) && secondResult.length > 0) {
      // Regular advisory array
      const secondMap = this.mapAdvisoriesToPackages(secondResult, queriedPackages);
      for (const [pkg, vulns] of secondMap) {
        results.set(pkg, vulns);
      }
    }

    // Ensure all packages have an entry
    for (const dep of batch) {
      if (!results.has(dep.name)) {
        results.set(dep.name, []);
      }
    }

    return results;
  }

  /**
   * Fetches all pages of results for a given URL
   * Handles pagination using the Link header
   * @param url Initial URL to fetch
   * @returns Array of all advisories across all pages
   */
  private async fetchAllPages(url: string): Promise<GitHubAdvisoryResponse[]> {
    const allAdvisories: GitHubAdvisoryResponse[] = [];
    let currentUrl: string | undefined = url;
    let pageCount = 0;
    const maxPages = 10; // Limit to prevent infinite loops

    while (currentUrl && pageCount < maxPages) {
      pageCount++;
      this.log('info', `Fetching page ${pageCount} of results`);

      // Make request and get full response to access headers
      const config = {};
      const response = await this.axiosInstance.get<GitHubAdvisoryResponse[]>(currentUrl, config);

      const advisories = response.data;
      if (advisories && advisories.length > 0) {
        allAdvisories.push(...advisories);
        this.log('info', `Page ${pageCount} returned ${advisories.length} advisories`);
      }

      // Check for pagination
      const linkHeader = response.headers.link as string | undefined;
      const links = this.parseLinkHeader(linkHeader);

      if (links.next) {
        // Construct next URL with cursor
        const baseUrl = url.split('?')[0];
        const params = new URLSearchParams(url.split('?')[1]);
        params.set('after', links.next);
        currentUrl = `${baseUrl}?${params.toString()}`;
        this.log('info', `Found next page cursor: ${links.next}`);
      } else {
        // No more pages
        currentUrl = undefined;
        this.log('info', 'No more pages to fetch');
      }
    }

    if (pageCount >= maxPages) {
      this.log('warn', `Reached maximum page limit (${maxPages}), there may be more results`);
    }

    this.log(
      'info',
      `Fetched ${allAdvisories.length} total advisories across ${pageCount} page(s)`
    );
    return allAdvisories;
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
}

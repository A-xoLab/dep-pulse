import * as crypto from 'node:crypto';
import { TextDecoder, TextEncoder } from 'node:util';
import * as zlib from 'node:zlib';
import * as vscode from 'vscode';
import type { PackageInfo, Vulnerability } from '../types';

/**
 * Cache entry structure with optional compression
 * Uses union type to properly type compressed vs uncompressed entries
 */
type CacheEntry =
  | {
      data: Vulnerability[] | PackageInfo;
      timestamp: number;
      compressed?: false;
      compressedData?: never;
    }
  | {
      data: never; // Compressed entries have no data field
      timestamp: number;
      compressed: true;
      compressedData: string; // Base64 encoded compressed data
    };

// ... existing code ...

/**
 * CacheManager handles caching of vulnerability data with TTL support
 * Implements file-based caching for OSV vulnerability data to avoid large extension state
 * Automatically compresses cache entries larger than 10KB to reduce storage
 */
export class CacheManager {
  private vulnerabilityTTL: number;
  private bypassCacheForCritical: boolean;
  private readonly compressionThreshold = 10 * 1024; // 10KB in bytes
  private readonly cacheDirName = 'vulnerability-cache';
  private cacheDirUri: vscode.Uri;
  private initialized = false;
  private initPromise: Promise<void> | null = null; // Promise to prevent concurrent initialization
  private stats = {
    hits: 0,
    requests: 0,
  };
  private compressionStats = {
    totalCompressed: 0,
    totalUncompressed: 0,
    totalBytesSaved: 0,
  };

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: (level: string, message: string, ...args: unknown[]) => void,
    config?: { vulnerabilityTTLMinutes?: number; bypassCacheForCritical?: boolean }
  ) {
    // Read TTL from configuration (convert minutes to milliseconds)
    this.vulnerabilityTTL = (config?.vulnerabilityTTLMinutes ?? 60) * 60 * 1000;
    this.bypassCacheForCritical = config?.bypassCacheForCritical ?? true;

    // Initialize cache directory URI
    this.cacheDirUri = vscode.Uri.joinPath(context.globalStorageUri, this.cacheDirName);

    this.log(
      'info',
      `CacheManager initialized with OSV TTL: ${this.vulnerabilityTTL}ms, bypass critical: ${this.bypassCacheForCritical}`
    );
    this.log('info', `[DEBUG] Global Storage URI: ${this.context.globalStorageUri.fsPath}`);
    this.log('info', `[DEBUG] Cache Directory URI: ${this.cacheDirUri.fsPath}`);

    // Initialize asynchronously
    this.init().catch((err) => {
      this.log('error', 'Failed to initialize CacheManager', err);
    });
  }

  /**
   * Get current cache statistics
   */
  public getStats(): { hits: number; requests: number } {
    return { ...this.stats };
  }

  /**
   * Get compression statistics
   */
  public getCompressionStats(): {
    totalCompressed: number;
    totalUncompressed: number;
    totalBytesSaved: number;
  } {
    return { ...this.compressionStats };
  }

  /**
   * Reset cache statistics
   */
  public resetStats(): void {
    this.stats = {
      hits: 0,
      requests: 0,
    };
    this.compressionStats = {
      totalCompressed: 0,
      totalUncompressed: 0,
      totalBytesSaved: 0,
    };
  }

  /**
   * Initialize cache directory and migrate old data
   * Uses promise caching to prevent concurrent initialization
   */
  private async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // If initialization is already in progress, return the existing promise
    if (this.initPromise) {
      return this.initPromise;
    }

    // Create and cache the initialization promise
    this.initPromise = (async () => {
      try {
        // Create cache directory if it doesn't exist
        try {
          await vscode.workspace.fs.createDirectory(this.cacheDirUri);
          this.log(
            'info',
            `[DEBUG] Created/Verified cache directory at: ${this.cacheDirUri.fsPath}`
          );
        } catch (error) {
          // Ignore error if directory already exists
          this.log('debug', 'Cache directory already exists or could not be created', error);
        }

        this.initialized = true;
      } catch (error) {
        this.log('error', 'Error initializing CacheManager', error);
        throw error;
      } finally {
        // Clear the promise after initialization completes (success or failure)
        this.initPromise = null;
      }
    })();

    return this.initPromise;
  }

  /**
   * Updates cache configuration at runtime
   */
  updateConfig(config: {
    vulnerabilityTTLMinutes?: number;
    bypassCacheForCritical?: boolean;
  }): void {
    if (config.vulnerabilityTTLMinutes !== undefined) {
      this.vulnerabilityTTL = config.vulnerabilityTTLMinutes * 60 * 1000;
      this.log('info', `Updated vulnerability cache TTL to ${this.vulnerabilityTTL}ms`);
    }
    if (config.bypassCacheForCritical !== undefined) {
      this.bypassCacheForCritical = config.bypassCacheForCritical;
      this.log('info', `Updated bypass cache for critical to ${this.bypassCacheForCritical}`);
    }
  }

  /**
   * Helper to get file URI for a cache key
   */
  private getCacheFileUri(key: string): vscode.Uri {
    // Hash the key to create a safe filename
    const hash = crypto.createHash('sha256').update(key).digest('hex');
    return vscode.Uri.joinPath(this.cacheDirUri, `${hash}.json`);
  }

  /**
   * Caches OSV vulnerability data including CVSS information
   * Uses cache key format: vuln:osv:{packageName}:{version}
   * Caches each package individually to enable partial cache hits
   * Automatically compresses entries larger than 10KB
   *
   * Requirements: 6.4, 6.5
   */
  async cacheOSVVulnerabilities(
    packageName: string,
    version: string,
    vulnerabilities: Vulnerability[]
  ): Promise<void> {
    await this.init();
    const cacheKey = this.buildOSVCacheKey(packageName, version);
    const fileUri = this.getCacheFileUri(cacheKey);

    const cacheEntry: CacheEntry = {
      data: vulnerabilities,
      timestamp: Date.now(),
    };

    // Check if entry size exceeds compression threshold
    const serialized = JSON.stringify(cacheEntry);
    const sizeInBytes = Buffer.byteLength(serialized, 'utf8');

    try {
      if (sizeInBytes > this.compressionThreshold) {
        try {
          // Compress the data
          const compressed = zlib.gzipSync(serialized);
          const compressedBase64 = compressed.toString('base64');

          // Store compressed entry
          const compressedEntry: CacheEntry = {
            data: undefined as never, // Compressed entries have no data field
            timestamp: cacheEntry.timestamp,
            compressed: true,
            compressedData: compressedBase64,
          };

          const data = new TextEncoder().encode(JSON.stringify(compressedEntry));
          await vscode.workspace.fs.writeFile(fileUri, data);

          const compressionRatio = ((1 - compressedBase64.length / sizeInBytes) * 100).toFixed(1);
          const bytesSaved = sizeInBytes - compressedBase64.length;
          this.compressionStats.totalCompressed++;
          this.compressionStats.totalBytesSaved += bytesSaved;
          this.log(
            'debug',
            `Cached ${vulnerabilities.length} OSV vulnerabilities for ${packageName}@${version} (compressed: ${sizeInBytes} -> ${compressedBase64.length} bytes, ${compressionRatio}% reduction)`
          );
        } catch (error: unknown) {
          // Fallback to uncompressed if compression fails
          this.log(
            'warn',
            `Compression failed for ${packageName}@${version}, storing uncompressed`,
            error
          );
          const data = new TextEncoder().encode(serialized);
          await vscode.workspace.fs.writeFile(fileUri, data);
          this.compressionStats.totalUncompressed++;
          this.log(
            'debug',
            `Cached ${vulnerabilities.length} OSV vulnerabilities for ${packageName}@${version} (uncompressed)`
          );
        }
      } else {
        // Store uncompressed entry
        const data = new TextEncoder().encode(serialized);
        await vscode.workspace.fs.writeFile(fileUri, data);
        this.compressionStats.totalUncompressed++;
        this.log(
          'debug',
          `Cached ${vulnerabilities.length} OSV vulnerabilities for ${packageName}@${version} (uncompressed, ${sizeInBytes} bytes)`
        );
      }
    } catch (error) {
      this.log('error', `Failed to write cache for ${packageName}@${version}`, error);
    }
  }

  /**
   * Gets cached OSV vulnerabilities with CVSS data
   * Ensures all CVSS fields are preserved and returned
   * Returns null if cache miss or expired
   * Bypasses cache for critical/high severity vulnerabilities when configured
   * Automatically decompresses compressed cache entries
   *
   * Requirements: 6.2, 6.4, 6.5
   */
  async getCachedOSVVulnerabilities(
    packageName: string,
    version: string
  ): Promise<Vulnerability[] | null> {
    await this.init();
    this.stats.requests++;
    const cacheKey = this.buildOSVCacheKey(packageName, version);
    const fileUri = this.getCacheFileUri(cacheKey);

    try {
      // Try to read file
      let fileContent: Uint8Array;
      try {
        fileContent = await vscode.workspace.fs.readFile(fileUri);
      } catch {
        // File not found or error reading
        // We check error code if possible, but in VS Code API it's often FileSystemError
        // We'll assume any read error is a cache miss for now to be safe
        this.log('debug', `Cache miss for ${packageName}@${version}`);
        return null;
      }

      const cached: CacheEntry = JSON.parse(new TextDecoder().decode(fileContent));

      // Decompress if needed
      let vulnerabilities: Vulnerability[];
      if (cached.compressed === true && cached.compressedData) {
        // Type guard: compressed entry
        try {
          const compressedBuffer = Buffer.from(cached.compressedData, 'base64');
          const decompressed = zlib.gunzipSync(compressedBuffer);
          const decompressedEntry: CacheEntry = JSON.parse(decompressed.toString('utf8'));
          // After decompression, entry should be uncompressed
          if (decompressedEntry.compressed === true) {
            this.log(
              'error',
              `Decompressed entry still marked as compressed for ${packageName}@${version}`
            );
            return null;
          }
          vulnerabilities = decompressedEntry.data as Vulnerability[];
        } catch (error: unknown) {
          this.log('error', `Failed to decompress cache for ${packageName}@${version}`, error);
          return null;
        }
      } else {
        // Type guard: uncompressed entry
        vulnerabilities = cached.data as Vulnerability[];
      }

      // Check if cache contains critical or high severity vulnerabilities
      // If bypass is enabled, return null to force fresh query
      if (this.bypassCacheForCritical && this.hasCriticalOrHighVulnerabilities(vulnerabilities)) {
        this.log(
          'info',
          `Bypassing cache for ${packageName}@${version} due to critical/high severity vulnerabilities`
        );
        return null;
      }

      // Check if cache is expired
      const age = Date.now() - cached.timestamp;
      if (age > this.vulnerabilityTTL) {
        this.log('debug', `Cache expired for ${packageName}@${version} (age: ${age}ms)`);
        // Optionally delete expired file
        try {
          await vscode.workspace.fs.delete(fileUri);
        } catch {
          /* ignore */
        }
        return null;
      }

      this.log(
        'debug',
        `Cache hit for ${packageName}@${version} (${vulnerabilities.length} vulnerabilities${cached.compressed ? ', compressed' : ''})`
      );
      this.stats.hits++;
      return vulnerabilities.map((v) => this.reviveVulnerabilityDates(v));
    } catch (error) {
      // If any error occurs during read/parse, treat as cache miss
      this.log('warn', `Error reading cache for ${packageName}@${version}`, error);
      return null;
    }
  }

  /**
   * Checks if vulnerabilities contain critical or high severity issues
   * Used for cache bypass logic
   *
   * Requirements: 6.2
   */
  private hasCriticalOrHighVulnerabilities(vulnerabilities: Vulnerability[]): boolean {
    return vulnerabilities.some((vuln) => vuln.severity === 'critical' || vuln.severity === 'high');
  }

  /**
   * Builds cache key for OSV vulnerability data
   * Format: vuln:osv:{packageName}:{version}
   *
   * Requirements: 6.4
   */
  private buildOSVCacheKey(packageName: string, version: string): string {
    return `vuln:osv:${packageName}:${version}`;
  }

  /**
   * Clears all OSV-related caches
   * Used for force refresh functionality
   *
   * Requirements: 6.3
   */
  async clearOSVCache(): Promise<void> {
    await this.init();
    try {
      const files = await vscode.workspace.fs.readDirectory(this.cacheDirUri);
      let clearedCount = 0;
      for (const [name, type] of files) {
        if (type === vscode.FileType.File && name.endsWith('.json')) {
          await vscode.workspace.fs.delete(vscode.Uri.joinPath(this.cacheDirUri, name));
          clearedCount++;
        }
      }
      this.log('info', `Cleared ${clearedCount} cache files`);
    } catch (error) {
      this.log('error', 'Error clearing cache', error);
    }
  }

  /**
   * Caches GitHub vulnerability data
   * Uses cache key format: vuln:github:{packageName}:{version}
   */
  async cacheGitHubVulnerabilities(
    packageName: string,
    version: string,
    vulnerabilities: Vulnerability[]
  ): Promise<void> {
    await this.init();
    const cacheKey = this.buildGitHubCacheKey(packageName, version);
    const fileUri = this.getCacheFileUri(cacheKey);

    const cacheEntry: CacheEntry = {
      data: vulnerabilities,
      timestamp: Date.now(),
    };

    const serialized = JSON.stringify(cacheEntry);
    const sizeInBytes = Buffer.byteLength(serialized, 'utf8');

    try {
      if (sizeInBytes > this.compressionThreshold) {
        try {
          const compressed = zlib.gzipSync(serialized);
          const compressedBase64 = compressed.toString('base64');

          const compressedEntry: CacheEntry = {
            data: undefined as never, // Compressed entries have no data field
            timestamp: cacheEntry.timestamp,
            compressed: true,
            compressedData: compressedBase64,
          };

          const data = new TextEncoder().encode(JSON.stringify(compressedEntry));
          await vscode.workspace.fs.writeFile(fileUri, data);

          const compressionRatio = ((1 - compressedBase64.length / sizeInBytes) * 100).toFixed(1);
          const bytesSaved = sizeInBytes - compressedBase64.length;
          this.compressionStats.totalCompressed++;
          this.compressionStats.totalBytesSaved += bytesSaved;
          this.log(
            'debug',
            `Cached ${vulnerabilities.length} GitHub vulnerabilities for ${packageName}@${version} (compressed: ${sizeInBytes} -> ${compressedBase64.length} bytes, ${compressionRatio}% reduction)`
          );
        } catch (error: unknown) {
          this.log(
            'warn',
            `Compression failed for ${packageName}@${version}, storing uncompressed`,
            error
          );
          const data = new TextEncoder().encode(serialized);
          await vscode.workspace.fs.writeFile(fileUri, data);
        }
      } else {
        const data = new TextEncoder().encode(serialized);
        await vscode.workspace.fs.writeFile(fileUri, data);
        this.compressionStats.totalUncompressed++;
        this.log(
          'debug',
          `Cached ${vulnerabilities.length} GitHub vulnerabilities for ${packageName}@${version} (uncompressed, ${sizeInBytes} bytes)`
        );
      }
    } catch (error) {
      this.log('error', `Failed to write cache for ${packageName}@${version}`, error);
    }
  }

  /**
   * Gets cached GitHub vulnerabilities
   */
  async getCachedGitHubVulnerabilities(
    packageName: string,
    version: string
  ): Promise<Vulnerability[] | null> {
    await this.init();
    this.stats.requests++;
    const cacheKey = this.buildGitHubCacheKey(packageName, version);
    const fileUri = this.getCacheFileUri(cacheKey);

    try {
      let fileContent: Uint8Array;
      try {
        fileContent = await vscode.workspace.fs.readFile(fileUri);
      } catch (error) {
        if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
          this.log('debug', `Cache miss for ${packageName}@${version}`);
          return null;
        }
        throw error;
      }

      const cached: CacheEntry = JSON.parse(new TextDecoder().decode(fileContent));

      let vulnerabilities: Vulnerability[];
      if (cached.compressed === true && cached.compressedData) {
        // Type guard: compressed entry
        try {
          const compressedBuffer = Buffer.from(cached.compressedData, 'base64');
          const decompressed = zlib.gunzipSync(compressedBuffer);
          const decompressedEntry: CacheEntry = JSON.parse(decompressed.toString('utf8'));
          // After decompression, entry should be uncompressed
          if (decompressedEntry.compressed === true) {
            this.log(
              'error',
              `Decompressed entry still marked as compressed for ${packageName}@${version}`
            );
            return null;
          }
          vulnerabilities = decompressedEntry.data as Vulnerability[];
        } catch (error: unknown) {
          this.log('error', `Failed to decompress cache for ${packageName}@${version}`, error);
          return null;
        }
      } else {
        // Type guard: uncompressed entry
        vulnerabilities = cached.data as Vulnerability[];
      }

      if (this.bypassCacheForCritical && this.hasCriticalOrHighVulnerabilities(vulnerabilities)) {
        this.log(
          'info',
          `Bypassing cache for ${packageName}@${version} due to critical/high severity vulnerabilities`
        );
        return null;
      }

      const age = Date.now() - cached.timestamp;
      if (age > this.vulnerabilityTTL) {
        this.log('debug', `Cache expired for ${packageName}@${version} (age: ${age}ms)`);
        try {
          await vscode.workspace.fs.delete(fileUri);
        } catch {
          /* ignore */
        }
        return null;
      }

      this.log(
        'debug',
        `Cache hit for ${packageName}@${version} (${vulnerabilities.length} vulnerabilities${cached.compressed ? ', compressed' : ''})`
      );
      this.stats.hits++;
      return vulnerabilities.map((v) => this.reviveVulnerabilityDates(v));
    } catch (error) {
      if (!(error instanceof vscode.FileSystemError && error.code === 'FileNotFound')) {
        this.log('warn', `Error reading cache for ${packageName}@${version}`, error);
      }
      return null;
    }
  }

  /**
   * Builds cache key for GitHub vulnerability data
   * Format: vuln:github:{packageName}:{version}
   */
  private buildGitHubCacheKey(packageName: string, version: string): string {
    return `vuln:github:${packageName}:${version}`;
  }

  /**
   * Helper to revive Date objects from JSON strings
   */
  private reviveVulnerabilityDates(vuln: Vulnerability): Vulnerability {
    return {
      ...vuln,
      publishedDate:
        typeof vuln.publishedDate === 'string' ? new Date(vuln.publishedDate) : vuln.publishedDate,
      lastModifiedDate:
        typeof vuln.lastModifiedDate === 'string'
          ? new Date(vuln.lastModifiedDate)
          : vuln.lastModifiedDate,
    };
  }

  /**
   * Clears all GitHub-related caches
   */
  async clearGitHubCache(): Promise<void> {
    await this.clearOSVCache();
  }

  /**
   * Caches NPM package info
   * Uses cache key format: npm:info:{packageName}
   */
  async cacheNpmInfo(packageName: string, info: PackageInfo): Promise<void> {
    await this.init();
    const cacheKey = this.buildNpmCacheKey(packageName);
    const fileUri = this.getCacheFileUri(cacheKey);

    const cacheEntry: CacheEntry = {
      data: info,
      timestamp: Date.now(),
    };

    const serialized = JSON.stringify(cacheEntry);
    const sizeInBytes = Buffer.byteLength(serialized, 'utf8');

    try {
      if (sizeInBytes > this.compressionThreshold) {
        try {
          const compressed = zlib.gzipSync(serialized);
          const compressedBase64 = compressed.toString('base64');

          const compressedEntry: CacheEntry = {
            data: undefined as never, // Compressed entries have no data field
            timestamp: cacheEntry.timestamp,
            compressed: true,
            compressedData: compressedBase64,
          };

          const compressionRatio = ((1 - compressedBase64.length / sizeInBytes) * 100).toFixed(1);
          const bytesSaved = sizeInBytes - compressedBase64.length;
          this.compressionStats.totalCompressed++;
          this.compressionStats.totalBytesSaved += bytesSaved;
          const data = new TextEncoder().encode(JSON.stringify(compressedEntry));
          await vscode.workspace.fs.writeFile(fileUri, data);
          this.log(
            'debug',
            `Cached NPM info for ${packageName} (compressed: ${sizeInBytes} -> ${compressedBase64.length} bytes, ${compressionRatio}% reduction)`
          );
        } catch (error: unknown) {
          this.log(
            'warn',
            `Compression failed for ${packageName} info, storing uncompressed`,
            error
          );
          const data = new TextEncoder().encode(serialized);
          await vscode.workspace.fs.writeFile(fileUri, data);
          this.compressionStats.totalUncompressed++;
        }
      } else {
        const data = new TextEncoder().encode(serialized);
        await vscode.workspace.fs.writeFile(fileUri, data);
        this.compressionStats.totalUncompressed++;
      }
      this.log('debug', `Cached NPM info for ${packageName}`);
    } catch (error) {
      this.log('error', `Failed to write NPM cache for ${packageName}`, error);
    }
  }

  /**
   * Gets cached NPM package info
   */
  async getCachedNpmInfo(packageName: string): Promise<PackageInfo | null> {
    await this.init();
    this.stats.requests++;
    const cacheKey = this.buildNpmCacheKey(packageName);
    const fileUri = this.getCacheFileUri(cacheKey);

    try {
      let fileContent: Uint8Array;
      try {
        fileContent = await vscode.workspace.fs.readFile(fileUri);
      } catch {
        return null;
      }

      const cached: CacheEntry = JSON.parse(new TextDecoder().decode(fileContent));

      let data: PackageInfo;
      if (cached.compressed === true && cached.compressedData) {
        // Type guard: compressed entry
        try {
          const compressedBuffer = Buffer.from(cached.compressedData, 'base64');
          const decompressed = zlib.gunzipSync(compressedBuffer);
          const decompressedEntry: CacheEntry = JSON.parse(decompressed.toString('utf8'));
          // After decompression, entry should be uncompressed
          if (decompressedEntry.compressed === true) {
            this.log('error', `Decompressed entry still marked as compressed for ${packageName}`);
            return null;
          }
          data = decompressedEntry.data as PackageInfo;
        } catch (error: unknown) {
          this.log('error', `Failed to decompress NPM cache for ${packageName}`, error);
          return null;
        }
      } else {
        // Type guard: uncompressed entry
        data = cached.data as PackageInfo;
      }

      // Check TTL (24 hours for NPM info)
      const NPM_TTL = 24 * 60 * 60 * 1000;
      const age = Date.now() - cached.timestamp;
      if (age > NPM_TTL) {
        this.log('debug', `NPM cache expired for ${packageName}`);
        try {
          await vscode.workspace.fs.delete(fileUri);
        } catch {
          /* ignore */
        }
        return null;
      }

      // Revive dates
      if (typeof data.publishedAt === 'string') {
        data.publishedAt = new Date(data.publishedAt);
      }

      this.stats.hits++;
      return data;
    } catch (error) {
      this.log('warn', `Error reading NPM cache for ${packageName}`, error);
      return null;
    }
  }

  private buildNpmCacheKey(packageName: string): string {
    return `npm:info:${packageName}`;
  }
}

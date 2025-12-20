import type * as vscode from 'vscode';
import {
  DepPulseError,
  type DownloadStats,
  ErrorCode,
  type PackageInfo,
  type PackageRegistryClient,
  type PackageSearchResult,
} from '../types';
import { BaseAPIClient } from './APIClient';

/**
 * Interface for npm registry API response
 */
interface NpmPackageResponse {
  name: string;
  'dist-tags': {
    latest: string;
    [key: string]: string;
  };
  versions: {
    [version: string]: {
      name: string;
      version: string;
      description?: string;
      license?: string;
      repository?: {
        type: string;
        url: string;
      };
      homepage?: string;
      deprecated?: string;
    };
  };
  time: {
    [version: string]: string;
    created: string;
    modified: string;
  };
  downloads?: {
    weekly: number;
    monthly: number;
  };
  readme?: string;
}

interface NpmDownloadResponse {
  downloads: number;
  start: string;
  end: string;
  package: string;
}

/**
 * Interface for npm search API response item
 */
interface NpmSearchResponseItem {
  package: {
    name: string;
    description?: string;
    version: string;
  };
  score?: {
    detail?: {
      popularity?: number;
    };
  };
}

/**
 * Client for interacting with the npm registry API
 */
export class NpmRegistryClient extends BaseAPIClient implements PackageRegistryClient {
  constructor(outputChannel: vscode.OutputChannel) {
    super('https://registry.npmjs.org', outputChannel);
  }

  /**
   * Gets package information from npm registry
   */
  async getPackageInfo(name: string): Promise<PackageInfo> {
    this.log('info', `Fetching package info for: ${name}`);

    try {
      const response = await this.get<NpmPackageResponse>(`/${name}`);

      const latestVersion = response['dist-tags'].latest;
      const versionInfo = response.versions[latestVersion];

      if (!versionInfo) {
        throw new DepPulseError(
          `Version ${latestVersion} not found for package ${name}`,
          ErrorCode.API_ERROR,
          true
        );
      }

      // Get publish date for latest version
      const publishedAt = response.time[latestVersion]
        ? new Date(response.time[latestVersion])
        : new Date();

      const packageInfo: PackageInfo = {
        name: versionInfo.name,
        version: versionInfo.version,
        description: versionInfo.description || '',
        license: versionInfo.license || 'Unknown',
        repository: versionInfo.repository?.url,
        homepage: versionInfo.homepage,
        publishedAt,
        downloads: response.downloads
          ? {
              weekly: response.downloads.weekly,
              monthly: response.downloads.monthly,
              total: 0, // npm registry doesn't provide total downloads
            }
          : undefined,
        deprecatedMessage: versionInfo.deprecated,
        readme: response.readme,
      };

      this.log('info', `Successfully fetched info for ${name}@${packageInfo.version}`);
      return packageInfo;
    } catch (error: unknown) {
      if (error instanceof DepPulseError && error.code === ErrorCode.API_ERROR) {
        // Check if it's a 404 - package not found
        if (error.context?.status === 404) {
          throw new DepPulseError(`Package not found: ${name}`, ErrorCode.API_ERROR, true, {
            packageName: name,
          });
        }
      }
      throw error;
    }
  }

  /**
   * Gets the latest version of a package
   */
  async getLatestVersion(name: string): Promise<string> {
    this.log('info', `Fetching latest version for: ${name}`);

    try {
      const response = await this.get<NpmPackageResponse>(`/${name}`);
      const latestVersion = response['dist-tags'].latest;

      if (!latestVersion) {
        throw new DepPulseError(
          `No latest version found for package ${name}`,
          ErrorCode.API_ERROR,
          true
        );
      }

      this.log('info', `Latest version of ${name}: ${latestVersion}`);
      return latestVersion;
    } catch (error: unknown) {
      if (error instanceof DepPulseError && error.code === ErrorCode.API_ERROR) {
        if (error.context?.status === 404) {
          throw new DepPulseError(`Package not found: ${name}`, ErrorCode.API_ERROR, true, {
            packageName: name,
          });
        }
      }
      throw error;
    }
  }

  /**
   * Searches for packages in the npm registry
   * Note: This uses the npm search API endpoint
   */
  async searchPackages(query: string): Promise<PackageSearchResult[]> {
    this.log('info', `Searching packages: ${query}`);

    try {
      // npm search API endpoint
      const searchUrl = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(query)}&size=10`;

      const response = await this.axiosInstance.get(searchUrl);
      const results: NpmSearchResponseItem[] = response.data.objects || [];

      const searchResults: PackageSearchResult[] = results.map((item: NpmSearchResponseItem) => ({
        name: item.package.name,
        description: item.package.description || '',
        version: item.package.version,
        downloads: item.score?.detail?.popularity || 0,
      }));

      this.log('info', `Found ${searchResults.length} packages matching "${query}"`);
      return searchResults;
    } catch (error: unknown) {
      this.log('error', `Search failed for query: ${query}`, error);
      // Type assertion is safe here as axios errors are AxiosError type
      throw this.handleError(error as import('axios').AxiosError, 'GET', `search?text=${query}`);
    }
  }

  /**
   * Fetches last-week download stats for a package
   */
  async getDownloadStats(packageName: string): Promise<DownloadStats> {
    this.log('info', `Fetching download stats for: ${packageName}`);

    try {
      const url = `https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(packageName)}`;
      const response = await this.axiosInstance.get<NpmDownloadResponse>(url);
      const downloads = response.data.downloads || 0;
      return {
        weekly: downloads,
        monthly: 0,
        total: downloads,
      };
    } catch (error: unknown) {
      this.log('warn', `Failed to fetch download stats for ${packageName}`, error);
      // Default to zero downloads on failure
      return {
        weekly: 0,
        monthly: 0,
        total: 0,
      };
    }
  }

  /**
   * Checks if a specific version of a package is deprecated
   * @param packageName The package name
   * @param version The version to check
   * @returns Deprecated message if version is deprecated, null otherwise
   */
  async getVersionDeprecationStatus(packageName: string, version: string): Promise<string | null> {
    this.log('info', `Checking deprecation status for ${packageName}@${version}`);

    try {
      const response = await this.get<NpmPackageResponse>(`/${packageName}`);
      const versionInfo = response.versions[version];

      if (!versionInfo) {
        this.log('warn', `Version ${version} not found for package ${packageName}`);
        return null;
      }

      if (versionInfo.deprecated) {
        this.log(
          'info',
          `Version ${version} of ${packageName} is deprecated: ${versionInfo.deprecated}`
        );
        return versionInfo.deprecated;
      }

      return null;
    } catch (error: unknown) {
      // Reduce verbosity for 404 errors (expected for test/fake packages)
      if (error instanceof DepPulseError && error.context?.status === 404) {
        this.log(
          'debug',
          `Package not found in registry: ${packageName} (expected for test/fake packages)`
        );
      } else {
        this.log('warn', `Failed to check deprecation status for ${packageName}@${version}`, error);
      }
      // Return null on error to avoid blocking analysis
      return null;
    }
  }
}

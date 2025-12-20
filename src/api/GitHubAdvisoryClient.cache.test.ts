import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { CacheManager } from '../utils/CacheManager';
import { GitHubAdvisoryClient, type GitHubAdvisoryResponse } from './GitHubAdvisoryClient';

const mockCalculateScores = vi.fn(() => ({ base: 7.5, overall: 7.5 }));

// Mock vscode
vi.mock('vscode', () => ({
  window: {
    createOutputChannel: vi.fn().mockReturnValue({ appendLine: vi.fn() }),
  },
}));

vi.mock('ae-cvss-calculator', () => ({
  Cvss2: class {
    calculateScores = mockCalculateScores;
  },
  Cvss3P0: class {
    calculateScores = mockCalculateScores;
  },
  Cvss3P1: class {
    calculateScores = mockCalculateScores;
  },
  Cvss4P0: class {
    calculateScores = mockCalculateScores;
  },
}));

// Mock node:https
vi.mock('node:https', () => ({
  Agent: vi.fn(),
}));

// Mock BaseAPIClient to avoid complex constructor logic
vi.mock('./APIClient', () => {
  return {
    BaseAPIClient: class {
      protected axiosInstance: unknown;
      protected log: unknown;
      protected baseURL: string;
      protected outputChannel: unknown;

      constructor(baseURL: string, outputChannel: unknown) {
        this.baseURL = baseURL;
        this.outputChannel = outputChannel;
        this.log = vi.fn();
        this.axiosInstance = {
          defaults: {
            headers: { common: {} },
            httpsAgent: {},
          },
          get: vi.fn(),
          post: vi.fn(),
        };
      }

      updateConnectionPool() {}
      optimizeConnectionPool() {}
    },
  };
});

// Mock CacheManager
const mockGetCachedGitHubVulnerabilities = vi.fn();
const mockCacheGitHubVulnerabilities = vi.fn().mockResolvedValue(undefined);
const mockClearGitHubCache = vi.fn().mockResolvedValue(undefined);

vi.mock('../utils/CacheManager', () => {
  return {
    CacheManager: class {
      getCachedGitHubVulnerabilities = mockGetCachedGitHubVulnerabilities;
      cacheGitHubVulnerabilities = mockCacheGitHubVulnerabilities;
      clearGitHubCache = mockClearGitHubCache;
    },
  };
});

describe('GitHubAdvisoryClient Caching', () => {
  let client: GitHubAdvisoryClient;
  let mockCacheManager: CacheManager;
  let mockOutputChannel: vscode.OutputChannel;

  beforeEach(() => {
    vi.clearAllMocks();
    mockOutputChannel = { appendLine: vi.fn() } as unknown as vscode.OutputChannel;
    // Create a mock instance (the implementation is mocked above)
    mockCacheManager = new CacheManager({} as vscode.ExtensionContext, vi.fn());
    try {
      client = new GitHubAdvisoryClient(mockOutputChannel, 'dummy-token', mockCacheManager);
    } catch (error) {
      console.error('FAILED TO CREATE GITHUBCLIENT:', error);
      throw error;
    }

    // Mock internal methods to avoid actual network calls
    vi.spyOn(
      client as unknown as { executeBatchRequest: () => Promise<unknown> },
      'executeBatchRequest'
    ).mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should check persistent cache before fetching', async () => {
    const deps = [{ name: 'react', version: '18.2.0', versionConstraint: '18.2.0', isDev: false }];
    const cachedVulns = [{ id: 'GHSA-1234', title: 'Test Vuln', severity: 'high' }];

    mockGetCachedGitHubVulnerabilities.mockResolvedValue(cachedVulns);

    const results = await client.getBatchVulnerabilities(deps);

    expect(mockGetCachedGitHubVulnerabilities).toHaveBeenCalledWith('react', '18.2.0');
    expect(results.get('react')).toEqual(cachedVulns);

    // Should verify that network call was NOT made
    expect(
      (client as unknown as { executeBatchRequest: unknown }).executeBatchRequest
    ).not.toHaveBeenCalled();
  });

  it('should fetch from API and save to persistent cache on cache miss', async () => {
    const deps = [
      { name: 'lodash', version: '4.17.15', versionConstraint: '4.17.15', isDev: false },
    ];

    // Cache miss
    mockGetCachedGitHubVulnerabilities.mockResolvedValue(null);

    // Mock API response
    const mockAdvisory: GitHubAdvisoryResponse = {
      ghsa_id: 'GHSA-1234',
      summary: 'Lodash Vuln',
      severity: 'high',
      identifiers: [{ type: 'GHSA', value: 'GHSA-1234' }],
      references: [],
      published_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      vulnerabilities: [
        {
          package: { ecosystem: 'npm', name: 'lodash' },
          vulnerable_version_range: '< 4.17.19',
        },
      ],
    };

    // Mock batch response
    vi.spyOn(
      client as unknown as { executeBatchRequest: () => Promise<unknown> },
      'executeBatchRequest'
    ).mockResolvedValue([mockAdvisory]);

    const results = await client.getBatchVulnerabilities(deps);

    expect(mockGetCachedGitHubVulnerabilities).toHaveBeenCalledWith('lodash', '4.17.15');
    expect(results.get('lodash')).toHaveLength(1);
    expect(results.get('lodash')?.[0].id).toEqual('GHSA-1234');

    // Should save to cache
    // Note: The client converts GitHubAdvisoryResponse to Vulnerability before caching
    expect(mockCacheGitHubVulnerabilities).toHaveBeenCalledWith(
      'lodash',
      '4.17.15',
      expect.any(Array)
    );
  });

  it('should clear persistent cache when bypassCache is true', async () => {
    const deps = [{ name: 'react', version: '18.2.0', versionConstraint: '18.2.0', isDev: false }];

    await client.getBatchVulnerabilities(deps, true);

    expect(mockClearGitHubCache).toHaveBeenCalled();
  });

  it('caches CVSS score calculations', () => {
    const vector = 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H';
    const calculate = (
      client as unknown as {
        calculateCVSSScore: (vector: string, version: string) => number | null;
      }
    ).calculateCVSSScore.bind(client);

    const first = calculate(vector, '3.1');
    const second = calculate(vector, '3.1');

    expect(first).toBe(second);
    expect(mockCalculateScores).toHaveBeenCalledTimes(1);
    expect(
      (client as unknown as { cvssScoreCache: Map<string, number | null> }).cvssScoreCache.size
    ).toBe(1);
  });
});

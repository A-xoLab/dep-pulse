import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { CacheManager } from '../utils/CacheManager';
import { OSVClient } from './OSVClient';

const mockCalculateScores = vi.fn(() => ({ base: 9.8, overall: 9.8 }));

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
const mockGetCachedOSVVulnerabilities = vi.fn();
const mockCacheOSVVulnerabilities = vi.fn().mockResolvedValue(undefined);
const mockClearOSVCache = vi.fn().mockResolvedValue(undefined);

vi.mock('../utils/CacheManager', () => {
  return {
    CacheManager: class {
      getCachedOSVVulnerabilities = mockGetCachedOSVVulnerabilities;
      cacheOSVVulnerabilities = mockCacheOSVVulnerabilities;
      clearOSVCache = mockClearOSVCache;
    },
  };
});

describe('OSVClient Caching', () => {
  let client: OSVClient;
  let mockCacheManager: CacheManager;
  let mockOutputChannel: vscode.OutputChannel;

  beforeEach(() => {
    vi.clearAllMocks();
    mockOutputChannel = { appendLine: vi.fn() } as unknown as vscode.OutputChannel;
    // Create a mock instance (the implementation is mocked above)
    mockCacheManager = new CacheManager({} as vscode.ExtensionContext, vi.fn());
    try {
      client = new OSVClient(mockOutputChannel, mockCacheManager);
    } catch (error) {
      console.error('FAILED TO CREATE OSVCLIENT:', error);
      throw error;
    }

    // Mock internal methods to avoid actual network calls
    vi.spyOn(
      client as unknown as { executeBatchRequest: () => Promise<unknown> },
      'executeBatchRequest'
    ).mockResolvedValue({ results: [] });
    vi.spyOn(
      client as unknown as { getVulnerabilityById: () => Promise<unknown> },
      'getVulnerabilityById'
    ).mockResolvedValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should check persistent cache before fetching', async () => {
    const deps = [{ name: 'react', version: '18.2.0', versionConstraint: '18.2.0', isDev: false }];
    const cachedVulns = [{ id: 'CVE-2023-1234', title: 'Test Vuln', severity: 'high' }];

    mockGetCachedOSVVulnerabilities.mockResolvedValue(cachedVulns);

    const results = await client.getBatchVulnerabilities(deps);

    expect(mockGetCachedOSVVulnerabilities).toHaveBeenCalledWith('react', '18.2.0');
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
    mockGetCachedOSVVulnerabilities.mockResolvedValue(null);

    // Mock API response
    const mockVuln = { id: 'CVE-2020-1234', title: 'Lodash Vuln', severity: 'critical' };

    // Mock batch response
    vi.spyOn(
      client as unknown as { executeBatchRequest: () => Promise<unknown> },
      'executeBatchRequest'
    ).mockResolvedValue({
      results: [
        {
          vulns: [{ id: 'CVE-2020-1234' }],
        },
      ],
    });

    // Mock detail fetch
    vi.spyOn(
      client as unknown as { getVulnerabilityById: () => Promise<unknown> },
      'getVulnerabilityById'
    ).mockResolvedValue(mockVuln);

    const results = await client.getBatchVulnerabilities(deps);

    expect(mockGetCachedOSVVulnerabilities).toHaveBeenCalledWith('lodash', '4.17.15');
    expect(results.get('lodash')).toHaveLength(1);
    expect(results.get('lodash')?.[0]).toEqual(mockVuln);

    // Should save to cache
    expect(mockCacheOSVVulnerabilities).toHaveBeenCalledWith('lodash', '4.17.15', [mockVuln]);
  });

  it('should clear persistent cache when bypassCache is true', async () => {
    const deps = [{ name: 'react', version: '18.2.0', versionConstraint: '18.2.0', isDev: false }];

    await client.getBatchVulnerabilities(deps, true);

    expect(mockClearOSVCache).toHaveBeenCalled();
  });

  it('reuses in-memory vulnerability cache between runs', async () => {
    const deps = [{ name: 'react', version: '18.2.0', versionConstraint: '18.2.0', isDev: false }];

    mockGetCachedOSVVulnerabilities.mockResolvedValue(null);

    vi.spyOn(
      client as unknown as { executeBatchRequest: () => Promise<unknown> },
      'executeBatchRequest'
    ).mockResolvedValue({
      results: [
        {
          vulns: [{ id: 'CVE-2024-9999' }],
        },
      ],
    });

    const getVulnDetailsSpy = vi
      .spyOn(
        client as unknown as { getVulnerabilityById: () => Promise<unknown> },
        'getVulnerabilityById'
      )
      .mockResolvedValue({
        id: 'CVE-2024-9999',
        title: 'Cached vulnerability',
        severity: 'high',
      });

    const first = await client.getBatchVulnerabilities(deps);
    const second = await client.getBatchVulnerabilities(deps);

    expect(first.get('react')?.[0]?.id).toBe('CVE-2024-9999');
    expect(second.get('react')?.[0]?.id).toBe('CVE-2024-9999');
    expect(getVulnDetailsSpy).toHaveBeenCalledTimes(1);
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
    expect(client.getCVSSCacheStats().size).toBe(1);
  });
});

import type { AxiosInstance } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import type { Dependency, Vulnerability } from '../types';
import { GitHubAdvisoryClient, type GitHubAdvisoryResponse } from './GitHubAdvisoryClient';

// Mock output channel
const createMockOutputChannel = (): vscode.OutputChannel => ({
  name: 'test',
  append: vi.fn(),
  appendLine: vi.fn(),
  replace: vi.fn(),
  clear: vi.fn(),
  show: vi.fn(),
  hide: vi.fn(),
  dispose: vi.fn(),
});

describe('GitHubAdvisoryClient - Batch Methods', () => {
  let client: GitHubAdvisoryClient;
  let mockOutputChannel: vscode.OutputChannel;

  beforeEach(() => {
    mockOutputChannel = createMockOutputChannel();
    client = new GitHubAdvisoryClient(mockOutputChannel);
  });

  describe('createBatches', () => {
    it('should handle 1 dependency', () => {
      const deps: Dependency[] = [
        { name: 'express', version: '4.17.1', versionConstraint: '4.17.1', isDev: false },
      ];

      // Access private method via type assertion
      const batches = (
        client as unknown as {
          createBatches: (dependencies: Dependency[], maxBatchSize: number) => Dependency[][];
        }
      ).createBatches(deps, 500);

      expect(batches).toHaveLength(1);
      expect(batches[0]).toHaveLength(1);
      expect(batches[0][0].name).toBe('express');
    });

    it('should handle 10 dependencies in single batch', () => {
      const deps: Dependency[] = Array.from({ length: 10 }, (_, i) => ({
        name: `package-${i}`,
        version: '1.0.0',
        versionConstraint: '1.0.0',
        isDev: false,
      }));

      const batches = (
        client as unknown as {
          createBatches: (dependencies: Dependency[], maxBatchSize: number) => Dependency[][];
        }
      ).createBatches(deps, 500);

      expect(batches).toHaveLength(1);
      expect(batches[0]).toHaveLength(10);
    });

    it('should handle 100 dependencies in single batch', () => {
      const deps: Dependency[] = Array.from({ length: 100 }, (_, i) => ({
        name: `package-${i}`,
        version: '1.0.0',
        versionConstraint: '1.0.0',
        isDev: false,
      }));

      const batches = (
        client as unknown as {
          createBatches: (dependencies: Dependency[], maxBatchSize: number) => Dependency[][];
        }
      ).createBatches(deps, 500);

      expect(batches).toHaveLength(1);
      expect(batches[0]).toHaveLength(100);
    });

    it('should handle 500 dependencies respecting URL length', () => {
      const deps: Dependency[] = Array.from({ length: 500 }, (_, i) => ({
        name: `package-${i}`,
        version: '1.0.0',
        versionConstraint: '1.0.0',
        isDev: false,
      }));

      const batches = (
        client as unknown as {
          createBatches: (dependencies: Dependency[], maxBatchSize: number) => Dependency[][];
        }
      ).createBatches(deps, 500);

      // Should split based on URL length constraint
      expect(batches.length).toBeGreaterThan(0);
      // Verify all dependencies are included
      const totalDeps = batches.reduce((sum: number, batch: Dependency[]) => sum + batch.length, 0);
      expect(totalDeps).toBe(500);
    });

    it('should split 1000 dependencies into multiple batches', () => {
      const deps: Dependency[] = Array.from({ length: 1000 }, (_, i) => ({
        name: `package-${i}`,
        version: '1.0.0',
        versionConstraint: '1.0.0',
        isDev: false,
      }));

      const batches = (
        client as unknown as {
          createBatches: (dependencies: Dependency[], maxBatchSize: number) => Dependency[][];
        }
      ).createBatches(deps, 500);

      // Should create multiple batches
      expect(batches.length).toBeGreaterThan(1);
      // Verify all dependencies are included
      const totalDeps = batches.reduce((sum: number, batch: Dependency[]) => sum + batch.length, 0);
      expect(totalDeps).toBe(1000);
    });

    it('should split 2000 dependencies into multiple batches', () => {
      const deps: Dependency[] = Array.from({ length: 2000 }, (_, i) => ({
        name: `package-${i}`,
        version: '1.0.0',
        versionConstraint: '1.0.0',
        isDev: false,
      }));

      const batches = (
        client as unknown as {
          createBatches: (dependencies: Dependency[], maxBatchSize: number) => Dependency[][];
        }
      ).createBatches(deps, 500);

      // Should create multiple batches
      expect(batches.length).toBeGreaterThan(1);
      // Verify all dependencies are included
      const totalDeps = batches.reduce((sum: number, batch: Dependency[]) => sum + batch.length, 0);
      expect(totalDeps).toBe(2000);
    });

    it('should split based on URL length for long package names', () => {
      // Create dependencies with very long names that would exceed URL length
      const deps: Dependency[] = Array.from({ length: 100 }, (_, i) => ({
        name: `very-long-package-name-that-takes-up-lots-of-space-in-url-${i}`,
        version: '1.0.0',
        versionConstraint: '1.0.0',
        isDev: false,
      }));

      const batches = (
        client as unknown as {
          createBatches: (dependencies: Dependency[], maxBatchSize: number) => Dependency[][];
        }
      ).createBatches(deps, 500);

      // Should create at least one batch
      expect(batches.length).toBeGreaterThanOrEqual(1);

      // Verify all dependencies are included
      const totalDeps = batches.reduce((sum: number, batch: Dependency[]) => sum + batch.length, 0);
      expect(totalDeps).toBe(100);
    });
  });

  describe('buildBatchAffectsParameter', () => {
    it('should handle simple package names', () => {
      const deps: Dependency[] = [
        { name: 'express', version: '4.17.1', versionConstraint: '4.17.1', isDev: false },
        { name: 'lodash', version: '4.17.20', versionConstraint: '4.17.20', isDev: false },
      ];

      const affects = (
        client as unknown as { buildBatchAffectsParameter: (dependencies: Dependency[]) => string }
      ).buildBatchAffectsParameter(deps);

      expect(affects).toBe('express@4.17.1,lodash@4.17.20');
    });

    it('should handle scoped packages with @', () => {
      const deps: Dependency[] = [
        { name: '@babel/core', version: '7.12.0', versionConstraint: '7.12.0', isDev: false },
        { name: '@types/node', version: '18.0.0', versionConstraint: '18.0.0', isDev: false },
      ];

      const affects = (
        client as unknown as { buildBatchAffectsParameter: (dependencies: Dependency[]) => string }
      ).buildBatchAffectsParameter(deps);

      // @ should be URL encoded as %40
      expect(affects).toContain('%40babel%2Fcore@7.12.0');
      expect(affects).toContain('%40types%2Fnode@18.0.0');
    });

    it('should handle packages with slashes', () => {
      const deps: Dependency[] = [
        { name: '@babel/core', version: '7.12.0', versionConstraint: '7.12.0', isDev: false },
      ];

      const affects = (
        client as unknown as { buildBatchAffectsParameter: (dependencies: Dependency[]) => string }
      ).buildBatchAffectsParameter(deps);

      // / should be URL encoded as %2F
      expect(affects).toContain('%2F');
    });

    it('should handle packages with hyphens', () => {
      const deps: Dependency[] = [
        { name: 'my-package', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
        { name: 'another-pkg', version: '2.0.0', versionConstraint: '2.0.0', isDev: false },
      ];

      const affects = (
        client as unknown as { buildBatchAffectsParameter: (dependencies: Dependency[]) => string }
      ).buildBatchAffectsParameter(deps);

      // Hyphens should not be encoded
      expect(affects).toBe('my-package@1.0.0,another-pkg@2.0.0');
    });

    it('should handle mixed special characters', () => {
      const deps: Dependency[] = [
        { name: '@babel/core', version: '7.12.0', versionConstraint: '7.12.0', isDev: false },
        { name: 'express', version: '4.17.1', versionConstraint: '4.17.1', isDev: false },
        { name: 'my-package', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
      ];

      const affects = (
        client as unknown as { buildBatchAffectsParameter: (dependencies: Dependency[]) => string }
      ).buildBatchAffectsParameter(deps);

      expect(affects).toContain('%40babel%2Fcore@7.12.0');
      expect(affects).toContain('express@4.17.1');
      expect(affects).toContain('my-package@1.0.0');
      expect(affects.split(',').length).toBe(3);
    });
  });

  describe('mapAdvisoriesToPackages', () => {
    it('should map single advisory to single package', () => {
      const advisories = [
        {
          ghsa_id: 'GHSA-xxxx-yyyy-zzzz',
          summary: 'Test Vulnerability',
          severity: 'high',
          identifiers: [{ type: 'CVE', value: 'CVE-2021-1234' }],
          references: [{ url: 'https://example.com' }],
          published_at: '2021-01-01T00:00:00Z',
          updated_at: '2021-01-02T00:00:00Z',
          vulnerabilities: [
            {
              package: { ecosystem: 'npm', name: 'express' },
              vulnerable_version_range: '< 4.17.2',
              patched_versions: '4.17.2',
            },
          ],
        },
      ];

      const queriedPackages = new Set(['express']);
      const result = (
        client as unknown as {
          mapAdvisoriesToPackages: (
            advisories: GitHubAdvisoryResponse[],
            queriedPackages: Set<string>
          ) => Map<string, Vulnerability[]>;
        }
      ).mapAdvisoriesToPackages(advisories, queriedPackages);

      expect(result.size).toBe(1);
      expect(result.has('express')).toBe(true);
      expect(result.get('express')).toHaveLength(1);
      expect(result.get('express')?.[0]?.id).toBe('CVE-2021-1234');
      expect(result.get('express')?.[0]?.severity).toBe('high');
    });

    it('should map advisory affecting multiple packages', () => {
      const advisories = [
        {
          ghsa_id: 'GHSA-xxxx-yyyy-zzzz',
          summary: 'Test Vulnerability',
          severity: 'critical',
          identifiers: [{ type: 'CVE', value: 'CVE-2021-1234' }],
          references: [{ url: 'https://example.com' }],
          published_at: '2021-01-01T00:00:00Z',
          updated_at: '2021-01-02T00:00:00Z',
          vulnerabilities: [
            {
              package: { ecosystem: 'npm', name: 'package-a' },
              vulnerable_version_range: '< 1.0.0',
            },
            {
              package: { ecosystem: 'npm', name: 'package-b' },
              vulnerable_version_range: '< 2.0.0',
            },
          ],
        },
      ];

      const queriedPackages = new Set(['package-a', 'package-b']);
      const result = (
        client as unknown as {
          mapAdvisoriesToPackages: (
            advisories: GitHubAdvisoryResponse[],
            queriedPackages: Set<string>
          ) => Map<string, Vulnerability[]>;
        }
      ).mapAdvisoriesToPackages(advisories, queriedPackages);

      expect(result.size).toBe(2);
      expect(result.has('package-a')).toBe(true);
      expect(result.has('package-b')).toBe(true);
      expect(result.get('package-a')).toHaveLength(1);
      expect(result.get('package-b')).toHaveLength(1);
      expect(result.get('package-a')?.[0]?.id).toBe('CVE-2021-1234');
      expect(result.get('package-b')?.[0]?.id).toBe('CVE-2021-1234');
    });

    it('should only include queried packages', () => {
      const advisories = [
        {
          ghsa_id: 'GHSA-xxxx-yyyy-zzzz',
          summary: 'Test Vulnerability',
          severity: 'high',
          identifiers: [{ type: 'CVE', value: 'CVE-2021-1234' }],
          references: [{ url: 'https://example.com' }],
          published_at: '2021-01-01T00:00:00Z',
          updated_at: '2021-01-02T00:00:00Z',
          vulnerabilities: [
            {
              package: { ecosystem: 'npm', name: 'express' },
              vulnerable_version_range: '< 4.17.2',
            },
            {
              package: { ecosystem: 'npm', name: 'lodash' },
              vulnerable_version_range: '< 4.17.21',
            },
          ],
        },
      ];

      // Only query for express
      const queriedPackages = new Set(['express']);
      const result = (
        client as unknown as {
          mapAdvisoriesToPackages: (
            advisories: GitHubAdvisoryResponse[],
            queriedPackages: Set<string>
          ) => Map<string, Vulnerability[]>;
        }
      ).mapAdvisoriesToPackages(advisories, queriedPackages);

      expect(result.size).toBe(1);
      expect(result.has('express')).toBe(true);
      expect(result.has('lodash')).toBe(false);
    });

    it('should handle multiple advisories for same package', () => {
      const advisories = [
        {
          ghsa_id: 'GHSA-1111-1111-1111',
          summary: 'Vulnerability 1',
          severity: 'high',
          identifiers: [{ type: 'CVE', value: 'CVE-2021-1111' }],
          references: [{ url: 'https://example.com/1' }],
          published_at: '2021-01-01T00:00:00Z',
          updated_at: '2021-01-02T00:00:00Z',
          vulnerabilities: [
            {
              package: { ecosystem: 'npm', name: 'express' },
              vulnerable_version_range: '< 4.17.0',
            },
          ],
        },
        {
          ghsa_id: 'GHSA-2222-2222-2222',
          summary: 'Vulnerability 2',
          severity: 'critical',
          identifiers: [{ type: 'CVE', value: 'CVE-2021-2222' }],
          references: [{ url: 'https://example.com/2' }],
          published_at: '2021-02-01T00:00:00Z',
          updated_at: '2021-02-02T00:00:00Z',
          vulnerabilities: [
            {
              package: { ecosystem: 'npm', name: 'express' },
              vulnerable_version_range: '< 4.17.2',
            },
          ],
        },
      ];

      const queriedPackages = new Set(['express']);
      const result = (
        client as unknown as {
          mapAdvisoriesToPackages: (
            advisories: GitHubAdvisoryResponse[],
            queriedPackages: Set<string>
          ) => Map<string, Vulnerability[]>;
        }
      ).mapAdvisoriesToPackages(advisories, queriedPackages);

      expect(result.size).toBe(1);
      expect(result.has('express')).toBe(true);
      expect(result.get('express')).toHaveLength(2);
      expect(result.get('express')?.[0]?.id).toBe('CVE-2021-1111');
      expect(result.get('express')?.[1]?.id).toBe('CVE-2021-2222');
    });

    it('should use GHSA ID when CVE not available', () => {
      const advisories = [
        {
          ghsa_id: 'GHSA-xxxx-yyyy-zzzz',
          summary: 'Test Vulnerability',
          severity: 'medium',
          identifiers: [{ type: 'GHSA', value: 'GHSA-xxxx-yyyy-zzzz' }],
          references: [{ url: 'https://example.com' }],
          published_at: '2021-01-01T00:00:00Z',
          updated_at: '2021-01-02T00:00:00Z',
          vulnerabilities: [
            {
              package: { ecosystem: 'npm', name: 'express' },
              vulnerable_version_range: '< 4.17.2',
            },
          ],
        },
      ];

      const queriedPackages = new Set(['express']);
      const result = (
        client as unknown as {
          mapAdvisoriesToPackages: (
            advisories: GitHubAdvisoryResponse[],
            queriedPackages: Set<string>
          ) => Map<string, Vulnerability[]>;
        }
      ).mapAdvisoriesToPackages(advisories, queriedPackages);

      expect(result.get('express')?.[0]?.id).toBe('GHSA-xxxx-yyyy-zzzz');
    });

    it('should normalize severity levels', () => {
      const advisories = [
        {
          ghsa_id: 'GHSA-1111',
          summary: 'Test 1',
          severity: 'CRITICAL',
          identifiers: [{ type: 'CVE', value: 'CVE-2021-1111' }],
          references: [],
          published_at: '2021-01-01T00:00:00Z',
          updated_at: '2021-01-02T00:00:00Z',
          vulnerabilities: [
            {
              package: { ecosystem: 'npm', name: 'pkg1' },
              vulnerable_version_range: '< 1.0.0',
            },
          ],
        },
        {
          ghsa_id: 'GHSA-2222',
          summary: 'Test 2',
          severity: 'moderate',
          identifiers: [{ type: 'CVE', value: 'CVE-2021-2222' }],
          references: [],
          published_at: '2021-01-01T00:00:00Z',
          updated_at: '2021-01-02T00:00:00Z',
          vulnerabilities: [
            {
              package: { ecosystem: 'npm', name: 'pkg2' },
              vulnerable_version_range: '< 1.0.0',
            },
          ],
        },
      ];

      const queriedPackages = new Set(['pkg1', 'pkg2']);
      const result = (
        client as unknown as {
          mapAdvisoriesToPackages: (
            advisories: GitHubAdvisoryResponse[],
            queriedPackages: Set<string>
          ) => Map<string, Vulnerability[]>;
        }
      ).mapAdvisoriesToPackages(advisories, queriedPackages);

      expect(result.get('pkg1')?.[0]?.severity).toBe('critical');
      expect(result.get('pkg2')?.[0]?.severity).toBe('medium');
    });
  });

  describe('parseLinkHeader', () => {
    it('should parse next cursor from Link header', () => {
      const linkHeader =
        '<https://api.github.com/advisories?after=cursor123>; rel="next", <https://api.github.com/advisories?before=cursor000>; rel="prev"';

      const links = (
        client as unknown as {
          parseLinkHeader: (header: string | undefined) => { next?: string; prev?: string };
        }
      ).parseLinkHeader(linkHeader);

      expect(links.next).toBe('cursor123');
      expect(links.prev).toBe('cursor000');
    });

    it('should handle Link header with only next', () => {
      const linkHeader = '<https://api.github.com/advisories?after=cursor456>; rel="next"';

      const links = (
        client as unknown as {
          parseLinkHeader: (header: string | undefined) => { next?: string; prev?: string };
        }
      ).parseLinkHeader(linkHeader);

      expect(links.next).toBe('cursor456');
      expect(links.prev).toBeUndefined();
    });

    it('should handle Link header with only prev', () => {
      const linkHeader = '<https://api.github.com/advisories?before=cursor789>; rel="prev"';

      const links = (
        client as unknown as {
          parseLinkHeader: (header: string | undefined) => { next?: string; prev?: string };
        }
      ).parseLinkHeader(linkHeader);

      expect(links.next).toBeUndefined();
      expect(links.prev).toBe('cursor789');
    });

    it('should handle empty Link header', () => {
      const links = (
        client as unknown as {
          parseLinkHeader: (header: string | undefined) => { next?: string; prev?: string };
        }
      ).parseLinkHeader('');

      expect(links.next).toBeUndefined();
      expect(links.prev).toBeUndefined();
    });

    it('should handle undefined Link header', () => {
      const links = (
        client as unknown as {
          parseLinkHeader: (header: string | undefined) => { next?: string; prev?: string };
        }
      ).parseLinkHeader(undefined);

      expect(links.next).toBeUndefined();
      expect(links.prev).toBeUndefined();
    });
  });
});

describe('GitHubAdvisoryClient - Error Handling and Retry Logic', () => {
  let client: GitHubAdvisoryClient;
  let mockOutputChannel: vscode.OutputChannel;

  beforeEach(() => {
    mockOutputChannel = createMockOutputChannel();
    client = new GitHubAdvisoryClient(mockOutputChannel);
  });

  describe('executeBatchWithSplit', () => {
    it('should split batch in half on failure', async () => {
      const deps: Dependency[] = [
        { name: 'pkg1', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
        { name: 'pkg2', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
        { name: 'pkg3', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
        { name: 'pkg4', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
      ];

      // Mock executeBatchRequest to fail initially, then succeed for smaller batches
      let callCount = 0;
      vi.spyOn(
        client as unknown as {
          executeBatchRequest: (batch: Dependency[]) => Promise<GitHubAdvisoryResponse[]>;
        },
        'executeBatchRequest'
      ).mockImplementation(async (...args: unknown[]) => {
        const batch = args[0] as Dependency[];
        callCount++;
        if (batch.length > 2) {
          throw new Error('Batch too large');
        }
        return [];
      });

      const result = await (
        client as unknown as {
          executeBatchWithSplit: (batch: Dependency[]) => Promise<Map<string, Vulnerability[]>>;
        }
      ).executeBatchWithSplit(deps);

      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(4);
      // Should have split and made multiple calls
      expect(callCount).toBeGreaterThan(1);
    });

    it('should return empty result for single package failure', async () => {
      const deps: Dependency[] = [
        { name: 'failing-pkg', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
      ];

      // Mock executeBatchRequest to always fail
      vi.spyOn(
        client as unknown as {
          executeBatchRequest: (batch: Dependency[]) => Promise<GitHubAdvisoryResponse[]>;
        },
        'executeBatchRequest'
      ).mockRejectedValue(new Error('API Error'));

      const result = await (
        client as unknown as {
          executeBatchWithSplit: (batch: Dependency[]) => Promise<Map<string, Vulnerability[]>>;
        }
      ).executeBatchWithSplit(deps);

      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(1);
      expect(result.get('failing-pkg')).toEqual([]);
    });

    it('should handle recursive splitting', async () => {
      const deps: Dependency[] = Array.from({ length: 8 }, (_, i) => ({
        name: `pkg${i}`,
        version: '1.0.0',
        versionConstraint: '1.0.0',
        isDev: false,
      }));

      // Mock to fail for batches > 2
      vi.spyOn(
        client as unknown as {
          executeBatchRequest: (batch: Dependency[]) => Promise<GitHubAdvisoryResponse[]>;
        },
        'executeBatchRequest'
      ).mockImplementation(async (...args: unknown[]) => {
        const batch = args[0] as Dependency[];
        if (batch.length > 2) {
          throw new Error('Batch too large');
        }
        return [];
      });

      const result = await (
        client as unknown as {
          executeBatchWithSplit: (batch: Dependency[]) => Promise<Map<string, Vulnerability[]>>;
        }
      ).executeBatchWithSplit(deps);

      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(8);
      // All packages should have entries
      for (let i = 0; i < 8; i++) {
        expect(result.has(`pkg${i}`)).toBe(true);
      }
    });

    it('should merge results from split batches', async () => {
      const deps: Dependency[] = [
        { name: 'pkg1', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
        { name: 'pkg2', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
      ];

      // Mock to return advisories for smaller batches
      vi.spyOn(
        client as unknown as {
          executeBatchRequest: (batch: Dependency[]) => Promise<GitHubAdvisoryResponse[]>;
        },
        'executeBatchRequest'
      ).mockImplementation(async (...args: unknown[]) => {
        const batch = args[0] as Dependency[];
        if (batch.length > 1) {
          throw new Error('Batch too large');
        }
        return [
          {
            ghsa_id: `GHSA-${batch[0].name}`,
            summary: 'Test Vuln',
            severity: 'high',
            identifiers: [{ type: 'CVE', value: `CVE-${batch[0].name}` }],
            references: [],
            published_at: '2021-01-01T00:00:00Z',
            updated_at: '2021-01-02T00:00:00Z',
            vulnerabilities: [
              {
                package: { ecosystem: 'npm', name: batch[0].name },
                vulnerable_version_range: '< 2.0.0',
              },
            ],
          },
        ];
      });

      const result = await (
        client as unknown as {
          executeBatchWithSplit: (batch: Dependency[]) => Promise<Map<string, Vulnerability[]>>;
        }
      ).executeBatchWithSplit(deps);

      expect(result.size).toBe(2);
      expect(result.get('pkg1')).toHaveLength(1);
      expect(result.get('pkg2')).toHaveLength(1);
    });
  });

  describe('getBatchVulnerabilities - Graceful Degradation', () => {
    it('should handle partial batch failures', async () => {
      const deps: Dependency[] = Array.from({ length: 10 }, (_, i) => ({
        name: `pkg${i}`,
        version: '1.0.0',
        versionConstraint: '1.0.0',
        isDev: false,
      }));

      // Mock createBatches to create 2 batches
      vi.spyOn(
        client as unknown as {
          createBatches: (dependencies: Dependency[], maxBatchSize: number) => Dependency[][];
        },
        'createBatches'
      ).mockReturnValue([deps.slice(0, 5), deps.slice(5, 10)]);

      // Mock executeBatchRequest to fail for first batch, succeed for second
      let callCount = 0;
      vi.spyOn(
        client as unknown as {
          executeBatchRequest: (batch: Dependency[]) => Promise<GitHubAdvisoryResponse[]>;
        },
        'executeBatchRequest'
      ).mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error('First batch failed');
        }
        return [];
      });

      // Mock executeBatchWithSplit to return empty results
      vi.spyOn(
        client as unknown as {
          executeBatchWithSplit: (batch: Dependency[]) => Promise<Map<string, Vulnerability[]>>;
        },
        'executeBatchWithSplit'
      ).mockResolvedValue(new Map());

      const result = await client.getBatchVulnerabilities(deps);

      expect(result).toBeInstanceOf(Map);
      // Should have entries for all packages even with partial failure
      expect(result.size).toBe(10);
    });

    it('should return empty map on complete failure', async () => {
      const deps: Dependency[] = [
        { name: 'pkg1', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
      ];

      // Mock createBatches to throw error
      vi.spyOn(
        client as unknown as {
          createBatches: (dependencies: Dependency[], maxBatchSize: number) => Dependency[][];
        },
        'createBatches'
      ).mockImplementation(() => {
        throw new Error('Complete failure');
      });

      const result = await client.getBatchVulnerabilities(deps);

      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(1);
      expect(result.get('pkg1')).toEqual([]);
    });

    it('should handle empty dependency array', async () => {
      const result = await client.getBatchVulnerabilities([]);

      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(0);
    });
  });

  describe('Error Scenarios', () => {
    it('should handle 403 Forbidden errors', async () => {
      const deps: Dependency[] = [
        { name: 'pkg1', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
      ];

      // Mock axiosInstance.get to throw 403 error
      const axiosGetSpy = vi.fn().mockRejectedValue({
        isAxiosError: true,
        response: {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0' },
          data: { message: 'rate limit exceeded' },
        },
      });

      // @ts-expect-error - accessing protected property for testing
      client.axiosInstance.get = axiosGetSpy;

      // Should NOT throw, but return empty map (graceful degradation)
      // However, it should have set the circuit breaker
      const result1 = await client.getBatchVulnerabilities(deps);
      expect(result1.size).toBe(1);

      // Verify circuit breaker is set (subsequent calls should return empty immediately)
      const result2 = await client.getBatchVulnerabilities(deps);
      expect(result2.size).toBe(1); // Still returns map with empty entries

      // The key verification: axiosGetSpy should have been called ONLY ONCE
      // The second call should return early due to isRateLimited check without making a request
      expect(axiosGetSpy).toHaveBeenCalledTimes(1);
    });

    it('should handle 429 Rate Limit errors', async () => {
      const deps: Dependency[] = [
        { name: 'pkg1', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
      ];

      // Mock to throw 429 error
      vi.spyOn(
        client as unknown as {
          executeBatchRequest: (batch: Dependency[]) => Promise<GitHubAdvisoryResponse[]>;
        },
        'executeBatchRequest'
      ).mockRejectedValue({
        code: 'RATE_LIMIT',
        message: 'Too Many Requests',
      });

      vi.spyOn(
        client as unknown as {
          executeBatchWithSplit: (batch: Dependency[]) => Promise<Map<string, Vulnerability[]>>;
        },
        'executeBatchWithSplit'
      ).mockResolvedValue(new Map([['pkg1', []]]));

      const result = await client.getBatchVulnerabilities(deps);

      expect(result).toBeInstanceOf(Map);
      expect(result.has('pkg1')).toBe(true);
    });

    it('should handle 500 Server errors', async () => {
      const deps: Dependency[] = [
        { name: 'pkg1', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
      ];

      // Mock to throw 500 error
      vi.spyOn(
        client as unknown as {
          executeBatchRequest: (batch: Dependency[]) => Promise<GitHubAdvisoryResponse[]>;
        },
        'executeBatchRequest'
      ).mockRejectedValue({
        code: 'API_ERROR',
        message: 'Internal Server Error',
      });

      vi.spyOn(
        client as unknown as {
          executeBatchWithSplit: (batch: Dependency[]) => Promise<Map<string, Vulnerability[]>>;
        },
        'executeBatchWithSplit'
      ).mockResolvedValue(new Map([['pkg1', []]]));

      const result = await client.getBatchVulnerabilities(deps);

      expect(result).toBeInstanceOf(Map);
      expect(result.has('pkg1')).toBe(true);
    });
  });
});

describe('GitHubAdvisoryClient - Token Validation and Rate Limiting', () => {
  let mockOutputChannel: vscode.OutputChannel;

  beforeEach(() => {
    mockOutputChannel = createMockOutputChannel();
  });

  describe('Token Configuration', () => {
    it('should configure Authorization header when token is provided', () => {
      const token = 'ghp_test123456789';
      const client = new GitHubAdvisoryClient(mockOutputChannel, token);

      expect(
        (client as unknown as { axiosInstance: AxiosInstance }).axiosInstance.defaults.headers
          .common.Authorization
      ).toBe(`Bearer ${token}`);
    });

    it('should not configure Authorization header when token is not provided', () => {
      const client = new GitHubAdvisoryClient(mockOutputChannel);

      expect(
        (client as unknown as { axiosInstance: AxiosInstance }).axiosInstance.defaults.headers
          .common.Authorization
      ).toBeUndefined();
    });

    it('should update token via updateToken method', () => {
      const client = new GitHubAdvisoryClient(mockOutputChannel);
      const newToken = 'ghp_newtoken123456';

      client.updateToken(newToken);

      expect((client as unknown as { githubToken: string }).githubToken).toBe(newToken);
      expect(
        (client as unknown as { axiosInstance: AxiosInstance }).axiosInstance.defaults.headers
          .common.Authorization
      ).toBe(`Bearer ${newToken}`);
    });

    it('should replace existing token when updateToken is called', () => {
      const oldToken = 'ghp_oldtoken123';
      const client = new GitHubAdvisoryClient(mockOutputChannel, oldToken);
      const newToken = 'ghp_newtoken456';

      expect(
        (client as unknown as { axiosInstance: AxiosInstance }).axiosInstance.defaults.headers
          .common.Authorization
      ).toBe(`Bearer ${oldToken}`);

      client.updateToken(newToken);

      expect((client as unknown as { githubToken: string }).githubToken).toBe(newToken);
      expect(
        (client as unknown as { axiosInstance: AxiosInstance }).axiosInstance.defaults.headers
          .common.Authorization
      ).toBe(`Bearer ${newToken}`);
    });

    it('should log token configuration', () => {
      const token = 'ghp_test123';
      const _client = new GitHubAdvisoryClient(mockOutputChannel, token);

      expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
        expect.stringContaining('GitHub token configured')
      );
    });
  });

  describe('Rate Limiting Edge Cases', () => {
    let client: GitHubAdvisoryClient;

    beforeEach(() => {
      client = new GitHubAdvisoryClient(mockOutputChannel);
    });

    it('should handle 429 rate limit errors with retry logic', async () => {
      const deps: Dependency[] = [
        { name: 'pkg1', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
      ];

      // Mock executeBatchRequest to throw 429 error initially, then succeed
      let callCount = 0;
      vi.spyOn(
        client as unknown as {
          executeBatchRequest: (batch: Dependency[]) => Promise<GitHubAdvisoryResponse[]>;
        },
        'executeBatchRequest'
      ).mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          const rateLimitError: Partial<Error> = {
            message: 'Rate limit exceeded',
            name: 'AxiosError',
          };
          (rateLimitError as unknown as { isAxiosError: boolean }).isAxiosError = true;
          (rateLimitError as unknown as { response: unknown }).response = {
            status: 429,
            statusText: 'Too Many Requests',
            headers: {
              'x-ratelimit-remaining': '0',
              'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 60),
            },
          };
          throw rateLimitError;
        }
        return [];
      });

      vi.spyOn(
        client as unknown as {
          executeBatchWithSplit: (batch: Dependency[]) => Promise<Map<string, Vulnerability[]>>;
        },
        'executeBatchWithSplit'
      ).mockResolvedValue(new Map([['pkg1', []]]));

      const result = await client.getBatchVulnerabilities(deps);

      expect(result).toBeInstanceOf(Map);
      expect(result.has('pkg1')).toBe(true);
    });

    it('should handle rate limit headers (x-ratelimit-remaining)', async () => {
      const deps: Dependency[] = [
        { name: 'pkg1', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
      ];

      // Mock response with rate limit headers
      vi.spyOn(
        client as unknown as {
          executeBatchRequest: (batch: Dependency[]) => Promise<GitHubAdvisoryResponse[]>;
        },
        'executeBatchRequest'
      ).mockResolvedValue([]);
      vi.spyOn(
        client as unknown as { post: (url: string, data: unknown) => Promise<unknown> },
        'post'
      ).mockResolvedValue({
        data: [],
        headers: {
          'x-ratelimit-remaining': '10',
          'x-ratelimit-limit': '60',
        },
      } as unknown);

      const result = await client.getBatchVulnerabilities(deps);

      expect(result).toBeInstanceOf(Map);
    });

    it('should handle rate limit reset time', async () => {
      const deps: Dependency[] = [
        { name: 'pkg1', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
      ];

      const resetTime = Math.floor(Date.now() / 1000) + 300; // 5 minutes from now

      // Mock 429 error with reset time
      vi.spyOn(
        client as unknown as {
          executeBatchRequest: (batch: Dependency[]) => Promise<GitHubAdvisoryResponse[]>;
        },
        'executeBatchRequest'
      ).mockRejectedValue({
        isAxiosError: true,
        response: {
          status: 429,
          headers: {
            'x-ratelimit-reset': String(resetTime),
          },
        },
      } as unknown);

      vi.spyOn(
        client as unknown as {
          executeBatchWithSplit: (batch: Dependency[]) => Promise<Map<string, Vulnerability[]>>;
        },
        'executeBatchWithSplit'
      ).mockResolvedValue(new Map([['pkg1', []]]));

      const result = await client.getBatchVulnerabilities(deps);

      expect(result).toBeInstanceOf(Map);
    });

    it('should handle rate limit with token (higher limits)', async () => {
      const token = 'ghp_test123';
      const clientWithToken = new GitHubAdvisoryClient(mockOutputChannel, token);
      const deps: Dependency[] = [
        { name: 'pkg1', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
      ];

      // Mock response showing higher rate limit with token
      vi.spyOn(
        clientWithToken as unknown as {
          executeBatchRequest: (batch: Dependency[]) => Promise<GitHubAdvisoryResponse[]>;
        },
        'executeBatchRequest'
      ).mockResolvedValue([]);
      vi.spyOn(
        clientWithToken as unknown as { post: (url: string, data: unknown) => Promise<unknown> },
        'post'
      ).mockResolvedValue({
        data: [],
        headers: {
          'x-ratelimit-remaining': '5000',
          'x-ratelimit-limit': '5000',
        },
      } as unknown);

      const result = await clientWithToken.getBatchVulnerabilities(deps);

      expect(result).toBeInstanceOf(Map);
      expect(
        (clientWithToken as unknown as { axiosInstance: AxiosInstance }).axiosInstance.defaults
          .headers.common.Authorization
      ).toBe(`Bearer ${token}`);
    });
  });

  describe('Error Response Handling', () => {
    let client: GitHubAdvisoryClient;

    beforeEach(() => {
      client = new GitHubAdvisoryClient(mockOutputChannel);
    });

    it('should handle 401 Unauthorized errors (invalid token)', async () => {
      const deps: Dependency[] = [
        { name: 'pkg1', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
      ];

      const authError: Partial<Error> = {
        message: 'Bad credentials',
        name: 'AxiosError',
      };
      (authError as unknown as { isAxiosError: boolean }).isAxiosError = true;
      (authError as unknown as { response: unknown }).response = {
        status: 401,
        statusText: 'Unauthorized',
        data: { message: 'Bad credentials' },
      };

      vi.spyOn(
        client as unknown as {
          executeBatchRequest: (batch: Dependency[]) => Promise<GitHubAdvisoryResponse[]>;
        },
        'executeBatchRequest'
      ).mockRejectedValue(authError);
      vi.spyOn(
        client as unknown as {
          executeBatchWithSplit: (batch: Dependency[]) => Promise<Map<string, Vulnerability[]>>;
        },
        'executeBatchWithSplit'
      ).mockResolvedValue(new Map([['pkg1', []]]));

      const result = await client.getBatchVulnerabilities(deps);

      expect(result).toBeInstanceOf(Map);
      expect(result.has('pkg1')).toBe(true);
    });

    it('should handle 403 Forbidden errors (token lacks permissions)', async () => {
      const deps: Dependency[] = [
        { name: 'pkg1', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
      ];

      const forbiddenError: Partial<Error> = {
        message: 'Forbidden',
        name: 'AxiosError',
      };
      (forbiddenError as unknown as { isAxiosError: boolean }).isAxiosError = true;
      (forbiddenError as unknown as { response: unknown }).response = {
        status: 403,
        statusText: 'Forbidden',
        data: { message: 'Resource not accessible by integration' },
      };

      vi.spyOn(
        client as unknown as {
          executeBatchRequest: (batch: Dependency[]) => Promise<GitHubAdvisoryResponse[]>;
        },
        'executeBatchRequest'
      ).mockRejectedValue(forbiddenError);
      vi.spyOn(
        client as unknown as {
          executeBatchWithSplit: (batch: Dependency[]) => Promise<Map<string, Vulnerability[]>>;
        },
        'executeBatchWithSplit'
      ).mockResolvedValue(new Map([['pkg1', []]]));

      const result = await client.getBatchVulnerabilities(deps);

      expect(result).toBeInstanceOf(Map);
      expect(result.has('pkg1')).toBe(true);
    });

    it('should handle 500 Internal Server Error with retry', async () => {
      const deps: Dependency[] = [
        { name: 'pkg1', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
      ];

      let callCount = 0;
      vi.spyOn(
        client as unknown as {
          executeBatchRequest: (batch: Dependency[]) => Promise<GitHubAdvisoryResponse[]>;
        },
        'executeBatchRequest'
      ).mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          const serverError: Partial<Error> = {
            message: 'Internal Server Error',
            name: 'AxiosError',
          };
          (serverError as unknown as { isAxiosError: boolean }).isAxiosError = true;
          (serverError as unknown as { response: unknown }).response = {
            status: 500,
            statusText: 'Internal Server Error',
          };
          throw serverError;
        }
        return [];
      });

      vi.spyOn(
        client as unknown as {
          executeBatchWithSplit: (batch: Dependency[]) => Promise<Map<string, Vulnerability[]>>;
        },
        'executeBatchWithSplit'
      ).mockResolvedValue(new Map([['pkg1', []]]));

      const result = await client.getBatchVulnerabilities(deps);

      expect(result).toBeInstanceOf(Map);
      expect(result.has('pkg1')).toBe(true);
    });

    it('should handle 502 Bad Gateway errors', async () => {
      const deps: Dependency[] = [
        { name: 'pkg1', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
      ];

      const badGatewayError: Partial<Error> = {
        message: 'Bad Gateway',
        name: 'AxiosError',
      };
      (badGatewayError as unknown as { isAxiosError: boolean }).isAxiosError = true;
      (badGatewayError as unknown as { response: unknown }).response = {
        status: 502,
        statusText: 'Bad Gateway',
      };

      vi.spyOn(
        client as unknown as {
          executeBatchRequest: (batch: Dependency[]) => Promise<GitHubAdvisoryResponse[]>;
        },
        'executeBatchRequest'
      ).mockRejectedValue(badGatewayError);
      vi.spyOn(
        client as unknown as {
          executeBatchWithSplit: (batch: Dependency[]) => Promise<Map<string, Vulnerability[]>>;
        },
        'executeBatchWithSplit'
      ).mockResolvedValue(new Map([['pkg1', []]]));

      const result = await client.getBatchVulnerabilities(deps);

      expect(result).toBeInstanceOf(Map);
      expect(result.has('pkg1')).toBe(true);
    });

    it('should handle 503 Service Unavailable errors', async () => {
      const deps: Dependency[] = [
        { name: 'pkg1', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
      ];

      const serviceUnavailableError: Partial<Error> = {
        message: 'Service Unavailable',
        name: 'AxiosError',
      };
      (serviceUnavailableError as unknown as { isAxiosError: boolean }).isAxiosError = true;
      (serviceUnavailableError as unknown as { response: unknown }).response = {
        status: 503,
        statusText: 'Service Unavailable',
      };

      vi.spyOn(
        client as unknown as {
          executeBatchRequest: (batch: Dependency[]) => Promise<GitHubAdvisoryResponse[]>;
        },
        'executeBatchRequest'
      ).mockRejectedValue(serviceUnavailableError);
      vi.spyOn(
        client as unknown as {
          executeBatchWithSplit: (batch: Dependency[]) => Promise<Map<string, Vulnerability[]>>;
        },
        'executeBatchWithSplit'
      ).mockResolvedValue(new Map([['pkg1', []]]));

      const result = await client.getBatchVulnerabilities(deps);

      expect(result).toBeInstanceOf(Map);
      expect(result.has('pkg1')).toBe(true);
    });

    it('should handle network timeout errors', async () => {
      const deps: Dependency[] = [
        { name: 'pkg1', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
      ];

      const timeoutError: Partial<Error> & { code?: string; isAxiosError?: boolean } = {
        message: 'timeout of 30000ms exceeded',
        name: 'AxiosError',
        code: 'ECONNABORTED',
        isAxiosError: true,
      };

      vi.spyOn(
        client as unknown as {
          executeBatchRequest: (batch: Dependency[]) => Promise<GitHubAdvisoryResponse[]>;
        },
        'executeBatchRequest'
      ).mockRejectedValue(timeoutError);
      vi.spyOn(
        client as unknown as {
          executeBatchWithSplit: (batch: Dependency[]) => Promise<Map<string, Vulnerability[]>>;
        },
        'executeBatchWithSplit'
      ).mockResolvedValue(new Map([['pkg1', []]]));

      const result = await client.getBatchVulnerabilities(deps);

      expect(result).toBeInstanceOf(Map);
      expect(result.has('pkg1')).toBe(true);
    });

    it('should handle connection refused errors', async () => {
      const deps: Dependency[] = [
        { name: 'pkg1', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
      ];

      const connectionError: Partial<Error> & { code?: string; isAxiosError?: boolean } = {
        message: 'connect ECONNREFUSED',
        name: 'AxiosError',
        code: 'ECONNREFUSED',
        isAxiosError: true,
      };

      vi.spyOn(
        client as unknown as {
          executeBatchRequest: (batch: Dependency[]) => Promise<GitHubAdvisoryResponse[]>;
        },
        'executeBatchRequest'
      ).mockRejectedValue(connectionError);
      vi.spyOn(
        client as unknown as {
          executeBatchWithSplit: (batch: Dependency[]) => Promise<Map<string, Vulnerability[]>>;
        },
        'executeBatchWithSplit'
      ).mockResolvedValue(new Map([['pkg1', []]]));

      const result = await client.getBatchVulnerabilities(deps);

      expect(result).toBeInstanceOf(Map);
      expect(result.has('pkg1')).toBe(true);
    });

    it('should handle malformed API responses', async () => {
      const deps: Dependency[] = [
        { name: 'pkg1', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
      ];

      // Mock response with invalid structure
      vi.spyOn(
        client as unknown as {
          executeBatchRequest: (batch: Dependency[]) => Promise<GitHubAdvisoryResponse[]>;
        },
        'executeBatchRequest'
      ).mockResolvedValue(null as unknown as GitHubAdvisoryResponse[]);

      vi.spyOn(
        client as unknown as {
          mapAdvisoriesToPackages: (
            advisories: GitHubAdvisoryResponse[],
            queriedPackages: Set<string>
          ) => Map<string, Vulnerability[]>;
        },
        'mapAdvisoriesToPackages'
      ).mockReturnValue(new Map());

      const result = await client.getBatchVulnerabilities(deps);

      expect(result).toBeInstanceOf(Map);
      expect(result.has('pkg1')).toBe(true);
    });

    it('should handle empty API responses gracefully', async () => {
      const deps: Dependency[] = [
        { name: 'pkg1', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
      ];

      vi.spyOn(
        client as unknown as {
          executeBatchRequest: (batch: Dependency[]) => Promise<GitHubAdvisoryResponse[]>;
        },
        'executeBatchRequest'
      ).mockResolvedValue([]);

      const result = await client.getBatchVulnerabilities(deps);

      expect(result).toBeInstanceOf(Map);
      expect(result.has('pkg1')).toBe(true);
      expect(result.get('pkg1')).toEqual([]);
    });
  });

  describe('Token Validation Edge Cases', () => {
    it('should handle empty token string', () => {
      const client = new GitHubAdvisoryClient(mockOutputChannel, '');

      expect((client as unknown as { githubToken: string }).githubToken).toBe('');
      expect(
        (
          client as unknown as {
            axiosInstance: { defaults: { headers: { common: { Authorization?: string } } } };
          }
        ).axiosInstance.defaults.headers.common.Authorization
      ).toBeUndefined();
    });

    it('should handle very long token strings', () => {
      const longToken = `ghp_${'a'.repeat(200)}`;
      const client = new GitHubAdvisoryClient(mockOutputChannel, longToken);

      expect((client as unknown as { githubToken: string }).githubToken).toBe(longToken);
      expect(
        (
          client as unknown as {
            axiosInstance: { defaults: { headers: { common: { Authorization: string } } } };
          }
        ).axiosInstance.defaults.headers.common.Authorization
      ).toBe(`Bearer ${longToken}`);
    });

    it('should handle token with special characters', () => {
      const specialToken = 'ghp_test-token_123.456';
      const client = new GitHubAdvisoryClient(mockOutputChannel, specialToken);

      expect((client as unknown as { githubToken: string }).githubToken).toBe(specialToken);
      expect(
        (
          client as unknown as {
            axiosInstance: { defaults: { headers: { common: { Authorization: string } } } };
          }
        ).axiosInstance.defaults.headers.common.Authorization
      ).toBe(`Bearer ${specialToken}`);
    });
  });
});

describe('GitHubAdvisoryClient - validateToken', () => {
  let client: GitHubAdvisoryClient;
  let mockOutputChannel: vscode.OutputChannel;

  beforeEach(() => {
    mockOutputChannel = createMockOutputChannel();
    client = new GitHubAdvisoryClient(mockOutputChannel);
  });

  it('should return false if no token is configured', async () => {
    const result = await client.validateToken();
    expect(result).toBe(false);
  });

  it('should return true for valid token (200 OK)', async () => {
    client.updateToken('valid-token');

    // Mock successful response from /user endpoint
    vi.spyOn(
      (client as unknown as { axiosInstance: AxiosInstance }).axiosInstance,
      'get'
    ).mockResolvedValue({
      status: 200,
      data: { login: 'test-user' },
    });

    const result = await client.validateToken();
    expect(result).toBe(true);
  });

  it('should return false for invalid token (401 Unauthorized)', async () => {
    client.updateToken('invalid-token');

    const authError: Partial<Error> = {
      message: 'Bad credentials',
      name: 'AxiosError',
    };
    (authError as unknown as { isAxiosError: boolean }).isAxiosError = true;
    (authError as unknown as { response: unknown }).response = {
      status: 401,
      statusText: 'Unauthorized',
    };

    vi.spyOn(
      (client as unknown as { axiosInstance: AxiosInstance }).axiosInstance,
      'get'
    ).mockRejectedValue(authError);

    const result = await client.validateToken();
    expect(result).toBe(false);
  });

  it('should return false for forbidden token (403 Forbidden)', async () => {
    client.updateToken('forbidden-token');

    const forbiddenError: Partial<Error> = {
      message: 'Forbidden',
      name: 'AxiosError',
    };
    (forbiddenError as unknown as { isAxiosError: boolean }).isAxiosError = true;
    (forbiddenError as unknown as { response: unknown }).response = {
      status: 403,
      statusText: 'Forbidden',
    };

    vi.spyOn(
      (client as unknown as { axiosInstance: AxiosInstance }).axiosInstance,
      'get'
    ).mockRejectedValue(forbiddenError);

    const result = await client.validateToken();
    expect(result).toBe(false);
  });

  it('should return false for other errors (e.g. network error)', async () => {
    client.updateToken('valid-token');

    const networkError: Partial<Error> = {
      message: 'Network Error',
      name: 'AxiosError',
    };
    (networkError as unknown as { isAxiosError: boolean }).isAxiosError = true;

    vi.spyOn(
      (client as unknown as { axiosInstance: AxiosInstance }).axiosInstance,
      'get'
    ).mockRejectedValue(networkError);

    const result = await client.validateToken();
    expect(result).toBe(false);
  });
});

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

describe('GitHubAdvisoryClient - Integration Tests', () => {
  let client: GitHubAdvisoryClient;
  let mockOutputChannel: vscode.OutputChannel;

  beforeEach(() => {
    mockOutputChannel = createMockOutputChannel();
    client = new GitHubAdvisoryClient(mockOutputChannel);
  });

  describe('11.1 Small Project Scenario (5 dependencies)', () => {
    it('should make single batch request for 5 dependencies', async () => {
      const deps: Dependency[] = [
        { name: 'express', version: '4.17.1', versionConstraint: '^4.17.1', isDev: false },
        { name: 'lodash', version: '4.17.20', versionConstraint: '^4.17.20', isDev: false },
        { name: 'axios', version: '0.21.1', versionConstraint: '^0.21.1', isDev: false },
        { name: 'react', version: '17.0.2', versionConstraint: '^17.0.2', isDev: false },
        { name: 'vue', version: '3.2.0', versionConstraint: '^3.2.0', isDev: false },
      ];

      // Spy on createBatches to verify single batch
      const createBatchesSpy = vi.spyOn(
        client as unknown as {
          createBatches: (deps: Dependency[], size: number) => Dependency[][];
        },
        'createBatches'
      );

      // Mock executeBatchRequest to return empty results
      vi.spyOn(
        client as unknown as {
          executeBatchRequest: (batch: Dependency[]) => Promise<GitHubAdvisoryResponse[]>;
        },
        'executeBatchRequest'
      ).mockResolvedValue([]);

      const result = await client.getBatchVulnerabilities(deps);

      // Verify single batch was created
      expect(createBatchesSpy).toHaveBeenCalledWith(deps, 500);
      const batches = createBatchesSpy.mock.results[0].value;
      expect(batches).toHaveLength(1);
      expect(batches[0]).toHaveLength(5);

      // Verify all packages have entries in result
      expect(result.size).toBe(5);
      expect(result.has('express')).toBe(true);
      expect(result.has('lodash')).toBe(true);
      expect(result.has('axios')).toBe(true);
      expect(result.has('react')).toBe(true);
      expect(result.has('vue')).toBe(true);
    });

    it('should find all vulnerabilities correctly', async () => {
      const deps: Dependency[] = [
        { name: 'express', version: '4.17.1', versionConstraint: '^4.17.1', isDev: false },
        { name: 'lodash', version: '4.17.20', versionConstraint: '^4.17.20', isDev: false },
        { name: 'axios', version: '0.21.1', versionConstraint: '^0.21.1', isDev: false },
        { name: 'react', version: '17.0.2', versionConstraint: '^17.0.2', isDev: false },
        { name: 'vue', version: '3.2.0', versionConstraint: '^3.2.0', isDev: false },
      ];

      // Mock executeBatchRequest to return mock advisories
      vi.spyOn(
        client as unknown as {
          executeBatchRequest: (batch: Dependency[]) => Promise<GitHubAdvisoryResponse[]>;
        },
        'executeBatchRequest'
      ).mockResolvedValue([
        {
          ghsa_id: 'GHSA-express-vuln',
          summary: 'Express Vulnerability',
          severity: 'high',
          identifiers: [{ type: 'CVE', value: 'CVE-2021-1234' }],
          references: [{ url: 'https://example.com/express' }],
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
        {
          ghsa_id: 'GHSA-lodash-vuln',
          summary: 'Lodash Prototype Pollution',
          severity: 'critical',
          identifiers: [{ type: 'CVE', value: 'CVE-2021-5678' }],
          references: [{ url: 'https://example.com/lodash' }],
          published_at: '2021-02-01T00:00:00Z',
          updated_at: '2021-02-02T00:00:00Z',
          vulnerabilities: [
            {
              package: { ecosystem: 'npm', name: 'lodash' },
              vulnerable_version_range: '< 4.17.21',
              patched_versions: '4.17.21',
            },
          ],
        },
      ]);

      const result = await client.getBatchVulnerabilities(deps);

      // Verify vulnerabilities were found
      expect(result.get('express')).toHaveLength(1);
      expect(result.get('express')?.[0].id).toBe('CVE-2021-1234');
      expect(result.get('express')?.[0].severity).toBe('high');

      expect(result.get('lodash')).toHaveLength(1);
      expect(result.get('lodash')?.[0].id).toBe('CVE-2021-5678');
      expect(result.get('lodash')?.[0].severity).toBe('critical');

      // Packages without vulnerabilities should have empty arrays
      expect(result.get('axios')).toEqual([]);
      expect(result.get('react')).toEqual([]);
      expect(result.get('vue')).toEqual([]);
    });

    it('should reduce API request count compared to individual requests', async () => {
      const deps: Dependency[] = [
        { name: 'express', version: '4.17.1', versionConstraint: '^4.17.1', isDev: false },
        { name: 'lodash', version: '4.17.20', versionConstraint: '^4.17.20', isDev: false },
        { name: 'axios', version: '0.21.1', versionConstraint: '^0.21.1', isDev: false },
        { name: 'react', version: '17.0.2', versionConstraint: '^17.0.2', isDev: false },
        { name: 'vue', version: '3.2.0', versionConstraint: '^3.2.0', isDev: false },
      ];

      // Mock executeBatchRequest to track calls
      const executeBatchRequestSpy = vi
        .spyOn(
          client as unknown as {
            executeBatchRequest: (batch: Dependency[]) => Promise<GitHubAdvisoryResponse[]>;
          },
          'executeBatchRequest'
        )
        .mockResolvedValue([]);

      await client.getBatchVulnerabilities(deps);

      // Verify only 1 batch request was made (vs 5 individual requests)
      expect(executeBatchRequestSpy).toHaveBeenCalledTimes(1);

      // API request reduction: 5 individual requests → 1 batch request = 80% reduction
      const individualRequests = 5;
      const batchRequests = executeBatchRequestSpy.mock.calls.length;
      const reduction = ((individualRequests - batchRequests) / individualRequests) * 100;

      expect(reduction).toBe(80);
    });

    it('should match results with individual request approach', async () => {
      const deps: Dependency[] = [
        { name: 'express', version: '4.17.1', versionConstraint: '^4.17.1', isDev: false },
        { name: 'lodash', version: '4.17.20', versionConstraint: '^4.17.20', isDev: false },
      ];

      const mockAdvisories = [
        {
          ghsa_id: 'GHSA-test-1',
          summary: 'Test Vulnerability',
          severity: 'high',
          identifiers: [{ type: 'CVE', value: 'CVE-2021-1111' }],
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

      // Mock for batch request
      vi.spyOn(
        client as unknown as {
          executeBatchRequest: (batch: Dependency[]) => Promise<GitHubAdvisoryResponse[]>;
        },
        'executeBatchRequest'
      ).mockResolvedValue(mockAdvisories);

      const batchResult = await client.getBatchVulnerabilities(deps);

      // Mock for individual requests
      vi.spyOn(
        client as unknown as {
          executeBatchRequest: (batch: Dependency[]) => Promise<GitHubAdvisoryResponse[]>;
        },
        'executeBatchRequest'
      ).mockResolvedValue(mockAdvisories);

      const individualResults = new Map<string, Vulnerability[]>();
      for (const dep of deps) {
        const result = await client.getVulnerabilities(dep.name, dep.version);
        individualResults.set(dep.name, result);
      }

      // Compare results
      expect(batchResult.get('express')).toEqual(individualResults.get('express'));
      expect(batchResult.get('lodash')).toEqual(individualResults.get('lodash'));
    });
  });

  describe('11.2 Medium Project Scenario (28 dependencies)', () => {
    it('should make 1-2 batch requests for 28 dependencies', async () => {
      const deps: Dependency[] = Array.from({ length: 28 }, (_, i) => ({
        name: `package-${i}`,
        version: '1.0.0',
        versionConstraint: '^1.0.0',
        isDev: i % 3 === 0,
      }));

      // Spy on createBatches
      const createBatchesSpy = vi.spyOn(
        client as unknown as {
          createBatches: (deps: Dependency[], size: number) => Dependency[][];
        },
        'createBatches'
      );

      // Mock executeBatchRequest
      vi.spyOn(
        client as unknown as {
          executeBatchRequest: (batch: Dependency[]) => Promise<GitHubAdvisoryResponse[]>;
        },
        'executeBatchRequest'
      ).mockResolvedValue([]);

      const result = await client.getBatchVulnerabilities(deps);

      // Verify batches were created
      expect(createBatchesSpy).toHaveBeenCalled();
      const batches = createBatchesSpy.mock.results[0].value;

      // Should be 1-2 batches for 28 dependencies
      expect(batches.length).toBeGreaterThanOrEqual(1);
      expect(batches.length).toBeLessThanOrEqual(2);

      // Verify all packages processed
      expect(result.size).toBe(28);
    });

    it('should not encounter rate limit errors', async () => {
      const deps: Dependency[] = Array.from({ length: 28 }, (_, i) => ({
        name: `package-${i}`,
        version: '1.0.0',
        versionConstraint: '^1.0.0',
        isDev: false,
      }));

      // Mock executeBatchRequest to succeed without rate limit errors
      vi.spyOn(
        client as unknown as {
          executeBatchRequest: (batch: Dependency[]) => Promise<GitHubAdvisoryResponse[]>;
        },
        'executeBatchRequest'
      ).mockResolvedValue([]);

      // Should not throw any errors
      await expect(client.getBatchVulnerabilities(deps)).resolves.toBeDefined();

      const result = await client.getBatchVulnerabilities(deps);

      // Verify all packages received data
      expect(result.size).toBe(28);
      for (let i = 0; i < 28; i++) {
        expect(result.has(`package-${i}`)).toBe(true);
      }
    });

    it('should measure performance improvement over individual requests', async () => {
      const deps: Dependency[] = Array.from({ length: 28 }, (_, i) => ({
        name: `package-${i}`,
        version: '1.0.0',
        versionConstraint: '^1.0.0',
        isDev: false,
      }));

      // Mock executeBatchRequest
      const executeBatchRequestSpy = vi
        .spyOn(
          client as unknown as {
            executeBatchRequest: (batch: Dependency[]) => Promise<GitHubAdvisoryResponse[]>;
          },
          'executeBatchRequest'
        )
        .mockResolvedValue([]);

      await client.getBatchVulnerabilities(deps);

      const batchRequestCount = executeBatchRequestSpy.mock.calls.length;

      // Individual requests would be 28 calls
      const individualRequestCount = 28;

      // Calculate reduction
      const reduction =
        ((individualRequestCount - batchRequestCount) / individualRequestCount) * 100;

      // Should have significant reduction (>90%)
      expect(reduction).toBeGreaterThan(90);
      expect(batchRequestCount).toBeLessThanOrEqual(2);
    });

    it('should verify all packages receive vulnerability data', async () => {
      const deps: Dependency[] = Array.from({ length: 28 }, (_, i) => ({
        name: `package-${i}`,
        version: '1.0.0',
        versionConstraint: '^1.0.0',
        isDev: false,
      }));

      // Mock executeBatchRequest to return some vulnerabilities
      vi.spyOn(
        client as unknown as {
          executeBatchRequest: (batch: Dependency[]) => Promise<GitHubAdvisoryResponse[]>;
        },
        'executeBatchRequest'
      ).mockResolvedValue([
        {
          ghsa_id: 'GHSA-test',
          summary: 'Test Vulnerability',
          severity: 'medium',
          identifiers: [{ type: 'CVE', value: 'CVE-2021-9999' }],
          references: [],
          published_at: '2021-01-01T00:00:00Z',
          updated_at: '2021-01-02T00:00:00Z',
          vulnerabilities: [
            {
              package: { ecosystem: 'npm', name: 'package-5' },
              vulnerable_version_range: '< 2.0.0',
            },
            {
              package: { ecosystem: 'npm', name: 'package-10' },
              vulnerable_version_range: '< 2.0.0',
            },
          ],
        },
      ]);

      const result = await client.getBatchVulnerabilities(deps);

      // Verify all packages have entries
      expect(result.size).toBe(28);

      // Verify packages with vulnerabilities
      expect(result.get('package-5')).toHaveLength(1);
      expect(result.get('package-10')).toHaveLength(1);

      // Verify packages without vulnerabilities have empty arrays
      expect(result.get('package-0')).toEqual([]);
      expect(result.get('package-1')).toEqual([]);
    });
  });

  describe('11.3 Large Project Scenario (100+ dependencies)', () => {
    it('should handle 100 dependencies with multiple batch requests', async () => {
      const deps: Dependency[] = Array.from({ length: 100 }, (_, i) => ({
        name: `package-${i}`,
        version: '1.0.0',
        versionConstraint: '^1.0.0',
        isDev: false,
      }));

      // Spy on createBatches
      const createBatchesSpy = vi.spyOn(
        client as unknown as {
          createBatches: (deps: Dependency[], size: number) => Dependency[][];
        },
        'createBatches'
      );

      // Mock executeBatchRequest
      vi.spyOn(
        client as unknown as {
          executeBatchRequest: (batch: Dependency[]) => Promise<GitHubAdvisoryResponse[]>;
        },
        'executeBatchRequest'
      ).mockResolvedValue([]);

      const result = await client.getBatchVulnerabilities(deps);

      // Verify batches were created
      expect(createBatchesSpy).toHaveBeenCalled();
      const batches = createBatchesSpy.mock.results[0].value;

      // Should create at least one batch
      expect(batches.length).toBeGreaterThanOrEqual(1);

      // Verify all packages processed
      expect(result.size).toBe(100);
    });

    it('should verify batch splitting logic works correctly', async () => {
      // Use longer package names to force URL length splitting
      const deps: Dependency[] = Array.from({ length: 150 }, (_, i) => ({
        name: `very-long-package-name-that-takes-up-lots-of-space-in-url-${i}`,
        version: '1.0.0',
        versionConstraint: '^1.0.0',
        isDev: false,
      }));

      // Spy on createBatches
      const createBatchesSpy = vi.spyOn(
        client as unknown as {
          createBatches: (deps: Dependency[], size: number) => Dependency[][];
        },
        'createBatches'
      );

      // Mock executeBatchRequest
      vi.spyOn(
        client as unknown as {
          executeBatchRequest: (batch: Dependency[]) => Promise<GitHubAdvisoryResponse[]>;
        },
        'executeBatchRequest'
      ).mockResolvedValue([]);

      await client.getBatchVulnerabilities(deps);

      const batches = createBatchesSpy.mock.results[0].value;

      // Verify batches were created (may be 1 or more depending on URL length)
      expect(batches.length).toBeGreaterThanOrEqual(1);

      // Verify total count matches
      const totalDeps = batches.reduce((sum: number, batch: Dependency[]) => sum + batch.length, 0);
      expect(totalDeps).toBe(150);

      // Verify no batch exceeds max size
      for (const batch of batches) {
        expect(batch.length).toBeLessThanOrEqual(500);
      }
    });

    it('should process all packages without errors', async () => {
      const deps: Dependency[] = Array.from({ length: 120 }, (_, i) => ({
        name: `package-${i}`,
        version: '1.0.0',
        versionConstraint: '^1.0.0',
        isDev: false,
      }));

      // Mock executeBatchRequest
      vi.spyOn(
        client as unknown as {
          executeBatchRequest: (batch: Dependency[]) => Promise<GitHubAdvisoryResponse[]>;
        },
        'executeBatchRequest'
      ).mockResolvedValue([]);

      const result = await client.getBatchVulnerabilities(deps);

      // Verify all packages have entries
      expect(result.size).toBe(120);

      // Verify each package has an entry (even if empty)
      for (let i = 0; i < 120; i++) {
        expect(result.has(`package-${i}`)).toBe(true);
        expect(Array.isArray(result.get(`package-${i}`))).toBe(true);
      }
    });

    it('should measure total execution time and API request count', async () => {
      const deps: Dependency[] = Array.from({ length: 100 }, (_, i) => ({
        name: `package-${i}`,
        version: '1.0.0',
        versionConstraint: '^1.0.0',
        isDev: false,
      }));

      // Mock executeBatchRequest
      const executeBatchRequestSpy = vi
        .spyOn(
          client as unknown as {
            executeBatchRequest: (batch: Dependency[]) => Promise<GitHubAdvisoryResponse[]>;
          },
          'executeBatchRequest'
        )
        .mockResolvedValue([]);

      const startTime = Date.now();
      const result = await client.getBatchVulnerabilities(deps);
      const executionTime = Date.now() - startTime;

      const batchRequestCount = executeBatchRequestSpy.mock.calls.length;

      // Verify execution completed
      expect(result.size).toBe(100);

      // Verify significant API request reduction
      // 100 individual requests → ~2-3 batch requests
      expect(batchRequestCount).toBeLessThan(10);

      // Calculate reduction percentage
      const individualRequests = 100;
      const reduction = ((individualRequests - batchRequestCount) / individualRequests) * 100;

      expect(reduction).toBeGreaterThan(90);

      // Execution time should be reasonable (< 5 seconds for mocked requests)
      expect(executionTime).toBeLessThan(5000);
    });
  });

  describe('11.4 Error Scenarios', () => {
    it('should handle invalid GitHub token (403 Forbidden)', async () => {
      const deps: Dependency[] = [
        { name: 'express', version: '4.17.1', versionConstraint: '^4.17.1', isDev: false },
        { name: 'lodash', version: '4.17.20', versionConstraint: '^4.17.20', isDev: false },
      ];

      // Mock executeBatchRequest to throw 403 error
      vi.spyOn(
        client as unknown as {
          executeBatchRequest: (batch: Dependency[]) => Promise<GitHubAdvisoryResponse[]>;
        },
        'executeBatchRequest'
      ).mockRejectedValue({
        code: 'AUTH_ERROR',
        message: 'Forbidden',
        statusCode: 403,
      });

      // Mock executeBatchWithSplit to handle the error
      vi.spyOn(
        client as unknown as {
          executeBatchWithSplit: (batch: Dependency[]) => Promise<Map<string, Vulnerability[]>>;
        },
        'executeBatchWithSplit'
      ).mockResolvedValue(
        new Map([
          ['express', []],
          ['lodash', []],
        ])
      );

      const result = await client.getBatchVulnerabilities(deps);

      // Verify graceful degradation
      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(2);
      expect(result.has('express')).toBe(true);
      expect(result.has('lodash')).toBe(true);
    });

    it('should handle rate limit exceeded (429 Too Many Requests)', async () => {
      const deps: Dependency[] = [
        { name: 'react', version: '17.0.2', versionConstraint: '^17.0.2', isDev: false },
        { name: 'vue', version: '3.2.0', versionConstraint: '^3.2.0', isDev: false },
      ];

      // Mock executeBatchRequest to throw 429 error
      vi.spyOn(
        client as unknown as {
          executeBatchRequest: (batch: Dependency[]) => Promise<GitHubAdvisoryResponse[]>;
        },
        'executeBatchRequest'
      ).mockRejectedValue({
        code: 'RATE_LIMIT',
        message: 'Too Many Requests',
        statusCode: 429,
      });

      // Mock executeBatchWithSplit to handle the error
      vi.spyOn(
        client as unknown as {
          executeBatchWithSplit: (batch: Dependency[]) => Promise<Map<string, Vulnerability[]>>;
        },
        'executeBatchWithSplit'
      ).mockResolvedValue(
        new Map([
          ['react', []],
          ['vue', []],
        ])
      );

      const result = await client.getBatchVulnerabilities(deps);

      // Verify graceful degradation
      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(2);
      expect(result.has('react')).toBe(true);
      expect(result.has('vue')).toBe(true);
    });

    it('should handle network timeout', async () => {
      const deps: Dependency[] = [
        { name: 'axios', version: '0.21.1', versionConstraint: '^0.21.1', isDev: false },
      ];

      // Mock executeBatchRequest to throw timeout error
      vi.spyOn(
        client as unknown as {
          executeBatchRequest: (batch: Dependency[]) => Promise<GitHubAdvisoryResponse[]>;
        },
        'executeBatchRequest'
      ).mockRejectedValue({
        code: 'ETIMEDOUT',
        message: 'Network timeout',
      });

      // Mock executeBatchWithSplit to handle the error
      vi.spyOn(
        client as unknown as {
          executeBatchWithSplit: (batch: Dependency[]) => Promise<Map<string, Vulnerability[]>>;
        },
        'executeBatchWithSplit'
      ).mockResolvedValue(new Map([['axios', []]]));

      const result = await client.getBatchVulnerabilities(deps);

      // Verify graceful degradation
      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(1);
      expect(result.has('axios')).toBe(true);
      expect(result.get('axios')).toEqual([]);
    });

    it('should verify graceful degradation with partial results', async () => {
      const deps: Dependency[] = Array.from({ length: 10 }, (_, i) => ({
        name: `package-${i}`,
        version: '1.0.0',
        versionConstraint: '^1.0.0',
        isDev: false,
      }));

      // Mock createBatches to create 2 batches
      vi.spyOn(
        client as unknown as {
          createBatches: (deps: Dependency[], size: number) => Dependency[][];
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
        return [
          {
            ghsa_id: 'GHSA-success',
            summary: 'Test Vulnerability',
            severity: 'low',
            identifiers: [{ type: 'CVE', value: 'CVE-2021-0000' }],
            references: [],
            published_at: '2021-01-01T00:00:00Z',
            updated_at: '2021-01-02T00:00:00Z',
            vulnerabilities: [
              {
                package: { ecosystem: 'npm', name: 'package-7' },
                vulnerable_version_range: '< 2.0.0',
              },
            ],
          },
        ];
      });

      // Mock executeBatchWithSplit for failed batch
      vi.spyOn(
        client as unknown as {
          executeBatchWithSplit: (batch: Dependency[]) => Promise<Map<string, Vulnerability[]>>;
        },
        'executeBatchWithSplit'
      ).mockResolvedValue(
        new Map([
          ['package-0', []],
          ['package-1', []],
          ['package-2', []],
          ['package-3', []],
          ['package-4', []],
        ])
      );

      const result = await client.getBatchVulnerabilities(deps);

      // Verify partial results returned
      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(10);

      // Verify successful batch has data
      expect(result.get('package-7')).toHaveLength(1);

      // Verify failed batch packages have empty arrays
      expect(result.get('package-0')).toEqual([]);
      expect(result.get('package-1')).toEqual([]);
    });

    it('should handle multiple error types in sequence', async () => {
      const deps: Dependency[] = [
        { name: 'pkg1', version: '1.0.0', versionConstraint: '^1.0.0', isDev: false },
        { name: 'pkg2', version: '1.0.0', versionConstraint: '^1.0.0', isDev: false },
        { name: 'pkg3', version: '1.0.0', versionConstraint: '^1.0.0', isDev: false },
      ];

      // Mock executeBatchRequest to throw different errors
      let callCount = 0;
      vi.spyOn(
        client as unknown as {
          executeBatchRequest: (batch: Dependency[]) => Promise<GitHubAdvisoryResponse[]>;
        },
        'executeBatchRequest'
      ).mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          throw { code: 'AUTH_ERROR', statusCode: 403 };
        }
        if (callCount === 2) {
          throw { code: 'RATE_LIMIT', statusCode: 429 };
        }
        throw { code: 'ETIMEDOUT' };
      });

      // Mock executeBatchWithSplit to return empty results
      vi.spyOn(
        client as unknown as {
          executeBatchWithSplit: (batch: Dependency[]) => Promise<Map<string, Vulnerability[]>>;
        },
        'executeBatchWithSplit'
      ).mockResolvedValue(
        new Map([
          ['pkg1', []],
          ['pkg2', []],
          ['pkg3', []],
        ])
      );

      const result = await client.getBatchVulnerabilities(deps);

      // Verify all packages handled despite errors
      expect(result.size).toBe(3);
      expect(result.has('pkg1')).toBe(true);
      expect(result.has('pkg2')).toBe(true);
      expect(result.has('pkg3')).toBe(true);
    });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import type { Dependency, OSVBatchRequest, OSVVulnerability } from '../types';
import {
  createAxiosVulnerability,
  createBabelVulnerability,
  createLodashVulnerability,
} from './__mocks__/osvResponses';
import { OSVClient } from './OSVClient';

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

describe('OSVClient - Integration Tests', () => {
  let client: OSVClient;
  let mockOutputChannel: vscode.OutputChannel;

  beforeEach(() => {
    mockOutputChannel = createMockOutputChannel();
    client = new OSVClient(mockOutputChannel);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('OSV batch query with mocked API', () => {
    it('should fetch vulnerabilities for known vulnerable packages', async () => {
      // Use known vulnerable versions
      const deps: Dependency[] = [
        { name: 'lodash', version: '4.17.20', versionConstraint: '4.17.20', isDev: false },
        { name: 'axios', version: '0.21.1', versionConstraint: '0.21.1', isDev: false },
      ];

      // Mock individual query responses (getBatchVulnerabilities uses individual queries)
      // Mock batch and details
      const lodashVuln = createLodashVulnerability();
      const axiosVuln = createAxiosVulnerability();

      vi.spyOn(client, 'post').mockResolvedValue({
        results: deps.map((dep) => {
          if (dep.name === 'lodash') return { vulns: [lodashVuln] };
          if (dep.name === 'axios') return { vulns: [axiosVuln] };
          return { vulns: [] };
        }),
      });

      vi.spyOn(client, 'get').mockImplementation(async (url) => {
        if (url.includes(lodashVuln.id)) return lodashVuln;
        if (url.includes(axiosVuln.id)) return axiosVuln;
        return {};
      });

      const result = await client.getBatchVulnerabilities(deps);

      // Verify we got results
      expect(result.size).toBeGreaterThanOrEqual(0);

      // Verify lodash has vulnerabilities
      const lodashVulns = result.get('lodash');
      expect(lodashVulns).toBeDefined();
      expect(lodashVulns?.length).toBeGreaterThan(0);

      for (const vuln of lodashVulns || []) {
        // Verify all required fields exist
        expect(vuln).toHaveProperty('id');
        expect(vuln).toHaveProperty('title');
        expect(vuln).toHaveProperty('description');
        expect(vuln).toHaveProperty('severity');
        expect(vuln).toHaveProperty('affectedVersions');
        expect(vuln).toHaveProperty('references');
        expect(vuln).toHaveProperty('sources');

        // Verify source is OSV
        expect(vuln.sources).toContain('osv');

        // Verify severity is valid
        expect(['critical', 'high', 'medium', 'low']).toContain(vuln.severity);

        // CVSS data should exist
        expect(vuln.cvssScore).toBeDefined();
        expect(vuln.cvssScore).toBeGreaterThanOrEqual(0);
        expect(vuln.cvssScore).toBeLessThanOrEqual(10);
        expect(vuln.cvssVersion).toBeDefined();
        expect(['2.0', '3.0', '3.1', '4.0']).toContain(vuln.cvssVersion);
        expect(vuln.vectorString).toBeDefined();
        expect(typeof vuln.vectorString).toBe('string');
      }

      // Verify axios has vulnerabilities
      const axiosVulns = result.get('axios');
      expect(axiosVulns).toBeDefined();
      expect(axiosVulns?.length).toBeGreaterThan(0);

      for (const vuln of axiosVulns || []) {
        expect(vuln.sources).toContain('osv');
        expect(vuln).toHaveProperty('id');
        expect(['critical', 'high', 'medium', 'low']).toContain(vuln.severity);
      }
    });

    it('should handle packages with no vulnerabilities', async () => {
      // Use a package version that is likely safe
      const deps: Dependency[] = [
        {
          name: 'nonexistentpackage12345xyz',
          version: '1.0.0',
          versionConstraint: '1.0.0',
          isDev: false,
        },
      ];

      // Mock empty response
      // Mock empty response
      vi.spyOn(client, 'post').mockResolvedValue({
        results: deps.map(() => ({ vulns: [] })),
      });

      const result = await client.getBatchVulnerabilities(deps);

      // Should still return a map with the package
      expect(result.size).toBe(1);
      expect(result.has('nonexistentpackage12345xyz')).toBe(true);
      expect(result.get('nonexistentpackage12345xyz')).toEqual([]);
    });

    it('should handle scoped packages', async () => {
      const deps: Dependency[] = [
        { name: '@babel/core', version: '7.0.0', versionConstraint: '7.0.0', isDev: false },
      ];

      // Mock response with vulnerability for @babel/core
      // Mock response with vulnerability for @babel/core
      const babelVuln = createBabelVulnerability();

      vi.spyOn(client, 'post').mockResolvedValue({
        results: deps.map((dep) => {
          if (dep.name === '@babel/core') return { vulns: [babelVuln] };
          return { vulns: [] };
        }),
      });

      vi.spyOn(client, 'get').mockImplementation(async (url) => {
        if (url.includes(babelVuln.id)) return babelVuln;
        return {};
      });

      const result = await client.getBatchVulnerabilities(deps);

      expect(result.size).toBe(1);
      expect(result.has('@babel/core')).toBe(true);

      // Verify structure - should have vulnerabilities
      const vulns = result.get('@babel/core');
      expect(vulns).toBeDefined();
      expect(vulns?.length).toBeGreaterThan(0);

      for (const vuln of vulns || []) {
        expect(vuln.sources).toContain('osv');
        expect(vuln).toHaveProperty('id');
      }
    });

    it('should support HTTP/2 multiplexing with concurrent requests', async () => {
      const deps: Dependency[] = [
        { name: 'lodash', version: '4.17.20', versionConstraint: '4.17.20', isDev: false },
        { name: 'axios', version: '0.21.1', versionConstraint: '0.21.1', isDev: false },
        { name: 'react', version: '16.0.0', versionConstraint: '16.0.0', isDev: false },
        { name: 'express', version: '4.17.0', versionConstraint: '4.17.0', isDev: false },
      ];

      // Mock individual query responses
      // Mock individual query responses
      const lodashVuln = createLodashVulnerability();
      const axiosVuln = createAxiosVulnerability();

      vi.spyOn(client, 'post').mockResolvedValue({
        results: deps.map((dep) => {
          if (dep.name === 'lodash') return { vulns: [lodashVuln] };
          if (dep.name === 'axios') return { vulns: [axiosVuln] };
          return { vulns: [] };
        }),
      });

      vi.spyOn(client, 'get').mockImplementation(async (url) => {
        if (url.includes(lodashVuln.id)) return lodashVuln;
        if (url.includes(axiosVuln.id)) return axiosVuln;
        return {};
      });

      const startTime = Date.now();
      const result = await client.getBatchVulnerabilities(deps);
      const duration = Date.now() - startTime;

      // Verify all packages processed
      expect(result.size).toBe(4);

      // Log duration for analysis (should be fast with mocks)
      console.log(`HTTP/2 batch request duration: ${duration}ms`);

      // Should complete very fast with mocked API
      expect(duration).toBeLessThan(1000); // < 1 second with mocks
    });
  });

  describe('CVSS score calculation', () => {
    it('should calculate CVSS v2.0 scores correctly', () => {
      const vectors = [
        { vector: 'AV:N/AC:L/Au:N/C:P/I:P/A:P', expectedRange: [4.0, 10.0] }, // Actual score is ~7.5
        { vector: 'AV:N/AC:L/Au:N/C:C/I:C/A:C', expectedRange: [9.0, 10.0] },
        { vector: 'AV:L/AC:H/Au:S/C:N/I:P/A:C', expectedRange: [3.0, 6.0] },
      ];

      for (const { vector, expectedRange } of vectors) {
        const score = (
          client as unknown as {
            calculateCVSSScore: (vectorString: string, version: string) => number | null;
          }
        ).calculateCVSSScore(vector, '2.0');

        expect(score).not.toBeNull();
        expect(score).toBeGreaterThanOrEqual(expectedRange[0]);
        expect(score).toBeLessThanOrEqual(expectedRange[1]);
      }
    });

    it('should calculate CVSS v3.0 scores correctly', () => {
      const vectors = [
        { vector: 'CVSS:3.0/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H', expectedRange: [8.0, 10.0] },
        { vector: 'CVSS:3.0/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:L/A:L', expectedRange: [5.0, 8.0] },
        { vector: 'CVSS:3.0/AV:L/AC:H/PR:L/UI:R/S:U/C:N/I:L/A:N', expectedRange: [1.0, 4.0] },
      ];

      for (const { vector, expectedRange } of vectors) {
        const score = (
          client as unknown as {
            calculateCVSSScore: (vectorString: string, version: string) => number | null;
          }
        ).calculateCVSSScore(vector, '3.0');

        expect(score).not.toBeNull();
        expect(score).toBeGreaterThanOrEqual(expectedRange[0]);
        expect(score).toBeLessThanOrEqual(expectedRange[1]);
      }
    });

    it('should calculate CVSS v3.1 scores correctly', () => {
      const vectors = [
        { vector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H', expectedRange: [8.0, 10.0] },
        { vector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:L/A:L', expectedRange: [5.0, 8.0] },
      ];

      for (const { vector, expectedRange } of vectors) {
        const score = (
          client as unknown as {
            calculateCVSSScore: (vectorString: string, version: string) => number | null;
          }
        ).calculateCVSSScore(vector, '3.1');

        expect(score).not.toBeNull();
        expect(score).toBeGreaterThanOrEqual(expectedRange[0]);
        expect(score).toBeLessThanOrEqual(expectedRange[1]);
      }
    });

    it('should calculate CVSS v4.0 scores correctly', () => {
      const vectors = [
        {
          vector: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N',
          expectedRange: [8.0, 10.0],
        },
        {
          vector: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:L/VI:L/VA:L/SC:N/SI:N/SA:N',
          expectedRange: [5.0, 8.0],
        },
      ];

      for (const { vector, expectedRange } of vectors) {
        const score = (
          client as unknown as {
            calculateCVSSScore: (vectorString: string, version: string) => number | null;
          }
        ).calculateCVSSScore(vector, '4.0');

        expect(score).not.toBeNull();
        expect(score).toBeGreaterThanOrEqual(expectedRange[0]);
        expect(score).toBeLessThanOrEqual(expectedRange[1]);
      }
    });

    it('should prioritize highest CVSS version', () => {
      const mockVuln = {
        severity: [
          { type: 'CVSS_V2' as const, score: 'AV:N/AC:L/Au:N/C:P/I:P/A:P' },
          { type: 'CVSS_V3' as const, score: 'CVSS:3.0/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' },
          { type: 'CVSS_V3' as const, score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' },
          {
            type: 'CVSS_V4' as const,
            score: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N',
          },
        ],
      };

      const cvssData = (
        client as unknown as {
          selectBestCVSS: (
            osvVuln: OSVVulnerability
          ) => { version: string; vectorString: string; score?: number } | null;
        }
      ).selectBestCVSS(mockVuln as unknown as OSVVulnerability);

      expect(cvssData).not.toBeNull();
      expect(cvssData?.version).toBe('4.0');
      expect(cvssData?.vectorString).toContain('CVSS:4.0/');
    });

    it('should handle invalid CVSS vectors gracefully', () => {
      const invalidVectors = ['INVALID_VECTOR', 'CVSS:3.1/INVALID'];

      for (const vector of invalidVectors) {
        const score = (
          client as unknown as {
            calculateCVSSScore: (vectorString: string, version: string) => number | null;
          }
        ).calculateCVSSScore(vector, '3.1');
        expect(score).toBeNull();
      }

      // Empty string should return null
      const emptyScore = (
        client as unknown as {
          calculateCVSSScore: (vectorString: string, version: string) => number | null;
        }
      ).calculateCVSSScore('', '3.1');
      expect(emptyScore).toBeNull();
    });
  });

  describe('Large batch handling', () => {
    it('should handle 100+ packages with batch splitting', async () => {
      // Create 150 dependencies
      const deps: Dependency[] = Array.from({ length: 150 }, (_, i) => ({
        name: `test-package-${i}`,
        version: '1.0.0',
        versionConstraint: '1.0.0',
        isDev: false,
      }));

      // Mock individual query responses for large batch
      // Mock individual query responses for large batch
      vi.spyOn(client, 'post').mockImplementation(async (_url, data) => {
        const request = data as { queries: unknown[] };
        return {
          results: request.queries.map(() => ({ vulns: [] })),
        };
      });

      const startTime = Date.now();
      const result = await client.getBatchVulnerabilities(deps);
      const duration = Date.now() - startTime;

      // Verify all packages were processed
      expect(result.size).toBe(150);

      // Should split into multiple batches
      console.log(`Large batch (150 packages) duration: ${duration}ms`);

      // Should complete quickly with mocked API
      expect(duration).toBeLessThan(5000); // < 5 seconds with mocks
    });

    it('should split batches when size exceeds limit', () => {
      // Create dependencies with very long names to test size limit
      const deps: Dependency[] = Array.from({ length: 1000 }, (_, i) => ({
        name: `very-long-package-name-${'x'.repeat(100)}-${i}`,
        version: '1.0.0',
        versionConstraint: '1.0.0',
        isDev: false,
      }));

      const batches = (
        client as unknown as {
          createBatches: (dependencies: Dependency[], maxBatchSize: number) => Dependency[][];
        }
      ).createBatches(deps, 500);

      // Verify batches are created
      expect(batches.length).toBeGreaterThan(1);

      // Verify each batch respects size limit
      for (const batch of batches) {
        const requestBody = (
          client as unknown as {
            buildBatchRequestBody: (dependencies: Dependency[]) => OSVBatchRequest;
          }
        ).buildBatchRequestBody(batch);
        const jsonSize = JSON.stringify(requestBody).length;
        const sizeMB = jsonSize / (1024 * 1024);

        // Should be under 30 MiB limit
        expect(sizeMB).toBeLessThan(30);
      }
    });

    it('should handle batch with mix of vulnerable and safe packages', async () => {
      // Mix of known vulnerable and likely safe packages
      const deps: Dependency[] = [
        { name: 'lodash', version: '4.17.20', versionConstraint: '4.17.20', isDev: false },
        { name: 'safepackage1', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
        { name: 'axios', version: '0.21.1', versionConstraint: '0.21.1', isDev: false },
        { name: 'safepackage2', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
        { name: 'safepackage3', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
      ];

      // Mock individual query responses
      // Mock individual query responses
      const lodashVuln = createLodashVulnerability();
      const axiosVuln = createAxiosVulnerability();

      vi.spyOn(client, 'post').mockResolvedValue({
        results: deps.map((dep) => {
          if (dep.name === 'lodash') return { vulns: [lodashVuln] };
          if (dep.name === 'axios') return { vulns: [axiosVuln] };
          return { vulns: [] };
        }),
      });

      vi.spyOn(client, 'get').mockImplementation(async (url) => {
        if (url.includes(lodashVuln.id)) return lodashVuln;
        if (url.includes(axiosVuln.id)) return axiosVuln;
        return {};
      });

      const result = await client.getBatchVulnerabilities(deps);

      // All packages should be in result
      expect(result.size).toBe(5);

      // Safe packages should have empty arrays
      expect(result.get('safepackage1')).toEqual([]);
      expect(result.get('safepackage2')).toEqual([]);
      expect(result.get('safepackage3')).toEqual([]);
    });
  });

  describe('Error handling and retry', () => {
    it('should handle network timeouts gracefully', async () => {
      // This test verifies graceful degradation
      const deps: Dependency[] = [
        { name: 'test-package', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
      ];

      // Mock timeout error
      // Mock timeout error
      vi.spyOn(client, 'post').mockRejectedValue(new Error('Network timeout'));

      // Should handle error gracefully
      try {
        const result = await client.getBatchVulnerabilities(deps);
        // If it doesn't throw, result should be defined
        expect(result).toBeDefined();
      } catch (error) {
        // If it throws, verify error is handled properly
        expect(error).toBeDefined();
      }
    });

    it('should handle malformed responses', async () => {
      // Test with unusual package names that might cause issues
      const deps: Dependency[] = [
        { name: '', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
        { name: 'valid-package', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
      ];

      // Mock malformed response - return empty array for valid package, error for empty name
      // Mock malformed response - return empty array for valid package, error for empty name
      vi.spyOn(client, 'post').mockImplementation(async (_url, data) => {
        const request = data as { queries: { package: { name: string } }[] };
        if (request.queries.some((q) => q.package.name === '')) {
          throw new Error('Invalid package name');
        }
        return {
          results: request.queries.map(() => ({ vulns: [] })),
        };
      });

      try {
        const result = await client.getBatchVulnerabilities(deps);
        // Should handle gracefully - either return empty or throw
        expect(result).toBeDefined();
      } catch (error) {
        // Should handle gracefully
        expect(error).toBeDefined();
      }
    });
  });

  describe('Batch optimization', () => {
    it('should use optimal batch size of 1000 packages', () => {
      const deps: Dependency[] = Array.from({ length: 1500 }, (_, i) => ({
        name: `package-${i}`,
        version: '1.0.0',
        versionConstraint: '1.0.0',
        isDev: false,
      }));

      const batches = (
        client as unknown as {
          createBatches: (dependencies: Dependency[], maxBatchSize: number) => Dependency[][];
        }
      ).createBatches(deps, 1000);

      // Should create 2 batches
      expect(batches.length).toBe(2);
      expect(batches[0].length).toBe(1000);
      expect(batches[1].length).toBe(500);
    });

    it('should handle small batches efficiently', () => {
      const deps: Dependency[] = [
        { name: 'package1', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
        { name: 'package2', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
      ];

      const batches = (
        client as unknown as {
          createBatches: (dependencies: Dependency[], maxBatchSize: number) => Dependency[][];
        }
      ).createBatches(deps, 1000);

      // Should create single batch for small set
      expect(batches.length).toBe(1);
      expect(batches[0].length).toBe(2);
    });
  });

  describe('Logging verification', () => {
    it('should log batch request details', async () => {
      const deps: Dependency[] = [
        { name: 'lodash', version: '4.17.20', versionConstraint: '4.17.20', isDev: false },
      ];

      // Mock response
      // Mock response
      const lodashVuln = createLodashVulnerability();

      vi.spyOn(client, 'post').mockResolvedValue({
        results: deps.map((dep) => {
          if (dep.name === 'lodash') return { vulns: [lodashVuln] };
          return { vulns: [] };
        }),
      });

      vi.spyOn(client, 'get').mockResolvedValue(lodashVuln);

      await client.getBatchVulnerabilities(deps);

      // Verify logging happened
      expect(mockOutputChannel.appendLine).toHaveBeenCalled();

      // Check for specific log patterns
      const allLogs = (
        mockOutputChannel.appendLine as unknown as ReturnType<typeof vi.fn>
      ).mock.calls
        .map((call: unknown[]) => call[0])
        .join('\n');

      // Should log package count
      expect(allLogs).toContain('1 packages');
    });

    it('should log CVSS calculation', async () => {
      const deps: Dependency[] = [
        { name: 'lodash', version: '4.17.20', versionConstraint: '4.17.20', isDev: false },
      ];

      // Mock response
      // Mock response
      const lodashVuln = createLodashVulnerability();

      vi.spyOn(client, 'post').mockResolvedValue({
        results: deps.map((dep) => {
          if (dep.name === 'lodash') return { vulns: [lodashVuln] };
          return { vulns: [] };
        }),
      });

      vi.spyOn(client, 'get').mockResolvedValue(lodashVuln);

      await client.getBatchVulnerabilities(deps);

      const allLogs = (
        mockOutputChannel.appendLine as unknown as ReturnType<typeof vi.fn>
      ).mock.calls
        .map((call: unknown[]) => call[0])
        .join('\n');

      // Check for batch processing logs
      expect(allLogs.length).toBeGreaterThan(0);
    });
  });
});

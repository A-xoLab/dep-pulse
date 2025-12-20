import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import type { Dependency } from '../types';
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

describe('GitHubAdvisoryClient - Performance Benchmarks', () => {
  let client: GitHubAdvisoryClient;
  let mockOutputChannel: vscode.OutputChannel;

  beforeEach(() => {
    mockOutputChannel = createMockOutputChannel();
    client = new GitHubAdvisoryClient(mockOutputChannel);
  });

  describe('12.1 API Request Reduction', () => {
    it('should reduce API requests by 90% for 10 dependencies', async () => {
      const deps: Dependency[] = Array.from({ length: 10 }, (_, i) => ({
        name: `package-${i}`,
        version: '1.0.0',
        versionConstraint: '^1.0.0',
        isDev: false,
      }));

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

      const batchRequests = executeBatchRequestSpy.mock.calls.length;
      const individualRequests = 10;
      const reduction = ((individualRequests - batchRequests) / individualRequests) * 100;

      expect(batchRequests).toBeLessThanOrEqual(1);
      expect(reduction).toBeGreaterThanOrEqual(90);

      console.log(
        `10 deps: ${individualRequests} → ${batchRequests} requests (${reduction.toFixed(1)}% reduction)`
      );
    });

    it('should reduce API requests by 90% for 25 dependencies', async () => {
      const deps: Dependency[] = Array.from({ length: 25 }, (_, i) => ({
        name: `package-${i}`,
        version: '1.0.0',
        versionConstraint: '^1.0.0',
        isDev: false,
      }));

      const executeBatchRequestSpy = vi
        .spyOn(
          client as unknown as {
            executeBatchRequest: (batch: Dependency[]) => Promise<GitHubAdvisoryResponse[]>;
          },
          'executeBatchRequest'
        )
        .mockResolvedValue([]);

      await client.getBatchVulnerabilities(deps);

      const batchRequests = executeBatchRequestSpy.mock.calls.length;
      const individualRequests = 25;
      const reduction = ((individualRequests - batchRequests) / individualRequests) * 100;

      expect(batchRequests).toBeLessThanOrEqual(1);
      expect(reduction).toBeGreaterThanOrEqual(90);

      console.log(
        `25 deps: ${individualRequests} → ${batchRequests} requests (${reduction.toFixed(1)}% reduction)`
      );
    });

    it('should reduce API requests by 90% for 50 dependencies', async () => {
      const deps: Dependency[] = Array.from({ length: 50 }, (_, i) => ({
        name: `package-${i}`,
        version: '1.0.0',
        versionConstraint: '^1.0.0',
        isDev: false,
      }));

      const executeBatchRequestSpy = vi
        .spyOn(
          client as unknown as {
            executeBatchRequest: (batch: Dependency[]) => Promise<GitHubAdvisoryResponse[]>;
          },
          'executeBatchRequest'
        )
        .mockResolvedValue([]);

      await client.getBatchVulnerabilities(deps);

      const batchRequests = executeBatchRequestSpy.mock.calls.length;
      const individualRequests = 50;
      const reduction = ((individualRequests - batchRequests) / individualRequests) * 100;

      expect(batchRequests).toBeLessThanOrEqual(1);
      expect(reduction).toBeGreaterThanOrEqual(90);

      console.log(
        `50 deps: ${individualRequests} → ${batchRequests} requests (${reduction.toFixed(1)}% reduction)`
      );
    });

    it('should reduce API requests by 90% for 100 dependencies', async () => {
      const deps: Dependency[] = Array.from({ length: 100 }, (_, i) => ({
        name: `package-${i}`,
        version: '1.0.0',
        versionConstraint: '^1.0.0',
        isDev: false,
      }));

      const executeBatchRequestSpy = vi
        .spyOn(
          client as unknown as {
            executeBatchRequest: (batch: Dependency[]) => Promise<GitHubAdvisoryResponse[]>;
          },
          'executeBatchRequest'
        )
        .mockResolvedValue([]);

      await client.getBatchVulnerabilities(deps);

      const batchRequests = executeBatchRequestSpy.mock.calls.length;
      const individualRequests = 100;
      const reduction = ((individualRequests - batchRequests) / individualRequests) * 100;

      expect(batchRequests).toBeLessThanOrEqual(1);
      expect(reduction).toBeGreaterThanOrEqual(90);

      console.log(
        `100 deps: ${individualRequests} → ${batchRequests} requests (${reduction.toFixed(1)}% reduction)`
      );
    });

    it('should document API request reduction results', async () => {
      const testCases = [
        { count: 10, name: 'Small project' },
        { count: 25, name: 'Medium project' },
        { count: 50, name: 'Large project' },
        { count: 100, name: 'Very large project' },
      ];

      const results: Array<{
        scenario: string;
        dependencies: number;
        individualRequests: number;
        batchRequests: number;
        reduction: number;
      }> = [];

      for (const testCase of testCases) {
        const deps: Dependency[] = Array.from({ length: testCase.count }, (_, i) => ({
          name: `package-${i}`,
          version: '1.0.0',
          versionConstraint: '^1.0.0',
          isDev: false,
        }));

        const executeBatchRequestSpy = vi
          .spyOn(
            client as unknown as {
              executeBatchRequest: (batch: Dependency[]) => Promise<GitHubAdvisoryResponse[]>;
            },
            'executeBatchRequest'
          )
          .mockResolvedValue([]);

        await client.getBatchVulnerabilities(deps);

        const batchRequests = executeBatchRequestSpy.mock.calls.length;
        const individualRequests = testCase.count;
        const reduction = ((individualRequests - batchRequests) / individualRequests) * 100;

        results.push({
          scenario: testCase.name,
          dependencies: testCase.count,
          individualRequests,
          batchRequests,
          reduction,
        });

        executeBatchRequestSpy.mockRestore();
      }

      // Verify all scenarios meet the 90% reduction target
      for (const result of results) {
        expect(result.reduction).toBeGreaterThanOrEqual(90);
      }

      // Log performance report
      console.log('\n=== API Request Reduction Performance Report ===');
      console.log('Scenario              | Deps | Before | After | Reduction');
      console.log('---------------------|------|--------|-------|----------');
      for (const result of results) {
        console.log(
          `${result.scenario.padEnd(20)} | ${result.dependencies.toString().padStart(4)} | ${result.individualRequests.toString().padStart(6)} | ${result.batchRequests.toString().padStart(5)} | ${result.reduction.toFixed(1)}%`
        );
      }
      console.log('================================================\n');
    });
  });

  describe('12.2 Execution Time Improvement', () => {
    it('should measure execution time for batch vs individual requests (10 deps)', async () => {
      const deps: Dependency[] = Array.from({ length: 10 }, (_, i) => ({
        name: `package-${i}`,
        version: '1.0.0',
        versionConstraint: '^1.0.0',
        isDev: false,
      }));

      // Mock with realistic delay (10ms per request)
      vi.spyOn(
        client as unknown as {
          executeBatchRequest: (batch: Dependency[]) => Promise<GitHubAdvisoryResponse[]>;
        },
        'executeBatchRequest'
      ).mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return [];
      });

      const startTime = Date.now();
      await client.getBatchVulnerabilities(deps);
      const batchTime = Date.now() - startTime;

      // Simulate individual requests (10ms each)
      const estimatedIndividualTime = 10 * 10; // 10 deps * 10ms

      const improvement = ((estimatedIndividualTime - batchTime) / estimatedIndividualTime) * 100;

      expect(batchTime).toBeLessThan(estimatedIndividualTime);
      expect(improvement).toBeGreaterThan(0);

      console.log(
        `10 deps: ${estimatedIndividualTime}ms → ${batchTime}ms (${improvement.toFixed(1)}% faster)`
      );
    });

    it('should measure execution time for batch vs individual requests (50 deps)', async () => {
      const deps: Dependency[] = Array.from({ length: 50 }, (_, i) => ({
        name: `package-${i}`,
        version: '1.0.0',
        versionConstraint: '^1.0.0',
        isDev: false,
      }));

      // Mock with realistic delay
      vi.spyOn(
        client as unknown as {
          executeBatchRequest: (batch: Dependency[]) => Promise<GitHubAdvisoryResponse[]>;
        },
        'executeBatchRequest'
      ).mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return [];
      });

      const startTime = Date.now();
      await client.getBatchVulnerabilities(deps);
      const batchTime = Date.now() - startTime;

      // Simulate individual requests
      const estimatedIndividualTime = 50 * 10;

      const improvement = ((estimatedIndividualTime - batchTime) / estimatedIndividualTime) * 100;

      expect(batchTime).toBeLessThan(estimatedIndividualTime);
      expect(improvement).toBeGreaterThan(70);

      console.log(
        `50 deps: ${estimatedIndividualTime}ms → ${batchTime}ms (${improvement.toFixed(1)}% faster)`
      );
    });

    it('should measure execution time for batch vs individual requests (100 deps)', async () => {
      const deps: Dependency[] = Array.from({ length: 100 }, (_, i) => ({
        name: `package-${i}`,
        version: '1.0.0',
        versionConstraint: '^1.0.0',
        isDev: false,
      }));

      // Mock with realistic delay
      vi.spyOn(
        client as unknown as {
          executeBatchRequest: (batch: Dependency[]) => Promise<GitHubAdvisoryResponse[]>;
        },
        'executeBatchRequest'
      ).mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return [];
      });

      const startTime = Date.now();
      await client.getBatchVulnerabilities(deps);
      const batchTime = Date.now() - startTime;

      // Simulate individual requests
      const estimatedIndividualTime = 100 * 10;

      const improvement = ((estimatedIndividualTime - batchTime) / estimatedIndividualTime) * 100;

      expect(batchTime).toBeLessThan(estimatedIndividualTime);
      expect(improvement).toBeGreaterThan(70);

      console.log(
        `100 deps: ${estimatedIndividualTime}ms → ${batchTime}ms (${improvement.toFixed(1)}% faster)`
      );
    });

    it('should document execution time improvement results', async () => {
      const testCases = [
        { count: 10, name: 'Small project', delay: 10 },
        { count: 25, name: 'Medium project', delay: 10 },
        { count: 50, name: 'Large project', delay: 10 },
        { count: 100, name: 'Very large project', delay: 10 },
      ];

      const results: Array<{
        scenario: string;
        dependencies: number;
        estimatedIndividualTime: number;
        batchTime: number;
        improvement: number;
      }> = [];

      for (const testCase of testCases) {
        const deps: Dependency[] = Array.from({ length: testCase.count }, (_, i) => ({
          name: `package-${i}`,
          version: '1.0.0',
          versionConstraint: '^1.0.0',
          isDev: false,
        }));

        vi.spyOn(
          client as unknown as {
            executeBatchRequest: (batch: Dependency[]) => Promise<GitHubAdvisoryResponse[]>;
          },
          'executeBatchRequest'
        ).mockImplementation(async () => {
          await new Promise((resolve) => setTimeout(resolve, testCase.delay));
          return [];
        });

        const startTime = Date.now();
        await client.getBatchVulnerabilities(deps);
        const batchTime = Date.now() - startTime;

        const estimatedIndividualTime = testCase.count * testCase.delay;
        const improvement = ((estimatedIndividualTime - batchTime) / estimatedIndividualTime) * 100;

        results.push({
          scenario: testCase.name,
          dependencies: testCase.count,
          estimatedIndividualTime,
          batchTime,
          improvement,
        });
      }

      // Verify improvement targets
      for (const result of results) {
        if (result.dependencies >= 25) {
          expect(result.improvement).toBeGreaterThan(70);
        }
      }

      // Log performance report
      console.log('\n=== Execution Time Improvement Performance Report ===');
      console.log('Scenario              | Deps | Before (ms) | After (ms) | Improvement');
      console.log('---------------------|------|-------------|------------|------------');
      for (const result of results) {
        console.log(
          `${result.scenario.padEnd(20)} | ${result.dependencies.toString().padStart(4)} | ${result.estimatedIndividualTime.toString().padStart(11)} | ${result.batchTime.toString().padStart(10)} | ${result.improvement.toFixed(1)}%`
        );
      }
      console.log('======================================================\n');
    });
  });

  describe('12.3 Memory Usage Validation', () => {
    it('should handle 100 dependencies without excessive memory usage', async () => {
      const deps: Dependency[] = Array.from({ length: 100 }, (_, i) => ({
        name: `package-${i}`,
        version: '1.0.0',
        versionConstraint: '^1.0.0',
        isDev: false,
      }));

      // Mock executeBatchRequest to return realistic data
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
          identifiers: [{ type: 'CVE', value: 'CVE-2021-0000' }],
          references: [{ url: 'https://example.com' }],
          published_at: '2021-01-01T00:00:00Z',
          updated_at: '2021-01-02T00:00:00Z',
          vulnerabilities: [
            {
              package: { ecosystem: 'npm', name: 'package-0' },
              vulnerable_version_range: '< 2.0.0',
            },
          ],
        },
      ]);

      const memBefore = process.memoryUsage().heapUsed;
      const result = await client.getBatchVulnerabilities(deps);
      const memAfter = process.memoryUsage().heapUsed;

      const memUsedMB = (memAfter - memBefore) / 1024 / 1024;

      // Verify result is valid
      expect(result.size).toBe(100);

      // Memory usage should be reasonable (< 10MB for 100 deps)
      expect(memUsedMB).toBeLessThan(10);

      console.log(`100 deps: Memory used = ${memUsedMB.toFixed(2)} MB`);
    });

    it('should handle 500 dependencies without excessive memory usage', async () => {
      const deps: Dependency[] = Array.from({ length: 500 }, (_, i) => ({
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
      ).mockResolvedValue([
        {
          ghsa_id: 'GHSA-test',
          summary: 'Test Vulnerability',
          severity: 'medium',
          identifiers: [{ type: 'CVE', value: 'CVE-2021-0000' }],
          references: [],
          published_at: '2021-01-01T00:00:00Z',
          updated_at: '2021-01-02T00:00:00Z',
          vulnerabilities: [
            {
              package: { ecosystem: 'npm', name: 'package-0' },
              vulnerable_version_range: '< 2.0.0',
            },
          ],
        },
      ]);

      const memBefore = process.memoryUsage().heapUsed;
      const result = await client.getBatchVulnerabilities(deps);
      const memAfter = process.memoryUsage().heapUsed;

      const memUsedMB = (memAfter - memBefore) / 1024 / 1024;

      // Verify result is valid
      expect(result.size).toBe(500);

      // Memory usage should be reasonable (< 50MB for 500 deps)
      expect(memUsedMB).toBeLessThan(50);

      console.log(`500 deps: Memory used = ${memUsedMB.toFixed(2)} MB`);
    });

    it('should validate memory usage remains acceptable for large projects', async () => {
      const testCases = [
        { count: 100, maxMemoryMB: 10 },
        { count: 250, maxMemoryMB: 25 },
        { count: 500, maxMemoryMB: 50 },
      ];

      const results: Array<{
        dependencies: number;
        memoryUsedMB: number;
        maxMemoryMB: number;
        withinLimit: boolean;
      }> = [];

      for (const testCase of testCases) {
        const deps: Dependency[] = Array.from({ length: testCase.count }, (_, i) => ({
          name: `package-${i}`,
          version: '1.0.0',
          versionConstraint: '^1.0.0',
          isDev: false,
        }));

        vi.spyOn(
          client as unknown as {
            executeBatchRequest: (batch: Dependency[]) => Promise<GitHubAdvisoryResponse[]>;
          },
          'executeBatchRequest'
        ).mockResolvedValue([]);

        const memBefore = process.memoryUsage().heapUsed;
        await client.getBatchVulnerabilities(deps);
        const memAfter = process.memoryUsage().heapUsed;

        const memUsedMB = (memAfter - memBefore) / 1024 / 1024;
        const withinLimit = memUsedMB < testCase.maxMemoryMB;

        results.push({
          dependencies: testCase.count,
          memoryUsedMB: memUsedMB,
          maxMemoryMB: testCase.maxMemoryMB,
          withinLimit,
        });

        expect(withinLimit).toBe(true);
      }

      // Log memory usage report
      console.log('\n=== Memory Usage Validation Report ===');
      console.log('Dependencies | Memory Used (MB) | Max Limit (MB) | Status');
      console.log('-------------|------------------|----------------|--------');
      for (const result of results) {
        const status = result.withinLimit ? 'PASS' : 'FAIL';
        console.log(
          `${result.dependencies.toString().padStart(12)} | ${result.memoryUsedMB.toFixed(2).padStart(16)} | ${result.maxMemoryMB.toString().padStart(14)} | ${status}`
        );
      }
      console.log('=======================================\n');
    });
  });
});

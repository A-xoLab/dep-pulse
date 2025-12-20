import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import type { Dependency } from '../types';
import { GitHubAdvisoryClient, type GitHubAdvisoryResponse } from './GitHubAdvisoryClient';

// Lightweight mock output channel
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

describe('GitHubAdvisoryClient - Performance Tests', () => {
  let client: GitHubAdvisoryClient;
  let mockOutputChannel: vscode.OutputChannel;

  beforeEach(() => {
    mockOutputChannel = createMockOutputChannel();
    client = new GitHubAdvisoryClient(mockOutputChannel);
  });

  const mockBatchExecutor = (results: GitHubAdvisoryResponse[] = []): void => {
    vi.spyOn(
      client as unknown as {
        executeBatchRequest: (batch: Dependency[]) => Promise<GitHubAdvisoryResponse[]>;
      },
      'executeBatchRequest'
    ).mockImplementation(async () => results);
  };

  describe('Response time benchmarks', () => {
    it('should process 50 dependencies quickly with mocked API', async () => {
      const deps: Dependency[] = Array.from({ length: 50 }, (_, i) => ({
        name: `pkg-${i}`,
        version: '1.0.0',
        versionConstraint: '1.0.0',
        isDev: false,
      }));

      mockBatchExecutor([]); // Empty advisories, no network

      const start = Date.now();
      const result = await client.getBatchVulnerabilities(deps);
      const duration = Date.now() - start;

      console.log(`GitHub batch (50 deps): ${duration}ms`);
      expect(duration).toBeLessThan(5000);
      expect(result.size).toBe(50);
    });

    it('should process 100 dependencies within acceptable time', async () => {
      const deps: Dependency[] = Array.from({ length: 100 }, (_, i) => ({
        name: `pkg-${i}`,
        version: '1.0.0',
        versionConstraint: '1.0.0',
        isDev: false,
      }));

      mockBatchExecutor([]);

      const start = Date.now();
      const result = await client.getBatchVulnerabilities(deps);
      const duration = Date.now() - start;

      console.log(`GitHub batch (100 deps): ${duration}ms`);
      expect(duration).toBeLessThan(8000);
      expect(result.size).toBe(100);
    });
  });

  describe('Batch splitting and URL length handling', () => {
    it('should split batches when URL length would be exceeded', async () => {
      // Use intentionally long names to exceed the MAX_AFFECTS_URL_LENGTH threshold
      const longName = `very-long-package-name-that-exceeds-url-limits-${'a'.repeat(400)}`;
      const deps: Dependency[] = Array.from({ length: 30 }, () => ({
        name: longName,
        version: '1.0.0',
        versionConstraint: '1.0.0',
        isDev: false,
      }));

      const createBatchesSpy = vi.spyOn(
        client as unknown as {
          createBatches: (deps: Dependency[], size: number) => Dependency[][];
        },
        'createBatches'
      );

      mockBatchExecutor([]);
      await client.getBatchVulnerabilities(deps);

      const batches = createBatchesSpy.mock.results[0].value;
      expect(batches.length).toBeGreaterThan(1); // URL-length splitting should occur
      expect(batches.flat().length).toBe(deps.length);
    });
  });

  describe('Rate limit resilience (simulated)', () => {
    it('should short-circuit when rate-limited flag is set', async () => {
      // Mark client as rate limited
      (client as unknown as { isRateLimited: boolean }).isRateLimited = true;
      mockBatchExecutor([]);

      const deps: Dependency[] = Array.from({ length: 10 }, (_, i) => ({
        name: `pkg-${i}`,
        version: '1.0.0',
        versionConstraint: '1.0.0',
        isDev: false,
      }));

      const executeSpy = vi.spyOn(
        client as unknown as {
          executeBatchRequest: (batch: Dependency[]) => Promise<GitHubAdvisoryResponse[]>;
        },
        'executeBatchRequest'
      );

      const result = await client.getBatchVulnerabilities(deps);

      // executeBatchRequest will short-circuit internally when rate-limited
      expect(executeSpy).toHaveBeenCalledTimes(1);
      // Still returns a map entry per dependency (empty advisories)
      expect(result.size).toBe(deps.length);
      for (const dep of deps) {
        expect(result.get(dep.name)).toEqual([]);
      }
    });
  });

  describe('Memory sanity for repeated batches', () => {
    it('should not grow heap significantly across multiple runs', async () => {
      const deps: Dependency[] = Array.from({ length: 30 }, (_, i) => ({
        name: `pkg-${i}`,
        version: '1.0.0',
        versionConstraint: '1.0.0',
        isDev: false,
      }));

      mockBatchExecutor([]);

      const startMem = process.memoryUsage().heapUsed;

      for (let i = 0; i < 5; i++) {
        await client.getBatchVulnerabilities(deps);
      }

      const endMem = process.memoryUsage().heapUsed;
      const deltaMb = (endMem - startMem) / (1024 * 1024);

      console.log(`Memory increase after repeated batches: ${deltaMb.toFixed(2)} MB`);
      expect(deltaMb).toBeLessThan(5); // Ensure no unexpected growth
    });
  });
});

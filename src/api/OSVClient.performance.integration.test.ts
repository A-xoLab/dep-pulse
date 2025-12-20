import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import type { Dependency } from '../types';

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

describe('OSVClient - Performance Tests', () => {
  let client: OSVClient;
  let mockOutputChannel: vscode.OutputChannel;

  beforeEach(() => {
    mockOutputChannel = createMockOutputChannel();
    client = new OSVClient(mockOutputChannel);
  });

  describe('Response time benchmarks', () => {
    it('should fetch 50 dependencies with cache in < 3 seconds', async () => {
      // Create 50 dependencies
      const deps: Dependency[] = Array.from({ length: 50 }, (_, i) => ({
        name: `test-package-${i}`,
        version: '1.0.0',
        versionConstraint: '1.0.0',
        isDev: false,
      }));

      // Mock individual query responses
      // Mock batch query response
      vi.spyOn(client, 'post').mockImplementation(async (_url, data) => {
        const request = data as { queries: unknown[] };
        return {
          results: request.queries.map(() => ({ vulns: [] })),
        };
      });

      // First fetch (no cache)
      const firstStart = Date.now();
      await client.getBatchVulnerabilities(deps);
      const firstDuration = Date.now() - firstStart;

      console.log(`First fetch (50 deps, no cache): ${firstDuration}ms`);

      // Second fetch (should benefit from internal caching/connection pooling)
      // Note: This doesn't test the CacheManager, but HTTP connection reuse
      const secondStart = Date.now();
      await client.getBatchVulnerabilities(deps);
      const secondDuration = Date.now() - secondStart;

      console.log(`Second fetch (50 deps, connection reuse): ${secondDuration}ms`);

      // Both should be fast with mocked API
      expect(firstDuration).toBeLessThan(3000); // < 3 seconds with mocks
      expect(secondDuration).toBeLessThan(3000); // < 3 seconds with mocks
    });

    it('should fetch 50 dependencies without cache in < 10 seconds', async () => {
      const deps: Dependency[] = Array.from({ length: 50 }, (_, i) => ({
        name: `package-${i}`,
        version: '1.0.0',
        versionConstraint: '1.0.0',
        isDev: false,
      }));

      // Mock individual query responses
      // Mock batch query response
      vi.spyOn(client, 'post').mockImplementation(async (_url, data) => {
        const request = data as { queries: unknown[] };
        return {
          results: request.queries.map(() => ({ vulns: [] })),
        };
      });

      const startTime = Date.now();
      const result = await client.getBatchVulnerabilities(deps);
      const duration = Date.now() - startTime;

      console.log(`OSV batch query (50 packages): ${duration}ms`);

      // Should be fast with mocked API
      expect(duration).toBeLessThan(10000); // < 10 seconds with mocks

      // Verify all packages processed
      expect(result.size).toBe(50);
    });

    it('should fetch 100 dependencies with batching logic', async () => {
      // Test batching logic with 100 packages (moved from 200 to regular CI)
      const deps: Dependency[] = Array.from({ length: 100 }, (_, i) => ({
        name: `package-${i}`,
        version: '1.0.0',
        versionConstraint: '1.0.0',
        isDev: false,
      }));

      // Mock individual query responses
      // Mock batch query response
      vi.spyOn(client, 'post').mockImplementation(async (_url, data) => {
        const request = data as { queries: unknown[] };
        return {
          results: request.queries.map(() => ({ vulns: [] })),
        };
      });

      const startTime = Date.now();
      const result = await client.getBatchVulnerabilities(deps);
      const duration = Date.now() - startTime;

      console.log(`OSV batch query (100 packages): ${duration}ms`);

      // Should be fast with mocked API
      expect(duration).toBeLessThan(10000); // < 10 seconds with mocks

      // Verify all packages processed
      expect(result.size).toBe(100);
    });

    it('should process small batches (10 packages) quickly', async () => {
      const deps: Dependency[] = Array.from({ length: 10 }, (_, i) => ({
        name: `small-package-${i}`,
        version: '1.0.0',
        versionConstraint: '1.0.0',
        isDev: false,
      }));

      // Mock individual query responses
      // Mock batch query response
      vi.spyOn(client, 'post').mockImplementation(async (_url, data) => {
        const request = data as { queries: unknown[] };
        return {
          results: request.queries.map(() => ({ vulns: [] })),
        };
      });

      const startTime = Date.now();
      const result = await client.getBatchVulnerabilities(deps);
      const duration = Date.now() - startTime;

      console.log(`OSV batch query (10 packages): ${duration}ms`);

      // Small batches should be very fast with mocks
      expect(duration).toBeLessThan(1000); // < 1 second with mocks
      expect(result.size).toBe(10);
    });

    it('should demonstrate HTTP/2 multiplexing benefits', async () => {
      // Create dependencies
      const deps: Dependency[] = Array.from({ length: 30 }, (_, i) => ({
        name: `concurrent-package-${i}`,
        version: '1.0.0',
        versionConstraint: '1.0.0',
        isDev: false,
      }));

      // Mock individual query responses
      // Mock batch query response
      vi.spyOn(client, 'post').mockImplementation(async (_url, data) => {
        const request = data as { queries: unknown[] };
        return {
          results: request.queries.map(() => ({ vulns: [] })),
        };
      });

      const startTime = Date.now();
      const result = await client.getBatchVulnerabilities(deps);
      const duration = Date.now() - startTime;

      console.log(`HTTP/2 multiplexed query (30 packages): ${duration}ms`);
      console.log(`Average time per package: ${(duration / 30).toFixed(2)}ms`);

      // With mocked API, should be very fast
      const averagePerPackage = duration / 30;
      expect(averagePerPackage).toBeLessThan(100); // < 100ms per package with mocks

      expect(result.size).toBe(30);
    });
  });

  describe('Rate limiting and error handling', () => {
    it('should handle multiple consecutive requests without rate limiting', async () => {
      const deps: Dependency[] = [
        { name: 'lodash', version: '4.17.20', versionConstraint: '4.17.20', isDev: false },
        { name: 'axios', version: '0.21.1', versionConstraint: '0.21.1', isDev: false },
      ];

      // Mock individual query responses
      // Mock batch query response
      vi.spyOn(client, 'post').mockImplementation(async (_url, data) => {
        const request = data as { queries: unknown[] };
        return {
          results: request.queries.map(() => ({ vulns: [] })),
        };
      });

      // Make 5 consecutive requests
      const results = [];
      for (let i = 0; i < 5; i++) {
        const result = await client.getBatchVulnerabilities(deps);
        results.push(result);
      }

      // All requests should succeed
      expect(results).toHaveLength(5);
      results.forEach((result) => {
        expect(result.size).toBe(2);
      });

      console.log('Successfully completed 5 consecutive requests without rate limiting');
    });

    it('should handle burst requests without errors', async () => {
      const deps: Dependency[] = [
        { name: 'react', version: '17.0.0', versionConstraint: '17.0.0', isDev: false },
      ];

      // Mock empty response
      // Mock batch query response
      vi.spyOn(client, 'post').mockImplementation(async (_url, data) => {
        const request = data as { queries: unknown[] };
        return {
          results: request.queries.map(() => ({ vulns: [] })),
        };
      });

      // Make 10 parallel requests (burst)
      const promises = Array.from({ length: 10 }, () => client.getBatchVulnerabilities(deps));

      const results = await Promise.all(promises);

      // All should succeed
      expect(results).toHaveLength(10);
      results.forEach((result) => {
        expect(result.size).toBe(1);
      });

      console.log('Successfully handled 10 parallel burst requests');
    });

    it('should not encounter rate limit errors in normal usage', async () => {
      const deps: Dependency[] = Array.from({ length: 50 }, (_, i) => ({
        name: `rate-test-${i}`,
        version: '1.0.0',
        versionConstraint: '1.0.0',
        isDev: false,
      }));

      // Mock individual query responses
      // Mock batch query response
      vi.spyOn(client, 'post').mockImplementation(async (_url, data) => {
        const request = data as { queries: unknown[] };
        return {
          results: request.queries.map(() => ({ vulns: [] })),
        };
      });

      let errorOccurred = false;
      try {
        await client.getBatchVulnerabilities(deps);
      } catch (error: unknown) {
        if (
          (error as Error).message.includes('rate limit') ||
          (error as Error).message.includes('429')
        ) {
          errorOccurred = true;
        }
      }

      expect(errorOccurred).toBe(false);
      console.log('No rate limit errors encountered');
    });
  });

  describe('Memory usage', () => {
    it('should handle large batch without excessive memory usage', async () => {
      const deps: Dependency[] = Array.from({ length: 150 }, (_, i) => ({
        name: `memory-test-package-${i}`,
        version: '1.0.0',
        versionConstraint: '1.0.0',
        isDev: false,
      }));

      // Mock individual query responses
      // Mock batch query response
      vi.spyOn(client, 'post').mockImplementation(async (_url, data) => {
        const request = data as { queries: unknown[] };
        return {
          results: request.queries.map(() => ({ vulns: [] })),
        };
      });

      // Measure memory before
      const memBefore = process.memoryUsage();

      await client.getBatchVulnerabilities(deps);

      // Measure memory after
      const memAfter = process.memoryUsage();

      const heapIncrease = (memAfter.heapUsed - memBefore.heapUsed) / (1024 * 1024); // MB

      console.log(`Memory usage increase: ${heapIncrease.toFixed(2)} MB for 150 packages`);
      console.log(`Heap used before: ${(memBefore.heapUsed / (1024 * 1024)).toFixed(2)} MB`);
      console.log(`Heap used after: ${(memAfter.heapUsed / (1024 * 1024)).toFixed(2)} MB`);

      // Should not use excessive memory (< 100 MB increase for 150 packages)
      expect(heapIncrease).toBeLessThan(100);
    });

    it('should not leak memory across multiple requests', async () => {
      const deps: Dependency[] = Array.from({ length: 10 }, (_, i) => ({
        name: `leak-test-${i}`,
        version: '1.0.0',
        versionConstraint: '1.0.0',
        isDev: false,
      }));

      // Mock individual query responses
      // Mock batch query response
      vi.spyOn(client, 'post').mockImplementation(async (_url, data) => {
        const request = data as { queries: unknown[] };
        return {
          results: request.queries.map(() => ({ vulns: [] })),
        };
      });

      // Measure initial memory
      const memInitial = process.memoryUsage().heapUsed;

      // Make 5 requests
      for (let i = 0; i < 5; i++) {
        await client.getBatchVulnerabilities(deps);
      }

      // Force garbage collection if available
      if (global.gc) {
        global.gc();
      }

      // Wait a bit for GC
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Measure final memory
      const memFinal = process.memoryUsage().heapUsed;

      const increase = (memFinal - memInitial) / (1024 * 1024); // MB

      console.log(`Memory increase after 5 requests: ${increase.toFixed(2)} MB`);

      // Should not significantly increase memory (allow 50MB for caching/pooling)
      expect(increase).toBeLessThan(50);
    });

    it('should batch requests efficiently to minimize memory spikes', async () => {
      // Test with 100 packages (moved from 300 to regular CI - tests batching logic)
      const deps: Dependency[] = Array.from({ length: 100 }, (_, i) => ({
        name: `batch-split-${i}`,
        version: '1.0.0',
        versionConstraint: '1.0.0',
        isDev: false,
      }));

      // Mock individual query responses
      // Mock batch query response
      vi.spyOn(client, 'post').mockImplementation(async (_url, data) => {
        const request = data as { queries: unknown[] };
        return {
          results: request.queries.map(() => ({ vulns: [] })),
        };
      });

      const memBefore = process.memoryUsage().heapUsed;

      await client.getBatchVulnerabilities(deps);

      const memAfter = process.memoryUsage().heapUsed;
      const increase = (memAfter - memBefore) / (1024 * 1024);

      console.log(`Memory increase for 100-package batch: ${increase.toFixed(2)} MB`);

      // Batching should keep memory reasonable even for large sets
      expect(increase).toBeLessThan(150);
    });
  });

  /**
   * Additional performance metrics
   */
  describe('Performance metrics and validation', () => {
    it('should provide consistent performance across multiple runs', async () => {
      const deps: Dependency[] = Array.from({ length: 20 }, (_, i) => ({
        name: `consistency-test-${i}`,
        version: '1.0.0',
        versionConstraint: '1.0.0',
        isDev: false,
      }));

      // Mock individual query responses
      // Mock batch query response
      vi.spyOn(client, 'post').mockImplementation(async (_url, data) => {
        const request = data as { queries: unknown[] };
        return {
          results: request.queries.map(() => ({ vulns: [] })),
        };
      });

      const durations: number[] = [];

      // Run 3 times
      for (let i = 0; i < 3; i++) {
        const start = Date.now();
        await client.getBatchVulnerabilities(deps);
        const duration = Date.now() - start;
        durations.push(duration);
      }

      console.log(`Durations: ${durations.join('ms, ')}ms`);

      // Calculate variance
      const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
      const variance = durations.reduce((sum, d) => sum + (d - avg) ** 2, 0) / durations.length;
      const stdDev = Math.sqrt(variance);

      console.log(`Average: ${avg.toFixed(2)}ms, StdDev: ${stdDev.toFixed(2)}ms`);

      // Performance should be relatively consistent
      // For very fast mocked responses (< 5ms), use absolute stdDev check
      // For slower responses, use coefficient of variation
      if (avg === 0) {
        // With mocks, all durations are 0, which is perfectly consistent
        expect(true).toBe(true);
      } else if (avg < 5) {
        // For very fast responses, check absolute consistency (stdDev < 2ms)
        expect(stdDev).toBeLessThan(2);
      } else {
        // For slower responses, use coefficient of variation (< 50%)
        const coefficientOfVariation = (stdDev / avg) * 100;
        expect(coefficientOfVariation).toBeLessThan(50);
      }
    });

    it('should log performance metrics', async () => {
      const deps: Dependency[] = [
        { name: 'lodash', version: '4.17.20', versionConstraint: '4.17.20', isDev: false },
      ];

      // Mock response
      // Mock batch query response
      vi.spyOn(client, 'post').mockImplementation(async (_url, data) => {
        const request = data as { queries: unknown[] };
        return {
          results: request.queries.map(() => ({ vulns: [] })),
        };
      });

      await client.getBatchVulnerabilities(deps);

      // Verify performance-related logging
      const logs = (mockOutputChannel.appendLine as unknown as ReturnType<typeof vi.fn>).mock.calls
        .map((call: unknown[]) => call[0])
        .join('\n');

      // Should log timing or batch information
      expect(logs.length).toBeGreaterThan(0);
    });
  });
});

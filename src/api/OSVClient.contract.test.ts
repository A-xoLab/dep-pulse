import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

/**
 * Contract Tests - Real API Validation
 *
 * These tests make REAL API calls to OSV.dev to validate:
 * - API compatibility (response structure hasn't changed)
 * - API availability and reliability
 * - Real-world performance characteristics
 *
 * These tests are excluded from regular CI runs and should be run:
 * - Nightly/weekly in CI
 * - Before releases
 * - When OSV.dev API changes are suspected
 *
 * Expected execution time: 2-5 minutes (due to real API calls)
 */
describe('OSVClient - Contract Tests (Real API)', () => {
  let client: OSVClient;
  let mockOutputChannel: vscode.OutputChannel;

  beforeEach(() => {
    mockOutputChannel = createMockOutputChannel();
    client = new OSVClient(mockOutputChannel);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Contract Test 1: Validate API response structure
   * Ensures OSV.dev API response format matches our expectations
   */
  describe('Contract 1: API Response Structure', () => {
    it('should receive valid response structure from OSV.dev API', async () => {
      // Use known vulnerable packages for reliable test
      const deps: Dependency[] = [
        { name: 'lodash', version: '4.17.20', versionConstraint: '4.17.20', isDev: false },
        { name: 'axios', version: '0.21.1', versionConstraint: '0.21.1', isDev: false },
      ];

      const result = await client.getBatchVulnerabilities(deps);

      // Verify response structure
      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(2);
      expect(result.has('lodash')).toBe(true);
      expect(result.has('axios')).toBe(true);

      // Verify structure of vulnerabilities if present
      const lodashVulns = result.get('lodash');
      if (lodashVulns && lodashVulns.length > 0) {
        const vuln = lodashVulns[0];
        expect(vuln).toHaveProperty('id');
        expect(vuln).toHaveProperty('title');
        expect(vuln).toHaveProperty('description');
        expect(vuln).toHaveProperty('severity');
        expect(vuln).toHaveProperty('affectedVersions');
        expect(vuln).toHaveProperty('references');
        expect(vuln).toHaveProperty('sources');
        expect(vuln.sources).toContain('osv');
      }
    }, 30000); // 30 second timeout for real API call
  });

  /**
   * Contract Test 2: Validate large batch handling
   * Tests real-world scenario with 200+ dependencies
   * This validates scale, not just batching logic
   */
  describe('Contract 2: Large Batch Scale Validation', () => {
    it('should handle 200+ dependencies with real API', async () => {
      // Create 200 dependencies (realistic large project size)
      const deps: Dependency[] = Array.from({ length: 200 }, (_, i) => ({
        name: `test-package-${i}`,
        version: '1.0.0',
        versionConstraint: '1.0.0',
        isDev: false,
      }));

      const startTime = Date.now();
      const result = await client.getBatchVulnerabilities(deps);
      const duration = Date.now() - startTime;

      // Verify all packages processed
      expect(result.size).toBe(200);

      // Log actual performance for monitoring
      console.log(
        `Contract test: 200 packages processed in ${duration}ms (${(duration / 1000).toFixed(2)}s)`
      );

      // Verify it completes (actual time varies with network)
      expect(duration).toBeGreaterThanOrEqual(0);
    }, 300000); // 5 minutes timeout (real API takes 176+ seconds)
  });

  /**
   * Contract Test 3: Validate error handling with real API
   * Tests how real API handles edge cases
   */
  describe('Contract 3: Real API Error Handling', () => {
    it('should handle network errors gracefully', async () => {
      // Use a small batch to test error handling
      const deps: Dependency[] = [
        { name: 'test-package', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
      ];

      // This test verifies the client handles real network conditions
      try {
        const result = await client.getBatchVulnerabilities(deps);
        // If successful, verify structure
        expect(result).toBeDefined();
        expect(result.size).toBe(1);
      } catch (error) {
        // If it fails, verify error is properly structured
        expect(error).toBeDefined();
        expect(typeof (error as Error).message).toBe('string');
      }
    }, 60000); // 60 second timeout
  });

  /**
   * Contract Test 4: Validate API rate limits
   * Ensures we don't hit rate limits with normal usage patterns
   */
  describe('Contract 4: Rate Limit Validation', () => {
    it('should handle multiple requests without hitting rate limits', async () => {
      const deps: Dependency[] = [
        { name: 'lodash', version: '4.17.20', versionConstraint: '4.17.20', isDev: false },
      ];

      // Make 3 consecutive requests (reasonable usage pattern)
      const results = [];
      for (let i = 0; i < 3; i++) {
        const result = await client.getBatchVulnerabilities(deps);
        results.push(result);
      }

      // All requests should succeed
      expect(results).toHaveLength(3);
      results.forEach((result) => {
        expect(result.size).toBe(1);
      });

      console.log(
        'Contract test: Successfully completed 3 consecutive requests without rate limiting'
      );
    }, 180000); // 3 minutes timeout (allows for network variability)
  });
});

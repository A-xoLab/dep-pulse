import { describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import type { AnalysisResult } from '../types';
import { BenchmarkSuite } from './benchmarks';

const outputChannelMock: vscode.OutputChannel = {
  name: 'benchmarks',
  append: vi.fn(),
  appendLine: vi.fn(),
  clear: vi.fn(),
  show: vi.fn(),
  hide: vi.fn(),
  replace: vi.fn(),
  dispose: vi.fn(),
};

describe('BenchmarkSuite', () => {
  it('runs a simple benchmark and generates a report', async () => {
    const suite = new BenchmarkSuite(outputChannelMock);
    const fakeResult: AnalysisResult = {
      timestamp: new Date(),
      dependencies: [
        {
          dependency: {
            name: 'dep',
            version: '1.0.0',
            versionConstraint: '^1.0.0',
            isDev: false,
          },
          security: { vulnerabilities: [], severity: 'none' },
          freshness: {
            currentVersion: '1.0.0',
            latestVersion: '1.0.0',
            versionGap: 'current',
            releaseDate: new Date(),
            isOutdated: false,
            isUnmaintained: false,
          },
          license: {
            license: 'MIT',
            spdxId: 'MIT',
            spdxIds: ['MIT'],
            isCompatible: true,
            licenseType: 'permissive',
          },
        },
      ],
      healthScore: {
        overall: 100,
        security: 100,
        freshness: 100,
        compatibility: 100,
        license: 100,
        breakdown: {
          totalDependencies: 1,
          criticalIssues: 0,
          warnings: 0,
          healthy: 1,
        },
      },
      summary: {
        totalDependencies: 1,
        analyzedDependencies: 1,
        failedDependencies: 0,
        criticalIssues: 0,
        highIssues: 0,
        warnings: 0,
        healthy: 1,
      },
    };

    const result = await suite.runBenchmark(
      { category: 'small', dependencyCount: 1, iterations: 1, warmup: false },
      async () => fakeResult
    );

    expect(result.success).toBe(true);
    const report = suite.generateReport([result]);
    expect(report).toContain('DepPulse Performance Benchmark Report');
    expect(report).toContain('SMALL Project');
  });
});

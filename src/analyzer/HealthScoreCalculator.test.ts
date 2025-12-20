import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import type { AnalysisResult, DependencyAnalysis } from '../types';
import { HealthScoreCalculator } from './HealthScoreCalculator';

describe('HealthScoreCalculator', () => {
  let outputChannel: vscode.OutputChannel;
  let calculator: HealthScoreCalculator;

  beforeEach(() => {
    outputChannel = { appendLine: vi.fn() } as unknown as vscode.OutputChannel;
    calculator = new HealthScoreCalculator(outputChannel);
  });

  const createMockAnalysisResult = (dependencies: DependencyAnalysis[]): AnalysisResult => ({
    timestamp: new Date(),
    dependencies,
    healthScore: {
      overall: 0,
      security: 0,
      freshness: 0,
      compatibility: 0,
      license: 0,
      breakdown: {
        totalDependencies: 0,
        criticalIssues: 0,
        warnings: 0,
        healthy: 0,
      },
    },
    summary: {
      totalDependencies: dependencies.length,
      analyzedDependencies: dependencies.length,
      failedDependencies: 0,
      criticalIssues: 0,
      highIssues: 0,
      warnings: 0,
      healthy: 0,
    },
  });

  const createMockDependency = (
    overrides: Partial<DependencyAnalysis> = {}
  ): DependencyAnalysis => ({
    dependency: { name: 'test-dep', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
    security: { vulnerabilities: [], severity: 'none' },
    freshness: {
      currentVersion: '1.0.0',
      latestVersion: '1.0.0',
      versionGap: 'current',
      releaseDate: new Date(),
      isOutdated: false,
      isUnmaintained: false,
      maintenanceSignals: { isLongTermUnmaintained: false, reasons: [], lastChecked: new Date() }, // Added missing property
    },
    license: { license: 'MIT', spdxIds: ['MIT'], isCompatible: true, licenseType: 'permissive' },
    packageInfo: {
      name: 'test-dep',
      version: '1.0.0',
      description: 'test',
      license: 'MIT',
      publishedAt: new Date(),
    },
    isFailed: false,
    classification: {
      primary: { type: 'healthy' },
      allIssues: [],
      displayPriority: 9,
    },
    ...overrides,
  });

  it('should calculate perfect score for healthy dependencies', () => {
    const deps = [createMockDependency(), createMockDependency()];
    const result = createMockAnalysisResult(deps);
    const score = calculator.calculate(result.dependencies);

    expect(score.overall).toBe(100);
    expect(score.security).toBe(100);
    expect(score.freshness).toBe(100);
    expect(score.license).toBe(100);
  });

  it('should penalize security score for vulnerabilities', () => {
    const deps = [
      createMockDependency({
        security: {
          vulnerabilities: [
            {
              id: 'CVE-1',
              title: 'Critical Vuln',
              description: 'desc',
              severity: 'critical',
              sources: ['osv'],
              affectedVersions: '*',
              references: [], // Added missing property
            },
          ],
          severity: 'critical',
        },
      }),
      createMockDependency(), // Healthy
    ];
    const result = createMockAnalysisResult(deps);
    const score = calculator.calculate(result.dependencies);

    // 50% vulnerable -> Base 50
    // Penalty: 1 critical * 8 = 8
    // Score: 50 - 8 = 42
    expect(score.security).toBe(42);
    expect(score.overall).toBeLessThan(100);
  });

  it('should penalize freshness score for outdated/unmaintained packages', () => {
    const deps = [
      createMockDependency({
        freshness: {
          currentVersion: '1.0.0',
          latestVersion: '2.0.0',
          versionGap: 'major',
          releaseDate: new Date(),
          isOutdated: true,
          isUnmaintained: false,
        },
      }),
      createMockDependency({
        freshness: {
          currentVersion: '1.0.0',
          latestVersion: '1.0.0',
          versionGap: 'current',
          releaseDate: new Date(),
          isOutdated: false,
          isUnmaintained: true,
        },
      }),
    ];
    const result = createMockAnalysisResult(deps);
    const score = calculator.calculate(result.dependencies);

    // 100% stale (excluding patches) -> Base 0
    // Penalty: 1 major (2) + 1 unmaintained (3) = 5
    // Max penalty cap: max(10, 0 * 0.3) = 10
    // Applied penalty: min(5, 10) = 5
    // Score: 0 - 5 -> 0 (min 0)
    expect(score.freshness).toBe(0);
  });

  it('should give better scores for projects with mostly patch updates', () => {
    const deps = [
      // 8 up-to-date dependencies
      ...Array.from({ length: 8 }, () => createMockDependency()),
      // 20 patch updates (low risk)
      ...Array.from({ length: 20 }, () =>
        createMockDependency({
          freshness: {
            currentVersion: '1.0.0',
            latestVersion: '1.0.1',
            versionGap: 'patch',
            releaseDate: new Date(),
            isOutdated: true,
            isUnmaintained: false,
          },
        })
      ),
      // 2 minor updates
      ...Array.from({ length: 2 }, () =>
        createMockDependency({
          freshness: {
            currentVersion: '1.0.0',
            latestVersion: '1.1.0',
            versionGap: 'minor',
            releaseDate: new Date(),
            isOutdated: true,
            isUnmaintained: false,
          },
        })
      ),
    ];
    const result = createMockAnalysisResult(deps);
    const score = calculator.calculate(result.dependencies);

    // 30 total dependencies
    // Stale count (excluding patches): 2 minor = 2
    // Stale percentage: 2/30 = 6.67%
    // Base score: 100 * (1 - 0.0667) = 93.33 ≈ 93
    // Raw penalty: 0*3 + 0*2 + 2*1 + 20*0.1 = 2 + 2 = 4
    // Max penalty: max(10, 93 * 0.3) = max(10, 27.9) = 27.9
    // Applied penalty: min(4, 27.9) = 4
    // Score: 93 - 4 = 89
    // This should be much better than the old formula which would have given ~0
    expect(score.freshness).toBeGreaterThan(80);
  });

  it('should penalize license score for incompatible licenses', () => {
    const deps = [
      createMockDependency({
        license: {
          license: 'GPL-3.0',
          spdxIds: ['GPL-3.0'],
          isCompatible: false,
          licenseType: 'copyleft',
        },
      }),
      createMockDependency(), // Compatible
    ];
    const result = createMockAnalysisResult(deps);
    const score = calculator.calculate(result.dependencies);

    // 50% incompatible -> 50 penalty -> 50 score
    expect(score.license).toBe(50);
  });

  it('should respect custom weights', () => {
    const customWeights = {
      security: 0.1,
      freshness: 0.1,
      compatibility: 0.1,
      license: 0.7,
    };
    calculator.setWeights(customWeights);

    const deps = [createMockDependency()]; // Perfect scores (100 each)
    const result = createMockAnalysisResult(deps);
    const score = calculator.calculate(result.dependencies);

    expect(score.overall).toBe(100);
    expect(calculator.getWeights()).toEqual(customWeights);
  });

  it('should ignore failed packages in calculation', () => {
    const deps = [
      createMockDependency(), // Healthy
      createMockDependency({ isFailed: true }), // Failed (should be ignored)
    ];
    const result = createMockAnalysisResult(deps);
    const score = calculator.calculate(result.dependencies);

    // Should behave as if only 1 healthy dependency exists
    expect(score.overall).toBe(100);
    expect(score.breakdown.totalDependencies).toBe(1);
  });

  describe('Compatibility Score Calculation', () => {
    it('should return 100 for dependencies without compatibility data', () => {
      const deps = [
        createMockDependency(), // No compatibility field
        createMockDependency(), // No compatibility field
      ];
      const result = createMockAnalysisResult(deps);
      const score = calculator.calculate(result.dependencies);

      // Should default to 100 if no compatibility data
      expect(score.compatibility).toBe(100);
    });

    it('should penalize compatibility score for deprecated versions', () => {
      const deps = [
        createMockDependency({
          compatibility: {
            status: 'version-deprecated',
            issues: [
              {
                type: 'version-deprecated',
                severity: 'critical',
                message: 'This version is deprecated',
              },
            ],
          },
        }),
        createMockDependency({
          compatibility: {
            status: 'safe',
            issues: [],
          },
        }),
      ];
      const result = createMockAnalysisResult(deps);
      const score = calculator.calculate(result.dependencies);

      // 50% deprecated -> Base 50
      // Penalty: 1 deprecated * 8 = 8
      // Score: 50 - 8 = 42
      expect(score.compatibility).toBe(42);
      expect(score.compatibility).toBeLessThan(100);
    });

    it('should penalize compatibility score for breaking changes', () => {
      const deps = [
        createMockDependency({
          compatibility: {
            status: 'breaking-changes',
            issues: [
              {
                type: 'breaking-change',
                severity: 'high',
                message: 'Major version upgrade available',
              },
            ],
          },
        }),
        createMockDependency({
          compatibility: {
            status: 'safe',
            issues: [],
          },
        }),
      ];
      const result = createMockAnalysisResult(deps);
      const score = calculator.calculate(result.dependencies);

      // 50% breaking -> Base 50
      // Penalty: 1 breaking * 4 = 4
      // Score: 50 - 4 = 46
      expect(score.compatibility).toBe(46);
      expect(score.compatibility).toBeLessThan(100);
    });

    it('should penalize compatibility score for version conflicts', () => {
      const deps = [
        createMockDependency({
          compatibility: {
            status: 'safe',
            issues: [
              {
                type: 'version-conflict',
                severity: 'high',
                message: 'Version conflict detected',
              },
            ],
          },
        }),
        createMockDependency({
          compatibility: {
            status: 'safe',
            issues: [],
          },
        }),
      ];
      const result = createMockAnalysisResult(deps);
      const score = calculator.calculate(result.dependencies);

      // 50% with conflicts -> Base 50
      // Penalty: 1 conflict * 6 = 6
      // Score: 50 - 6 = 44
      expect(score.compatibility).toBe(44);
      expect(score.compatibility).toBeLessThan(100);
    });

    it('should calculate perfect compatibility score for all safe packages', () => {
      const deps = [
        createMockDependency({
          compatibility: {
            status: 'safe',
            issues: [],
          },
        }),
        createMockDependency({
          compatibility: {
            status: 'safe',
            issues: [],
          },
        }),
      ];
      const result = createMockAnalysisResult(deps);
      const score = calculator.calculate(result.dependencies);

      expect(score.compatibility).toBe(100);
    });

    it('should cap compatibility penalty at 50 points', () => {
      // Create many deprecated packages to test penalty cap
      const deps = Array.from({ length: 20 }, () =>
        createMockDependency({
          compatibility: {
            status: 'version-deprecated',
            issues: [
              {
                type: 'version-deprecated',
                severity: 'critical',
                message: 'Deprecated',
              },
            ],
          },
        })
      );
      const result = createMockAnalysisResult(deps);
      const score = calculator.calculate(result.dependencies);

      // 100% deprecated -> Base 0
      // Penalty: 20 deprecated * 8 = 160, but capped at 50
      // Score: 0 - 50 = 0 (min 0)
      expect(score.compatibility).toBe(0);
      expect(score.compatibility).toBeGreaterThanOrEqual(0);
    });

    it('should combine multiple compatibility issue types', () => {
      const deps = [
        createMockDependency({
          compatibility: {
            status: 'version-deprecated',
            issues: [
              {
                type: 'version-deprecated',
                severity: 'critical',
                message: 'Deprecated',
              },
            ],
          },
        }),
        createMockDependency({
          compatibility: {
            status: 'breaking-changes',
            issues: [
              {
                type: 'breaking-change',
                severity: 'high',
                message: 'Breaking change',
              },
            ],
          },
        }),
        createMockDependency({
          compatibility: {
            status: 'safe',
            issues: [],
          },
        }),
      ];
      const result = createMockAnalysisResult(deps);
      const score = calculator.calculate(result.dependencies);

      // 66.7% with issues -> Base 33
      // Penalty: 1 deprecated (8) + 1 breaking (4) = 12
      // Score: 33 - 12 = 21
      expect(score.compatibility).toBe(21);
      expect(score.compatibility).toBeLessThan(100);
    });

    it('should include compatibility in overall score calculation', () => {
      const deps = [
        createMockDependency({
          compatibility: {
            status: 'version-deprecated',
            issues: [
              {
                type: 'version-deprecated',
                severity: 'critical',
                message: 'Deprecated',
              },
            ],
          },
        }),
      ];
      const result = createMockAnalysisResult(deps);
      const score = calculator.calculate(result.dependencies);

      // Security: 100, Freshness: 100, Compatibility: 0 (deprecated), License: 100
      // Overall: 100*0.4 + 100*0.3 + 0*0.2 + 100*0.1 = 40 + 30 + 0 + 10 = 80
      expect(score.compatibility).toBe(0);
      expect(score.overall).toBe(80);
    });
  });
});

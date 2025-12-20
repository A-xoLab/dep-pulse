import { describe, expect, it } from 'vitest';
import type { AnalysisResult, DependencyAnalysis } from '../types';
import { DashboardDataTransformer } from './DashboardDataTransformer';

describe('DashboardDataTransformer', () => {
  const mockAnalysisResult: AnalysisResult = {
    timestamp: new Date(),
    dependencies: [],
    healthScore: {
      overall: 100,
      security: 100,
      freshness: 100,
      compatibility: 100,
      license: 100,
      breakdown: {
        totalDependencies: 0,
        criticalIssues: 0,
        warnings: 0,
        healthy: 0,
      },
    },
    summary: {
      totalDependencies: 0,
      analyzedDependencies: 0,
      failedDependencies: 0,
      criticalIssues: 0,
      highIssues: 0,
      warnings: 0,
      healthy: 0,
    },
    performanceMetrics: {
      scanDuration: 100,
      memoryUsage: {
        heapUsed: 1000,
        heapTotal: 2000,
        rss: 3000,
      },
      dependencyCount: 0,
      validDependencyCount: 10,
      invalidDependencyCount: 0,
      transitiveDependencyCount: 0,
    },
  };

  it('should transform analysis data including performance metrics', () => {
    const transformer = new DashboardDataTransformer(() => {});
    const dashboardData = transformer.transformAnalysisData(mockAnalysisResult);

    expect(dashboardData.performanceMetrics).toBeDefined();
    expect(dashboardData.performanceMetrics).toEqual(mockAnalysisResult.performanceMetrics);
  });

  it('should handle missing performance metrics', () => {
    const resultWithoutMetrics = { ...mockAnalysisResult };
    delete resultWithoutMetrics.performanceMetrics;

    const transformer = new DashboardDataTransformer(() => {});
    const dashboardData = transformer.transformAnalysisData(resultWithoutMetrics);

    expect(dashboardData.performanceMetrics).toBeUndefined();
  });

  const baseDep: DependencyAnalysis = {
    dependency: {
      name: 'pkg',
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
    license: { license: 'MIT', spdxIds: ['MIT'], isCompatible: true, licenseType: 'permissive' },
    packageInfo: {
      name: 'pkg',
      version: '1.0.0',
      description: '',
      license: 'MIT',
      publishedAt: new Date(),
    },
  };

  it('hides alternatives when only version-specific deprecation exists but an upgrade path is available', () => {
    const dep: DependencyAnalysis = {
      ...baseDep,
      freshness: {
        ...baseDep.freshness,
        latestVersion: '1.0.1',
        isOutdated: true,
        versionGap: 'patch',
      },
      maintenanceSignals: {
        isLongTermUnmaintained: true,
        reasons: [
          {
            source: 'npm',
            type: 'version-deprecated',
            message: 'Deprecated due to CVE',
          },
        ],
        lastChecked: new Date(),
      },
    };

    const transformer = new DashboardDataTransformer(() => {});
    const row = transformer.transformDependencyToTableRow(dep);

    expect(row.alternativesEligible).toBe(false);
  });

  it('hides alternatives for major upgrade within grace period (upgrade path exists)', () => {
    const dep: DependencyAnalysis = {
      ...baseDep,
      freshness: {
        ...baseDep.freshness,
        latestVersion: '2.0.0',
        versionGap: 'major',
        isOutdated: false, // grace period active
        isUnmaintained: false,
      },
      maintenanceSignals: {
        isLongTermUnmaintained: true,
        reasons: [
          {
            source: 'npm',
            type: 'version-deprecated',
            message: 'Deprecated due to CVE',
          },
        ],
        lastChecked: new Date(),
      },
    };

    const transformer = new DashboardDataTransformer(() => {});
    const row = transformer.transformDependencyToTableRow(dep);

    expect(row.alternativesEligible).toBe(false);
  });

  it('shows alternatives for package-level deprecation without a supported upgrade', () => {
    const dep: DependencyAnalysis = {
      ...baseDep,
      freshness: {
        ...baseDep.freshness,
        isOutdated: false,
      },
      maintenanceSignals: {
        isLongTermUnmaintained: true,
        reasons: [
          {
            source: 'npm',
            type: 'deprecated',
            message: 'Package deprecated',
          },
        ],
        lastChecked: new Date(),
      },
    };

    const transformer = new DashboardDataTransformer(() => {});
    const row = transformer.transformDependencyToTableRow(dep);

    expect(row.alternativesEligible).toBe(true);
  });

  it('shows alternatives for archived or unmaintained signals when no upgrade path exists', () => {
    const dep: DependencyAnalysis = {
      ...baseDep,
      freshness: {
        ...baseDep.freshness,
        isOutdated: false,
        isUnmaintained: true,
      },
      maintenanceSignals: {
        isLongTermUnmaintained: true,
        reasons: [
          {
            source: 'github',
            type: 'archived',
            repository: 'owner/repo',
          },
        ],
        lastChecked: new Date(),
      },
    };

    const transformer = new DashboardDataTransformer(() => {});
    const row = transformer.transformDependencyToTableRow(dep);

    expect(row.alternativesEligible).toBe(true);
  });

  it('omits transitive children when transitiveEnabled is false', () => {
    const child: DependencyAnalysis = {
      ...baseDep,
      dependency: { ...baseDep.dependency, name: 'child', isTransitive: true },
      security: {
        vulnerabilities: [
          {
            id: 'CVE-1',
            title: 'Test vuln',
            severity: 'low',
            affectedVersions: '>=1.0.0',
            description: 'Test',
            references: [],
            sources: ['osv'],
          },
        ],
        severity: 'low',
      },
    };

    const parent: DependencyAnalysis = {
      ...baseDep,
      dependency: { ...baseDep.dependency, name: 'parent' },
      children: [child],
    };

    const analysis: AnalysisResult = {
      ...mockAnalysisResult,
      dependencies: [parent],
      performanceMetrics: mockAnalysisResult.performanceMetrics
        ? {
            ...mockAnalysisResult.performanceMetrics,
            transitiveDependencyCount: 1,
          }
        : undefined,
      summary: {
        ...mockAnalysisResult.summary,
        totalDependencies: 1,
        analyzedDependencies: 1,
      },
    };

    const transformer = new DashboardDataTransformer(() => {});
    const dashboardData = transformer.transformAnalysisData(analysis, { transitiveEnabled: false });

    expect(dashboardData.dependencies[0].children).toBeUndefined();
    expect(dashboardData.transitiveEnabled).toBe(false);
    expect(dashboardData.performanceMetrics?.transitiveDependencyCount).toBe(0);
  });
});

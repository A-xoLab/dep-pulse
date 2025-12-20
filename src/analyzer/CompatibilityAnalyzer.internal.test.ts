import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import type { Dependency, FreshnessAnalysis, PackageRegistryClient } from '../types';
import { CompatibilityAnalyzer } from './CompatibilityAnalyzer';

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

describe('CompatibilityAnalyzer - Internal Implementation', () => {
  let analyzer: CompatibilityAnalyzer;
  let mockOutputChannel: vscode.OutputChannel;
  let mockRegistryClient: PackageRegistryClient;

  beforeEach(() => {
    mockOutputChannel = createMockOutputChannel();
    mockRegistryClient = {
      getPackageInfo: vi.fn(),
      getLatestVersion: vi.fn(),
      getVersionDeprecationStatus: vi.fn(),
      searchPackages: vi.fn(),
    };
    analyzer = new CompatibilityAnalyzer(mockRegistryClient, mockOutputChannel);
  });

  describe('Version Deprecation Detection', () => {
    it('should call getVersionDeprecationStatus with correct parameters', async () => {
      const dependency: Dependency = {
        name: 'test-package',
        version: '1.0.0',
        versionConstraint: '1.0.0',
        isDev: false,
      };

      vi.mocked(mockRegistryClient.getVersionDeprecationStatus).mockResolvedValue(null);

      await analyzer.analyze(dependency);

      expect(mockRegistryClient.getVersionDeprecationStatus).toHaveBeenCalledWith(
        'test-package',
        '1.0.0'
      );
    });

    it('should handle deprecation status errors gracefully', async () => {
      const dependency: Dependency = {
        name: 'test-package',
        version: '1.0.0',
        versionConstraint: '1.0.0',
        isDev: false,
      };

      vi.mocked(mockRegistryClient.getVersionDeprecationStatus).mockRejectedValue(
        new Error('Network error')
      );

      const result = await analyzer.analyze(dependency);

      expect(result.status).toBe('safe');
      expect(result.issues).toHaveLength(0);
    });
  });

  describe('Breaking Changes Detection', () => {
    it('should detect breaking changes when major version is outdated', async () => {
      const dependency: Dependency = {
        name: 'test-package',
        version: '1.0.0',
        versionConstraint: '1.0.0',
        isDev: false,
      };

      const freshnessAnalysis: FreshnessAnalysis = {
        currentVersion: '1.0.0',
        latestVersion: '2.0.0',
        versionGap: 'major',
        releaseDate: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000), // 100 days ago
        isOutdated: true,
        isUnmaintained: false,
      };

      const result = await analyzer.analyze(dependency, undefined, freshnessAnalysis);

      expect(result.status).toBe('breaking-changes');
      expect(result.issues.some((issue) => issue.type === 'breaking-change')).toBe(true);
      expect(result.upgradeWarnings).toBeDefined();
    });

    it('should not detect breaking changes for unmaintained packages', async () => {
      const dependency: Dependency = {
        name: 'test-package',
        version: '1.0.0',
        versionConstraint: '1.0.0',
        isDev: false,
      };

      const freshnessAnalysis: FreshnessAnalysis = {
        currentVersion: '1.0.0',
        latestVersion: '2.0.0',
        versionGap: 'major',
        releaseDate: new Date(),
        isOutdated: true,
        isUnmaintained: false,
        maintenanceSignals: {
          isLongTermUnmaintained: true,
          reasons: [],
          lastChecked: new Date(),
        },
      };

      const result = await analyzer.analyze(dependency, undefined, freshnessAnalysis);

      expect(result.status).toBe('safe');
      expect(result.issues).toHaveLength(0);
    });
  });

  describe('Issue Classification', () => {
    it('should prioritize version-deprecated over breaking-changes', async () => {
      const deprecationMessage = 'Deprecated version';
      vi.mocked(mockRegistryClient.getVersionDeprecationStatus).mockResolvedValue(
        deprecationMessage
      );

      const dependency: Dependency = {
        name: 'test-package',
        version: '1.0.0',
        versionConstraint: '1.0.0',
        isDev: false,
      };

      const freshnessAnalysis: FreshnessAnalysis = {
        currentVersion: '1.0.0',
        latestVersion: '2.0.0',
        versionGap: 'major',
        releaseDate: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000),
        isOutdated: true,
        isUnmaintained: false,
      };

      const result = await analyzer.analyze(dependency, undefined, freshnessAnalysis);

      expect(result.status).toBe('version-deprecated');
    });

    it('should include upgrade warnings for breaking changes', async () => {
      const dependency: Dependency = {
        name: 'test-package',
        version: '1.0.0',
        versionConstraint: '1.0.0',
        isDev: false,
      };

      const freshnessAnalysis: FreshnessAnalysis = {
        currentVersion: '1.0.0',
        latestVersion: '2.0.0',
        versionGap: 'major',
        releaseDate: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000),
        isOutdated: true,
        isUnmaintained: false,
      };

      const result = await analyzer.analyze(dependency, undefined, freshnessAnalysis);

      expect(result.upgradeWarnings).toBeDefined();
      expect(result.upgradeWarnings?.length).toBeGreaterThan(0);
      expect(result.upgradeWarnings?.[0].breakingChange).toBe('Major version upgrade');
    });
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import type { Dependency, FreshnessAnalysis, PackageInfo, PackageRegistryClient } from '../types';
import { DepPulseError, ErrorCode } from '../types';
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

// Mock registry client
const createMockRegistryClient = (
  deprecationMessage: string | null = null
): PackageRegistryClient => ({
  getPackageInfo: vi.fn().mockResolvedValue({
    name: 'test-package',
    version: '2.0.0',
    description: 'Test package',
    license: 'MIT',
    publishedAt: new Date(),
  } as PackageInfo),
  getLatestVersion: vi.fn().mockResolvedValue('2.0.0'),
  getVersionDeprecationStatus: vi.fn().mockResolvedValue(deprecationMessage),
  searchPackages: vi.fn().mockResolvedValue([]),
});

describe('CompatibilityAnalyzer', () => {
  let analyzer: CompatibilityAnalyzer;
  let mockOutputChannel: vscode.OutputChannel;
  let mockRegistryClient: PackageRegistryClient;

  beforeEach(() => {
    mockOutputChannel = createMockOutputChannel();
    mockRegistryClient = createMockRegistryClient();
    analyzer = new CompatibilityAnalyzer(mockRegistryClient, mockOutputChannel);
  });

  describe('analyze', () => {
    it('should return safe status for package with no issues', async () => {
      const dependency: Dependency = {
        name: 'test-package',
        version: '1.0.0',
        versionConstraint: '1.0.0',
        isDev: false,
      };

      const freshnessAnalysis: FreshnessAnalysis = {
        currentVersion: '1.0.0',
        latestVersion: '1.0.0',
        versionGap: 'current',
        releaseDate: new Date(),
        isOutdated: false,
        isUnmaintained: false,
      };

      const result = await analyzer.analyze(dependency, undefined, freshnessAnalysis);

      expect(result.status).toBe('safe');
      expect(result.issues).toHaveLength(0);
    });

    it('should detect version deprecation', async () => {
      const deprecationMessage = 'This version is deprecated. Please upgrade.';
      mockRegistryClient = createMockRegistryClient(deprecationMessage);
      analyzer = new CompatibilityAnalyzer(mockRegistryClient, mockOutputChannel);

      const dependency: Dependency = {
        name: 'test-package',
        version: '1.0.0',
        versionConstraint: '1.0.0',
        isDev: false,
      };

      const result = await analyzer.analyze(dependency);

      expect(result.status).toBe('version-deprecated');
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].type).toBe('version-deprecated');
      expect(result.issues[0].severity).toBe('critical');
      expect(result.issues[0].message).toBe(deprecationMessage);
    });

    it('should detect breaking changes for major version upgrade', async () => {
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
      };

      const result = await analyzer.analyze(dependency, undefined, freshnessAnalysis);

      expect(result.status).toBe('breaking-changes');
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].type).toBe('breaking-change');
      expect(result.issues[0].severity).toBe('high');
      expect(result.upgradeWarnings).toBeDefined();
      expect(result.upgradeWarnings?.length).toBeGreaterThan(0);
    });

    it('should return safe status for internal dependencies', async () => {
      const dependency: Dependency = {
        name: '@internal/package',
        version: '1.0.0',
        versionConstraint: '1.0.0',
        isDev: false,
        isInternal: true,
      };

      const result = await analyzer.analyze(dependency);

      expect(result.status).toBe('safe');
      expect(result.issues).toHaveLength(0);
    });

    it('should handle errors gracefully and return safe status when no issues detected', async () => {
      const errorClient: PackageRegistryClient = {
        ...createMockRegistryClient(),
        getVersionDeprecationStatus: vi
          .fn()
          .mockRejectedValue(new DepPulseError('Network error', ErrorCode.NETWORK_ERROR, true)),
      };

      analyzer = new CompatibilityAnalyzer(errorClient, mockOutputChannel);

      const dependency: Dependency = {
        name: 'test-package',
        version: '1.0.0',
        versionConstraint: '1.0.0',
        isDev: false,
      };

      const result = await analyzer.analyze(dependency);

      // When deprecation check fails but no issues are detected, status is 'safe'
      // This is graceful degradation - we assume safe if we can't determine otherwise
      expect(result.status).toBe('safe');
      expect(result.issues).toHaveLength(0);
    });

    it('should detect both deprecation and breaking changes', async () => {
      const deprecationMessage = 'This version is deprecated.';
      mockRegistryClient = createMockRegistryClient(deprecationMessage);
      analyzer = new CompatibilityAnalyzer(mockRegistryClient, mockOutputChannel);

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
      };

      const result = await analyzer.analyze(dependency, undefined, freshnessAnalysis);

      expect(result.status).toBe('version-deprecated');
      expect(result.issues.length).toBeGreaterThanOrEqual(1);
      expect(result.issues.some((issue) => issue.type === 'version-deprecated')).toBe(true);
    });

    it('should not flag breaking changes for minor/patch updates', async () => {
      const dependency: Dependency = {
        name: 'test-package',
        version: '1.0.0',
        versionConstraint: '1.0.0',
        isDev: false,
      };

      const freshnessAnalysis: FreshnessAnalysis = {
        currentVersion: '1.0.0',
        latestVersion: '1.1.0',
        versionGap: 'minor',
        releaseDate: new Date(),
        isOutdated: true,
        isUnmaintained: false,
      };

      const result = await analyzer.analyze(dependency, undefined, freshnessAnalysis);

      expect(result.status).toBe('safe');
      expect(result.issues).toHaveLength(0);
    });

    it('should not flag breaking changes if grace period is active', async () => {
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
        releaseDate: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // 30 days ago
        isOutdated: false, // Grace period active
        isUnmaintained: false,
      };

      const result = await analyzer.analyze(dependency, undefined, freshnessAnalysis);

      expect(result.status).toBe('safe');
      expect(result.issues).toHaveLength(0);
    });
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import type {
  Dependency,
  FreshnessAnalysis,
  PackageInfo,
  PackageRegistryClient,
  ProjectInfo,
  SecurityAnalysis,
} from '../types';
import { DepPulseError, ErrorCode } from '../types';
import type { CacheManager } from '../utils/CacheManager';
import { AnalysisEngine } from './AnalysisEngine';
import type { CompatibilityAnalyzer } from './CompatibilityAnalyzer';
import type { FreshnessAnalyzer } from './FreshnessAnalyzer';
import type { SecurityAnalyzer } from './SecurityAnalyzer';

// Helper to create ProjectInfo
const createProjectInfo = (deps: Dependency[]): ProjectInfo => ({
  type: ['npm'],
  dependencyFiles: [
    {
      path: '/test/package.json',
      type: 'npm',
      dependencies: deps,
    },
  ],
  dependencies: deps,
});

// Helper to create PackageInfo
const createPackageInfo = (name: string, version: string): PackageInfo => ({
  name,
  version,
  description: 'Test package',
  license: 'MIT',
  repository: 'https://github.com/test/test',
  homepage: 'https://test.com',
  publishedAt: new Date(),
});

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

// Mock extension context with working cache
const createMockContext = (): vscode.ExtensionContext => {
  const cache = new Map<string, unknown>();
  return {
    subscriptions: [],
    workspaceState: {
      get: vi.fn(),
      update: vi.fn(),
      keys: vi.fn(() => []),
    },
    globalState: {
      get: vi.fn((key: string) => cache.get(key)),
      update: vi.fn((key: string, value: unknown) => {
        cache.set(key, value);
        return Promise.resolve();
      }),
      keys: vi.fn(() => Array.from(cache.keys())),
      setKeysForSync: vi.fn(),
    },
    secrets: {} as unknown as vscode.SecretStorage,
    extensionUri: {} as unknown as vscode.Uri,
    extensionPath: '/test/path',
    environmentVariableCollection: {} as unknown as vscode.GlobalEnvironmentVariableCollection,
    asAbsolutePath: vi.fn((path: string) => `/test/path/${path}`),
    storageUri: undefined,
    storagePath: undefined,
    globalStorageUri: {} as unknown as vscode.Uri,
    globalStoragePath: '/test/global',
    logUri: {} as unknown as vscode.Uri,
    logPath: '/test/logs',
    extensionMode: 3,
    extension: {} as unknown as vscode.Extension<unknown>,
    languageModelAccessInformation: {} as unknown as vscode.LanguageModelAccessInformation,
  };
};

describe('AnalysisEngine - Comprehensive Tests', () => {
  let engine: AnalysisEngine;
  let mockSecurityAnalyzer: SecurityAnalyzer;
  let mockFreshnessAnalyzer: FreshnessAnalyzer;
  let mockRegistryClient: PackageRegistryClient;
  let mockOutputChannel: vscode.OutputChannel;
  let mockContext: vscode.ExtensionContext;
  let mockCacheManager: CacheManager;

  beforeEach(() => {
    vi.clearAllMocks();
    mockOutputChannel = createMockOutputChannel();
    mockContext = createMockContext();

    // Mock SecurityAnalyzer with batch support
    mockSecurityAnalyzer = {
      analyze: vi.fn(),
      analyzeBatch: vi.fn(),
      optimizeConnectionPool: vi.fn(),
    } as unknown as SecurityAnalyzer;

    // Mock FreshnessAnalyzer
    mockFreshnessAnalyzer = {
      analyze: vi.fn(),
    } as unknown as FreshnessAnalyzer;

    // Mock PackageRegistryClient
    mockRegistryClient = {
      getPackageInfo: vi.fn(),
      getLatestVersion: vi.fn(),
    } as unknown as PackageRegistryClient;

    engine = new AnalysisEngine(
      mockSecurityAnalyzer,
      mockFreshnessAnalyzer,
      mockRegistryClient,
      mockOutputChannel,
      mockContext
    );
  });

  describe('Error Recovery', () => {
    it('should recover when vulnerability scan fails for one package', async () => {
      const deps: Dependency[] = [
        { name: 'good-pkg', version: '1.0.0', versionConstraint: '^1.0.0', isDev: false },
        { name: 'bad-pkg', version: '2.0.0', versionConstraint: '^2.0.0', isDev: false },
      ];

      const projectInfo = createProjectInfo(deps);

      // Mock batch security analysis with one failure
      const securityResults = new Map<string, SecurityAnalysis>([
        ['good-pkg', { vulnerabilities: [], severity: 'none' }],
        // bad-pkg missing from results (simulated failure)
      ]);

      vi.mocked(mockSecurityAnalyzer.analyzeBatch).mockResolvedValue(securityResults);

      vi.mocked(mockRegistryClient.getPackageInfo)
        .mockResolvedValueOnce(createPackageInfo('good-pkg', '1.0.0'))
        .mockResolvedValueOnce(createPackageInfo('bad-pkg', '2.0.0'));

      vi.mocked(mockFreshnessAnalyzer.analyze).mockResolvedValue({
        currentVersion: '1.0.0',
        latestVersion: '1.0.0',
        versionGap: 'current',
        releaseDate: new Date(),
        isOutdated: false,
        isUnmaintained: false,
      } as FreshnessAnalysis);

      const result = await engine.analyze(projectInfo);

      expect(result.dependencies).toHaveLength(2);
      expect(result.dependencies[0].security.severity).toBe('none');
      expect(result.dependencies[1].security.severity).toBe('none'); // Default when missing
    });

    it('should recover when freshness scan fails for one package', async () => {
      const deps: Dependency[] = [
        { name: 'good-pkg', version: '1.0.0', versionConstraint: '^1.0.0', isDev: false },
        { name: 'bad-pkg', version: '2.0.0', versionConstraint: '^2.0.0', isDev: false },
      ];

      const projectInfo = createProjectInfo(deps);

      const securityResults = new Map<string, SecurityAnalysis>([
        ['good-pkg', { vulnerabilities: [], severity: 'none' }],
        ['bad-pkg', { vulnerabilities: [], severity: 'none' }],
      ]);

      vi.mocked(mockSecurityAnalyzer.analyzeBatch).mockResolvedValue(securityResults);

      vi.mocked(mockRegistryClient.getPackageInfo)
        .mockResolvedValueOnce(createPackageInfo('good-pkg', '1.0.0'))
        .mockResolvedValueOnce(createPackageInfo('bad-pkg', '2.0.0'));

      vi.mocked(mockFreshnessAnalyzer.analyze)
        .mockResolvedValueOnce({
          currentVersion: '1.0.0',
          latestVersion: '1.0.0',
          versionGap: 'current',
          releaseDate: new Date(),
          isOutdated: false,
          isUnmaintained: false,
        } as FreshnessAnalysis)
        .mockRejectedValueOnce(new Error('Freshness analysis failed'));

      const result = await engine.analyze(projectInfo);

      expect(result.dependencies).toHaveLength(2);
      expect(result.dependencies[0].freshness.isOutdated).toBe(false);
      expect(result.dependencies[1].freshness.isOutdated).toBe(false); // Default fallback
    });

    it('should handle complete security scan failure gracefully', async () => {
      const deps: Dependency[] = [
        { name: 'test-pkg', version: '1.0.0', versionConstraint: '^1.0.0', isDev: false },
      ];

      const projectInfo = createProjectInfo(deps);

      vi.mocked(mockSecurityAnalyzer.analyzeBatch).mockRejectedValue(
        new Error('Security API unavailable')
      );

      vi.mocked(mockRegistryClient.getPackageInfo).mockResolvedValue(
        createPackageInfo('test-pkg', '1.0.0')
      );

      vi.mocked(mockFreshnessAnalyzer.analyze).mockResolvedValue({
        currentVersion: '1.0.0',
        latestVersion: '1.0.0',
        versionGap: 'current',
        releaseDate: new Date(),
        isOutdated: false,
        isUnmaintained: false,
      } as FreshnessAnalysis);

      await expect(engine.analyze(projectInfo)).rejects.toThrow();
    });
  });

  it('should omit transitive analysis when includeTransitiveDependencies is false', async () => {
    const deps: Dependency[] = [
      {
        name: 'root',
        version: '1.0.0',
        versionConstraint: '^1.0.0',
        isDev: false,
        children: [
          {
            name: 'child',
            version: '1.0.0',
            versionConstraint: '^1.0.0',
            isDev: false,
            isTransitive: true,
          },
        ],
      },
    ];

    const projectInfo = createProjectInfo(deps);

    const securityResults = new Map<string, SecurityAnalysis>([
      ['root', { vulnerabilities: [], severity: 'none' }],
    ]);
    vi.mocked(mockSecurityAnalyzer.analyzeBatch).mockResolvedValue(securityResults);

    vi.mocked(mockRegistryClient.getPackageInfo).mockResolvedValue(
      createPackageInfo('root', '1.0.0')
    );

    vi.mocked(mockFreshnessAnalyzer.analyze).mockResolvedValue({
      currentVersion: '1.0.0',
      latestVersion: '1.0.0',
      versionGap: 'current',
      releaseDate: new Date(),
      isOutdated: false,
      isUnmaintained: false,
    } as FreshnessAnalysis);

    const result = await engine.analyze(projectInfo, { includeTransitiveDependencies: false });

    expect(result.dependencies).toHaveLength(1);
    expect(result.dependencies[0].children).toBeUndefined();
    expect(result.performanceMetrics?.transitiveDependencyCount).toBe(0);
  });

  describe('Partial Results Handling', () => {
    it('should handle partial security results', async () => {
      const deps: Dependency[] = [
        { name: 'pkg1', version: '1.0.0', versionConstraint: '^1.0.0', isDev: false },
        { name: 'pkg2', version: '2.0.0', versionConstraint: '^2.0.0', isDev: false },
        { name: 'pkg3', version: '3.0.0', versionConstraint: '^3.0.0', isDev: false },
      ];

      const projectInfo = createProjectInfo(deps);

      // Only return results for pkg1 and pkg2
      const securityResults = new Map<string, SecurityAnalysis>([
        ['pkg1', { vulnerabilities: [], severity: 'none' }],
        ['pkg2', { vulnerabilities: [], severity: 'none' }],
        // pkg3 missing
      ]);

      vi.mocked(mockSecurityAnalyzer.analyzeBatch).mockResolvedValue(securityResults);

      vi.mocked(mockRegistryClient.getPackageInfo).mockResolvedValue(
        createPackageInfo('test', '1.0.0')
      );

      vi.mocked(mockFreshnessAnalyzer.analyze).mockResolvedValue({
        currentVersion: '1.0.0',
        latestVersion: '1.0.0',
        versionGap: 'current',
        releaseDate: new Date(),
        isOutdated: false,
        isUnmaintained: false,
      } as FreshnessAnalysis);

      const result = await engine.analyze(projectInfo);

      expect(result.dependencies).toHaveLength(3);
      expect(result.dependencies[0].security.severity).toBe('none');
      expect(result.dependencies[1].security.severity).toBe('none');
      expect(result.dependencies[2].security.severity).toBe('none'); // Default
    });

    it('should handle empty security results', async () => {
      const deps: Dependency[] = [
        { name: 'test-pkg', version: '1.0.0', versionConstraint: '^1.0.0', isDev: false },
      ];

      const projectInfo = createProjectInfo(deps);

      const securityResults = new Map<string, SecurityAnalysis>();

      vi.mocked(mockSecurityAnalyzer.analyzeBatch).mockResolvedValue(securityResults);

      vi.mocked(mockRegistryClient.getPackageInfo).mockResolvedValue(
        createPackageInfo('test-pkg', '1.0.0')
      );

      vi.mocked(mockFreshnessAnalyzer.analyze).mockResolvedValue({
        currentVersion: '1.0.0',
        latestVersion: '1.0.0',
        versionGap: 'current',
        releaseDate: new Date(),
        isOutdated: false,
        isUnmaintained: false,
      } as FreshnessAnalysis);

      const result = await engine.analyze(projectInfo);

      expect(result.dependencies).toHaveLength(1);
      expect(result.dependencies[0].security.severity).toBe('none');
      expect(result.dependencies[0].security.vulnerabilities).toHaveLength(0);

      // Verify performance metrics
      expect(result.performanceMetrics).toBeDefined();
      expect(result.performanceMetrics?.scanDuration).toBeGreaterThanOrEqual(0);
      expect(result.performanceMetrics?.dependencyCount).toBe(1);
      expect(result.performanceMetrics?.memoryUsage).toBeDefined();
    });
  });

  describe('Large Project Handling', () => {
    it('should handle 500+ dependencies efficiently', async () => {
      const deps: Dependency[] = Array.from({ length: 500 }, (_, i) => ({
        name: `package-${i}`,
        version: '1.0.0',
        versionConstraint: '^1.0.0',
        isDev: false,
      }));

      const projectInfo = createProjectInfo(deps);

      const securityResults = new Map<string, SecurityAnalysis>();
      for (const dep of deps) {
        securityResults.set(dep.name, { vulnerabilities: [], severity: 'none' });
      }

      vi.mocked(mockSecurityAnalyzer.analyzeBatch).mockResolvedValue(securityResults);

      vi.mocked(mockRegistryClient.getPackageInfo).mockResolvedValue(
        createPackageInfo('test', '1.0.0')
      );

      vi.mocked(mockFreshnessAnalyzer.analyze).mockResolvedValue({
        currentVersion: '1.0.0',
        latestVersion: '1.0.0',
        versionGap: 'current',
        releaseDate: new Date(),
        isOutdated: false,
        isUnmaintained: false,
      } as FreshnessAnalysis);

      const startTime = Date.now();
      const result = await engine.analyze(projectInfo);
      const duration = Date.now() - startTime;

      expect(result.dependencies).toHaveLength(500);
      expect(result.summary.totalDependencies).toBe(500);
      expect(duration).toBeLessThan(10000); // Should complete in reasonable time with mocks
    });

    it('should process dependencies in chunks', async () => {
      const deps: Dependency[] = Array.from({ length: 150 }, (_, i) => ({
        name: `package-${i}`,
        version: '1.0.0',
        versionConstraint: '^1.0.0',
        isDev: false,
      }));

      const projectInfo = createProjectInfo(deps);

      const securityResults = new Map<string, SecurityAnalysis>();
      for (const dep of deps) {
        securityResults.set(dep.name, { vulnerabilities: [], severity: 'none' });
      }

      vi.mocked(mockSecurityAnalyzer.analyzeBatch).mockResolvedValue(securityResults);

      vi.mocked(mockRegistryClient.getPackageInfo).mockResolvedValue(
        createPackageInfo('test', '1.0.0')
      );

      vi.mocked(mockFreshnessAnalyzer.analyze).mockResolvedValue({
        currentVersion: '1.0.0',
        latestVersion: '1.0.0',
        versionGap: 'current',
        releaseDate: new Date(),
        isOutdated: false,
        isUnmaintained: false,
      } as FreshnessAnalysis);

      // Create engine with smaller chunk size
      const chunkedEngine = new AnalysisEngine(
        mockSecurityAnalyzer,
        mockFreshnessAnalyzer,
        mockRegistryClient,
        mockOutputChannel,
        mockContext,
        50 // chunk size
      );

      const result = await chunkedEngine.analyze(projectInfo);

      expect(result.dependencies).toHaveLength(150);
      // Should call analyzeBatch multiple times (once per chunk)
      expect(mockSecurityAnalyzer.analyzeBatch).toHaveBeenCalledTimes(3); // 150 / 50 = 3 chunks
    });
  });

  describe('Configuration Handling', () => {
    it('should use custom chunk size', () => {
      const customEngine = new AnalysisEngine(
        mockSecurityAnalyzer,
        mockFreshnessAnalyzer,
        mockRegistryClient,
        mockOutputChannel,
        mockContext,
        25
      );

      expect((customEngine as unknown as { chunkSize: number }).chunkSize).toBe(25);
    });

    it('should use default chunk size when not specified', () => {
      expect((engine as unknown as { chunkSize: number }).chunkSize).toBe(50);
    });

    it('should optimize connection pool based on project size', async () => {
      const deps: Dependency[] = Array.from({ length: 200 }, (_, i) => ({
        name: `package-${i}`,
        version: '1.0.0',
        versionConstraint: '^1.0.0',
        isDev: false,
      }));

      const projectInfo = createProjectInfo(deps);

      const securityResults = new Map<string, SecurityAnalysis>();
      for (const dep of deps) {
        securityResults.set(dep.name, { vulnerabilities: [], severity: 'none' });
      }

      vi.mocked(mockSecurityAnalyzer.analyzeBatch).mockResolvedValue(securityResults);
      vi.mocked(mockRegistryClient.getPackageInfo).mockResolvedValue(
        createPackageInfo('test', '1.0.0')
      );
      vi.mocked(mockFreshnessAnalyzer.analyze).mockResolvedValue({
        currentVersion: '1.0.0',
        latestVersion: '1.0.0',
        versionGap: 'current',
        releaseDate: new Date(),
        isOutdated: false,
        isUnmaintained: false,
      } as FreshnessAnalysis);

      await engine.analyze(projectInfo);

      expect(mockSecurityAnalyzer.optimizeConnectionPool).toHaveBeenCalledWith(200);
    });
  });

  describe('Caching behavior', () => {
    it('returns cached package info before hitting registry', async () => {
      const cachedInfo = createPackageInfo('react', '1.0.0');
      mockCacheManager = {
        getCachedNpmInfo: vi.fn().mockResolvedValue(cachedInfo),
        cacheNpmInfo: vi.fn(),
        resetStats: vi.fn(),
      } as unknown as CacheManager;

      const cachedEngine = new AnalysisEngine(
        mockSecurityAnalyzer,
        mockFreshnessAnalyzer,
        mockRegistryClient,
        mockOutputChannel,
        mockContext,
        50,
        mockCacheManager
      );

      const result = await (
        cachedEngine as unknown as {
          getCachedPackageInfo: (name: string, bypass?: boolean) => Promise<PackageInfo>;
        }
      ).getCachedPackageInfo('react');

      expect(result).toEqual(cachedInfo);
      expect(
        (mockCacheManager as unknown as { getCachedNpmInfo: unknown }).getCachedNpmInfo
      ).toHaveBeenCalledWith('react');
      expect(mockRegistryClient.getPackageInfo).not.toHaveBeenCalled();
    });

    it('bypasses cache when bypass flag is true', async () => {
      const freshInfo = createPackageInfo('react', '18.2.0');
      mockCacheManager = {
        getCachedNpmInfo: vi.fn(),
        cacheNpmInfo: vi.fn(),
        resetStats: vi.fn(),
      } as unknown as CacheManager;

      const cachedEngine = new AnalysisEngine(
        mockSecurityAnalyzer,
        mockFreshnessAnalyzer,
        mockRegistryClient,
        mockOutputChannel,
        mockContext,
        50,
        mockCacheManager
      );

      vi.mocked(mockRegistryClient.getPackageInfo).mockResolvedValue(freshInfo);

      const result = await (
        cachedEngine as unknown as {
          getCachedPackageInfo: (name: string, bypass?: boolean) => Promise<PackageInfo>;
        }
      ).getCachedPackageInfo('react', true);

      expect(result).toEqual(freshInfo);
      expect(
        (mockCacheManager as unknown as { getCachedNpmInfo: unknown }).getCachedNpmInfo
      ).not.toHaveBeenCalled();
      expect(mockRegistryClient.getPackageInfo).toHaveBeenCalledTimes(1);
      expect(
        (mockCacheManager as unknown as { cacheNpmInfo: unknown }).cacheNpmInfo
      ).toHaveBeenCalledWith('react', freshInfo);
    });

    it('uses negative cache for missing packages and expires after TTL', async () => {
      const notFoundError = new DepPulseError(
        'Package not found: missing',
        ErrorCode.API_ERROR,
        true
      );
      const baseTime = Date.now();
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(baseTime);

      vi.mocked(mockRegistryClient.getPackageInfo).mockRejectedValueOnce(notFoundError);

      await expect(
        (
          engine as unknown as { getCachedPackageInfo: (name: string) => Promise<PackageInfo> }
        ).getCachedPackageInfo('missing')
      ).rejects.toThrow('Package not found');

      // Within negative cache TTL (7 days)
      nowSpy.mockReturnValue(baseTime + 2 * 24 * 60 * 60 * 1000);
      await expect(
        (
          engine as unknown as { getCachedPackageInfo: (name: string) => Promise<PackageInfo> }
        ).getCachedPackageInfo('missing')
      ).rejects.toThrow('Package not found');
      expect(mockRegistryClient.getPackageInfo).toHaveBeenCalledTimes(1);

      // After TTL expires, should try registry again
      nowSpy.mockReturnValue(baseTime + 8 * 24 * 60 * 60 * 1000);
      vi.mocked(mockRegistryClient.getPackageInfo).mockResolvedValueOnce(
        createPackageInfo('missing', '1.0.0')
      );
      const fetched = await (
        engine as unknown as { getCachedPackageInfo: (name: string) => Promise<PackageInfo> }
      ).getCachedPackageInfo('missing');

      expect(fetched.name).toBe('missing');
      expect(mockRegistryClient.getPackageInfo).toHaveBeenCalledTimes(2);
      nowSpy.mockRestore();
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty dependency list', async () => {
      const projectInfo = createProjectInfo([]);

      vi.mocked(mockSecurityAnalyzer.analyzeBatch).mockResolvedValue(new Map());

      const result = await engine.analyze(projectInfo);

      expect(result.dependencies).toHaveLength(0);
      expect(result.summary.totalDependencies).toBe(0);
      expect(result.healthScore.overall).toBe(100); // Perfect score for no dependencies
    });

    it('should handle package not found errors', async () => {
      const deps: Dependency[] = [
        { name: 'fake-package', version: '1.0.0', versionConstraint: '^1.0.0', isDev: false },
      ];

      const projectInfo = createProjectInfo(deps);

      const securityResults = new Map<string, SecurityAnalysis>([
        ['fake-package', { vulnerabilities: [], severity: 'none' }],
      ]);

      vi.mocked(mockSecurityAnalyzer.analyzeBatch).mockResolvedValue(securityResults);

      const packageNotFoundError = new DepPulseError(
        'Package not found: fake-package',
        ErrorCode.API_ERROR,
        true
      );

      vi.mocked(mockRegistryClient.getPackageInfo).mockRejectedValue(packageNotFoundError);

      vi.mocked(mockFreshnessAnalyzer.analyze).mockResolvedValue({
        currentVersion: '1.0.0',
        latestVersion: '1.0.0',
        versionGap: 'current',
        releaseDate: new Date(),
        isOutdated: false,
        isUnmaintained: false,
      } as FreshnessAnalysis);

      const result = await engine.analyze(projectInfo);

      expect(result.dependencies).toHaveLength(1);
      expect(result.dependencies[0].isFailed).toBe(true);
      expect(result.failedPackages).toBeDefined();
      expect(result.failedPackages?.[0].name).toBe('fake-package');
    });

    it('should handle missing package info gracefully', async () => {
      const deps: Dependency[] = [
        { name: 'test-pkg', version: '1.0.0', versionConstraint: '^1.0.0', isDev: false },
      ];

      const projectInfo = createProjectInfo(deps);

      const securityResults = new Map<string, SecurityAnalysis>([
        ['test-pkg', { vulnerabilities: [], severity: 'none' }],
      ]);

      vi.mocked(mockSecurityAnalyzer.analyzeBatch).mockResolvedValue(securityResults);

      // Mock package info without license to test fallback
      const packageInfoWithoutLicense = createPackageInfo('test-pkg', '1.0.0');
      delete (packageInfoWithoutLicense as unknown as { license?: string }).license;
      vi.mocked(mockRegistryClient.getPackageInfo).mockResolvedValue(packageInfoWithoutLicense);

      vi.mocked(mockFreshnessAnalyzer.analyze).mockResolvedValue({
        currentVersion: '1.0.0',
        latestVersion: '1.0.0',
        versionGap: 'current',
        releaseDate: new Date(),
        isOutdated: false,
        isUnmaintained: false,
      } as FreshnessAnalysis);

      const result = await engine.analyze(projectInfo);

      expect(result.dependencies).toHaveLength(1);
      expect(result.dependencies[0].license.license).toBe('Unknown');
    });

    it('should handle dependencies with duplicate names', async () => {
      const deps: Dependency[] = [
        { name: 'test-pkg', version: '1.0.0', versionConstraint: '^1.0.0', isDev: false },
        { name: 'test-pkg', version: '2.0.0', versionConstraint: '^2.0.0', isDev: false },
      ];

      const projectInfo = createProjectInfo(deps);

      // Use composite key for duplicate names
      const securityResults = new Map<string, SecurityAnalysis>([
        ['test-pkg@1.0.0', { vulnerabilities: [], severity: 'none' }],
        ['test-pkg@2.0.0', { vulnerabilities: [], severity: 'none' }],
      ]);

      vi.mocked(mockSecurityAnalyzer.analyzeBatch).mockResolvedValue(securityResults);

      vi.mocked(mockRegistryClient.getPackageInfo).mockResolvedValue(
        createPackageInfo('test-pkg', '1.0.0')
      );

      vi.mocked(mockFreshnessAnalyzer.analyze).mockResolvedValue({
        currentVersion: '1.0.0',
        latestVersion: '1.0.0',
        versionGap: 'current',
        releaseDate: new Date(),
        isOutdated: false,
        isUnmaintained: false,
      } as FreshnessAnalysis);

      const result = await engine.analyze(projectInfo);

      expect(result.dependencies).toHaveLength(2);
      expect(result.dependencies[0].security.severity).toBe('none');
      expect(result.dependencies[1].security.severity).toBe('none');
    });
  });

  describe('Status Management', () => {
    it('should update status during analysis', async () => {
      const deps: Dependency[] = [
        { name: 'test-pkg', version: '1.0.0', versionConstraint: '^1.0.0', isDev: false },
      ];

      const projectInfo = createProjectInfo(deps);

      const securityResults = new Map<string, SecurityAnalysis>([
        ['test-pkg', { vulnerabilities: [], severity: 'none' }],
      ]);

      vi.mocked(mockSecurityAnalyzer.analyzeBatch).mockResolvedValue(securityResults);
      vi.mocked(mockRegistryClient.getPackageInfo).mockResolvedValue(
        createPackageInfo('test-pkg', '1.0.0')
      );
      vi.mocked(mockFreshnessAnalyzer.analyze).mockResolvedValue({
        currentVersion: '1.0.0',
        latestVersion: '1.0.0',
        versionGap: 'current',
        releaseDate: new Date(),
        isOutdated: false,
        isUnmaintained: false,
      } as FreshnessAnalysis);

      await engine.analyze(projectInfo);

      const status = engine.getAnalysisStatus();
      expect(status.isRunning).toBe(false);
      expect(status.progress).toBe(100);
    });

    it('should reset status on completion', async () => {
      const deps: Dependency[] = [
        { name: 'test-pkg', version: '1.0.0', versionConstraint: '^1.0.0', isDev: false },
      ];

      const projectInfo = createProjectInfo(deps);

      const securityResults = new Map<string, SecurityAnalysis>([
        ['test-pkg', { vulnerabilities: [], severity: 'none' }],
      ]);

      vi.mocked(mockSecurityAnalyzer.analyzeBatch).mockResolvedValue(securityResults);
      vi.mocked(mockRegistryClient.getPackageInfo).mockResolvedValue(
        createPackageInfo('test-pkg', '1.0.0')
      );
      vi.mocked(mockFreshnessAnalyzer.analyze).mockResolvedValue({
        currentVersion: '1.0.0',
        latestVersion: '1.0.0',
        versionGap: 'current',
        releaseDate: new Date(),
        isOutdated: false,
        isUnmaintained: false,
      } as FreshnessAnalysis);

      await engine.analyze(projectInfo);

      const status = engine.getAnalysisStatus();
      expect(status.isRunning).toBe(false);
      expect(status.currentDependency).toBeUndefined();
    });
  });

  describe('Resource Cleanup', () => {
    it('should clean up intermediate data after analysis', async () => {
      const deps: Dependency[] = [
        { name: 'test-pkg', version: '1.0.0', versionConstraint: '^1.0.0', isDev: false },
      ];

      const projectInfo = createProjectInfo(deps);

      const securityResults = new Map<string, SecurityAnalysis>([
        ['test-pkg', { vulnerabilities: [], severity: 'none' }],
      ]);

      vi.mocked(mockSecurityAnalyzer.analyzeBatch).mockResolvedValue(securityResults);
      vi.mocked(mockRegistryClient.getPackageInfo).mockResolvedValue(
        createPackageInfo('test-pkg', '1.0.0')
      );
      vi.mocked(mockFreshnessAnalyzer.analyze).mockResolvedValue({
        currentVersion: '1.0.0',
        latestVersion: '1.0.0',
        versionGap: 'current',
        releaseDate: new Date(),
        isOutdated: false,
        isUnmaintained: false,
      } as FreshnessAnalysis);

      const cleanupSpy = vi.spyOn(
        engine as unknown as { cleanupIntermediateData: () => void },
        'cleanupIntermediateData'
      );

      await engine.analyze(projectInfo);

      expect(cleanupSpy).toHaveBeenCalled();
    });
  });

  describe('Incremental Analysis', () => {
    it('should handle incremental analysis for changed dependencies', async () => {
      const deps: Dependency[] = [
        { name: 'changed-pkg', version: '2.0.0', versionConstraint: '^2.0.0', isDev: false },
      ];

      const securityResults = new Map<string, SecurityAnalysis>([
        ['changed-pkg', { vulnerabilities: [], severity: 'none' }],
      ]);

      vi.mocked(mockSecurityAnalyzer.analyzeBatch).mockResolvedValue(securityResults);
      vi.mocked(mockRegistryClient.getPackageInfo).mockResolvedValue(
        createPackageInfo('changed-pkg', '2.0.0')
      );
      vi.mocked(mockFreshnessAnalyzer.analyze).mockResolvedValue({
        currentVersion: '2.0.0',
        latestVersion: '2.0.0',
        versionGap: 'current',
        releaseDate: new Date(),
        isOutdated: false,
        isUnmaintained: false,
      } as FreshnessAnalysis);

      const result = await engine.analyzeIncremental(deps);

      expect(result.dependencies).toHaveLength(1);
      expect(result.dependencies[0].dependency.name).toBe('changed-pkg');
      expect(result.dependencies[0].dependency.version).toBe('2.0.0');
    });
  });

  describe('Compatibility Analyzer Integration', () => {
    it('should work without compatibility analyzer (backward compatibility)', async () => {
      const deps: Dependency[] = [
        { name: 'test-pkg', version: '1.0.0', versionConstraint: '^1.0.0', isDev: false },
      ];

      const projectInfo = createProjectInfo(deps);

      const securityResults = new Map<string, SecurityAnalysis>([
        ['test-pkg', { vulnerabilities: [], severity: 'none' }],
      ]);

      vi.mocked(mockSecurityAnalyzer.analyzeBatch).mockResolvedValue(securityResults);
      vi.mocked(mockRegistryClient.getPackageInfo).mockResolvedValue(
        createPackageInfo('test-pkg', '1.0.0')
      );
      vi.mocked(mockFreshnessAnalyzer.analyze).mockResolvedValue({
        currentVersion: '1.0.0',
        latestVersion: '1.0.0',
        versionGap: 'current',
        releaseDate: new Date(),
        isOutdated: false,
        isUnmaintained: false,
      } as FreshnessAnalysis);

      // Engine without compatibility analyzer
      const engineWithoutCompat = new AnalysisEngine(
        mockSecurityAnalyzer,
        mockFreshnessAnalyzer,
        mockRegistryClient,
        mockOutputChannel,
        mockContext
      );

      const result = await engineWithoutCompat.analyze(projectInfo);

      expect(result.dependencies).toHaveLength(1);
      expect(result.dependencies[0].compatibility).toBeUndefined();
    });

    it('should include compatibility analysis when analyzer is provided', async () => {
      const deps: Dependency[] = [
        { name: 'test-pkg', version: '1.0.0', versionConstraint: '^1.0.0', isDev: false },
      ];

      const projectInfo = createProjectInfo(deps);

      const securityResults = new Map<string, SecurityAnalysis>([
        ['test-pkg', { vulnerabilities: [], severity: 'none' }],
      ]);

      vi.mocked(mockSecurityAnalyzer.analyzeBatch).mockResolvedValue(securityResults);
      vi.mocked(mockRegistryClient.getPackageInfo).mockResolvedValue(
        createPackageInfo('test-pkg', '1.0.0')
      );

      const freshnessAnalysis: FreshnessAnalysis = {
        currentVersion: '1.0.0',
        latestVersion: '1.0.0',
        versionGap: 'current',
        releaseDate: new Date(),
        isOutdated: false,
        isUnmaintained: false,
      };

      vi.mocked(mockFreshnessAnalyzer.analyze).mockResolvedValue(freshnessAnalysis);

      // Mock CompatibilityAnalyzer
      const mockCompatibilityAnalyzer = {
        analyze: vi.fn().mockResolvedValue({
          status: 'safe',
          issues: [],
        }),
      } as unknown as CompatibilityAnalyzer;

      // Engine with compatibility analyzer
      const engineWithCompat = new AnalysisEngine(
        mockSecurityAnalyzer,
        mockFreshnessAnalyzer,
        mockRegistryClient,
        mockOutputChannel,
        mockContext,
        50,
        undefined,
        mockCompatibilityAnalyzer
      );

      const result = await engineWithCompat.analyze(projectInfo);

      expect(result.dependencies).toHaveLength(1);
      expect(result.dependencies[0].compatibility).toBeDefined();
      expect(result.dependencies[0].compatibility?.status).toBe('safe');
      expect(mockCompatibilityAnalyzer.analyze).toHaveBeenCalled();
    });

    it('should pass freshness analysis to compatibility analyzer', async () => {
      const deps: Dependency[] = [
        { name: 'test-pkg', version: '1.0.0', versionConstraint: '^1.0.0', isDev: false },
      ];

      const projectInfo = createProjectInfo(deps);

      const securityResults = new Map<string, SecurityAnalysis>([
        ['test-pkg', { vulnerabilities: [], severity: 'none' }],
      ]);

      vi.mocked(mockSecurityAnalyzer.analyzeBatch).mockResolvedValue(securityResults);
      vi.mocked(mockRegistryClient.getPackageInfo).mockResolvedValue(
        createPackageInfo('test-pkg', '1.0.0')
      );

      const freshnessAnalysis: FreshnessAnalysis = {
        currentVersion: '1.0.0',
        latestVersion: '2.0.0',
        versionGap: 'major',
        releaseDate: new Date(),
        isOutdated: true,
        isUnmaintained: false,
      };

      vi.mocked(mockFreshnessAnalyzer.analyze).mockResolvedValue(freshnessAnalysis);

      const mockCompatibilityAnalyzer = {
        analyze: vi.fn().mockResolvedValue({
          status: 'breaking-changes',
          issues: [
            {
              type: 'breaking-change',
              severity: 'high',
              message: 'Major version upgrade available',
            },
          ],
        }),
      } as unknown as CompatibilityAnalyzer;

      const engineWithCompat = new AnalysisEngine(
        mockSecurityAnalyzer,
        mockFreshnessAnalyzer,
        mockRegistryClient,
        mockOutputChannel,
        mockContext,
        50,
        undefined,
        mockCompatibilityAnalyzer
      );

      await engineWithCompat.analyze(projectInfo);

      expect(mockCompatibilityAnalyzer.analyze).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'test-pkg', version: '1.0.0' }),
        expect.any(Object), // packageInfo
        expect.objectContaining({ versionGap: 'major', isOutdated: true }) // freshnessAnalysis
      );
    });
  });
});

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
import { AnalysisEngine } from './AnalysisEngine';
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

describe('AnalysisEngine - Regression Tests', () => {
  let engine: AnalysisEngine;
  let mockSecurityAnalyzer: SecurityAnalyzer;
  let mockFreshnessAnalyzer: FreshnessAnalyzer;
  let mockRegistryClient: PackageRegistryClient;
  let mockOutputChannel: vscode.OutputChannel;
  let mockContext: vscode.ExtensionContext;

  beforeEach(() => {
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

  describe('Batch Scanning Integration', () => {
    it('should use batch security analysis for multiple dependencies', async () => {
      const deps: Dependency[] = [
        { name: 'express', version: '4.17.1', versionConstraint: '^4.17.1', isDev: false },
        { name: 'lodash', version: '4.17.20', versionConstraint: '^4.17.20', isDev: false },
        { name: 'axios', version: '0.21.1', versionConstraint: '^0.21.1', isDev: false },
      ];

      const projectInfo = createProjectInfo(deps);

      // Mock batch security analysis
      const securityResults = new Map<string, SecurityAnalysis>([
        ['express', { vulnerabilities: [], severity: 'none' }],
        ['lodash', { vulnerabilities: [], severity: 'none' }],
        ['axios', { vulnerabilities: [], severity: 'none' }],
      ]);

      vi.mocked(mockSecurityAnalyzer.analyzeBatch).mockResolvedValue(securityResults);

      // Mock package info
      vi.mocked(mockRegistryClient.getPackageInfo).mockResolvedValue(
        createPackageInfo('test', '1.0.0')
      );

      // Mock freshness analysis
      vi.mocked(mockFreshnessAnalyzer.analyze).mockResolvedValue({
        currentVersion: '1.0.0',
        latestVersion: '1.0.0',
        versionGap: 'current',
        releaseDate: new Date(),
        isOutdated: false,
        isUnmaintained: false,
      } as FreshnessAnalysis);

      const result = await engine.analyze(projectInfo);

      // Verify batch method was called once
      expect(mockSecurityAnalyzer.analyzeBatch).toHaveBeenCalledTimes(1);
      expect(mockSecurityAnalyzer.analyzeBatch).toHaveBeenCalledWith(deps);

      // Verify individual analyze was NOT called
      expect(mockSecurityAnalyzer.analyze).not.toHaveBeenCalled();

      // Verify all dependencies were analyzed
      expect(result.dependencies).toHaveLength(3);
      expect(result.summary.totalDependencies).toBe(3);
    });

    it('should maintain backward compatibility with single dependency analysis', async () => {
      const dep: Dependency = {
        name: 'express',
        version: '4.17.1',
        versionConstraint: '^4.17.1',
        isDev: false,
      };

      const projectInfo = createProjectInfo([dep]);

      // Mock batch security analysis (should still be called for single dep)
      const securityResults = new Map<string, SecurityAnalysis>([
        ['express', { vulnerabilities: [], severity: 'none' }],
      ]);

      vi.mocked(mockSecurityAnalyzer.analyzeBatch).mockResolvedValue(securityResults);

      vi.mocked(mockRegistryClient.getPackageInfo).mockResolvedValue(
        createPackageInfo('express', '4.17.1')
      );

      vi.mocked(mockFreshnessAnalyzer.analyze).mockResolvedValue({
        currentVersion: '4.17.1',
        latestVersion: '4.17.1',
        versionGap: 'current',
        releaseDate: new Date(),
        isOutdated: false,
        isUnmaintained: false,
      } as FreshnessAnalysis);

      const result = await engine.analyze(projectInfo);

      // Verify batch method was called
      expect(mockSecurityAnalyzer.analyzeBatch).toHaveBeenCalledTimes(1);

      // Verify result is correct
      expect(result.dependencies).toHaveLength(1);
      expect(result.dependencies[0].dependency.name).toBe('express');
    });
  });

  describe('Health Score Calculation', () => {
    it('should calculate health score correctly with batch scanning', async () => {
      const deps: Dependency[] = [
        { name: 'safe-pkg', version: '1.0.0', versionConstraint: '^1.0.0', isDev: false },
        { name: 'vuln-pkg', version: '2.0.0', versionConstraint: '^2.0.0', isDev: false },
      ];

      const projectInfo = createProjectInfo(deps);

      // Mock batch security analysis with one vulnerable package
      const securityResults = new Map<string, SecurityAnalysis>([
        ['safe-pkg', { vulnerabilities: [], severity: 'none' }],
        [
          'vuln-pkg',
          {
            vulnerabilities: [
              {
                id: 'CVE-2021-1234',
                title: 'Test Vulnerability',
                description: 'A test vulnerability',
                severity: 'high',
                affectedVersions: '< 3.0.0',
                patchedVersions: '3.0.0',
                references: ['https://example.com'],
                publishedDate: new Date(),
                sources: ['github'],
              },
            ],
            severity: 'high',
          },
        ],
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

      // Verify health score is calculated
      expect(result.healthScore).toBeDefined();
      expect(result.healthScore.overall).toBeGreaterThanOrEqual(0);
      expect(result.healthScore.overall).toBeLessThanOrEqual(100);

      // Verify security score is affected by vulnerability
      expect(result.healthScore.security).toBeLessThan(100);

      // Verify summary counts
      expect(result.summary.totalDependencies).toBe(2);
      expect(result.summary.highIssues).toBe(1);
    });

    it('should maintain accurate health score with no vulnerabilities', async () => {
      const deps: Dependency[] = [
        { name: 'pkg1', version: '1.0.0', versionConstraint: '^1.0.0', isDev: false },
        { name: 'pkg2', version: '2.0.0', versionConstraint: '^2.0.0', isDev: false },
        { name: 'pkg3', version: '3.0.0', versionConstraint: '^3.0.0', isDev: false },
      ];

      const projectInfo = createProjectInfo(deps);

      const securityResults = new Map<string, SecurityAnalysis>([
        ['pkg1', { vulnerabilities: [], severity: 'none' }],
        ['pkg2', { vulnerabilities: [], severity: 'none' }],
        ['pkg3', { vulnerabilities: [], severity: 'none' }],
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

      expect(result.healthScore.overall).toBe(100);
      expect(result.healthScore.security).toBe(100);
      expect(result.summary.healthy).toBe(3);
      expect(result.summary.criticalIssues).toBe(0);
      expect(result.summary.highIssues).toBe(0);
    });
  });

  describe('Freshness Analysis', () => {
    it('should correctly identify outdated packages with batch scanning', async () => {
      const deps: Dependency[] = [
        { name: 'outdated-pkg', version: '1.0.0', versionConstraint: '^1.0.0', isDev: false },
      ];

      const projectInfo = createProjectInfo(deps);

      const securityResults = new Map<string, SecurityAnalysis>([
        ['outdated-pkg', { vulnerabilities: [], severity: 'none' }],
      ]);

      vi.mocked(mockSecurityAnalyzer.analyzeBatch).mockResolvedValue(securityResults);

      vi.mocked(mockRegistryClient.getPackageInfo).mockResolvedValue(
        createPackageInfo('outdated-pkg', '2.0.0')
      );

      // Mock outdated package
      vi.mocked(mockFreshnessAnalyzer.analyze).mockResolvedValue({
        currentVersion: '1.0.0',
        latestVersion: '2.0.0',
        versionGap: 'major',
        releaseDate: new Date(),
        isOutdated: true,
        isUnmaintained: false,
      } as FreshnessAnalysis);

      const result = await engine.analyze(projectInfo);

      // Verify outdated package is detected
      expect(result.dependencies[0].freshness.isOutdated).toBe(true);
      expect(result.dependencies[0].freshness.versionGap).toBe('major');
      expect(result.summary.warnings).toBeGreaterThan(0);
    });

    it('should correctly identify unmaintained packages with batch scanning', async () => {
      const deps: Dependency[] = [
        { name: 'unmaintained-pkg', version: '1.0.0', versionConstraint: '^1.0.0', isDev: false },
      ];

      const projectInfo = createProjectInfo(deps);

      const securityResults = new Map<string, SecurityAnalysis>([
        ['unmaintained-pkg', { vulnerabilities: [], severity: 'none' }],
      ]);

      vi.mocked(mockSecurityAnalyzer.analyzeBatch).mockResolvedValue(securityResults);

      const packageInfo = createPackageInfo('unmaintained-pkg', '1.0.0');
      packageInfo.publishedAt = new Date('2020-01-01');
      vi.mocked(mockRegistryClient.getPackageInfo).mockResolvedValue(packageInfo);

      // Mock unmaintained package (no updates in 3 years)
      const threeYearsAgo = new Date();
      threeYearsAgo.setFullYear(threeYearsAgo.getFullYear() - 3);

      vi.mocked(mockFreshnessAnalyzer.analyze).mockResolvedValue({
        currentVersion: '1.0.0',
        latestVersion: '1.0.0',
        versionGap: 'current',
        releaseDate: threeYearsAgo,
        isOutdated: false,
        isUnmaintained: true,
      } as FreshnessAnalysis);

      const result = await engine.analyze(projectInfo);

      // Verify unmaintained package is detected
      expect(result.dependencies[0].freshness.isUnmaintained).toBe(true);
      expect(result.summary.warnings).toBeGreaterThan(0);
    });
  });

  describe('Error Handling and Graceful Degradation', () => {
    it('should handle partial failures in batch scanning', async () => {
      const deps: Dependency[] = [
        { name: 'good-pkg', version: '1.0.0', versionConstraint: '^1.0.0', isDev: false },
        { name: 'bad-pkg', version: '2.0.0', versionConstraint: '^2.0.0', isDev: false },
      ];

      const projectInfo = createProjectInfo(deps);

      // Mock batch security analysis with partial results
      const securityResults = new Map<string, SecurityAnalysis>([
        ['good-pkg', { vulnerabilities: [], severity: 'none' }],
        ['bad-pkg', { vulnerabilities: [], severity: 'none' }],
      ]);

      vi.mocked(mockSecurityAnalyzer.analyzeBatch).mockResolvedValue(securityResults);

      // Mock package info to fail for one package
      // With caching, each package is fetched once and cached
      vi.mocked(mockRegistryClient.getPackageInfo)
        .mockResolvedValueOnce(createPackageInfo('good-pkg', '1.0.0'))
        .mockRejectedValueOnce(new Error('Package not found'));

      vi.mocked(mockFreshnessAnalyzer.analyze).mockResolvedValue({
        currentVersion: '1.0.0',
        latestVersion: '1.0.0',
        versionGap: 'current',
        releaseDate: new Date(),
        isOutdated: false,
        isUnmaintained: false,
      } as FreshnessAnalysis);

      const result = await engine.analyze(projectInfo);

      // Verify analysis completed despite error
      expect(result.dependencies).toHaveLength(2);
      // With caching, bad-pkg fails once (cached), then fails in assembly loop

      expect(result.summary.errors).toBe(1);

      // Verify good package was analyzed
      expect(result.dependencies[0].dependency.name).toBe('good-pkg');
    });

    it('should continue analysis when security scanning fails', async () => {
      const deps: Dependency[] = [
        { name: 'pkg1', version: '1.0.0', versionConstraint: '^1.0.0', isDev: false },
      ];

      const projectInfo = createProjectInfo(deps);

      // Mock batch security analysis to fail
      vi.mocked(mockSecurityAnalyzer.analyzeBatch).mockRejectedValue(
        new Error('Security API unavailable')
      );

      vi.mocked(mockRegistryClient.getPackageInfo).mockResolvedValue(
        createPackageInfo('pkg1', '1.0.0')
      );

      vi.mocked(mockFreshnessAnalyzer.analyze).mockResolvedValue({
        currentVersion: '1.0.0',
        latestVersion: '1.0.0',
        versionGap: 'current',
        releaseDate: new Date(),
        isOutdated: false,
        isUnmaintained: false,
      } as FreshnessAnalysis);

      // Should throw error since security analysis is critical
      await expect(engine.analyze(projectInfo)).rejects.toThrow();
    });
  });

  describe('Performance and Scalability', () => {
    it('should handle large projects efficiently with batch scanning', async () => {
      const deps: Dependency[] = Array.from({ length: 50 }, (_, i) => ({
        name: `package-${i}`,
        version: '1.0.0',
        versionConstraint: '^1.0.0',
        isDev: false,
      }));

      const projectInfo = createProjectInfo(deps);

      // Mock batch security analysis
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

      // Verify all dependencies analyzed
      expect(result.dependencies).toHaveLength(50);
      expect(result.summary.totalDependencies).toBe(50);

      // Verify batch method called only once
      expect(mockSecurityAnalyzer.analyzeBatch).toHaveBeenCalledTimes(1);

      // Verify reasonable performance (should be fast with mocks)
      expect(duration).toBeLessThan(1000);
    });
  });
});

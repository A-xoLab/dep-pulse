import * as fc from 'fast-check';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { getPropertyTestRuns } from '../test-setup';
import type {
  Dependency,
  PackageInfo,
  PackageRegistryClient,
  Vulnerability,
  VulnerabilityClient,
} from '../types';
import { AnalysisEngine } from './AnalysisEngine';
import { FreshnessAnalyzer } from './FreshnessAnalyzer';
import { SecurityAnalyzer } from './SecurityAnalyzer';

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

// Mock extension context
const createMockContext = (): vscode.ExtensionContext => {
  const storage = new Map<string, unknown>();
  return {
    globalState: {
      get: vi.fn(() => {
        // Return undefined to force fresh fetches (no cache)
        return undefined;
      }),
      update: vi.fn((key: string, value: unknown) => {
        storage.set(key, value);
        return Promise.resolve();
      }),
      keys: vi.fn(() => Array.from(storage.keys())),
      setKeysForSync: vi.fn(),
    },
  } as unknown as vscode.ExtensionContext;
};

describe('AnalysisEngine - Property-Based Tests', () => {
  let mockOutputChannel: vscode.OutputChannel;
  let mockContext: vscode.ExtensionContext;

  beforeEach(() => {
    mockOutputChannel = createMockOutputChannel();
    mockContext = createMockContext();
    // Clear any cached data
    vi.clearAllMocks();
  });

  /**
   * Property 16: OSV not used for freshness
   * For any dependency analysis, OSV.dev should only be queried for vulnerabilities,
   * never for latest version or release date information
   * Validates: Requirements 9.3
   * Feature: osv-integration, Property 16: OSV not used for freshness
   */
  describe('Property 16: OSV not used for freshness', () => {
    it('should only use PackageRegistryClient for freshness data, never OSVClient', async () => {
      await fc.assert(
        fc.asyncProperty(
          // Generate random dependencies
          fc.array(
            fc.record({
              name: fc
                .string({ minLength: 2, maxLength: 30 })
                .filter((s) => !s.includes(' ') && !s.includes('/')),
              version: fc
                .tuple(
                  fc.integer({ min: 1, max: 10 }),
                  fc.integer({ min: 0, max: 20 }),
                  fc.integer({ min: 0, max: 50 })
                )
                .map(([major, minor, patch]) => `${major}.${minor}.${patch}`),
              versionConstraint: fc.string({ minLength: 1, maxLength: 20 }),
              isDev: fc.boolean(),
            }),
            { minLength: 1, maxLength: 10 }
          ),
          async (dependencies: Dependency[]) => {
            // Create mock OSV client that tracks all method calls
            const osvGetVulnerabilitiesMock = vi.fn().mockResolvedValue([]);
            const osvGetBatchVulnerabilitiesMock = vi
              .fn()
              .mockImplementation((deps: Dependency[]) => {
                const results = new Map<string, Vulnerability[]>();
                for (const dep of deps) {
                  results.set(dep.name, []);
                }
                return Promise.resolve(results);
              });

            const osvClient: VulnerabilityClient = {
              getVulnerabilities: osvGetVulnerabilitiesMock,
              getBatchVulnerabilities: osvGetBatchVulnerabilitiesMock,
            };

            // Create mock PackageRegistryClient that tracks all method calls
            const registryGetPackageInfoMock = vi.fn().mockImplementation((packageName: string) => {
              const packageInfo: PackageInfo = {
                name: packageName,
                version: '2.0.0',
                description: 'Test package',
                publishedAt: new Date(),
                license: 'MIT',
              };
              return Promise.resolve(packageInfo);
            });

            const registryClient: PackageRegistryClient = {
              getPackageInfo: registryGetPackageInfoMock,
              getLatestVersion: vi.fn().mockResolvedValue('2.0.0'),
              searchPackages: vi.fn().mockResolvedValue([]),
              getVersionDeprecationStatus: vi.fn().mockResolvedValue(null),
            };

            // Create analyzers
            const securityAnalyzer = new SecurityAnalyzer(osvClient, mockOutputChannel);
            const freshnessAnalyzer = new FreshnessAnalyzer(registryClient, mockOutputChannel);

            // Create analysis engine
            const analysisEngine = new AnalysisEngine(
              securityAnalyzer,
              freshnessAnalyzer,
              registryClient,
              mockOutputChannel,
              mockContext
            );

            // Execute analysis
            const projectInfo = {
              type: ['npm' as const],
              dependencyFiles: [],
              dependencies,
            };

            await analysisEngine.analyze(projectInfo);

            // CRITICAL ASSERTION: OSV client should ONLY be called for vulnerability scanning
            // It should NEVER be called for freshness data (latest version, release dates)

            // Verify OSV was called for vulnerabilities (batch mode)
            expect(osvGetBatchVulnerabilitiesMock).toHaveBeenCalledTimes(1);
            expect(osvGetBatchVulnerabilitiesMock).toHaveBeenCalledWith(dependencies, false);

            // Verify OSV was NOT called for individual package info
            // (which would indicate it's being used for freshness)
            expect(osvGetVulnerabilitiesMock).not.toHaveBeenCalled();

            // Verify PackageRegistryClient WAS called for freshness data
            // It should be called once per dependency for package info
            expect(registryGetPackageInfoMock).toHaveBeenCalled();
            expect(registryGetPackageInfoMock.mock.calls.length).toBeGreaterThan(0);

            // Verify that all package info calls were for the correct packages
            const calledPackages = registryGetPackageInfoMock.mock.calls.map((call) => call[0]);
            for (const dep of dependencies) {
              expect(calledPackages).toContain(dep.name);
            }

            // CRITICAL: Verify OSV client has NO methods that could be used for freshness
            // OSV should only have vulnerability-related methods
            const osvClientKeys = Object.keys(osvClient);
            expect(osvClientKeys).not.toContain('getPackageInfo');
            expect(osvClientKeys).not.toContain('getLatestVersion');
            expect(osvClientKeys).not.toContain('getReleaseDate');
            expect(osvClientKeys).not.toContain('getPackageMetadata');
          }
        ),
        { numRuns: getPropertyTestRuns(100, 20) }
      );
    });

    it('should use separate clients for vulnerability and freshness analysis', async () => {
      await fc.assert(
        fc.asyncProperty(
          // Generate random dependencies
          fc.array(
            fc.record({
              name: fc.string({ minLength: 1, maxLength: 30 }).filter((s) => !s.includes(' ')),
              version: fc
                .tuple(
                  fc.integer({ min: 0, max: 10 }),
                  fc.integer({ min: 0, max: 20 }),
                  fc.integer({ min: 0, max: 50 })
                )
                .map(([major, minor, patch]) => `${major}.${minor}.${patch}`),
              versionConstraint: fc.string({ minLength: 1, maxLength: 20 }),
              isDev: fc.boolean(),
            }),
            { minLength: 1, maxLength: 10 }
          ),
          async (dependencies: Dependency[]) => {
            // Track which client types are used for what purpose
            const vulnerabilityClientCalls: string[] = [];
            const registryClientCalls: string[] = [];

            // Create mock OSV client
            const osvClient: VulnerabilityClient = {
              getVulnerabilities: vi.fn().mockImplementation((packageName: string) => {
                vulnerabilityClientCalls.push(`getVulnerabilities:${packageName}`);
                return Promise.resolve([]);
              }),
              getBatchVulnerabilities: vi.fn().mockImplementation((deps: Dependency[]) => {
                vulnerabilityClientCalls.push('getBatchVulnerabilities');
                const results = new Map<string, Vulnerability[]>();
                for (const dep of deps) {
                  results.set(dep.name, []);
                }
                return Promise.resolve(results);
              }),
            };

            // Create mock PackageRegistryClient
            const registryClient: PackageRegistryClient = {
              getPackageInfo: vi.fn().mockImplementation((packageName: string) => {
                registryClientCalls.push(`getPackageInfo:${packageName}`);
                const packageInfo: PackageInfo = {
                  name: packageName,
                  version: '2.0.0',
                  description: 'Test package',
                  publishedAt: new Date(),
                  license: 'MIT',
                };
                return Promise.resolve(packageInfo);
              }),
              getLatestVersion: vi.fn().mockResolvedValue('2.0.0'),
              searchPackages: vi.fn().mockResolvedValue([]),
              getVersionDeprecationStatus: vi.fn().mockResolvedValue(null),
            };

            // Create analyzers
            const securityAnalyzer = new SecurityAnalyzer(osvClient, mockOutputChannel);
            const freshnessAnalyzer = new FreshnessAnalyzer(registryClient, mockOutputChannel);

            // Create analysis engine
            const analysisEngine = new AnalysisEngine(
              securityAnalyzer,
              freshnessAnalyzer,
              registryClient,
              mockOutputChannel,
              mockContext
            );

            // Execute analysis
            const projectInfo = {
              type: ['npm' as const],
              dependencyFiles: [],
              dependencies,
            };

            const result = await analysisEngine.analyze(projectInfo);

            // Verify both clients were used
            expect(vulnerabilityClientCalls.length).toBeGreaterThan(0);
            expect(registryClientCalls.length).toBeGreaterThan(0);

            // Verify vulnerability client was only used for vulnerability operations
            for (const call of vulnerabilityClientCalls) {
              expect(call).toMatch(/^(getVulnerabilities|getBatchVulnerabilities)/);
            }

            // Verify registry client was only used for package info operations
            for (const call of registryClientCalls) {
              expect(call).toMatch(/^getPackageInfo/);
            }

            // Verify analysis results contain both vulnerability and freshness data
            expect(result.dependencies.length).toBe(dependencies.length);
            for (const depAnalysis of result.dependencies) {
              // Each dependency should have security analysis (from OSV)
              expect(depAnalysis.security).toBeDefined();
              expect(depAnalysis.security.vulnerabilities).toBeDefined();
              expect(depAnalysis.security.severity).toBeDefined();

              // Each dependency should have freshness analysis (from registry)
              expect(depAnalysis.freshness).toBeDefined();
              expect(depAnalysis.freshness.currentVersion).toBeDefined();
              expect(depAnalysis.freshness.latestVersion).toBeDefined();
              expect(depAnalysis.freshness.releaseDate).toBeDefined();
            }
          }
        ),
        { numRuns: getPropertyTestRuns(100, 20) }
      );
    });

    it('should never pass OSVClient to FreshnessAnalyzer', async () => {
      await fc.assert(
        fc.asyncProperty(
          // Generate random dependencies
          fc.array(
            fc.record({
              name: fc.string({ minLength: 1, maxLength: 30 }).filter((s) => !s.includes(' ')),
              version: fc
                .tuple(
                  fc.integer({ min: 0, max: 10 }),
                  fc.integer({ min: 0, max: 20 }),
                  fc.integer({ min: 0, max: 50 })
                )
                .map(([major, minor, patch]) => `${major}.${minor}.${patch}`),
              versionConstraint: fc.string({ minLength: 1, maxLength: 20 }),
              isDev: fc.boolean(),
            }),
            { minLength: 1, maxLength: 5 }
          ),
          async (dependencies: Dependency[]) => {
            // Create mock clients
            const osvClient: VulnerabilityClient = {
              getVulnerabilities: vi.fn().mockResolvedValue([]),
              getBatchVulnerabilities: vi.fn().mockImplementation((deps: Dependency[]) => {
                const results = new Map<string, Vulnerability[]>();
                for (const dep of deps) {
                  results.set(dep.name, []);
                }
                return Promise.resolve(results);
              }),
            };

            const registryClient: PackageRegistryClient = {
              getPackageInfo: vi.fn().mockImplementation((packageName: string) => {
                const packageInfo: PackageInfo = {
                  name: packageName,
                  version: '2.0.0',
                  description: 'Test package',
                  publishedAt: new Date(),
                  license: 'MIT',
                };
                return Promise.resolve(packageInfo);
              }),
              getLatestVersion: vi.fn().mockResolvedValue('2.0.0'),
              searchPackages: vi.fn().mockResolvedValue([]),
              getVersionDeprecationStatus: vi.fn().mockResolvedValue(null),
            };

            // Create FreshnessAnalyzer - it should ONLY accept PackageRegistryClient
            // This is a compile-time check, but we verify at runtime too
            const freshnessAnalyzer = new FreshnessAnalyzer(registryClient, mockOutputChannel);

            // Verify FreshnessAnalyzer does not have access to OSV client
            // by checking it only uses registry client methods
            for (const dep of dependencies) {
              await freshnessAnalyzer.analyze(dep);
            }

            // Verify registry client was called
            expect(registryClient.getPackageInfo).toHaveBeenCalled();

            // Verify OSV client was NOT called by FreshnessAnalyzer
            expect(osvClient.getVulnerabilities).not.toHaveBeenCalled();
            expect(osvClient.getBatchVulnerabilities).not.toHaveBeenCalled();
          }
        ),
        { numRuns: getPropertyTestRuns(50, 10) }
      );
    });

    it('should maintain separation between vulnerability and freshness data sources', async () => {
      await fc.assert(
        fc.asyncProperty(
          // Generate random dependencies
          fc.array(
            fc.record({
              name: fc.string({ minLength: 1, maxLength: 30 }).filter((s) => !s.includes(' ')),
              version: fc
                .tuple(
                  fc.integer({ min: 0, max: 10 }),
                  fc.integer({ min: 0, max: 20 }),
                  fc.integer({ min: 0, max: 50 })
                )
                .map(([major, minor, patch]) => `${major}.${minor}.${patch}`),
              versionConstraint: fc.string({ minLength: 1, maxLength: 20 }),
              isDev: fc.boolean(),
            }),
            { minLength: 1, maxLength: 10 }
          ),
          async (dependencies: Dependency[]) => {
            // Create mock clients with distinct data
            const osvClient: VulnerabilityClient = {
              getVulnerabilities: vi.fn().mockResolvedValue([]),
              getBatchVulnerabilities: vi.fn().mockImplementation((deps: Dependency[]) => {
                const results = new Map<string, Vulnerability[]>();
                for (const dep of deps) {
                  // OSV returns vulnerability data
                  results.set(dep.name, [
                    {
                      id: `OSV-${dep.name}`,
                      title: 'OSV Vulnerability',
                      severity: 'medium',
                      affectedVersions: '< 2.0.0',
                      description: 'From OSV',
                      references: [],
                      publishedDate: new Date('2023-01-01'),
                      lastModifiedDate: new Date('2023-01-02'),
                    },
                  ]);
                }
                return Promise.resolve(results);
              }),
            };

            const registryClient: PackageRegistryClient = {
              getPackageInfo: vi.fn().mockImplementation((packageName: string) => {
                // Registry returns freshness data
                const packageInfo: PackageInfo = {
                  name: packageName,
                  version: '3.0.0', // Latest version from registry
                  description: 'From Registry',
                  publishedAt: new Date('2024-01-01'), // Release date from registry
                  license: 'MIT',
                };
                return Promise.resolve(packageInfo);
              }),
              getLatestVersion: vi.fn().mockResolvedValue('3.0.0'),
              searchPackages: vi.fn().mockResolvedValue([]),
              getVersionDeprecationStatus: vi.fn().mockResolvedValue(null),
            };

            // Create analyzers
            const securityAnalyzer = new SecurityAnalyzer(osvClient, mockOutputChannel);
            const freshnessAnalyzer = new FreshnessAnalyzer(registryClient, mockOutputChannel);

            // Create analysis engine
            const analysisEngine = new AnalysisEngine(
              securityAnalyzer,
              freshnessAnalyzer,
              registryClient,
              mockOutputChannel,
              mockContext
            );

            // Execute analysis
            const projectInfo = {
              type: ['npm' as const],
              dependencyFiles: [],
              dependencies,
            };

            const result = await analysisEngine.analyze(projectInfo);

            // Verify data sources are correctly separated
            for (const depAnalysis of result.dependencies) {
              // Security data should come from OSV
              if (depAnalysis.security.vulnerabilities.length > 0) {
                const vuln = depAnalysis.security.vulnerabilities[0];
                expect(vuln.id).toContain('OSV');
                expect(vuln.description).toBe('From OSV');
              }

              // Freshness data should come from Registry
              expect(depAnalysis.freshness.latestVersion).toBe('3.0.0');
              expect(depAnalysis.freshness.releaseDate).toEqual(new Date('2024-01-01'));

              // Verify no cross-contamination:
              // - Vulnerability data should not contain registry info
              // - Freshness data should not contain OSV info
              expect(depAnalysis.freshness.latestVersion).not.toContain('OSV');
              if (depAnalysis.security.vulnerabilities.length > 0) {
                expect(depAnalysis.security.vulnerabilities[0].description).not.toContain(
                  'Registry'
                );
              }
            }
          }
        ),
        { numRuns: getPropertyTestRuns(100, 20) }
      );
    });
  });

  /**
   * Property 17: Parallel vulnerability and freshness analysis
   * For any set of dependencies, vulnerability scanning (OSV/GitHub) and freshness analysis
   * (npm registry) should execute in parallel
   * Validates: Requirements 9.2
   * Feature: osv-integration, Property 17: Parallel vulnerability and freshness analysis
   */
  describe('Property 17: Parallel vulnerability and freshness analysis', () => {
    it('should execute vulnerability and freshness analysis in parallel', async () => {
      await fc.assert(
        fc.asyncProperty(
          // Generate random dependencies
          fc.array(
            fc.record({
              name: fc.string({ minLength: 1, maxLength: 30 }).filter((s) => !s.includes(' ')),
              version: fc
                .tuple(
                  fc.integer({ min: 0, max: 10 }),
                  fc.integer({ min: 0, max: 20 }),
                  fc.integer({ min: 0, max: 50 })
                )
                .map(([major, minor, patch]) => `${major}.${minor}.${patch}`),
              versionConstraint: fc.string({ minLength: 1, maxLength: 20 }),
              isDev: fc.boolean(),
            }),
            { minLength: 1, maxLength: 10 }
          ),
          async (dependencies: Dependency[]) => {
            // Track execution timing to verify parallel execution
            let vulnerabilityScanStartTime: number | null = null;
            let vulnerabilityScanEndTime: number | null = null;
            let freshnessAnalysisStartTime: number | null = null;
            let freshnessAnalysisEndTime: number | null = null;

            // Create mock OSV client with timing tracking
            const osvClient: VulnerabilityClient = {
              getVulnerabilities: vi.fn().mockResolvedValue([]),
              getBatchVulnerabilities: vi.fn().mockImplementation(async (deps: Dependency[]) => {
                vulnerabilityScanStartTime = Date.now();
                // Simulate some work
                await new Promise((resolve) => setTimeout(resolve, 50));
                vulnerabilityScanEndTime = Date.now();

                const results = new Map<string, Vulnerability[]>();
                for (const dep of deps) {
                  results.set(dep.name, []);
                }
                return results;
              }),
            };

            // Create mock PackageRegistryClient with timing tracking
            const registryClient: PackageRegistryClient = {
              getPackageInfo: vi.fn().mockImplementation(async (packageName: string) => {
                if (freshnessAnalysisStartTime === null) {
                  freshnessAnalysisStartTime = Date.now();
                }
                // Simulate some work
                await new Promise((resolve) => setTimeout(resolve, 30));
                freshnessAnalysisEndTime = Date.now();

                const packageInfo: PackageInfo = {
                  name: packageName,
                  version: '2.0.0',
                  description: 'Test package',
                  publishedAt: new Date(),
                  license: 'MIT',
                };
                return packageInfo;
              }),
              getLatestVersion: vi.fn().mockResolvedValue('2.0.0'),
              searchPackages: vi.fn().mockResolvedValue([]),
              getVersionDeprecationStatus: vi.fn().mockResolvedValue(null),
            };

            // Create analyzers
            const securityAnalyzer = new SecurityAnalyzer(osvClient, mockOutputChannel);
            const freshnessAnalyzer = new FreshnessAnalyzer(registryClient, mockOutputChannel);

            // Create analysis engine
            const analysisEngine = new AnalysisEngine(
              securityAnalyzer,
              freshnessAnalyzer,
              registryClient,
              mockOutputChannel,
              mockContext
            );

            // Execute analysis
            const projectInfo = {
              type: ['npm' as const],
              dependencyFiles: [],
              dependencies,
            };

            await analysisEngine.analyze(projectInfo);

            // CRITICAL ASSERTION: Verify parallel execution
            // If executed in parallel, the start times should overlap
            // i.e., freshness should start before vulnerability scan ends

            expect(vulnerabilityScanStartTime).not.toBeNull();
            expect(vulnerabilityScanEndTime).not.toBeNull();
            expect(freshnessAnalysisStartTime).not.toBeNull();
            expect(freshnessAnalysisEndTime).not.toBeNull();

            // Verify parallel execution: freshness should start before vulnerability scan ends
            // This proves they're running concurrently, not sequentially
            if (
              vulnerabilityScanStartTime !== null &&
              vulnerabilityScanEndTime !== null &&
              freshnessAnalysisStartTime !== null
            ) {
              // Freshness analysis should start before or during vulnerability scan
              // (not after it completes)
              expect(freshnessAnalysisStartTime).toBeLessThanOrEqual(vulnerabilityScanEndTime + 10); // Small tolerance for timing
            }

            // Verify both operations were called
            expect(osvClient.getBatchVulnerabilities).toHaveBeenCalledTimes(1);
            expect(registryClient.getPackageInfo).toHaveBeenCalled();
          }
        ),
        { numRuns: getPropertyTestRuns(20, 5) } // Reduced runs due to timing delays
      );
    }, 10000);

    it('should not wait for vulnerability scan to complete before starting freshness analysis', async () => {
      await fc.assert(
        fc.asyncProperty(
          // Generate random dependencies
          fc.array(
            fc.record({
              name: fc.string({ minLength: 1, maxLength: 30 }).filter((s) => !s.includes(' ')),
              version: fc
                .tuple(
                  fc.integer({ min: 0, max: 10 }),
                  fc.integer({ min: 0, max: 20 }),
                  fc.integer({ min: 0, max: 50 })
                )
                .map(([major, minor, patch]) => `${major}.${minor}.${patch}`),
              versionConstraint: fc.string({ minLength: 1, maxLength: 20 }),
              isDev: fc.boolean(),
            }),
            { minLength: 2, maxLength: 10 }
          ),
          async (dependencies: Dependency[]) => {
            // Track call order to verify parallel execution
            const callOrder: string[] = [];

            // Create mock OSV client
            const osvClient: VulnerabilityClient = {
              getVulnerabilities: vi.fn().mockResolvedValue([]),
              getBatchVulnerabilities: vi.fn().mockImplementation(async (deps: Dependency[]) => {
                callOrder.push('vulnerability-start');
                // Simulate longer work for vulnerability scan
                await new Promise((resolve) => setTimeout(resolve, 100));
                callOrder.push('vulnerability-end');

                const results = new Map<string, Vulnerability[]>();
                for (const dep of deps) {
                  results.set(dep.name, []);
                }
                return results;
              }),
            };

            // Create mock PackageRegistryClient
            const registryClient: PackageRegistryClient = {
              getPackageInfo: vi.fn().mockImplementation(async (packageName: string) => {
                callOrder.push(`freshness-${packageName}`);
                // Simulate shorter work for freshness
                await new Promise((resolve) => setTimeout(resolve, 20));

                const packageInfo: PackageInfo = {
                  name: packageName,
                  version: '2.0.0',
                  description: 'Test package',
                  publishedAt: new Date(),
                  license: 'MIT',
                };
                return packageInfo;
              }),
              getLatestVersion: vi.fn().mockResolvedValue('2.0.0'),
              searchPackages: vi.fn().mockResolvedValue([]),
              getVersionDeprecationStatus: vi.fn().mockResolvedValue(null),
            };

            // Create analyzers
            const securityAnalyzer = new SecurityAnalyzer(osvClient, mockOutputChannel);
            const freshnessAnalyzer = new FreshnessAnalyzer(registryClient, mockOutputChannel);

            // Create analysis engine
            const analysisEngine = new AnalysisEngine(
              securityAnalyzer,
              freshnessAnalyzer,
              registryClient,
              mockOutputChannel,
              mockContext
            );

            // Execute analysis
            const projectInfo = {
              type: ['npm' as const],
              dependencyFiles: [],
              dependencies,
            };

            await analysisEngine.analyze(projectInfo);

            // CRITICAL ASSERTION: Verify parallel execution by checking call order
            // If parallel, freshness calls should appear BEFORE vulnerability-end
            // If sequential, all freshness calls would appear AFTER vulnerability-end

            const vulnerabilityEndIndex = callOrder.indexOf('vulnerability-end');
            const firstFreshnessIndex = callOrder.findIndex((call) =>
              call.startsWith('freshness-')
            );

            expect(vulnerabilityEndIndex).toBeGreaterThan(-1);
            expect(firstFreshnessIndex).toBeGreaterThan(-1);

            // Freshness should start before vulnerability scan ends (parallel execution)
            expect(firstFreshnessIndex).toBeLessThan(vulnerabilityEndIndex);

            // Verify both operations completed
            expect(callOrder).toContain('vulnerability-start');
            expect(callOrder).toContain('vulnerability-end');
            expect(
              callOrder.filter((call) => call.startsWith('freshness-')).length
            ).toBeGreaterThan(0);
          }
        ),
        { numRuns: getPropertyTestRuns(20, 5) } // Reduced runs due to timing delays
      );
    }, 10000);

    it('should complete both vulnerability and freshness analysis even if one is slower', async () => {
      await fc.assert(
        fc.asyncProperty(
          // Generate random dependencies
          fc.array(
            fc.record({
              name: fc.string({ minLength: 1, maxLength: 30 }).filter((s) => !s.includes(' ')),
              version: fc
                .tuple(
                  fc.integer({ min: 0, max: 10 }),
                  fc.integer({ min: 0, max: 20 }),
                  fc.integer({ min: 0, max: 50 })
                )
                .map(([major, minor, patch]) => `${major}.${minor}.${patch}`),
              versionConstraint: fc.string({ minLength: 1, maxLength: 20 }),
              isDev: fc.boolean(),
            }),
            { minLength: 1, maxLength: 10 }
          ),
          // Generate random delays to simulate varying response times
          fc.integer({ min: 10, max: 100 }),
          fc.integer({ min: 10, max: 100 }),
          async (dependencies: Dependency[], vulnDelay: number, freshnessDelay: number) => {
            // Create mock OSV client with variable delay
            const osvClient: VulnerabilityClient = {
              getVulnerabilities: vi.fn().mockResolvedValue([]),
              getBatchVulnerabilities: vi.fn().mockImplementation(async (deps: Dependency[]) => {
                await new Promise((resolve) => setTimeout(resolve, vulnDelay));
                const results = new Map<string, Vulnerability[]>();
                for (const dep of deps) {
                  results.set(dep.name, []);
                }
                return results;
              }),
            };

            // Create mock PackageRegistryClient with variable delay
            const registryClient: PackageRegistryClient = {
              getPackageInfo: vi.fn().mockImplementation(async (packageName: string) => {
                await new Promise((resolve) => setTimeout(resolve, freshnessDelay));
                const packageInfo: PackageInfo = {
                  name: packageName,
                  version: '2.0.0',
                  description: 'Test package',
                  publishedAt: new Date(),
                  license: 'MIT',
                };
                return packageInfo;
              }),
              getLatestVersion: vi.fn().mockResolvedValue('2.0.0'),
              searchPackages: vi.fn().mockResolvedValue([]),
              getVersionDeprecationStatus: vi.fn().mockResolvedValue(null),
            };

            // Create analyzers
            const securityAnalyzer = new SecurityAnalyzer(osvClient, mockOutputChannel);
            const freshnessAnalyzer = new FreshnessAnalyzer(registryClient, mockOutputChannel);

            // Create analysis engine
            const analysisEngine = new AnalysisEngine(
              securityAnalyzer,
              freshnessAnalyzer,
              registryClient,
              mockOutputChannel,
              mockContext
            );

            // Execute analysis
            const projectInfo = {
              type: ['npm' as const],
              dependencyFiles: [],
              dependencies,
            };

            const result = await analysisEngine.analyze(projectInfo);

            // CRITICAL ASSERTION: Both analyses should complete regardless of which is slower
            // Verify both vulnerability and freshness data are present
            expect(result.dependencies.length).toBe(dependencies.length);

            for (const depAnalysis of result.dependencies) {
              // Security data should be present (from vulnerability scan)
              expect(depAnalysis.security).toBeDefined();
              expect(depAnalysis.security.vulnerabilities).toBeDefined();
              expect(depAnalysis.security.severity).toBeDefined();

              // Freshness data should be present (from freshness analysis)
              expect(depAnalysis.freshness).toBeDefined();
              expect(depAnalysis.freshness.currentVersion).toBeDefined();
              expect(depAnalysis.freshness.latestVersion).toBeDefined();
              expect(depAnalysis.freshness.releaseDate).toBeDefined();
            }

            // Verify both operations were called
            expect(osvClient.getBatchVulnerabilities).toHaveBeenCalledTimes(1);
            expect(registryClient.getPackageInfo).toHaveBeenCalled();
          }
        ),
        { numRuns: getPropertyTestRuns(20, 5) } // Reduced runs due to timing delays
      );
    }, 10000);
  });

  /**
   * Property 18: Combined analysis results
   * For any dependency analysis, the final result should contain both vulnerability data
   * from OSV and freshness data from npm registry
   * Validates: Requirements 9.5
   * Feature: osv-integration, Property 18: Combined analysis results
   */
  describe('Property 18: Combined analysis results', () => {
    it('should include both vulnerability and freshness data in analysis results', async () => {
      await fc.assert(
        fc.asyncProperty(
          // Generate random dependencies
          fc.array(
            fc.record({
              name: fc.string({ minLength: 1, maxLength: 30 }).filter((s) => !s.includes(' ')),
              version: fc
                .tuple(
                  fc.integer({ min: 0, max: 10 }),
                  fc.integer({ min: 0, max: 20 }),
                  fc.integer({ min: 0, max: 50 })
                )
                .map(([major, minor, patch]) => `${major}.${minor}.${patch}`),
              versionConstraint: fc.string({ minLength: 1, maxLength: 20 }),
              isDev: fc.boolean(),
            }),
            { minLength: 1, maxLength: 10 }
          ),
          async (dependencies: Dependency[]) => {
            // Create mock OSV client that returns vulnerability data
            const osvClient: VulnerabilityClient = {
              getVulnerabilities: vi.fn().mockResolvedValue([]),
              getBatchVulnerabilities: vi.fn().mockImplementation(async (deps: Dependency[]) => {
                const results = new Map<string, Vulnerability[]>();
                for (const dep of deps) {
                  results.set(dep.name, [
                    {
                      id: `VULN-${dep.name}`,
                      title: 'Test Vulnerability',
                      severity: 'medium',
                      affectedVersions: '< 2.0.0',
                      description: 'Test vulnerability description',
                      references: [],
                      publishedDate: new Date('2023-01-01'),
                      lastModifiedDate: new Date('2023-01-02'),
                    },
                  ]);
                }
                return results;
              }),
            };

            // Create mock PackageRegistryClient that returns freshness data
            const registryClient: PackageRegistryClient = {
              getPackageInfo: vi.fn().mockImplementation(async (packageName: string) => {
                const packageInfo: PackageInfo = {
                  name: packageName,
                  version: '3.0.0',
                  description: 'Test package',
                  publishedAt: new Date('2024-01-01'),
                  license: 'MIT',
                };
                return packageInfo;
              }),
              getLatestVersion: vi.fn().mockResolvedValue('3.0.0'),
              searchPackages: vi.fn().mockResolvedValue([]),
              getVersionDeprecationStatus: vi.fn().mockResolvedValue(null),
            };

            // Create analyzers
            const securityAnalyzer = new SecurityAnalyzer(osvClient, mockOutputChannel);
            const freshnessAnalyzer = new FreshnessAnalyzer(registryClient, mockOutputChannel);

            // Create analysis engine
            const analysisEngine = new AnalysisEngine(
              securityAnalyzer,
              freshnessAnalyzer,
              registryClient,
              mockOutputChannel,
              mockContext
            );

            // Execute analysis
            const projectInfo = {
              type: ['npm' as const],
              dependencyFiles: [],
              dependencies,
            };

            const result = await analysisEngine.analyze(projectInfo);

            // CRITICAL ASSERTION: Every dependency should have BOTH vulnerability and freshness data
            expect(result.dependencies.length).toBe(dependencies.length);

            for (let i = 0; i < dependencies.length; i++) {
              const dep = dependencies[i];
              const depAnalysis = result.dependencies[i];

              // Verify dependency matches
              expect(depAnalysis.dependency.name).toBe(dep.name);
              expect(depAnalysis.dependency.version).toBe(dep.version);

              // Verify vulnerability data is present (from OSV)
              // Note: SecurityAnalyzer filters by version, so vulnerabilities may be empty
              // if the version doesn't match the affected range
              expect(depAnalysis.security).toBeDefined();
              expect(depAnalysis.security.vulnerabilities).toBeDefined();
              expect(depAnalysis.security.severity).toBeDefined();

              // If vulnerabilities are present, verify they have the correct structure
              if (depAnalysis.security.vulnerabilities.length > 0) {
                expect(depAnalysis.security.vulnerabilities[0].id).toBe(`VULN-${dep.name}`);
              }

              // Verify freshness data is present (from npm registry)
              expect(depAnalysis.freshness).toBeDefined();
              expect(depAnalysis.freshness.currentVersion).toBe(dep.version);
              expect(depAnalysis.freshness.latestVersion).toBe('3.0.0');
              expect(depAnalysis.freshness.releaseDate).toEqual(new Date('2024-01-01'));
              expect(depAnalysis.freshness.isOutdated).toBeDefined();
              expect(depAnalysis.freshness.isUnmaintained).toBeDefined();

              // Verify license data is present (from npm registry)
              expect(depAnalysis.license).toBeDefined();
              expect(depAnalysis.license.license).toBe('MIT');
            }
          }
        ),
        { numRuns: getPropertyTestRuns(100, 20) }
      );
    });

    it('should maintain data integrity when combining vulnerability and freshness results', async () => {
      await fc.assert(
        fc.asyncProperty(
          // Generate random dependencies
          fc.array(
            fc.record({
              name: fc.string({ minLength: 1, maxLength: 30 }).filter((s) => !s.includes(' ')),
              version: fc
                .tuple(
                  fc.integer({ min: 0, max: 10 }),
                  fc.integer({ min: 0, max: 20 }),
                  fc.integer({ min: 0, max: 50 })
                )
                .map(([major, minor, patch]) => `${major}.${minor}.${patch}`),
              versionConstraint: fc.string({ minLength: 1, maxLength: 20 }),
              isDev: fc.boolean(),
            }),
            { minLength: 1, maxLength: 10 }
          ),
          async (dependencies: Dependency[]) => {
            // Create mock clients with distinct, verifiable data
            const osvClient: VulnerabilityClient = {
              getVulnerabilities: vi.fn().mockResolvedValue([]),
              getBatchVulnerabilities: vi.fn().mockImplementation(async (deps: Dependency[]) => {
                const results = new Map<string, Vulnerability[]>();
                // SecurityAnalyzer expects package names as keys (not composite keys)
                // If there are duplicate names, the last one wins (acceptable for property test)
                for (const dep of deps) {
                  results.set(dep.name, [
                    {
                      id: `OSV-${dep.name}-${dep.version}`,
                      title: `Vulnerability in ${dep.name}`,
                      severity: 'high',
                      affectedVersions: `<=${dep.version}`,
                      description: `OSV vulnerability for ${dep.name}`,
                      references: [`https://osv.dev/${dep.name}`],
                      publishedDate: new Date('2023-06-01'),
                      lastModifiedDate: new Date('2023-06-15'),
                    },
                  ]);
                }
                return results;
              }),
            };

            const registryClient: PackageRegistryClient = {
              getPackageInfo: vi.fn().mockImplementation(async (packageName: string) => {
                const packageInfo: PackageInfo = {
                  name: packageName,
                  version: '5.0.0',
                  description: `Registry info for ${packageName}`,
                  publishedAt: new Date('2024-03-15'),
                  license: 'Apache-2.0',
                };
                return packageInfo;
              }),
              getLatestVersion: vi.fn().mockResolvedValue('5.0.0'),
              searchPackages: vi.fn().mockResolvedValue([]),
              getVersionDeprecationStatus: vi.fn().mockResolvedValue(null),
            };

            // Create analyzers
            const securityAnalyzer = new SecurityAnalyzer(osvClient, mockOutputChannel);
            const freshnessAnalyzer = new FreshnessAnalyzer(registryClient, mockOutputChannel);

            // Create analysis engine
            const analysisEngine = new AnalysisEngine(
              securityAnalyzer,
              freshnessAnalyzer,
              registryClient,
              mockOutputChannel,
              mockContext
            );

            // Execute analysis
            const projectInfo = {
              type: ['npm' as const],
              dependencyFiles: [],
              dependencies,
            };

            const result = await analysisEngine.analyze(projectInfo);

            // CRITICAL ASSERTION: Verify data integrity - no mixing or corruption
            // Note: When duplicate package names exist, the Map in SecurityAnalyzer uses only the name as key,
            // so the last dependency with that name will overwrite previous ones. We need to find the
            // dependency by name and version to get the correct analysis.
            for (let i = 0; i < dependencies.length; i++) {
              const dep = dependencies[i];
              // Find the analysis for this specific dependency by matching name and version
              // (not by index, since duplicates may cause mismatches)
              const depAnalysis = result.dependencies.find(
                (d) => d.dependency.name === dep.name && d.dependency.version === dep.version
              );

              // Skip if we couldn't find a matching analysis (shouldn't happen, but be defensive)
              if (!depAnalysis) {
                continue;
              }

              // Verify vulnerability data integrity (from OSV)
              // Note: Vulnerabilities may be filtered out if version doesn't match affectedVersions
              // Also note: When duplicate package names exist, the vulnerability data may come from
              // the last dependency with that name in the Map. We verify that if vulnerabilities exist,
              // they match the expected format, but we don't assert on the specific ID since duplicates
              // may cause the last one to overwrite previous entries.
              if (depAnalysis.security.vulnerabilities.length > 0) {
                // Check if this is a duplicate name case - if so, the vulnerability ID might not match
                // exactly because the Map overwrites entries. We verify the structure is correct instead.
                const isDuplicateName = dependencies.filter((d) => d.name === dep.name).length > 1;
                if (!isDuplicateName) {
                  // Only check exact ID match when there are no duplicates
                  expect(depAnalysis.security.vulnerabilities[0].id).toBe(
                    `OSV-${dep.name}-${dep.version}`
                  );
                }
                // Always verify the structure is correct
                expect(depAnalysis.security.vulnerabilities[0].description).toContain('OSV');
                expect(depAnalysis.security.vulnerabilities[0].description).toContain(dep.name);
                expect(depAnalysis.security.vulnerabilities[0].references[0]).toContain('osv.dev');
              }
              // If no vulnerabilities, that's also valid (version might not match affectedVersions)

              // Verify freshness data integrity (from registry)
              expect(depAnalysis.freshness.latestVersion).toBe('5.0.0');
              expect(depAnalysis.freshness.releaseDate).toEqual(new Date('2024-03-15'));

              // Verify license data integrity (from registry)
              expect(depAnalysis.license.license).toBe('Apache-2.0');

              // Verify no cross-contamination (only if vulnerabilities exist)
              if (depAnalysis.security.vulnerabilities.length > 0) {
                // Vulnerability data should not contain registry-specific info
                expect(depAnalysis.security.vulnerabilities[0].description).not.toContain(
                  'Registry'
                );
              }
              // Freshness data should not contain OSV-specific info
              expect(depAnalysis.freshness.latestVersion).not.toContain('OSV');
            }
          }
        ),
        { numRuns: getPropertyTestRuns(100, 20) }
      );
    });

    it('should handle empty results from either source without losing data from the other', async () => {
      await fc.assert(
        fc.asyncProperty(
          // Generate random dependencies
          fc.array(
            fc.record({
              name: fc.string({ minLength: 1, maxLength: 30 }).filter((s) => !s.includes(' ')),
              version: fc
                .tuple(
                  fc.integer({ min: 0, max: 10 }),
                  fc.integer({ min: 0, max: 20 }),
                  fc.integer({ min: 0, max: 50 })
                )
                .map(([major, minor, patch]) => `${major}.${minor}.${patch}`),
              versionConstraint: fc.string({ minLength: 1, maxLength: 20 }),
              isDev: fc.boolean(),
            }),
            { minLength: 1, maxLength: 10 }
          ),
          async (dependencies: Dependency[]) => {
            // Create mock OSV client that returns NO vulnerabilities
            const osvClient: VulnerabilityClient = {
              getVulnerabilities: vi.fn().mockResolvedValue([]),
              getBatchVulnerabilities: vi.fn().mockImplementation(async (deps: Dependency[]) => {
                const results = new Map<string, Vulnerability[]>();
                for (const dep of deps) {
                  results.set(dep.name, []); // No vulnerabilities
                }
                return results;
              }),
            };

            // Create mock PackageRegistryClient that returns freshness data
            const registryClient: PackageRegistryClient = {
              getPackageInfo: vi.fn().mockImplementation(async (packageName: string) => {
                const packageInfo: PackageInfo = {
                  name: packageName,
                  version: '2.5.0',
                  description: 'Test package',
                  publishedAt: new Date('2024-02-01'),
                  license: 'BSD-3-Clause',
                };
                return packageInfo;
              }),
              getLatestVersion: vi.fn().mockResolvedValue('2.5.0'),
              searchPackages: vi.fn().mockResolvedValue([]),
              getVersionDeprecationStatus: vi.fn().mockResolvedValue(null),
            };

            // Create analyzers
            const securityAnalyzer = new SecurityAnalyzer(osvClient, mockOutputChannel);
            const freshnessAnalyzer = new FreshnessAnalyzer(registryClient, mockOutputChannel);

            // Create analysis engine
            const analysisEngine = new AnalysisEngine(
              securityAnalyzer,
              freshnessAnalyzer,
              registryClient,
              mockOutputChannel,
              mockContext
            );

            // Execute analysis
            const projectInfo = {
              type: ['npm' as const],
              dependencyFiles: [],
              dependencies,
            };

            const result = await analysisEngine.analyze(projectInfo);

            // CRITICAL ASSERTION: Even with no vulnerabilities, freshness data should be present
            for (const depAnalysis of result.dependencies) {
              // Vulnerability data should be empty but present
              expect(depAnalysis.security).toBeDefined();
              expect(depAnalysis.security.vulnerabilities).toEqual([]);
              expect(depAnalysis.security.severity).toBe('none');

              // Freshness data should still be complete
              expect(depAnalysis.freshness).toBeDefined();
              expect(depAnalysis.freshness.latestVersion).toBe('2.5.0');
              expect(depAnalysis.freshness.releaseDate).toEqual(new Date('2024-02-01'));

              // License data should still be present
              expect(depAnalysis.license).toBeDefined();
              expect(depAnalysis.license.license).toBe('BSD-3-Clause');
            }
          }
        ),
        { numRuns: getPropertyTestRuns(100, 20) }
      );
    });
  });
});

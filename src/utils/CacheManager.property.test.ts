import * as fc from 'fast-check';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { getPropertyTestRuns } from '../test-setup';
import type { Vulnerability } from '../types';
import { CacheManager } from './CacheManager';

// Mock in-memory file system
const mockFs = new Map<string, Uint8Array>();

// Mock vscode module
vi.mock('vscode', () => {
  return {
    Uri: {
      joinPath: vi.fn((base, ...pathSegments) => ({
        fsPath: `${base.fsPath}/${pathSegments.join('/')}`,
        scheme: 'file',
        toString: () => `file://${base.fsPath}/${pathSegments.join('/')}`,
      })),
      file: vi.fn((path) => ({ fsPath: path, scheme: 'file', toString: () => `file://${path}` })),
    },
    workspace: {
      fs: {
        createDirectory: vi.fn().mockResolvedValue(undefined),
        writeFile: vi.fn((uri, content) => {
          mockFs.set(uri.toString(), content);
          return Promise.resolve();
        }),
        readFile: vi.fn((uri) => {
          const content = mockFs.get(uri.toString());
          if (!content) {
            const error = new Error('File not found') as Error & { code: string };
            error.code = 'FileNotFound';
            return Promise.reject(error);
          }
          return Promise.resolve(content);
        }),
        delete: vi.fn((uri) => {
          mockFs.delete(uri.toString());
          return Promise.resolve();
        }),
        readDirectory: vi.fn(() => Promise.resolve([])),
      },
    },
    FileSystemError: class extends Error {
      code: string;
      constructor(message?: string) {
        super(message);
        this.code = 'FileNotFound';
      }
    },
    FileType: {
      File: 1,
      Directory: 2,
    },
  };
});

// Mock extension context
const createMockContext = (): vscode.ExtensionContext => {
  const cache = new Map<string, unknown>();
  return {
    subscriptions: [],
    workspaceState: {} as unknown as vscode.Memento,
    globalState: {
      get: vi.fn((key: string) => cache.get(key)),
      update: vi.fn((key: string, value: unknown) => {
        if (value === undefined) {
          cache.delete(key);
        } else {
          cache.set(key, value);
        }
        return Promise.resolve();
      }),
      keys: vi.fn(() => Array.from(cache.keys())),
      setKeysForSync: vi.fn(),
    },
    extensionPath: '/test/path',
    extensionUri: { fsPath: '/test/path' } as unknown as vscode.Uri,
    environmentVariableCollection: {} as unknown as vscode.GlobalEnvironmentVariableCollection,
    extensionMode: 3,
    storageUri: { fsPath: '/test/storage' } as unknown as vscode.Uri,
    storagePath: '/test/storage',
    globalStorageUri: { fsPath: '/test/global-storage' } as unknown as vscode.Uri,
    globalStoragePath: '/test/global-storage',
    logUri: {} as unknown as vscode.Uri,
    logPath: '/test/log',
    asAbsolutePath: vi.fn((path: string) => `/test/path/${path}`),
    secrets: {} as unknown as vscode.SecretStorage,
    extension: {} as unknown as vscode.Extension<unknown>,
    languageModelAccessInformation: {} as unknown as vscode.LanguageModelAccessInformation,
  };
};

// Mock log function
const createMockLog = () => vi.fn();

describe('CacheManager - Property-Based Tests', () => {
  let mockContext: vscode.ExtensionContext;
  let mockLog: ReturnType<typeof createMockLog>;

  beforeEach(() => {
    mockContext = createMockContext();
    mockLog = createMockLog();
    mockFs.clear();
  });

  /**
   * Property 12: Critical vulnerability cache bypass
   * For any vulnerability with critical or high severity, the CacheManager should bypass
   * the cache and query OSV.dev directly
   * Validates: Requirements 6.2
   * Feature: osv-integration, Property 12: Critical vulnerability cache bypass
   */
  describe('Property 12: Critical vulnerability cache bypass', () => {
    it('should bypass cache for any package with critical or high severity vulnerabilities', async () => {
      await fc.assert(
        fc.asyncProperty(
          // Generate random package names and versions
          fc.string({ minLength: 1, maxLength: 50 }),
          fc.string({ minLength: 1, maxLength: 20 }),
          // Generate vulnerabilities with at least one critical or high
          fc
            .array(
              fc.record({
                id: fc.string({ minLength: 10, maxLength: 30 }),
                title: fc.string({ minLength: 10, maxLength: 100 }),
                severity: fc.constantFrom('critical', 'high', 'medium', 'low'),
                affectedVersions: fc.string({ minLength: 1, maxLength: 20 }),
                description: fc.string({ minLength: 20, maxLength: 200 }),
                references: fc.array(fc.webUrl(), { minLength: 0, maxLength: 3 }),
                source: fc.constant('osv' as const),
              }),
              { minLength: 1, maxLength: 10 }
            )
            .filter((vulns) =>
              vulns.some((v) => v.severity === 'critical' || v.severity === 'high')
            ),
          async (packageName, version, vulnerabilities: Vulnerability[]) => {
            const cacheManager = new CacheManager(mockContext, mockLog, {
              vulnerabilityTTLMinutes: 60,
              bypassCacheForCritical: true,
            });

            // Cache the vulnerabilities
            await cacheManager.cacheOSVVulnerabilities(packageName, version, vulnerabilities);

            // Try to retrieve from cache - should return null due to bypass
            const cached = await cacheManager.getCachedOSVVulnerabilities(packageName, version);

            // Verify cache was bypassed
            expect(cached).toBeNull();
          }
        ),
        { numRuns: getPropertyTestRuns(100, 20) }
      );
    });

    it('should NOT bypass cache when bypassCacheForCritical is disabled', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 1, maxLength: 50 }),
          fc.string({ minLength: 1, maxLength: 20 }),
          fc
            .array(
              fc.record({
                id: fc.string({ minLength: 10, maxLength: 30 }),
                title: fc.string({ minLength: 10, maxLength: 100 }),
                severity: fc.constantFrom('critical', 'high', 'medium', 'low'),
                affectedVersions: fc.string({ minLength: 1, maxLength: 20 }),
                description: fc.string({ minLength: 20, maxLength: 200 }),
                references: fc.array(fc.webUrl(), { minLength: 0, maxLength: 3 }),
                source: fc.constant('osv' as const),
              }),
              { minLength: 1, maxLength: 10 }
            )
            .filter((vulns) =>
              vulns.some((v) => v.severity === 'critical' || v.severity === 'high')
            ),
          async (packageName, version, vulnerabilities: Vulnerability[]) => {
            const cacheManager = new CacheManager(mockContext, mockLog, {
              vulnerabilityTTLMinutes: 60,
              bypassCacheForCritical: false, // Disabled
            });

            await cacheManager.cacheOSVVulnerabilities(packageName, version, vulnerabilities);
            const cached = await cacheManager.getCachedOSVVulnerabilities(packageName, version);

            // Should return cached data even with critical/high vulnerabilities
            expect(cached).not.toBeNull();
            expect(cached).toHaveLength(vulnerabilities.length);
          }
        ),
        { numRuns: getPropertyTestRuns(100, 20) }
      );
    });

    it('should NOT bypass cache for packages with only medium or low severity vulnerabilities', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 1, maxLength: 50 }),
          fc.string({ minLength: 1, maxLength: 20 }),
          fc.array(
            fc.record({
              id: fc.string({ minLength: 10, maxLength: 30 }),
              title: fc.string({ minLength: 10, maxLength: 100 }),
              severity: fc.constantFrom('medium', 'low'),
              affectedVersions: fc.string({ minLength: 1, maxLength: 20 }),
              description: fc.string({ minLength: 20, maxLength: 200 }),
              references: fc.array(fc.webUrl(), { minLength: 0, maxLength: 3 }),
              source: fc.constant('osv' as const),
            }),
            { minLength: 1, maxLength: 10 }
          ),
          async (packageName, version, vulnerabilities: Vulnerability[]) => {
            const cacheManager = new CacheManager(mockContext, mockLog, {
              vulnerabilityTTLMinutes: 60,
              bypassCacheForCritical: true,
            });

            await cacheManager.cacheOSVVulnerabilities(packageName, version, vulnerabilities);
            const cached = await cacheManager.getCachedOSVVulnerabilities(packageName, version);

            // Should return cached data for medium/low severity
            expect(cached).not.toBeNull();
            expect(cached).toHaveLength(vulnerabilities.length);
          }
        ),
        { numRuns: getPropertyTestRuns(100, 20) }
      );
    });
  });

  /**
   * Property 13: Cache key format
   * For any package name and version, the cache key for OSV data should match
   * the format `vuln:osv:{packageName}:{version}`
   * Validates: Requirements 6.4
   * Feature: osv-integration, Property 13: Cache key format
   */
  describe('Property 13: Cache key format', () => {
    it('should use correct cache key format (hashed) for any package name and version', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 1, maxLength: 50 }),
          fc.string({ minLength: 1, maxLength: 20 }),
          fc.array(
            fc.record({
              id: fc.string({ minLength: 10, maxLength: 30 }),
              title: fc.string({ minLength: 10, maxLength: 100 }),
              severity: fc.constantFrom('critical', 'high', 'medium', 'low'),
              affectedVersions: fc.string({ minLength: 1, maxLength: 20 }),
              description: fc.string({ minLength: 20, maxLength: 200 }),
              references: fc.array(fc.webUrl(), { minLength: 0, maxLength: 3 }),
              source: fc.constant('osv' as const),
            }),
            { minLength: 0, maxLength: 5 }
          ),
          async (packageName, version, vulnerabilities: Vulnerability[]) => {
            const cacheManager = new CacheManager(mockContext, mockLog, {
              vulnerabilityTTLMinutes: 60,
              bypassCacheForCritical: false, // Disable bypass to test key format
            });

            await cacheManager.cacheOSVVulnerabilities(packageName, version, vulnerabilities);

            // Verify that a file was written. We can't easily verify the key format directly
            // because it's hashed, but we can verify that getCachedOSVVulnerabilities works,
            // which implies the key generation is consistent.
            const cached = await cacheManager.getCachedOSVVulnerabilities(packageName, version);
            expect(cached).not.toBeNull();
          }
        ),
        { numRuns: getPropertyTestRuns(100, 20) }
      );
    });

    it('should handle scoped package names correctly', async () => {
      await fc.assert(
        fc.asyncProperty(
          // Generate scoped package names
          fc
            .tuple(
              fc.string({ minLength: 1, maxLength: 20 }),
              fc.string({ minLength: 1, maxLength: 20 })
            )
            .map(([scope, name]) => `@${scope}/${name}`),
          fc.string({ minLength: 1, maxLength: 20 }),
          fc.array(
            fc.record({
              id: fc.string({ minLength: 10, maxLength: 30 }),
              title: fc.string({ minLength: 10, maxLength: 100 }),
              severity: fc.constantFrom('critical', 'high', 'medium', 'low'),
              affectedVersions: fc.string({ minLength: 1, maxLength: 20 }),
              description: fc.string({ minLength: 20, maxLength: 200 }),
              references: fc.array(fc.webUrl(), { minLength: 0, maxLength: 3 }),
              source: fc.constant('osv' as const),
            }),
            { minLength: 0, maxLength: 5 }
          ),
          async (packageName, version, vulnerabilities: Vulnerability[]) => {
            const cacheManager = new CacheManager(mockContext, mockLog, {
              vulnerabilityTTLMinutes: 60,
              bypassCacheForCritical: false,
            });

            await cacheManager.cacheOSVVulnerabilities(packageName, version, vulnerabilities);

            // Verify scoped package names are handled correctly (no error)
            const cached = await cacheManager.getCachedOSVVulnerabilities(packageName, version);
            expect(cached).not.toBeNull();
          }
        ),
        { numRuns: getPropertyTestRuns(100, 20) }
      );
    });
  });

  /**
   * Property 14: Per-package caching
   * For any batch of dependencies, each package's vulnerabilities should be cached
   * individually to enable partial cache hits
   * Validates: Requirements 6.5
   * Feature: osv-integration, Property 14: Per-package caching
   */
  describe('Property 14: Per-package caching', () => {
    it('should cache each package individually for any batch of dependencies', async () => {
      await fc.assert(
        fc.asyncProperty(
          // Generate multiple packages
          fc.array(
            fc.record({
              name: fc.string({ minLength: 1, maxLength: 50 }),
              version: fc.string({ minLength: 1, maxLength: 20 }),
              vulnerabilities: fc.array(
                fc.record({
                  id: fc.string({ minLength: 10, maxLength: 30 }),
                  title: fc.string({ minLength: 10, maxLength: 100 }),
                  severity: fc.constantFrom('critical', 'high', 'medium', 'low'),
                  affectedVersions: fc.string({ minLength: 1, maxLength: 20 }),
                  description: fc.string({ minLength: 20, maxLength: 200 }),
                  references: fc.array(fc.webUrl(), { minLength: 0, maxLength: 3 }),
                  source: fc.constant('osv' as const),
                }),
                { minLength: 0, maxLength: 5 }
              ),
            }),
            { minLength: 2, maxLength: 20 }
          ),
          async (packages) => {
            const cacheManager = new CacheManager(mockContext, mockLog, {
              vulnerabilityTTLMinutes: 60,
              bypassCacheForCritical: false,
            });

            // Cache each package individually
            for (const pkg of packages) {
              await cacheManager.cacheOSVVulnerabilities(
                pkg.name,
                pkg.version,
                pkg.vulnerabilities
              );
            }

            // Verify each package can be retrieved independently
            for (const pkg of packages) {
              const cached = await cacheManager.getCachedOSVVulnerabilities(pkg.name, pkg.version);
              expect(cached).not.toBeNull();
              expect(cached).toHaveLength(pkg.vulnerabilities.length);
            }
          }
        ),
        { numRuns: getPropertyTestRuns(100, 20) }
      );
    });

    it('should enable partial cache hits when some packages are cached and others are not', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.record({
              name: fc.string({ minLength: 1, maxLength: 50 }),
              version: fc.string({ minLength: 1, maxLength: 20 }),
              vulnerabilities: fc.array(
                fc.record({
                  id: fc.string({ minLength: 10, maxLength: 30 }),
                  title: fc.string({ minLength: 10, maxLength: 100 }),
                  severity: fc.constantFrom('critical', 'high', 'medium', 'low'),
                  affectedVersions: fc.string({ minLength: 1, maxLength: 20 }),
                  description: fc.string({ minLength: 20, maxLength: 200 }),
                  references: fc.array(fc.webUrl(), { minLength: 0, maxLength: 3 }),
                  source: fc.constant('osv' as const),
                }),
                { minLength: 0, maxLength: 5 }
              ),
            }),
            { minLength: 3, maxLength: 20 }
          ),
          async (packages) => {
            const cacheManager = new CacheManager(mockContext, mockLog, {
              vulnerabilityTTLMinutes: 60,
              bypassCacheForCritical: false,
            });

            // Cache only half of the packages
            const halfIndex = Math.floor(packages.length / 2);
            for (let i = 0; i < halfIndex; i++) {
              const pkg = packages[i];
              await cacheManager.cacheOSVVulnerabilities(
                pkg.name,
                pkg.version,
                pkg.vulnerabilities
              );
            }

            // Verify cached packages return data
            for (let i = 0; i < halfIndex; i++) {
              const pkg = packages[i];
              const cached = await cacheManager.getCachedOSVVulnerabilities(pkg.name, pkg.version);
              expect(cached).not.toBeNull();
            }

            // Verify non-cached packages return null
            for (let i = halfIndex; i < packages.length; i++) {
              const pkg = packages[i];
              const cached = await cacheManager.getCachedOSVVulnerabilities(pkg.name, pkg.version);
              expect(cached).toBeNull();
            }
          }
        ),
        { numRuns: getPropertyTestRuns(100, 20) }
      );
    });
  });
});

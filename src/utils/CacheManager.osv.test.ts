import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import type { PackageInfo, Vulnerability } from '../types';
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
        readDirectory: vi.fn(() => {
          const entries: [string, vscode.FileType][] = [];
          for (const uriString of mockFs.keys()) {
            // Simple extraction of filename from URI string
            const parts = uriString.split('/');
            const name = parts[parts.length - 1];
            entries.push([name, 1 /* FileType.File */]);
          }
          return Promise.resolve(entries);
        }),
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

// Mock ExtensionContext with global state storage
const createMockContext = (): vscode.ExtensionContext => {
  const storage = new Map<string, unknown>();

  return {
    globalStorageUri: { fsPath: '/test/global-storage' } as unknown as vscode.Uri,
    globalState: {
      get: vi.fn().mockImplementation((key: string) => storage.get(key)),
      update: vi.fn().mockImplementation(async (key: string, value: unknown) => {
        if (value === undefined) {
          storage.delete(key);
        } else {
          storage.set(key, value);
        }
      }),
      keys: vi.fn().mockImplementation(() => Array.from(storage.keys())),
      setKeysForSync: vi.fn(),
    },
  } as unknown as vscode.ExtensionContext;
};

describe('CacheManager - OSV Integration Tests', () => {
  let cacheManager: CacheManager;
  let mockContext: vscode.ExtensionContext;
  const mockLog = vi.fn();

  beforeEach(() => {
    mockContext = createMockContext();
    cacheManager = new CacheManager(mockContext, mockLog, {
      vulnerabilityTTLMinutes: 60,
      bypassCacheForCritical: true,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Task 15.5: Test OSV cache behavior
   * Validates: Requirements 6.1, 6.4
   */
  describe('15.5: OSV cache behavior', () => {
    const createTestVuln = (
      id: string,
      severity: 'critical' | 'high' | 'medium' | 'low'
    ): Vulnerability => ({
      id,
      title: 'Test Vulnerability',
      severity,
      affectedVersions: '< 2.0.0',
      description: 'Test description',
      references: [],
      publishedDate: new Date(),
      lastModifiedDate: new Date(),
      sources: ['osv'],
    });

    it('should cache OSV vulnerability data with 60-minute TTL', async () => {
      const packageName = 'lodash';
      const version = '4.17.20';
      const vulnerabilities: Vulnerability[] = [createTestVuln('CVE-2021-1234', 'medium')];

      await cacheManager.cacheOSVVulnerabilities(packageName, version, vulnerabilities);

      const cached = await cacheManager.getCachedOSVVulnerabilities(packageName, version);
      expect(cached).toEqual(vulnerabilities);
      expect(mockLog).toHaveBeenCalled();
    });

    it('should cache OSV data separately per package and version', async () => {
      const packages = [
        { name: 'lodash', version: '4.17.20' },
        { name: 'axios', version: '0.21.1' },
      ];

      for (const pkg of packages) {
        const vulns = [createTestVuln(`CVE-2021-${pkg.name}`, 'low')];
        await cacheManager.cacheOSVVulnerabilities(pkg.name, pkg.version, vulns);
      }

      const cached1 = await cacheManager.getCachedOSVVulnerabilities(
        packages[0].name,
        packages[0].version
      );
      const cached2 = await cacheManager.getCachedOSVVulnerabilities(
        packages[1].name,
        packages[1].version
      );

      expect(cached1).not.toBeNull();
      expect(cached2).not.toBeNull();
    });

    it('should handle cache misses', async () => {
      const cached = await cacheManager.getCachedOSVVulnerabilities('nonexistent', '1.0.0');
      expect(cached).toBeNull();
      expect(mockLog).toHaveBeenCalledWith('debug', expect.stringContaining('Cache miss'));
    });

    it('should respect TTL for OSV cache (60 minutes)', async () => {
      const packageName = 'test-package';
      const version = '1.0.0';
      const vulns = [createTestVuln('CVE-2021-TEST', 'low')];

      await cacheManager.cacheOSVVulnerabilities(packageName, version, vulns);

      // Should be cached initially
      let cached = await cacheManager.getCachedOSVVulnerabilities(packageName, version);
      expect(cached).toEqual(vulns);

      // Mock time to simulate expiry
      const cacheTime = Date.now();

      // Just before expiry (59 minutes later)
      vi.spyOn(Date, 'now').mockReturnValue(cacheTime + 59 * 60 * 1000);
      cached = await cacheManager.getCachedOSVVulnerabilities(packageName, version);
      expect(cached).toEqual(vulns);

      // After expiry (61 minutes later)
      vi.spyOn(Date, 'now').mockReturnValue(cacheTime + 61 * 60 * 1000);
      cached = await cacheManager.getCachedOSVVulnerabilities(packageName, version);
      expect(cached).toBeNull();

      vi.restoreAllMocks();
    });

    it('should clear all OSV cache entries', async () => {
      const packages = ['pkg1', 'pkg2', 'pkg3'];

      for (const pkg of packages) {
        const vulns = [createTestVuln(`CVE-${pkg}`, 'low')];
        await cacheManager.cacheOSVVulnerabilities(pkg, '1.0.0', vulns);
      }

      // Verify all cached
      for (const pkg of packages) {
        const cached = await cacheManager.getCachedOSVVulnerabilities(pkg, '1.0.0');
        expect(cached).not.toBeNull();
      }

      // Clear OSV cache
      await cacheManager.clearOSVCache();

      // Verify all cleared
      for (const pkg of packages) {
        const cached = await cacheManager.getCachedOSVVulnerabilities(pkg, '1.0.0');
        expect(cached).toBeNull();
      }
    });
  });

  describe('NPM cache behavior', () => {
    it('should expire npm package info after 24 hours', async () => {
      const packageName = 'npm-package';
      const info: PackageInfo = {
        name: packageName,
        version: '1.0.0',
        description: 'Test package',
        license: 'MIT',
        publishedAt: new Date('2024-01-01T00:00:00Z'),
      };

      const baseTime = Date.now();
      const nowSpy = vi.spyOn(Date, 'now');

      try {
        nowSpy.mockReturnValue(baseTime);
        await cacheManager.cacheNpmInfo(packageName, info);

        // Within TTL (just under 24h) should still be cached
        nowSpy.mockReturnValue(baseTime + 23 * 60 * 60 * 1000 + 59 * 60 * 1000);
        let cached = await cacheManager.getCachedNpmInfo(packageName);
        expect(cached).not.toBeNull();
        expect(cached?.name).toBe(packageName);

        // Past TTL (over 24h) should be treated as expired and removed
        nowSpy.mockReturnValue(baseTime + 25 * 60 * 60 * 1000);
        cached = await cacheManager.getCachedNpmInfo(packageName);
        expect(cached).toBeNull();
        expect(mockFs.size).toBe(0);
      } finally {
        nowSpy.mockRestore();
      }
    });
  });

  /**
   * Task 15.6: Test critical vulnerability cache bypass
   * Validates: Requirements 6.2
   */
  describe('15.6: Critical vulnerability cache bypass', () => {
    const createTestVuln = (
      id: string,
      severity: 'critical' | 'high' | 'medium' | 'low'
    ): Vulnerability => ({
      id,
      title: 'Test Vulnerability',
      severity,
      affectedVersions: '< 2.0.0',
      description: 'Test description',
      references: [],
      publishedDate: new Date(),
      lastModifiedDate: new Date(),
      sources: ['osv'],
    });

    it('should bypass cache for critical severity vulnerabilities', async () => {
      const packageName = 'critical-package';
      const version = '1.0.0';
      const criticalVulns = [createTestVuln('CVE-2021-CRITICAL', 'critical')];

      // Cache critical vulnerabilities
      await cacheManager.cacheOSVVulnerabilities(packageName, version, criticalVulns);

      // Clear previous logs
      mockLog.mockClear();

      // Should bypass cache and return null
      const cached = await cacheManager.getCachedOSVVulnerabilities(packageName, version);
      expect(cached).toBeNull();

      // Verify bypass logging (after clearing)
      expect(mockLog).toHaveBeenCalledWith('info', expect.stringContaining('Bypassing cache'));
    });

    it('should bypass cache for high severity vulnerabilities', async () => {
      const packageName = 'high-severity-package';
      const version = '1.0.0';
      const highVulns = [createTestVuln('CVE-2021-HIGH', 'high')];

      await cacheManager.cacheOSVVulnerabilities(packageName, version, highVulns);

      // Should bypass cache for high severity
      const cached = await cacheManager.getCachedOSVVulnerabilities(packageName, version);
      expect(cached).toBeNull();
    });

    it('should cache medium and low severity vulnerabilities', async () => {
      const mediumPkg = { name: 'medium-package', version: '1.0.0' };
      const lowPkg = { name: 'low-package', version: '1.0.0' };

      const mediumVulns = [createTestVuln('CVE-2021-MEDIUM', 'medium')];
      const lowVulns = [createTestVuln('CVE-2021-LOW', 'low')];

      await cacheManager.cacheOSVVulnerabilities(mediumPkg.name, mediumPkg.version, mediumVulns);
      await cacheManager.cacheOSVVulnerabilities(lowPkg.name, lowPkg.version, lowVulns);

      // Both should be cached (not bypassed)
      const cachedMedium = await cacheManager.getCachedOSVVulnerabilities(
        mediumPkg.name,
        mediumPkg.version
      );
      const cachedLow = await cacheManager.getCachedOSVVulnerabilities(lowPkg.name, lowPkg.version);

      expect(cachedMedium).toEqual(mediumVulns);
      expect(cachedLow).toEqual(lowVulns);
    });

    it('should bypass cache if ANY vulnerability is critical/high', async () => {
      const packageName = 'mixed-severity';
      const version = '1.0.0';
      const mixedVulns = [
        createTestVuln('CVE-2021-LOW', 'low'),
        createTestVuln('CVE-2021-MEDIUM', 'medium'),
        createTestVuln('CVE-2021-CRITICAL', 'critical'),
      ];

      await cacheManager.cacheOSVVulnerabilities(packageName, version, mixedVulns);

      // Should bypass because one is critical
      const cached = await cacheManager.getCachedOSVVulnerabilities(packageName, version);
      expect(cached).toBeNull();
    });

    it('should respect bypassCacheForCritical configuration', async () => {
      // Create manager with bypass disabled
      const managerWithoutBypass = new CacheManager(mockContext, mockLog, {
        vulnerabilityTTLMinutes: 60,
        bypassCacheForCritical: false,
      });

      const packageName = 'critical-package';
      const version = '1.0.0';
      const criticalVulns = [createTestVuln('CVE-2021-CRITICAL', 'critical')];

      await managerWithoutBypass.cacheOSVVulnerabilities(packageName, version, criticalVulns);

      // Should be cached when bypass is disabled
      const cached = await managerWithoutBypass.getCachedOSVVulnerabilities(packageName, version);
      expect(cached).toEqual(criticalVulns);
    });
  });

  /**
   * Additional OSV-specific cache patterns
   */
  describe('OSV cache edge cases', () => {
    const createTestVuln = (id: string): Vulnerability => ({
      id,
      title: 'Test',
      severity: 'medium',
      affectedVersions: '< 2.0.0',
      description: 'Test',
      references: [],
      publishedDate: new Date(),
      lastModifiedDate: new Date(),
      sources: ['osv'],
      cvssScore: 7.5,
      cvssVersion: '3.1',
      vectorString: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
    });

    it('should preserve CVSS data in cache', async () => {
      const packageName = 'package-with-cvss';
      const version = '1.0.0';
      const vulns = [createTestVuln('CVE-2021-CVSS')];

      await cacheManager.cacheOSVVulnerabilities(packageName, version, vulns);

      const cached = await cacheManager.getCachedOSVVulnerabilities(packageName, version);
      expect(cached).not.toBeNull();
      expect(cached?.[0]?.cvssScore).toBe(7.5);
      expect(cached?.[0]?.cvssVersion).toBe('3.1');
      expect(cached?.[0]?.vectorString).toContain('CVSS:3.1/');
    });

    it('should handle concurrent cache operations', async () => {
      const operations = Array.from({ length: 10 }, (_, i) =>
        cacheManager.cacheOSVVulnerabilities(`pkg${i}`, '1.0.0', [createTestVuln(`CVE-${i}`)])
      );

      await Promise.all(operations);

      // All should be cached
      for (let i = 0; i < 10; i++) {
        const cached = await cacheManager.getCachedOSVVulnerabilities(`pkg${i}`, '1.0.0');
        expect(cached).not.toBeNull();
      }
    });

    it('should log cache operations', async () => {
      const packageName = 'logged-package';
      const version = '1.0.0';
      const vulns = [createTestVuln('CVE-2021-LOG')];

      mockLog.mockClear();

      await cacheManager.cacheOSVVulnerabilities(packageName, version, vulns);
      await cacheManager.getCachedOSVVulnerabilities(packageName, version);

      expect(mockLog).toHaveBeenCalledWith('debug', expect.stringContaining('Cached'));
      expect(mockLog).toHaveBeenCalledWith('debug', expect.stringContaining('Cache hit'));
    });

    it('should update configuration at runtime', () => {
      cacheManager.updateConfig({
        vulnerabilityTTLMinutes: 120,
        bypassCacheForCritical: false,
      });

      expect(mockLog).toHaveBeenCalledWith(
        'info',
        expect.stringContaining('Updated vulnerability cache TTL')
      );
      expect(mockLog).toHaveBeenCalledWith('info', expect.stringContaining('Updated bypass cache'));
    });
  });
});

import { describe, expect, it } from 'vitest';
import type { Dependency, PackageInfo, PackageRegistryClient } from '../types';
import { FreshnessAnalyzer } from './FreshnessAnalyzer';

class MockRegistryClient implements PackageRegistryClient {
  constructor(
    private readonly info: PackageInfo,
    private readonly versionDeprecation?: Map<string, string>
  ) {}

  async getPackageInfo(): Promise<PackageInfo> {
    return this.info;
  }

  async getLatestVersion(name: string): Promise<string> {
    throw new Error(`Not implemented: ${name}`);
  }

  async searchPackages(): Promise<never[]> {
    return [];
  }

  async getVersionDeprecationStatus(packageName: string, version: string): Promise<string | null> {
    const key = `${packageName}@${version}`;
    return this.versionDeprecation?.get(key) || null;
  }
}

const mockOutputChannel = {
  appendLine: () => {},
} as unknown as import('vscode').OutputChannel;

const basePackageInfo: PackageInfo = {
  name: 'legacy-lib',
  version: '2.0.0',
  description: 'Legacy package',
  license: 'MIT',
  publishedAt: new Date(Date.now() - 3 * 365 * 24 * 60 * 60 * 1000),
};

const dependency: Dependency = {
  name: 'legacy-lib',
  version: '1.0.0',
  versionConstraint: '1.0.0',
  isDev: false,
};

describe('FreshnessAnalyzer maintenance signals', () => {
  it('flags npm-deprecated packages as long-term unmaintained', async () => {
    const info: PackageInfo = {
      ...basePackageInfo,
      deprecatedMessage: 'This package is no longer maintained',
    };
    const registryClient = new MockRegistryClient(info);
    const analyzer = new FreshnessAnalyzer(registryClient, mockOutputChannel);

    const result = await analyzer.analyze(dependency, info);

    expect(result.maintenanceSignals?.isLongTermUnmaintained).toBe(true);
    expect(result.maintenanceSignals?.reasons[0].source).toBe('npm');
    expect(result.isUnmaintained).toBe(true);
  });

  it('detects README notices about deprecation', async () => {
    const info: PackageInfo = {
      ...basePackageInfo,
      readme: '# Legacy Lib\n\nThis project is no longer maintained. Use new-lib instead.',
    };
    const registryClient = new MockRegistryClient(info);
    const analyzer = new FreshnessAnalyzer(registryClient, mockOutputChannel);

    const result = await analyzer.analyze(dependency, info);

    const reasons = result.maintenanceSignals?.reasons ?? [];
    const readmeReason = reasons.find((reason) => reason.source === 'readme');
    expect(readmeReason).toBeTruthy();
    if (readmeReason && readmeReason.source === 'readme') {
      expect(readmeReason.excerpt).toContain('no longer maintained');
    }
    expect(result.isUnmaintained).toBe(true);
  });

  it('detects version-specific deprecation from npm registry', async () => {
    const info: PackageInfo = {
      ...basePackageInfo,
    };
    const versionDeprecation = new Map<string, string>();
    versionDeprecation.set(
      'legacy-lib@1.0.0',
      'Version 1.0.0 is deprecated. Please upgrade to 2.0.0'
    );
    const registryClient = new MockRegistryClient(info, versionDeprecation);
    const analyzer = new FreshnessAnalyzer(registryClient, mockOutputChannel);

    const result = await analyzer.analyze(dependency, info);

    expect(result.maintenanceSignals?.isLongTermUnmaintained).toBe(true);
    const reasons = result.maintenanceSignals?.reasons ?? [];
    const versionDeprecatedReason = reasons.find(
      (reason) => reason.source === 'npm' && reason.type === 'version-deprecated'
    );
    expect(versionDeprecatedReason).toBeTruthy();
    if (versionDeprecatedReason && versionDeprecatedReason.source === 'npm') {
      expect(versionDeprecatedReason.message).toContain('deprecated');
    }
    expect(result.isUnmaintained).toBe(true);
  });

  it('prioritizes version-specific deprecation over README signals', async () => {
    const info: PackageInfo = {
      ...basePackageInfo,
      readme: '# Legacy Lib\n\nThis project is no longer maintained.',
    };
    const versionDeprecation = new Map<string, string>();
    versionDeprecation.set('legacy-lib@1.0.0', 'Version 1.0.0 is deprecated');
    const registryClient = new MockRegistryClient(info, versionDeprecation);
    const analyzer = new FreshnessAnalyzer(registryClient, mockOutputChannel);

    const result = await analyzer.analyze(dependency, info);

    const reasons = result.maintenanceSignals?.reasons ?? [];
    // Should have version deprecation, not README notice
    const versionDeprecatedReason = reasons.find(
      (reason) => reason.source === 'npm' && reason.type === 'version-deprecated'
    );
    expect(versionDeprecatedReason).toBeTruthy();
    const readmeReason = reasons.find((reason) => reason.source === 'readme');
    expect(readmeReason).toBeFalsy(); // README should not be included when version deprecation exists
  });

  it('detects version-specific deprecation in README', async () => {
    const info: PackageInfo = {
      ...basePackageInfo,
      readme:
        '# Legacy Lib\n\nVersion 1.0.0 is deprecated. Please upgrade to version 2.0.0 for security updates.',
    };
    const registryClient = new MockRegistryClient(info);
    const analyzer = new FreshnessAnalyzer(registryClient, mockOutputChannel);

    const result = await analyzer.analyze(dependency, info);

    const reasons = result.maintenanceSignals?.reasons ?? [];
    const readmeReason = reasons.find((reason) => reason.source === 'readme');
    expect(readmeReason).toBeTruthy();
    if (readmeReason && readmeReason.source === 'readme') {
      expect(readmeReason.excerpt).toMatch(/version.*1\.0\.0.*deprecated/i);
    }
    expect(result.isUnmaintained).toBe(true);
  });

  it('filters out API documentation examples from README signals', async () => {
    const info: PackageInfo = {
      ...basePackageInfo,
      publishedAt: new Date(Date.now() - 180 * 24 * 60 * 60 * 1000), // 180 days ago (recent, not unmaintained)
      readme: `# API Documentation

For Bearer tokens and such, use \`Authorization\` custom headers instead.
auth: { username: 'janedoe', password: 's00pers3cret' }

This is just an example of how to use the API.`,
    };
    const registryClient = new MockRegistryClient(info);
    const analyzer = new FreshnessAnalyzer(registryClient, mockOutputChannel);

    const result = await analyzer.analyze(dependency, info);

    const reasons = result.maintenanceSignals?.reasons ?? [];
    const readmeReason = reasons.find((reason) => reason.source === 'readme');
    // Should NOT trigger because it's just API documentation, not a deprecation notice
    expect(readmeReason).toBeFalsy();
    expect(result.isUnmaintained).toBe(false);
  });

  it('filters out code examples that look like maintenance signals', async () => {
    const info: PackageInfo = {
      ...basePackageInfo,
      publishedAt: new Date(Date.now() - 180 * 24 * 60 * 60 * 1000), // 180 days ago (recent, not unmaintained)
      readme: `# Usage Example

// For Bearer tokens and such, use Authorization custom headers instead.
const config = {
  auth: { username: 'janedoe', password: 's00pers3cret' }
};`,
    };
    const registryClient = new MockRegistryClient(info);
    const analyzer = new FreshnessAnalyzer(registryClient, mockOutputChannel);

    const result = await analyzer.analyze(dependency, info);

    const reasons = result.maintenanceSignals?.reasons ?? [];
    const readmeReason = reasons.find((reason) => reason.source === 'readme');
    // Should NOT trigger - this is clearly a code example
    expect(readmeReason).toBeFalsy();
    expect(result.isUnmaintained).toBe(false);
  });
});

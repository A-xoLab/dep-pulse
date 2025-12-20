import { describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import type { Dependency, PackageRegistryClient } from '../types';
import { FreshnessAnalyzer } from './FreshnessAnalyzer';

describe('FreshnessAnalyzer internal packages', () => {
  const registryClient = {
    getPackageInfo: vi.fn(),
  } as unknown as PackageRegistryClient;

  const outputChannel = {
    name: 'test',
    append: vi.fn(),
    appendLine: vi.fn(),
    replace: vi.fn(),
    clear: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
  } satisfies vscode.OutputChannel;

  it('skips registry lookup for internal deps', async () => {
    const analyzer = new FreshnessAnalyzer(registryClient, outputChannel);
    const dep: Dependency = {
      name: 'internal-a',
      version: 'workspace:*',
      versionConstraint: 'workspace:*',
      isDev: false,
      isInternal: true,
    };

    const result = await analyzer.analyze(dep, undefined);

    expect(registryClient.getPackageInfo).not.toHaveBeenCalled();
    expect(result.isOutdated).toBe(false);
    expect(result.versionGap).toBe('current');
  });
});

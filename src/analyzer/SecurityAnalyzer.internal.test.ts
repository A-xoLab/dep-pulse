import { describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import type { Dependency, VulnerabilityAggregator } from '../types';
import { SecurityAnalyzer } from './SecurityAnalyzer';

describe('SecurityAnalyzer internal packages', () => {
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

  it('skips vulnerability lookups for internal deps in batch', async () => {
    const getBatchAggregatedVulnerabilities = vi.fn();
    const analyzer = new SecurityAnalyzer(
      {
        configureSources: vi.fn(),
        getBatchAggregatedVulnerabilities,
      } as unknown as VulnerabilityAggregator,
      outputChannel
    );

    const deps: Dependency[] = [
      {
        name: 'internal-a',
        version: 'workspace:*',
        versionConstraint: 'workspace:*',
        isDev: false,
        isInternal: true,
      },
      { name: 'external-b', version: '1.0.0', versionConstraint: '^1.0.0', isDev: false },
    ];

    await analyzer.analyzeBatch(deps);

    expect(getBatchAggregatedVulnerabilities).toHaveBeenCalledTimes(1);
    const firstCallArg = getBatchAggregatedVulnerabilities.mock.calls[0]?.[0] as Dependency[];
    expect(firstCallArg.map((d) => d.name)).toEqual(['external-b']);
  });

  it('returns empty vulnerabilities for internal deps in single analyze', async () => {
    const getBatchAggregatedVulnerabilities = vi.fn();
    const analyzer = new SecurityAnalyzer(
      {
        getBatchAggregatedVulnerabilities,
      } as unknown as VulnerabilityAggregator,
      outputChannel
    );

    const result = await analyzer.analyze({
      name: 'internal-a',
      version: 'workspace:*',
      versionConstraint: 'workspace:*',
      isDev: false,
      isInternal: true,
    });

    expect(result.vulnerabilities).toHaveLength(0);
    expect(result.severity).toBe('none');
    expect(getBatchAggregatedVulnerabilities).not.toHaveBeenCalled();
  });
});

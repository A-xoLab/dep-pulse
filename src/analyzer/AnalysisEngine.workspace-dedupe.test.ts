import { describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import type { Dependency, PackageRegistryClient } from '../types';
import { AnalysisEngine } from './AnalysisEngine';
import type { FreshnessAnalyzer } from './FreshnessAnalyzer';
import type { SecurityAnalyzer } from './SecurityAnalyzer';

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

const makeDep = (
  name: string,
  version: string,
  scope: string,
  children: Dependency[] = []
): Dependency => ({
  name,
  version,
  versionConstraint: version,
  isDev: false,
  packageRoot: scope,
  workspaceFolder: '/ws',
  children,
});

type Collector = (deps: Dependency[], isMonorepo: boolean) => Dependency[];
const getCollector = (engine: AnalysisEngine): Collector =>
  (engine as unknown as { collectAllDependencies: Collector }).collectAllDependencies;

describe('AnalysisEngine collectAllDependencies - workspace-scoped dedupe', () => {
  const mockSecurityAnalyzer = {
    analyze: vi.fn(),
    analyzeBatch: vi.fn(),
    optimizeConnectionPool: vi.fn(),
  } as unknown as SecurityAnalyzer;

  const mockFreshnessAnalyzer = {
    analyze: vi.fn(),
  } as unknown as FreshnessAnalyzer;

  const mockRegistryClient = {
    getPackageInfo: vi.fn(),
    getLatestVersion: vi.fn(),
  } as unknown as PackageRegistryClient;

  const createEngine = () =>
    new AnalysisEngine(
      mockSecurityAnalyzer,
      mockFreshnessAnalyzer,
      mockRegistryClient,
      createMockOutputChannel(),
      createMockContext()
    );

  it('keeps distinct entries across workspaces but dedupes within the same workspace', () => {
    const deps: Dependency[] = [
      makeDep('react', '1.0.0', '/apps/a'),
      makeDep('react', '1.0.0', '/apps/a'), // duplicate in same workspace
      makeDep('react', '1.0.0', '/apps/b'), // different workspace
    ];

    const engine = createEngine();
    const all = getCollector(engine)(deps, true);

    expect(all).toHaveLength(2);
    const scopes = all.map((d) => d.packageRoot).sort();
    expect(scopes).toEqual(['/apps/a', '/apps/b']);
  });

  it('preserves version conflicts within the same workspace', () => {
    const deps: Dependency[] = [
      makeDep('react', '1.0.0', '/apps/a'),
      makeDep('react', '2.0.0', '/apps/a'),
    ];

    const engine = createEngine();
    const all = getCollector(engine)(deps, true);

    expect(all).toHaveLength(2);
    const versions = all.map((d) => d.version).sort();
    expect(versions).toEqual(['1.0.0', '2.0.0']);
  });

  it('still dedupes for monoliths', () => {
    const deps: Dependency[] = [
      { name: 'react', version: '1.0.0', versionConstraint: '1.0.0', isDev: false, children: [] },
      { name: 'react', version: '1.0.0', versionConstraint: '1.0.0', isDev: false, children: [] },
    ];

    const engine = createEngine();
    const all = getCollector(engine)(deps, false);

    expect(all).toHaveLength(1);
  });
});

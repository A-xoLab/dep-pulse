import * as fs from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PnpmLockParser } from './PnpmLockParser';

vi.mock('node:fs/promises');

// Mock Logger
vi.mock('../../utils/Logger', () => ({
  Logger: {
    getInstance: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

describe('PnpmLockParser', () => {
  let parser: PnpmLockParser;

  beforeEach(() => {
    parser = new PnpmLockParser();
    vi.resetAllMocks();
  });

  it('should parse pnpm-lock.yaml v9 correctly', async () => {
    const mockYaml = `
lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      '@emotion/is-prop-valid':
        specifier: latest
        version: 1.4.0
      '@hookform/resolvers':
        specifier: latest
        version: 5.2.2(react-hook-form@7.63.0(react@19.1.1))
    devDependencies:
      typescript:
        specifier: ^5
        version: 5.9.2
packages:
  '@emotion/is-prop-valid@1.4.0':
    resolution: {integrity: sha512-xxx}
  '@hookform/resolvers@5.2.2(react-hook-form@7.63.0(react@19.1.1))':
    resolution: {integrity: sha512-yyy}
snapshots:
  '@emotion/is-prop-valid@1.4.0':
    dependencies:
      '@emotion/memoize': 0.9.0
  '@hookform/resolvers@5.2.2(react-hook-form@7.63.0(react@19.1.1))':
    dependencies:
      '@standard-schema/utils': 0.3.0
      react-hook-form: 7.63.0(react@19.1.1)
  '@emotion/memoize@0.9.0': {}
  '@standard-schema/utils@0.3.0': {}
  typescript@5.9.2: {}
`;

    vi.mocked(fs.readFile).mockResolvedValue(mockYaml);

    const deps = await parser.parse('/path/to/pnpm-lock.yaml');

    expect(deps).toHaveLength(3); // 2 dependencies + 1 devDependency

    // Check direct dependency
    const emotionDep = deps.find((d) => d.name === '@emotion/is-prop-valid');
    expect(emotionDep).toBeDefined();
    expect(emotionDep?.version).toBe('1.4.0');
    expect(emotionDep?.isDev).toBe(false);
    expect(emotionDep?.children).toHaveLength(1);
    expect(emotionDep?.children?.[0].name).toBe('@emotion/memoize');
    expect(emotionDep?.children?.[0].version).toBe('0.9.0');

    // Check dependency with peer dep suffix
    const hookformDep = deps.find((d) => d.name === '@hookform/resolvers');
    expect(hookformDep).toBeDefined();
    expect(hookformDep?.version).toBe('5.2.2'); // Should be cleaned
    expect(hookformDep?.children).toHaveLength(2);

    // Check dev dependency
    const tsDep = deps.find((d) => d.name === 'typescript');
    expect(tsDep).toBeDefined();
    expect(tsDep?.isDev).toBe(true);
  });

  it('should handle missing root importer', async () => {
    const mockYaml = `
lockfileVersion: '9.0'
importers: {}
`;
    vi.mocked(fs.readFile).mockResolvedValue(mockYaml);
    const deps = await parser.parse('/path/to/pnpm-lock.yaml');
    expect(deps).toEqual([]);
  });
});

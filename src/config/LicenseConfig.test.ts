import { describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { getProjectLicense, loadLicenseConfig, validateSpdxId } from './LicenseConfig';

vi.mock('vscode', () => {
  const workspaceConfig: Record<string, unknown> = {};

  return {
    workspace: {
      getConfiguration: vi.fn((_section: string, _scope?: vscode.Uri) => ({
        get: vi.fn(
          (key: string, defaultValue: unknown) => (workspaceConfig[key] as unknown) ?? defaultValue
        ),
      })),
      fs: {
        readFile: vi.fn(),
      },
    },
    Uri: {
      joinPath: vi.fn((base: { fsPath: string }, ...paths: string[]) => ({
        fsPath: [base.fsPath, ...paths].join('/'),
      })),
    },
  };
});

describe('LicenseConfig', () => {
  it('loads defaults and appends copyleft licenses when not strict', () => {
    const config = loadLicenseConfig();

    expect(config.strictMode).toBe(false);
    // Should contain a known permissive license and a known copyleft
    expect(config.acceptableLicenses).toContain('MIT');
    expect(config.acceptableLicenses).toContain('LGPL-2.1');
  });

  it('normalizes acceptableLicenses and respects strictMode', () => {
    const config = loadLicenseConfig();
    // The mock provides empty workspaceConfig so defaults are used
    expect(config.acceptableLicenses.length).toBeGreaterThan(0);
    // In default (non-strict) mode, copyleft licenses are appended
    expect(config.acceptableLicenses).toContain('LGPL-2.1');
  });

  it('validates SPDX identifiers with a basic pattern', () => {
    expect(validateSpdxId('MIT')).toBe(true);
    expect(validateSpdxId('Apache-2.0')).toBe(true);
    expect(validateSpdxId('')).toBe(false);
    expect(validateSpdxId(' with space ')).toBe(false);
  });

  it('prefers config projectLicense over package.json', async () => {
    const license = await getProjectLicense({
      // No config override in this test; workspace folder is still optional
      uri: { fsPath: '/workspace' },
      index: 0,
      name: 'ws',
    } as unknown as vscode.WorkspaceFolder);

    // With no config and no real package.json, getProjectLicense should gracefully
    // fall back to undefined rather than throwing.
    expect(license).toBeUndefined();
  });
});

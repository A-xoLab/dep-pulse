import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { isCacheEnabled, setCacheEnabled } from '../../extension';

// Mock vscode module
const mockUpdate = vi.fn();
const mockGet = vi.fn();

// Mutable workspace folders mock
let mockWorkspaceFolders: unknown[] | undefined;

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: mockGet,
      update: mockUpdate,
      inspect: vi.fn(),
    })),
    get workspaceFolders() {
      return mockWorkspaceFolders;
    },
  },
  ConfigurationTarget: {
    Global: 1,
    Workspace: 2,
  },
  window: {
    createOutputChannel: vi.fn(() => ({
      appendLine: vi.fn(),
      dispose: vi.fn(),
    })),
  },
  commands: {
    registerCommand: vi.fn(),
  },
  ExtensionContext: vi.fn(),
}));

describe('Configuration Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default behavior for get
    mockGet.mockReturnValue(true);
    // Default: No workspace open
    mockWorkspaceFolders = undefined;
  });

  it('isCacheEnabled should return value from configuration', () => {
    mockGet.mockReturnValue(false);
    expect(isCacheEnabled()).toBe(false);
    expect(mockGet).toHaveBeenCalledWith('enableCache', true);
  });

  it('setCacheEnabled should update Global configuration when no workspace is open', async () => {
    mockWorkspaceFolders = undefined;
    await setCacheEnabled(false);
    expect(mockUpdate).toHaveBeenCalledWith('enableCache', false, 1); // 1 is Global
  });

  it('setCacheEnabled should update Workspace configuration when workspace is open', async () => {
    const mockUri = { fsPath: '/tmp/test' };
    mockWorkspaceFolders = [{ uri: mockUri, name: 'test', index: 0 }];

    await setCacheEnabled(true);

    // Verify getConfiguration was called with the resource URI
    expect(vi.mocked(vscode.workspace.getConfiguration)).toHaveBeenCalledWith(
      'depPulse.analysis',
      mockUri
    );
    // Verify update was called with Workspace target
    expect(mockUpdate).toHaveBeenCalledWith('enableCache', true, 2); // 2 is Workspace
  });
});

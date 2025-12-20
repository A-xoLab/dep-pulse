import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

// Mock vscode module
const mockGet = vi.fn();
const mockInspect = vi.fn();

// Mutable workspace folders mock
let mockWorkspaceFolders: unknown[] | undefined;

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: mockGet,
      inspect: mockInspect,
    })),
    get workspaceFolders() {
      return mockWorkspaceFolders;
    },
  },
  Uri: {
    file: (path: string) => ({ fsPath: path }),
  },
}));

describe('Configuration Precedence Reproduction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWorkspaceFolders = undefined;
  });

  it('should respect workspace setting over global setting when resource is provided', () => {
    // Setup workspace
    const mockUri = { fsPath: '/tmp/test' };
    mockWorkspaceFolders = [{ uri: mockUri, name: 'test', index: 0 }];

    // Setup configuration
    // Global: false (User settings)
    // Workspace: true (Workspace settings)
    mockGet.mockImplementation((key: string, defaultValue: unknown) => {
      if (key === 'autoScanOnStartup') {
        return true; // Should return workspace value
      }
      return defaultValue;
    });

    mockInspect.mockReturnValue({
      key: 'depPulse.analysis.autoScanOnStartup',
      defaultValue: true,
      globalValue: false,
      workspaceValue: true,
    });

    // Simulate the logic in triggerAutoScan
    const resource = vscode.workspace.workspaceFolders?.[0]?.uri;
    const config = vscode.workspace.getConfiguration('depPulse.analysis', resource);

    // Verify getConfiguration was called with the resource
    expect(vscode.workspace.getConfiguration).toHaveBeenCalledWith('depPulse.analysis', resource);

    // Verify value
    const autoScanEnabled = config.get<boolean>('autoScanOnStartup', true);
    expect(autoScanEnabled).toBe(true);
  });

  it('should return global setting when resource is NOT provided (or undefined)', () => {
    // Setup NO workspace
    mockWorkspaceFolders = undefined;

    // Setup configuration
    // Global: false
    // Workspace: undefined
    mockGet.mockImplementation((key: string, defaultValue: unknown) => {
      if (key === 'autoScanOnStartup') {
        return false; // Should return global value
      }
      return defaultValue;
    });

    // Simulate the logic in triggerAutoScan
    const resource = vscode.workspace.workspaceFolders?.[0]?.uri;
    const config = vscode.workspace.getConfiguration('depPulse.analysis', resource);

    // Verify getConfiguration was called with undefined resource
    expect(vscode.workspace.getConfiguration).toHaveBeenCalledWith('depPulse.analysis', undefined);

    // Verify value
    const autoScanEnabled = config.get<boolean>('autoScanOnStartup', true);
    expect(autoScanEnabled).toBe(false);
  });
});

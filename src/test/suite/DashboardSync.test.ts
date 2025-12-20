import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import * as extension from '../../extension';
import { DashboardController } from '../../ui/DashboardController';
import type { AlternativeSuggestionService } from '../../utils';

// Mock vscode module
vi.mock('vscode', () => {
  return {
    workspace: {
      workspaceFolders: [],
      getConfiguration: vi.fn(),
      onDidChangeConfiguration: vi.fn(),
    },
    ConfigurationTarget: {
      Global: 1,
      Workspace: 2,
      WorkspaceFolder: 3,
    },
    Uri: {
      file: (path: string) => ({ fsPath: path, scheme: 'file' }),
      parse: (path: string) => ({ fsPath: path, scheme: 'file' }),
    },
    window: {
      createOutputChannel: vi.fn().mockReturnValue({ appendLine: vi.fn() }),
      showInformationMessage: vi.fn(),
    },
    commands: {
      registerCommand: vi.fn(),
    },
    ExtensionContext: vi.fn(),
    Disposable: vi.fn(),
    ExtensionMode: {
      Production: 1,
      Development: 2,
      Test: 3,
    },
  };
});

// Mock extension module to control isCacheEnabled
vi.mock('../../extension', () => ({
  isCacheEnabled: vi.fn(),
  isScanningInProgress: vi.fn(() => false),
}));

describe('DashboardController Cache Sync', () => {
  let controller: DashboardController;
  let outputChannelMock: { appendLine: ReturnType<typeof vi.fn> };
  let extensionUri: { fsPath: string };

  beforeEach(() => {
    vi.resetAllMocks();
    outputChannelMock = { appendLine: vi.fn() };
    extensionUri = { fsPath: '/path/to/extension' };

    // Default cache enabled
    vi.mocked(extension.isCacheEnabled).mockReturnValue(true);

    controller = new DashboardController(
      extensionUri as vscode.Uri,
      outputChannelMock as unknown as vscode.OutputChannel,
      true, // Initial cache enabled
      vscode.ExtensionMode.Test,
      { getAlternatives: vi.fn() } as unknown as AlternativeSuggestionService
    );

    // Mock sendMessage
    controller.sendMessage = vi.fn();

    // Mock webviewManager to pass the check in handleWebviewReady
    // biome-ignore lint/suspicious/noExplicitAny: Accessing private property for testing
    (controller as any).webviewManager = {
      panel: { visible: true },
      markAsReady: vi.fn(),
      getPanel: vi.fn().mockReturnValue({ visible: true, webview: { postMessage: vi.fn() } }),
    };
  });

  it('handleWebviewReady should sync with current configuration', async () => {
    // Simulate configuration changing to false *after* controller init but *before* webview ready
    vi.mocked(extension.isCacheEnabled).mockReturnValue(false);

    // Access private method for testing
    // biome-ignore lint/suspicious/noExplicitAny: Accessing private method for testing
    await (controller as any).handleWebviewReady();

    // Verify it sent the Updated (false) status, not the Initial (true) status
    expect(controller.sendMessage).toHaveBeenCalledWith({
      type: 'cacheStatusChanged',
      data: { enabled: false },
    });

    // Verify internal state was updated
    // biome-ignore lint/suspicious/noExplicitAny: Accessing private property for testing
    expect((controller as any)._isCacheEnabled).toBe(false);
  });

  it('setCacheEnabled should update internal state', () => {
    controller.setCacheEnabled(false);
    // biome-ignore lint/suspicious/noExplicitAny: Accessing private property for testing
    expect((controller as any)._isCacheEnabled).toBe(false);

    controller.setCacheEnabled(true);
    // biome-ignore lint/suspicious/noExplicitAny: Accessing private property for testing
    expect((controller as any)._isCacheEnabled).toBe(true);
  });
});

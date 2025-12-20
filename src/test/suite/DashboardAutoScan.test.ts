import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import type { AnalysisResult } from '../../types';
import { DashboardController } from '../../ui/DashboardController';
import type { AlternativeSuggestionService } from '../../utils';

// Mock node:fs
vi.mock('node:fs', () => ({
  readFileSync: vi.fn().mockReturnValue('/* mock css */'),
}));

// Mock vscode module
vi.mock('vscode', () => ({
  Uri: {
    file: vi.fn(),
    joinPath: vi.fn().mockImplementation(() => ({ fsPath: '/mock/path/output.css' })),
    parse: vi.fn(),
  },
  commands: {
    executeCommand: vi.fn().mockResolvedValue(undefined),
  },
  window: {
    createWebviewPanel: vi.fn(() => ({
      webview: {
        html: '',
        onDidReceiveMessage: vi.fn(),
        postMessage: vi.fn(),
        asWebviewUri: vi.fn(),
      },
      onDidDispose: vi.fn(),
      reveal: vi.fn(),
      dispose: vi.fn(),
      visible: true,
    })),
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
  },
  workspace: {
    workspaceFolders: [],
    fs: {
      readFile: vi.fn(),
    },
  },
  ViewColumn: {
    One: 1,
  },
  ExtensionMode: {
    Production: 1,
    Development: 2,
    Test: 3,
  },
}));

describe('DashboardController Auto-Scan', () => {
  let controller: DashboardController;
  let mockOutputChannel: vscode.OutputChannel;
  let mockExtensionUri: vscode.Uri;

  beforeEach(() => {
    vi.clearAllMocks();
    mockOutputChannel = {
      appendLine: vi.fn(),
      show: vi.fn(),
      dispose: vi.fn(),
    } as unknown as vscode.OutputChannel;
    mockExtensionUri = { fsPath: '/tmp/test' } as unknown as vscode.Uri;
    controller = new DashboardController(
      mockExtensionUri,
      mockOutputChannel,
      true,
      vscode.ExtensionMode.Test,
      { getAlternatives: vi.fn() } as unknown as AlternativeSuggestionService
    );
  });

  it('should NOT trigger scan when show() is called and no analysis exists', () => {
    controller.show();
    expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith('depPulse.scan');
  });

  it('should NOT trigger scan when show() is called and analysis ALREADY exists', async () => {
    // Simulate existing analysis
    const mockAnalysis = {
      dependencies: [],
      healthScore: { overall: 100 },
      summary: {},
      timestamp: new Date(),
    } as unknown as AnalysisResult;

    // Update controller with analysis
    await controller.update(mockAnalysis);

    // Clear previous calls (update might trigger things)
    vi.clearAllMocks();

    // Show dashboard
    controller.show();

    // Should NOT trigger scan
    expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith('depPulse.scan');
  });
});

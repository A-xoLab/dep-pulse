import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import type { DashboardController } from '../ui/DashboardController';
import { setupConfigurationListener } from './ConfigurationListener';

// Mock Logger
const mockLogger = {
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  getOutputChannel: vi.fn(),
};

vi.mock('../utils', () => ({
  Logger: {
    getInstance: vi.fn(() => mockLogger),
  },
}));

// Mock vscode
const configStore = new Map<string, unknown>();
let changeCallback: (event: vscode.ConfigurationChangeEvent) => Promise<void>;

vi.mock('vscode', () => {
  return {
    workspace: {
      getConfiguration: vi.fn((section) => ({
        get: vi.fn((key, defaultValue) => {
          const fullKey = section ? `${section}.${key}` : key;
          return configStore.get(fullKey) ?? defaultValue;
        }),
        inspect: vi.fn(() => ({ globalValue: undefined, workspaceValue: undefined })),
      })),
      onDidChangeConfiguration: vi.fn((callback) => {
        changeCallback = callback;
        return { dispose: vi.fn() };
      }),
    },
    window: {
      showInformationMessage: vi.fn(),
    },
    commands: {
      executeCommand: vi.fn(),
    },
    Disposable: class {
      dispose() {}
    },
  };
});

describe('ConfigurationListener - Analysis Settings', () => {
  let context: vscode.ExtensionContext;
  let disposables: vscode.Disposable[];
  let getDashboardController: () => DashboardController | undefined;
  let initializeServices: (
    context: vscode.ExtensionContext,
    options?: { preserveDashboard?: boolean }
  ) => void;

  beforeEach(() => {
    vi.clearAllMocks();
    configStore.clear();

    context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
    disposables = [];
    getDashboardController = vi.fn(() => ({ sendMessage: vi.fn() })) as unknown as () =>
      | DashboardController
      | undefined;
    initializeServices = vi.fn();

    // Default config
    configStore.set('depPulse.vulnerabilityDetection.primarySource', 'osv');
  });

  it('should notify user to restart when scanOnSave changes', async () => {
    setupConfigurationListener(context, disposables, getDashboardController, initializeServices);

    // Change scanOnSave
    configStore.set('depPulse.analysis.scanOnSave', false);

    await changeCallback({
      affectsConfiguration: (section: string) =>
        section === 'depPulse.analysis.scanOnSave' ||
        section === 'depPulse.analysis' ||
        section === 'depPulse',
    });

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('Restart VS Code')
    );
  });

  it('should log changes for autoScanOnStartup', async () => {
    setupConfigurationListener(context, disposables, getDashboardController, initializeServices);

    // Change autoScanOnStartup
    configStore.set('depPulse.analysis.autoScanOnStartup', false);

    await changeCallback({
      affectsConfiguration: (section: string) =>
        section === 'depPulse.analysis.autoScanOnStartup' ||
        section === 'depPulse.analysis' ||
        section === 'depPulse',
    });

    // Verify log message (indirectly verifying it was processed)
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('New settings - Auto-scan: false')
    );
  });
});

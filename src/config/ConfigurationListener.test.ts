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

const networkServiceMock = {
  reset: vi.fn(),
  checkConnectivity: vi.fn(() => Promise.resolve(true)),
};

vi.mock('../utils', () => ({
  Logger: {
    getInstance: vi.fn(() => mockLogger),
  },
  NetworkStatusService: {
    getInstance: vi.fn(() => networkServiceMock),
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
        update: vi.fn((key, value) => {
          const fullKey = section ? `${section}.${key}` : key;
          configStore.set(fullKey, value);
          return Promise.resolve();
        }),
      })),
      onDidChangeConfiguration: vi.fn((callback) => {
        changeCallback = callback;
        return { dispose: vi.fn() };
      }),
    },
    window: {
      showInformationMessage: vi.fn(),
      showErrorMessage: vi.fn(),
      showWarningMessage: vi.fn(),
      createOutputChannel: vi.fn(() => ({
        appendLine: vi.fn(),
        show: vi.fn(),
      })),
    },
    commands: {
      executeCommand: vi.fn(),
    },
    Disposable: class {
      dispose() {}
    },
  };
});

// Mock ConfigurationEnforcer
const enforceGitHubTokenMock = vi.fn();
vi.mock('./ConfigurationEnforcer', () => {
  return {
    ConfigurationEnforcer: class {
      enforceGitHubToken = enforceGitHubTokenMock;
    },
  };
});

describe('ConfigurationListener', () => {
  let context: vscode.ExtensionContext;
  let disposables: vscode.Disposable[];

  let getDashboardController: () => DashboardController | undefined;
  let initializeServices: (
    context: vscode.ExtensionContext,
    options?: { preserveDashboard?: boolean }
  ) => void;

  beforeEach(() => {
    vi.clearAllMocks();
    // vi.useFakeTimers(); // Disable fake timers to avoid issues
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

  it('should initialize with current source', () => {
    setupConfigurationListener(context, disposables, getDashboardController, initializeServices);

    expect(vscode.workspace.onDidChangeConfiguration).toHaveBeenCalled();
  });

  it('should NOT re-initialize if source is unchanged (redundant scan check)', async () => {
    // Initial source is 'osv'
    configStore.set('depPulse.vulnerabilityDetection.primarySource', 'osv');

    setupConfigurationListener(context, disposables, getDashboardController, initializeServices);

    // Trigger change event with SAME source
    await changeCallback({
      affectsConfiguration: (section: string) =>
        section === 'depPulse.vulnerabilityDetection.primarySource' || section === 'depPulse',
    });

    expect(initializeServices).not.toHaveBeenCalled();
    expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith(
      'depPulse.scan',
      expect.anything()
    );
  });

  it('should re-initialize if source changes from osv to github (valid)', async () => {
    // Initial source is 'osv'
    configStore.set('depPulse.vulnerabilityDetection.primarySource', 'osv');

    setupConfigurationListener(context, disposables, getDashboardController, initializeServices);

    // Change config to 'github'
    configStore.set('depPulse.vulnerabilityDetection.primarySource', 'github');
    enforceGitHubTokenMock.mockResolvedValue(true); // Valid token

    // Trigger change event
    await changeCallback({
      affectsConfiguration: (section: string) =>
        section === 'depPulse.vulnerabilityDetection.primarySource' || section === 'depPulse',
    });

    expect(enforceGitHubTokenMock).toHaveBeenCalled();
    expect(initializeServices).toHaveBeenCalled();
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('depPulse.scan', {
      bypassCache: true,
    });
  });

  it('should revert switch to github when offline', async () => {
    configStore.set('depPulse.vulnerabilityDetection.primarySource', 'osv');

    setupConfigurationListener(context, disposables, getDashboardController, initializeServices);

    // Attempt to switch to github while offline
    configStore.set('depPulse.vulnerabilityDetection.primarySource', 'github');
    networkServiceMock.checkConnectivity.mockResolvedValueOnce(false);

    await changeCallback({
      affectsConfiguration: (section: string) =>
        section === 'depPulse.vulnerabilityDetection.primarySource' || section === 'depPulse',
    });

    expect(networkServiceMock.checkConnectivity).toHaveBeenCalled();
    expect(enforceGitHubTokenMock).not.toHaveBeenCalled();
    expect(initializeServices).not.toHaveBeenCalled();
    expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith(
      'depPulse.scan',
      expect.anything()
    );
    expect(configStore.get('depPulse.vulnerabilityDetection.primarySource')).toBe('osv');
  });

  it('should abort switch if source changes to github (invalid) and keep previous source', async () => {
    // Initial source is 'osv'
    configStore.set('depPulse.vulnerabilityDetection.primarySource', 'osv');

    setupConfigurationListener(context, disposables, getDashboardController, initializeServices);

    // Change config to 'github'
    configStore.set('depPulse.vulnerabilityDetection.primarySource', 'github');
    enforceGitHubTokenMock.mockResolvedValue(false); // Invalid token

    // Trigger change event
    await changeCallback({
      affectsConfiguration: (section: string) =>
        section === 'depPulse.vulnerabilityDetection.primarySource' || section === 'depPulse',
    });

    expect(enforceGitHubTokenMock).toHaveBeenCalled();
    // Should NOT initialize services (abort switch)
    expect(initializeServices).not.toHaveBeenCalled();
    expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith(
      'depPulse.scan',
      expect.anything()
    );
  });

  it('should NOT re-initialize if reverting from aborted github back to osv', async () => {
    // Initial source is 'osv'
    configStore.set('depPulse.vulnerabilityDetection.primarySource', 'osv');

    setupConfigurationListener(context, disposables, getDashboardController, initializeServices);

    // 1. Try switch to 'github' (invalid)
    configStore.set('depPulse.vulnerabilityDetection.primarySource', 'github');
    enforceGitHubTokenMock.mockResolvedValue(false);

    await changeCallback({
      affectsConfiguration: (section: string) =>
        section === 'depPulse.vulnerabilityDetection.primarySource' || section === 'depPulse',
    });

    expect(initializeServices).not.toHaveBeenCalled(); // Aborted

    // 2. Switch back to 'osv'
    configStore.set('depPulse.vulnerabilityDetection.primarySource', 'osv');

    await changeCallback({
      affectsConfiguration: (section: string) =>
        section === 'depPulse.vulnerabilityDetection.primarySource' || section === 'depPulse',
    });

    // Should still NOT initialize because effective source was never changed from 'osv'
    expect(initializeServices).not.toHaveBeenCalled();
  });
});

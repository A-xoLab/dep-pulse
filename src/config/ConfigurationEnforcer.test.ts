import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { ConfigurationEnforcer } from './ConfigurationEnforcer';

const configStore = new Map<string, unknown>();

// Mock vscode and persist config updates in configStore
vi.mock('vscode', () => {
  return {
    workspace: {
      getConfiguration: vi.fn((section: string) => ({
        get: vi.fn((key: string, defaultValue?: unknown) => {
          const fullKey = section ? `${section}.${key}` : key;
          return configStore.get(fullKey) ?? defaultValue;
        }),
        update: vi.fn((key: string, value: unknown) => {
          const fullKey = section ? `${section}.${key}` : key;
          configStore.set(fullKey, value);
          return Promise.resolve();
        }),
        inspect: vi.fn(() => ({
          globalValue: configStore.get('depPulse.vulnerabilityDetection.primarySource'),
          workspaceValue: undefined,
          workspaceFolderValue: undefined,
        })),
      })),
      onDidChangeConfiguration: vi.fn(),
      workspaceFolders: [],
    },
    window: {
      createOutputChannel: vi.fn(() => ({
        appendLine: vi.fn(),
        show: vi.fn(),
        dispose: vi.fn(),
      })),
      showErrorMessage: vi.fn(() => Promise.resolve()),
      showWarningMessage: vi.fn(() => Promise.resolve()),
    },
    commands: {
      executeCommand: vi.fn(),
    },
    ConfigurationTarget: {
      Global: 1,
      Workspace: 2,
      WorkspaceFolder: 3,
    },
    Disposable: class {
      dispose() {}
    },
  };
});

// Hoisted mock for GitHubAdvisoryClient validation and secret access
const mocks = vi.hoisted(() => ({
  validateToken: vi.fn().mockResolvedValue(true),
  getGitHubToken: vi.fn().mockReturnValue(''),
}));

vi.mock('../api/GitHubAdvisoryClient', () => ({
  GitHubAdvisoryClient: class {
    validateToken = mocks.validateToken;
  },
}));

vi.mock('../utils/SecretCache', () => ({
  getGitHubToken: () => mocks.getGitHubToken(),
}));

describe('ConfigurationEnforcer', () => {
  let enforcer: ConfigurationEnforcer;
  let outputChannel: vscode.OutputChannel;

  beforeEach(() => {
    vi.clearAllMocks();
    configStore.clear();

    // Default config
    configStore.set('depPulse.vulnerabilityDetection.primarySource', 'osv');

    outputChannel = vscode.window.createOutputChannel('DepPulse');
    enforcer = new ConfigurationEnforcer(outputChannel);

    mocks.validateToken.mockReset();
    mocks.validateToken.mockResolvedValue(true);
    mocks.getGitHubToken.mockReset();
    mocks.getGitHubToken.mockReturnValue('');
  });

  it('should do nothing if primary source is not github', async () => {
    configStore.set('depPulse.vulnerabilityDetection.primarySource', 'osv');

    const result = await enforcer.enforceGitHubToken();

    expect(result).toBe(true);
    expect(mocks.validateToken).not.toHaveBeenCalled();
    expect(configStore.get('depPulse.vulnerabilityDetection.primarySource')).toBe('osv');
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
  });

  it('should revert to osv if github is selected but token is missing', async () => {
    configStore.set('depPulse.vulnerabilityDetection.primarySource', 'github');
    mocks.getGitHubToken.mockReturnValue('');

    const result = await enforcer.enforceGitHubToken();

    expect(result).toBe(false);
    expect(mocks.validateToken).not.toHaveBeenCalled();
    expect(configStore.get('depPulse.vulnerabilityDetection.primarySource')).toBe('osv');
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'GitHub integration requires a valid Personal Access Token. Please configure your token using “DepPulse: Configure API Secrets”.',
      expect.anything(),
      'Configure Secrets'
    );
  });

  it('should revert to osv if github is selected and token is invalid', async () => {
    configStore.set('depPulse.vulnerabilityDetection.primarySource', 'github');
    mocks.getGitHubToken.mockReturnValue('invalid-token');

    mocks.validateToken.mockResolvedValue(false);

    const result = await enforcer.enforceGitHubToken();

    expect(result).toBe(false);
    expect(mocks.validateToken).toHaveBeenCalled();
    expect(configStore.get('depPulse.vulnerabilityDetection.primarySource')).toBe('osv');
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'GitHub integration requires a valid Personal Access Token. Please configure your token using “DepPulse: Configure API Secrets”.',
      expect.anything(),
      'Configure Secrets'
    );
  });

  it('should NOT revert if github is selected and token is valid', async () => {
    configStore.set('depPulse.vulnerabilityDetection.primarySource', 'github');
    mocks.getGitHubToken.mockReturnValue('valid-token');

    mocks.validateToken.mockResolvedValue(true);

    const result = await enforcer.enforceGitHubToken();

    expect(result).toBe(true);
    expect(mocks.validateToken).toHaveBeenCalled();
    expect(configStore.get('depPulse.vulnerabilityDetection.primarySource')).toBe('github');
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
  });
});

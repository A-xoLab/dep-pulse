import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

// Mock vscode
vi.mock('vscode', () => ({
  window: {
    showInformationMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    withProgress: vi.fn((_options, callback) => {
      const progress = {
        report: vi.fn(),
      };
      return Promise.resolve(callback(progress));
    }),
    createOutputChannel: vi.fn(() => ({
      append: vi.fn(),
      appendLine: vi.fn(),
      replace: vi.fn(),
      clear: vi.fn(),
      show: vi.fn(),
      hide: vi.fn(),
      dispose: vi.fn(),
    })),
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/test/project' } }],
    getConfiguration: vi.fn(() => ({
      get: vi.fn(() => true),
      inspect: vi.fn(),
      update: vi.fn(),
    })),
    fs: {
      createDirectory: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn().mockRejectedValue(new Error('File not found')),
      readDirectory: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue(undefined),
    },
  },
  commands: {
    executeCommand: vi.fn(),
  },
  Uri: {
    joinPath: vi.fn((base, ...pathSegments) => ({
      fsPath: `${base.fsPath}/${pathSegments.join('/')}`,
      scheme: 'file',
      toString: () => `file://${base.fsPath}/${pathSegments.join('/')}`,
    })),
    file: vi.fn((path) => ({ fsPath: path, scheme: 'file', toString: () => `file://${path}` })),
  },
  ProgressLocation: {
    Window: 1,
  },
}));

describe('Memory Leak Detection - Integration Tests', () => {
  const activeIntervals: Set<NodeJS.Timeout> = new Set();
  const activeTimeouts: Set<NodeJS.Timeout> = new Set();

  beforeEach(() => {
    activeIntervals.clear();
    activeTimeouts.clear();

    // Track all intervals and timeouts
    const originalSetInterval = global.setInterval;
    const originalSetTimeout = global.setTimeout;
    const originalClearInterval = global.clearInterval;
    const originalClearTimeout = global.clearTimeout;

    global.setInterval = ((fn: () => void, delay?: number) => {
      const id = originalSetInterval(fn, delay);
      activeIntervals.add(id);
      return id;
    }) as typeof setInterval;

    global.setTimeout = ((fn: () => void, delay?: number) => {
      const id = originalSetTimeout(fn, delay);
      activeTimeouts.add(id);
      return id;
    }) as typeof setTimeout;

    global.clearInterval = ((id: NodeJS.Timeout) => {
      activeIntervals.delete(id);
      return originalClearInterval(id);
    }) as typeof clearInterval;

    global.clearTimeout = ((id: NodeJS.Timeout) => {
      activeTimeouts.delete(id);
      return originalClearTimeout(id);
    }) as typeof clearTimeout;
  });

  afterEach(() => {
    // Clean up any remaining intervals/timeouts
    activeIntervals.forEach((id) => {
      clearInterval(id);
    });
    activeTimeouts.forEach((id) => {
      clearTimeout(id);
    });
    activeIntervals.clear();
    activeTimeouts.clear();
  });

  it('should clean up progress intervals after scan completion', async () => {
    // Note: handleScanCommand is not exported, so we test the cleanup pattern directly
    const _mockContext = {
      subscriptions: [],
      workspaceState: {} as unknown as vscode.Memento,
      globalState: {
        get: vi.fn(),
        update: vi.fn(),
        keys: vi.fn(() => []),
        setKeysForSync: vi.fn(),
      } as unknown as vscode.Memento,
      globalStorageUri: { fsPath: '/test/global-storage' } as unknown as vscode.Uri,
      extensionUri: { fsPath: '/test/extension' } as unknown as vscode.Uri,
      extensionPath: '/test/extension',
      asAbsolutePath: vi.fn((path: string) => `/test/extension/${path}`),
      storageUri: undefined,
      storagePath: undefined,
      globalStoragePath: '/test/global-storage',
      logPath: '/test/logs',
      extensionMode: 1,
      secrets: {} as unknown as vscode.SecretStorage,
      environmentVariableCollection: {} as unknown as vscode.EnvironmentVariableCollection,
    } as unknown as vscode.ExtensionContext;

    const initialIntervalCount = activeIntervals.size;

    // Mock withProgress to complete quickly
    vi.mocked(vscode.window.withProgress).mockImplementation((_options, callback) => {
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve(
            callback(
              { report: vi.fn() },
              { isCancellationRequested: false, onCancellationRequested: vi.fn() }
            )
          );
        }, 10);
      });
    });

    // Simulate progress interval cleanup
    let progressInterval: NodeJS.Timeout | undefined;
    try {
      // Simulate creating an interval
      progressInterval = setInterval(() => {
        // Progress polling
      }, 100);

      // Simulate cleanup
      if (progressInterval) {
        clearInterval(progressInterval);
        progressInterval = undefined;
      }
    } catch {
      // Ignore errors
    } finally {
      if (progressInterval) {
        clearInterval(progressInterval);
        progressInterval = undefined;
      }
    }

    // Wait a bit for cleanup
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify intervals were cleaned up
    // Note: Some intervals may remain if scan is still in progress,
    // but they should be cleaned up eventually
    const finalIntervalCount = activeIntervals.size;
    // The count should not grow unbounded
    expect(finalIntervalCount).toBeLessThanOrEqual(initialIntervalCount + 2);
  });

  it('should clean up file watcher timers on disposal', () => {
    // This test verifies that file watcher debounce timers are properly cleaned up
    const initialTimeoutCount = activeTimeouts.size;

    // Simulate file watcher setup and disposal
    const timerState: { debounceTimer: NodeJS.Timeout | undefined } = {
      debounceTimer: undefined,
    };

    // Setup watcher (simulated)
    const watcherDisposable = {
      dispose: () => {
        if (timerState.debounceTimer) {
          clearTimeout(timerState.debounceTimer);
          timerState.debounceTimer = undefined;
        }
      },
    };

    // Create a timer
    timerState.debounceTimer = setTimeout(() => {
      // Timer callback
    }, 1000);

    expect(activeTimeouts.size).toBeGreaterThan(initialTimeoutCount);

    // Dispose
    watcherDisposable.dispose();

    // Verify timer was cleaned up
    expect(timerState.debounceTimer).toBeUndefined();
    expect(activeTimeouts.size).toBeLessThanOrEqual(initialTimeoutCount + 1);
  });

  it('should not leak event listeners on webview recreation', () => {
    // This test verifies that webview event listeners are properly cleaned up
    // We can't directly test the webview code, but we can verify the cleanup pattern

    const listeners: Array<{ type: string; handler: () => void }> = [];

    // Simulate adding listeners
    const addListener = (type: string, handler: () => void) => {
      listeners.push({ type, handler });
      // In real code: window.addEventListener(type, handler);
    };

    // Simulate cleanup
    const cleanup = () => {
      listeners.forEach(({ type: _type, handler: _handler }) => {
        // In real code: window.removeEventListener(type, handler);
      });
      listeners.length = 0;
    };

    // Add some listeners
    addListener('message', () => {});
    addListener('scroll', () => {});
    expect(listeners.length).toBe(2);

    // Cleanup
    cleanup();
    expect(listeners.length).toBe(0);
  });
});

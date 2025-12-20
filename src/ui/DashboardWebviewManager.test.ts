import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import type { DashboardData } from './DashboardDataTransformer';
import { DashboardWebviewManager } from './DashboardWebviewManager';

// Mock vscode module
vi.mock('vscode', () => ({
  window: {
    createWebviewPanel: vi.fn(),
  },
  Uri: {
    joinPath: vi.fn(),
    file: vi.fn(),
    parse: vi.fn(),
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

// Mock VS Code API
const createMockWebview = () => ({
  html: '',
  postMessage: vi.fn().mockResolvedValue(true),
  asWebviewUri: vi.fn((uri) => uri),
  cspSource: 'test-csp',
  onDidReceiveMessage: vi.fn(),
});

const createMockPanel = (): vscode.WebviewPanel => {
  const webview = createMockWebview();
  const onDidReceiveMessageHandler = vi.fn();
  const onDidDisposeHandler = vi.fn();
  const panel: {
    webview: ReturnType<typeof createMockWebview> & {
      onDidReceiveMessage: (callback: (message: unknown) => void) => { dispose: () => void };
    };
    viewType: string;
    title: string;
    viewColumn: number;
    active: boolean;
    visible: boolean;
    options: object;
    _disposeCallback: (() => void) | null;
    _onDidReceiveMessageHandler: (message: unknown) => void;
    onDidDispose: (callback: () => void) => { dispose: () => void };
    onDidChangeViewState: () => void;
    reveal: () => void;
    dispose: () => void;
  } = {
    webview: {
      ...webview,
      onDidReceiveMessage: vi.fn((callback: (message: unknown) => void) => {
        onDidReceiveMessageHandler.mockImplementation(callback);
        return { dispose: vi.fn() };
      }),
    },
    viewType: 'depPulseDashboard',
    title: 'DepPulse Dashboard',
    viewColumn: 1,
    active: true,
    visible: true,
    options: {},
    _disposeCallback: null,
    _onDidReceiveMessageHandler: onDidReceiveMessageHandler,
    onDidDispose: (callback: () => void) => {
      panel._disposeCallback = callback;
      onDidDisposeHandler.mockImplementation(callback);
      return { dispose: vi.fn() };
    },
    onDidChangeViewState: vi.fn(),
    reveal: vi.fn(),
    dispose: vi.fn(() => {
      if (panel._disposeCallback) {
        panel._disposeCallback();
      }
    }),
  };
  return panel as unknown as vscode.WebviewPanel;
};

const _createMockOutputChannel = (): vscode.OutputChannel => ({
  name: 'test',
  append: vi.fn(),
  appendLine: vi.fn(),
  replace: vi.fn(),
  clear: vi.fn(),
  show: vi.fn(),
  hide: vi.fn(),
  dispose: vi.fn(),
});

const createMockUri = (path: string): vscode.Uri => {
  const uri = {
    scheme: 'file',
    authority: '',
    path,
    query: '',
    fragment: '',
    fsPath: path,
    with: vi.fn(),
    toJSON: vi.fn(),
    toString: () => path,
  } as vscode.Uri;
  return uri;
};

describe('DashboardWebviewManager', () => {
  let manager: DashboardWebviewManager;
  let mockExtensionUri: vscode.Uri;
  let mockLog: (message: string) => void;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExtensionUri = createMockUri('/test/extension');
    mockLog = vi.fn() as (message: string) => void;
    manager = new DashboardWebviewManager(mockExtensionUri, mockLog, vscode.ExtensionMode.Test);

    // Mock vscode APIs
    vi.spyOn(vscode.window, 'createWebviewPanel').mockReturnValue(createMockPanel());
    vi.spyOn(vscode.Uri, 'joinPath').mockImplementation((base, ...paths) =>
      createMockUri(`${base.path}/${paths.join('/')}`)
    );
  });

  describe('constructor', () => {
    it('should initialize with extension URI and log function', () => {
      expect(manager).toBeDefined();
      expect((manager as unknown as { extensionUri: vscode.Uri }).extensionUri).toBe(
        mockExtensionUri
      );
      expect((manager as unknown as { log: (message: string) => void }).log).toBe(mockLog);
    });

    it('should initialize with empty state', () => {
      expect((manager as unknown as { panel: unknown }).panel).toBeUndefined();
      expect((manager as unknown as { isWebviewReady: boolean }).isWebviewReady).toBe(false);
      expect((manager as unknown as { disposables: unknown[] }).disposables).toEqual([]);
      expect((manager as unknown as { readyTimeout: unknown }).readyTimeout).toBeNull();
    });
  });

  describe('setMessageHandler()', () => {
    it('should set message handler', () => {
      const handler = vi.fn();
      manager.setMessageHandler(handler);
      expect((manager as unknown as { onMessageHandler: unknown }).onMessageHandler).toBe(handler);
    });
  });

  describe('setReadyCallback()', () => {
    it('should set ready callback', () => {
      const callback = vi.fn().mockResolvedValue(undefined);
      manager.setReadyCallback(callback);
      expect((manager as unknown as { onReadyCallback: unknown }).onReadyCallback).toBe(callback);
    });
  });

  describe('show()', () => {
    it('should create new panel when none exists', () => {
      manager.show();
      expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
        'depPulseDashboard',
        'DepPulse Dashboard',
        vscode.ViewColumn.One,
        expect.objectContaining({
          enableScripts: true,
          retainContextWhenHidden: true,
        })
      );
      expect(mockLog).toHaveBeenCalledWith(
        'Dashboard panel created, waiting for webview ready signal'
      );
    });

    it('should reveal existing panel when already created', () => {
      const mockPanel = createMockPanel();
      (manager as unknown as { panel: vscode.WebviewPanel }).panel = mockPanel;

      manager.show();

      expect(vscode.window.createWebviewPanel).not.toHaveBeenCalled();
      expect(mockPanel.reveal).toHaveBeenCalledWith(vscode.ViewColumn.One);
      expect(mockLog).toHaveBeenCalledWith('Dashboard panel revealed');
    });

    it('should reset readiness state for new panel', () => {
      (manager as unknown as { isWebviewReady: boolean }).isWebviewReady = true;
      manager.show();
      expect((manager as unknown as { isWebviewReady: boolean }).isWebviewReady).toBe(false);
    });

    it('should set webview HTML content', () => {
      const mockPanel = createMockPanel();
      vi.spyOn(vscode.window, 'createWebviewPanel').mockReturnValue(mockPanel);

      manager.show();

      expect(mockPanel.webview.html).toContain('<!DOCTYPE html>');
      expect(mockPanel.webview.html).toContain('DepPulse Dashboard');
    });

    it('should set up message handler for ready signal', () => {
      const mockPanel = createMockPanel();
      vi.spyOn(vscode.window, 'createWebviewPanel').mockReturnValue(mockPanel);
      const messageHandler = vi.fn();
      manager.setMessageHandler(messageHandler);

      manager.show();

      // Simulate ready message
      const messageCallback = (
        mockPanel as unknown as { _onDidReceiveMessageHandler: (msg: unknown) => void }
      )._onDidReceiveMessageHandler;
      messageCallback({ command: 'ready' });

      expect((manager as unknown as { isWebviewReady: boolean }).isWebviewReady).toBe(true);
    });

    it('should set up message handler for other messages', () => {
      const mockPanel = createMockPanel();
      vi.spyOn(vscode.window, 'createWebviewPanel').mockReturnValue(mockPanel);
      const messageHandler = vi.fn();
      manager.setMessageHandler(messageHandler);

      manager.show();

      // Simulate non-ready message
      const messageCallback = (
        mockPanel as unknown as { _onDidReceiveMessageHandler: (msg: unknown) => void }
      )._onDidReceiveMessageHandler;
      messageCallback({ command: 'refresh' });

      expect(messageHandler).toHaveBeenCalledWith({ command: 'refresh' });
    });

    it('should set up panel disposal handler', () => {
      const mockPanel = createMockPanel();
      vi.spyOn(vscode.window, 'createWebviewPanel').mockReturnValue(mockPanel);

      manager.show();

      // Trigger disposal
      const disposeCallback = (mockPanel as unknown as { _disposeCallback: () => void })
        ._disposeCallback;
      if (disposeCallback) {
        disposeCallback();
      }

      expect((manager as unknown as { panel: unknown }).panel).toBeUndefined();
      expect((manager as unknown as { isWebviewReady: boolean }).isWebviewReady).toBe(false);
      expect(mockLog).toHaveBeenCalledWith('Dashboard panel disposed');
    });

    it('should clear timeout on panel disposal', () => {
      const mockPanel = createMockPanel();
      vi.spyOn(vscode.window, 'createWebviewPanel').mockReturnValue(mockPanel);
      vi.useFakeTimers();

      manager.show();

      const timeout = (manager as unknown as { readyTimeout: unknown }).readyTimeout;
      expect(timeout).not.toBeNull();

      const disposeCallback = (mockPanel as unknown as { _disposeCallback: () => void })
        ._disposeCallback;
      if (disposeCallback) {
        disposeCallback();
      }

      expect((manager as unknown as { readyTimeout: unknown }).readyTimeout).toBeNull();
      vi.useRealTimers();
    });

    it('should set timeout fallback for ready signal', () => {
      vi.useFakeTimers();
      const mockPanel = createMockPanel();
      vi.spyOn(vscode.window, 'createWebviewPanel').mockReturnValue(mockPanel);

      manager.show();

      expect((manager as unknown as { readyTimeout: unknown }).readyTimeout).not.toBeNull();

      // Fast-forward time past timeout
      vi.advanceTimersByTime(5000);

      expect(mockLog).toHaveBeenCalledWith(
        expect.stringContaining('WARNING: Webview ready signal timeout')
      );

      vi.useRealTimers();
    });
  });

  describe('hide()', () => {
    it('should dispose panel when it exists', () => {
      const mockPanel = createMockPanel();
      (manager as unknown as { panel: vscode.WebviewPanel }).panel = mockPanel;

      manager.hide();

      expect(mockPanel.dispose).toHaveBeenCalled();
      expect((manager as unknown as { panel: unknown }).panel).toBeUndefined();
      expect(mockLog).toHaveBeenCalledWith('Dashboard panel hidden');
    });

    it('should not throw when panel does not exist', () => {
      expect(() => manager.hide()).not.toThrow();
    });
  });

  describe('getPanel()', () => {
    it('should return panel when it exists', () => {
      const mockPanel = createMockPanel();
      (manager as unknown as { panel: vscode.WebviewPanel }).panel = mockPanel;

      expect(manager.getPanel()).toBe(mockPanel);
    });

    it('should return undefined when panel does not exist', () => {
      expect(manager.getPanel()).toBeUndefined();
    });
  });

  describe('isReady()', () => {
    it('should return false when webview is not ready', () => {
      expect(manager.isReady()).toBe(false);
    });

    it('should return true when webview is ready', () => {
      (manager as unknown as { isWebviewReady: boolean }).isWebviewReady = true;
      expect(manager.isReady()).toBe(true);
    });
  });

  describe('markAsReady()', () => {
    it('should mark webview as ready via markAsReady', () => {
      manager.markAsReady();
      expect((manager as unknown as { isWebviewReady: boolean }).isWebviewReady).toBe(true);
    });

    it('should clear timeout when marking as ready', () => {
      vi.useFakeTimers();
      const mockPanel = createMockPanel();
      vi.spyOn(vscode.window, 'createWebviewPanel').mockReturnValue(mockPanel);

      manager.show();

      const timeout = (manager as unknown as { readyTimeout: unknown }).readyTimeout;
      expect(timeout).not.toBeNull();

      manager.markAsReady();

      expect((manager as unknown as { readyTimeout: unknown }).readyTimeout).toBeNull();
      vi.useRealTimers();
    });
  });

  describe('sendData()', () => {
    it('should send data to webview when panel and ready', () => {
      const mockPanel = createMockPanel();
      (manager as unknown as { panel: vscode.WebviewPanel }).panel = mockPanel;
      (manager as unknown as { isWebviewReady: boolean }).isWebviewReady = true;

      const dashboardData: DashboardData = {
        healthScore: {
          overall: 100,
          security: 100,
          freshness: 100,
          compatibility: 100,
          license: 100,
        },
        metrics: {
          totalDependencies: 0,
          analyzedDependencies: 0,
          failedDependencies: 0,
          criticalIssues: 0,
          highIssues: 0,
          outdatedPackages: 0,
          healthyPackages: 0,
        },
        chartData: {
          severity: { critical: 0, high: 0, medium: 0, low: 0, none: 0 },
          freshness: { current: 0, patch: 0, minor: 0, major: 0, unmaintained: 0 },
        },
        dependencies: [],
        packageManager: 'npm',
        lastScanned: new Date(),
        isCached: false,
      };

      manager.sendData(dashboardData);

      expect(mockPanel.webview.postMessage).toHaveBeenCalledWith({
        type: 'analysisUpdate',
        data: dashboardData,
      });
      expect(mockLog).toHaveBeenCalledWith(
        expect.stringContaining('Sending analysisUpdate message')
      );
    });

    it('should not send data when panel does not exist', () => {
      const dashboardData: DashboardData = {
        healthScore: {
          overall: 100,
          security: 100,
          freshness: 100,
          compatibility: 100,
          license: 100,
        },
        metrics: {
          totalDependencies: 0,
          analyzedDependencies: 0,
          failedDependencies: 0,
          criticalIssues: 0,
          highIssues: 0,
          outdatedPackages: 0,
          healthyPackages: 0,
        },
        chartData: {
          severity: { critical: 0, high: 0, medium: 0, low: 0, none: 0 },
          freshness: { current: 0, patch: 0, minor: 0, major: 0, unmaintained: 0 },
        },
        dependencies: [],
        packageManager: 'npm',
        lastScanned: new Date(),
        isCached: false,
      };

      manager.sendData(dashboardData);

      expect(mockLog).toHaveBeenCalledWith('WARNING: Cannot send data - panel does not exist');
    });

    it('should not send data when webview is not ready', () => {
      const mockPanel = createMockPanel();
      (manager as unknown as { panel: vscode.WebviewPanel }).panel = mockPanel;
      (manager as unknown as { isWebviewReady: boolean }).isWebviewReady = false;

      const dashboardData: DashboardData = {
        healthScore: {
          overall: 100,
          security: 100,
          freshness: 100,
          compatibility: 100,
          license: 100,
        },
        metrics: {
          totalDependencies: 0,
          analyzedDependencies: 0,
          failedDependencies: 0,
          criticalIssues: 0,
          highIssues: 0,
          outdatedPackages: 0,
          healthyPackages: 0,
        },
        chartData: {
          severity: { critical: 0, high: 0, medium: 0, low: 0, none: 0 },
          freshness: { current: 0, patch: 0, minor: 0, major: 0, unmaintained: 0 },
        },
        dependencies: [],
        packageManager: 'npm',
        lastScanned: new Date(),
        isCached: false,
      };

      manager.sendData(dashboardData);

      expect(mockPanel.webview.postMessage).not.toHaveBeenCalled();
      expect(mockLog).toHaveBeenCalledWith('WARNING: Cannot send data - webview not ready yet');
    });

    it('should handle errors when sending data', () => {
      const mockPanel = createMockPanel();
      (manager as unknown as { panel: vscode.WebviewPanel }).panel = mockPanel;
      (manager as unknown as { isWebviewReady: boolean }).isWebviewReady = true;

      const error = new Error('Post message failed');
      vi.spyOn(mockPanel.webview, 'postMessage').mockImplementation(() => {
        throw error;
      });

      const dashboardData: DashboardData = {
        healthScore: {
          overall: 100,
          security: 100,
          freshness: 100,
          compatibility: 100,
          license: 100,
        },
        metrics: {
          totalDependencies: 0,
          analyzedDependencies: 0,
          failedDependencies: 0,
          criticalIssues: 0,
          highIssues: 0,
          outdatedPackages: 0,
          healthyPackages: 0,
        },
        chartData: {
          severity: { critical: 0, high: 0, medium: 0, low: 0, none: 0 },
          freshness: { current: 0, patch: 0, minor: 0, major: 0, unmaintained: 0 },
        },
        dependencies: [],
        packageManager: 'npm',
        lastScanned: new Date(),
        isCached: false,
      };

      manager.sendData(dashboardData);

      expect(mockLog).toHaveBeenCalledWith(
        expect.stringContaining('ERROR sending data to webview')
      );
    });
  });

  describe('sendProgressUpdate()', () => {
    it('should send progress update when panel and ready', () => {
      const mockPanel = createMockPanel();
      (manager as unknown as { panel: vscode.WebviewPanel }).panel = mockPanel;
      (manager as unknown as { isWebviewReady: boolean }).isWebviewReady = true;

      manager.sendProgressUpdate(50, 'Processing...');

      expect(mockPanel.webview.postMessage).toHaveBeenCalledWith({
        type: 'progressUpdate',
        data: {
          progress: 50,
          message: 'Processing...',
        },
      });
    });

    it('should clamp progress to 0-100 range', () => {
      const mockPanel = createMockPanel();
      (manager as unknown as { panel: vscode.WebviewPanel }).panel = mockPanel;
      (manager as unknown as { isWebviewReady: boolean }).isWebviewReady = true;

      manager.sendProgressUpdate(150, 'Over 100');

      expect(mockPanel.webview.postMessage).toHaveBeenCalledWith({
        type: 'progressUpdate',
        data: {
          progress: 100,
          message: 'Over 100',
        },
      });

      manager.sendProgressUpdate(-10, 'Negative');

      expect(mockPanel.webview.postMessage).toHaveBeenCalledWith({
        type: 'progressUpdate',
        data: {
          progress: 0,
          message: 'Negative',
        },
      });
    });

    it('should not send progress when panel does not exist', () => {
      manager.sendProgressUpdate(50, 'Processing...');
      // Should not throw or log error
    });

    it('should not send progress when webview is not ready', () => {
      const mockPanel = createMockPanel();
      (manager as unknown as { panel: vscode.WebviewPanel }).panel = mockPanel;
      (manager as unknown as { isWebviewReady: boolean }).isWebviewReady = false;

      manager.sendProgressUpdate(50, 'Processing...');

      expect(mockPanel.webview.postMessage).not.toHaveBeenCalled();
    });

    it('should handle errors when sending progress', () => {
      const mockPanel = createMockPanel();
      (manager as unknown as { panel: vscode.WebviewPanel }).panel = mockPanel;
      (manager as unknown as { isWebviewReady: boolean }).isWebviewReady = true;

      const error = new Error('Post message failed');
      vi.spyOn(mockPanel.webview, 'postMessage').mockImplementation(() => {
        throw error;
      });

      manager.sendProgressUpdate(50, 'Processing...');

      expect(mockLog).toHaveBeenCalledWith(
        expect.stringContaining('Error sending progress update')
      );
    });
  });

  describe('handleWebviewReady()', () => {
    it('should mark webview as ready on ready signal', async () => {
      const mockPanel = createMockPanel();
      vi.spyOn(vscode.window, 'createWebviewPanel').mockReturnValue(mockPanel);
      manager.show();

      await (
        manager as unknown as { handleWebviewReady: () => Promise<void> }
      ).handleWebviewReady();

      expect((manager as unknown as { isWebviewReady: boolean }).isWebviewReady).toBe(true);
      expect(mockLog).toHaveBeenCalledWith('Webview ready signal received');
    });

    it('should clear timeout when ready signal received', async () => {
      vi.useFakeTimers();
      const mockPanel = createMockPanel();
      vi.spyOn(vscode.window, 'createWebviewPanel').mockReturnValue(mockPanel);

      manager.show();

      const timeout = (manager as unknown as { readyTimeout: unknown }).readyTimeout;
      expect(timeout).not.toBeNull();

      await (
        manager as unknown as { handleWebviewReady: () => Promise<void> }
      ).handleWebviewReady();

      expect((manager as unknown as { readyTimeout: unknown }).readyTimeout).toBeNull();
      vi.useRealTimers();
    });

    it('should execute ready callback if set', async () => {
      const mockPanel = createMockPanel();
      vi.spyOn(vscode.window, 'createWebviewPanel').mockReturnValue(mockPanel);
      manager.show();

      const callback = vi.fn().mockResolvedValue(undefined);
      manager.setReadyCallback(callback);

      await (
        manager as unknown as { handleWebviewReady: () => Promise<void> }
      ).handleWebviewReady();

      expect(callback).toHaveBeenCalled();
      expect(mockLog).toHaveBeenCalledWith('Webview ready handling completed');
    });

    it('should handle callback errors', async () => {
      const mockPanel = createMockPanel();
      vi.spyOn(vscode.window, 'createWebviewPanel').mockReturnValue(mockPanel);
      manager.show();

      const callback = vi.fn().mockRejectedValue(new Error('Callback error'));
      manager.setReadyCallback(callback);

      await (
        manager as unknown as { handleWebviewReady: () => Promise<void> }
      ).handleWebviewReady();

      expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('Error in ready callback'));
    });

    it('should work without callback', async () => {
      const mockPanel = createMockPanel();
      vi.spyOn(vscode.window, 'createWebviewPanel').mockReturnValue(mockPanel);
      manager.show();

      await (
        manager as unknown as { handleWebviewReady: () => Promise<void> }
      ).handleWebviewReady();

      expect((manager as unknown as { isWebviewReady: boolean }).isWebviewReady).toBe(true);
      expect(mockLog).toHaveBeenCalledWith('Webview ready handling completed');
    });
  });

  describe('getWebviewContent()', () => {
    it('should generate HTML content with proper structure', () => {
      const mockWebview = createMockWebview();
      const html = (
        manager as unknown as { getWebviewContent: (w: unknown) => string }
      ).getWebviewContent(mockWebview);

      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('<html lang="en">');
      expect(html).toContain('DepPulse Dashboard');
      expect(html).toContain('dashboard-state.js');
      expect(html).toContain('dashboard-core.js');
    });

    it('should include CSP with webview CSP source', () => {
      const mockWebview = createMockWebview();
      const html = (
        manager as unknown as { getWebviewContent: (w: unknown) => string }
      ).getWebviewContent(mockWebview);

      expect(html).toContain('test-csp');
    });

    it('should include script URIs', () => {
      const mockWebview = createMockWebview();
      vi.spyOn(mockWebview, 'asWebviewUri').mockImplementation((uri: vscode.Uri) => {
        // Return a URI with the path as the string representation
        return createMockUri(uri.path);
      });

      const html = (
        manager as unknown as { getWebviewContent: (w: unknown) => string }
      ).getWebviewContent(mockWebview);

      expect(html).toContain('dashboard-state.js');
      expect(html).toContain('dashboard-utils.js');
      expect(html).toContain('dashboard-charts.js');
      expect(html).toContain('dashboard-filters.js');
      expect(html).toContain('dashboard-table.js');
      expect(html).toContain('dashboard-core.js');
    });
  });

  describe('dispose()', () => {
    it('should dispose panel if it exists', () => {
      const mockPanel = createMockPanel();
      (manager as unknown as { panel: vscode.WebviewPanel }).panel = mockPanel;

      manager.dispose();

      expect(mockPanel.dispose).toHaveBeenCalled();
    });

    it('should dispose all disposables', () => {
      const disposable1 = { dispose: vi.fn() };
      const disposable2 = { dispose: vi.fn() };
      (manager as unknown as { disposables: { dispose: () => void }[] }).disposables = [
        disposable1,
        disposable2,
      ];

      manager.dispose();

      expect(disposable1.dispose).toHaveBeenCalled();
      expect(disposable2.dispose).toHaveBeenCalled();
      expect((manager as unknown as { disposables: unknown[] }).disposables).toEqual([]);
    });

    it('should clear timeout', () => {
      vi.useFakeTimers();
      const mockPanel = createMockPanel();
      vi.spyOn(vscode.window, 'createWebviewPanel').mockReturnValue(mockPanel);

      manager.show();

      const timeout = (manager as unknown as { readyTimeout: unknown }).readyTimeout;
      expect(timeout).not.toBeNull();

      manager.dispose();

      expect((manager as unknown as { readyTimeout: unknown }).readyTimeout).toBeNull();
      vi.useRealTimers();
    });

    it('should log disposal', () => {
      manager.dispose();
      expect(mockLog).toHaveBeenCalledWith('DashboardWebviewManager disposed');
    });
  });

  describe('integration scenarios', () => {
    it('should handle full lifecycle: create, ready, send data, dispose', async () => {
      const mockPanel = createMockPanel();
      vi.spyOn(vscode.window, 'createWebviewPanel').mockReturnValue(mockPanel);
      const messageHandler = vi.fn();
      manager.setMessageHandler(messageHandler);

      // Create panel
      manager.show();
      expect((manager as unknown as { panel: unknown }).panel).toBeDefined();

      // Simulate ready signal
      const messageCallback = (
        mockPanel as unknown as { _onDidReceiveMessageHandler: (msg: unknown) => void }
      )._onDidReceiveMessageHandler;
      messageCallback({ command: 'ready' });

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect((manager as unknown as { isWebviewReady: boolean }).isWebviewReady).toBe(true);

      // Send data
      const dashboardData: DashboardData = {
        healthScore: {
          overall: 100,
          security: 100,
          freshness: 100,
          compatibility: 100,
          license: 100,
        },
        metrics: {
          totalDependencies: 0,
          analyzedDependencies: 0,
          failedDependencies: 0,
          criticalIssues: 0,
          highIssues: 0,
          outdatedPackages: 0,
          healthyPackages: 0,
        },
        chartData: {
          severity: { critical: 0, high: 0, medium: 0, low: 0, none: 0 },
          freshness: { current: 0, patch: 0, minor: 0, major: 0, unmaintained: 0 },
        },
        dependencies: [],
        packageManager: 'npm',
        lastScanned: new Date(),
        isCached: false,
      };

      manager.sendData(dashboardData);
      expect(mockPanel.webview.postMessage).toHaveBeenCalled();

      // Dispose
      manager.dispose();
      expect((manager as unknown as { panel: unknown }).panel).toBeUndefined();
    });

    it('should handle panel disposal during operations', () => {
      const mockPanel = createMockPanel();
      vi.spyOn(vscode.window, 'createWebviewPanel').mockReturnValue(mockPanel);

      manager.show();
      (manager as unknown as { isWebviewReady: boolean }).isWebviewReady = true;

      // Dispose panel
      const disposeCallback = (mockPanel as unknown as { _disposeCallback: () => void })
        ._disposeCallback;
      if (disposeCallback) {
        disposeCallback();
      }

      // Try to send data after disposal
      const dashboardData: DashboardData = {
        healthScore: {
          overall: 100,
          security: 100,
          freshness: 100,
          compatibility: 100,
          license: 100,
        },
        metrics: {
          totalDependencies: 0,
          analyzedDependencies: 0,
          failedDependencies: 0,
          criticalIssues: 0,
          highIssues: 0,
          outdatedPackages: 0,
          healthyPackages: 0,
        },
        chartData: {
          severity: { critical: 0, high: 0, medium: 0, low: 0, none: 0 },
          freshness: { current: 0, patch: 0, minor: 0, major: 0, unmaintained: 0 },
        },
        dependencies: [],
        packageManager: 'npm',
        lastScanned: new Date(),
        isCached: false,
      };

      manager.sendData(dashboardData);

      expect(mockLog).toHaveBeenCalledWith('WARNING: Cannot send data - panel does not exist');
    });
  });
});

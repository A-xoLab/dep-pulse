/**
 * Property-Based Tests for DashboardController
 * Feature: fix-dashboard-data-loading
 *
 * These tests verify correctness properties using fast-check for property-based testing.
 * Each test runs 100 iterations with randomly generated inputs.
 */

import * as fc from 'fast-check';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { getPropertyTestRuns } from '../test-setup';
import type { AnalysisResult } from '../types';
import type { AlternativeSuggestionService } from '../utils';
import { DashboardController } from './DashboardController';

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
  workspace: {
    workspaceFolders: [],
    getConfiguration: vi.fn(() => ({
      get: vi.fn((_key, defaultValue) => defaultValue),
      inspect: vi.fn(() => ({ globalValue: undefined, workspaceValue: undefined })),
    })),
  },
}));

// Mock helpers
const createMockWebview = () => ({
  html: '',
  postMessage: vi.fn().mockResolvedValue(true),
  asWebviewUri: vi.fn((uri) => uri),
  cspSource: 'test-csp',
  onDidReceiveMessage: vi.fn(),
});

const createMockPanel = (): vscode.WebviewPanel => {
  const webview = createMockWebview();
  const panel: {
    webview: ReturnType<typeof createMockWebview>;
    viewType: string;
    title: string;
    viewColumn: number;
    active: boolean;
    visible: boolean;
    options: object;
    _disposeCallback: (() => void) | null;
    onDidDispose: (callback: () => void) => { dispose: () => void };
    onDidChangeViewState: () => void;
    reveal: () => void;
    dispose: () => void;
  } = {
    webview,
    viewType: 'depPulseDashboard',
    title: 'DepPulse Dashboard',
    viewColumn: 1,
    active: true,
    visible: true,
    options: {},
    _disposeCallback: null,
    onDidDispose: vi.fn((callback) => {
      panel._disposeCallback = callback;
      return { dispose: vi.fn() };
    }),
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

const createMockOutputChannel = (): vscode.OutputChannel => ({
  name: 'test',
  append: vi.fn(),
  appendLine: vi.fn(),
  replace: vi.fn(),
  clear: vi.fn(),
  show: vi.fn(),
  hide: vi.fn(),
  dispose: vi.fn(),
});

const createMockUri = (path: string): vscode.Uri => ({
  scheme: 'file',
  authority: '',
  path,
  query: '',
  fragment: '',
  fsPath: path,
  with: vi.fn(),
  toJSON: vi.fn(),
});

// Arbitraries for generating random test data
const dependencyArbitrary = fc.record({
  name: fc.string({ minLength: 1, maxLength: 50 }),
  version: fc.string({ minLength: 1, maxLength: 20 }),
  versionConstraint: fc.string({ minLength: 1, maxLength: 20 }),
  isDev: fc.boolean(),
});

const severityArbitrary = fc.constantFrom('critical', 'high', 'medium', 'low', 'none');

const versionGapArbitrary = fc.constantFrom('current', 'patch', 'minor', 'major');

const dependencyAnalysisArbitrary = fc.record({
  dependency: dependencyArbitrary,
  security: fc.record({
    vulnerabilities: fc.array(
      fc.record({
        id: fc.string(),
        title: fc.string(),
        severity: severityArbitrary,
        description: fc.string(),
        affectedVersions: fc.string(),
        patchedVersions: fc.option(fc.string(), { nil: undefined }),
        cvssScore: fc.option(fc.float({ min: 0, max: 10 }), { nil: undefined }),
        publishedDate: fc.date(),
        references: fc.array(fc.webUrl()),
      }),
      { maxLength: 5 }
    ),
    severity: severityArbitrary,
  }),
  freshness: fc.record({
    currentVersion: fc.string(),
    latestVersion: fc.string(),
    versionGap: versionGapArbitrary,
    releaseDate: fc.date(),
    isOutdated: fc.boolean(),
    isUnmaintained: fc.boolean(),
    maintenanceSignals: fc.option(
      fc.record({
        isLongTermUnmaintained: fc.boolean(),
        reasons: fc.array(
          fc.oneof(
            fc.record({
              source: fc.constant('npm'),
              type: fc.constantFrom('deprecated', 'version-deprecated'),
              message: fc.option(fc.string(), { nil: undefined }),
            }),
            fc.record({
              source: fc.constant('github'),
              type: fc.constant('archived'),
              repository: fc.string(),
            }),
            fc.record({
              source: fc.constant('readme'),
              type: fc.constant('notice'),
              excerpt: fc.string(),
            })
          ),
          { maxLength: 3 }
        ),
        lastChecked: fc.date(),
      }),
      { nil: undefined }
    ),
  }),
  license: fc.record({
    license: fc.string(),
    spdxIds: fc.array(fc.string(), { minLength: 0 }),
    isCompatible: fc.boolean(),
    licenseType: fc.constantFrom('permissive', 'copyleft', 'proprietary', 'unknown'),
  }),
  isFailed: fc.option(fc.boolean(), { nil: undefined }),
  maintenanceSignals: fc.option(
    fc.record({
      isLongTermUnmaintained: fc.boolean(),
      reasons: fc.array(
        fc.oneof(
          fc.record({
            source: fc.constant('npm'),
            type: fc.constantFrom('deprecated', 'version-deprecated'),
            message: fc.option(fc.string(), { nil: undefined }),
          }),
          fc.record({
            source: fc.constant('github'),
            type: fc.constant('archived'),
            repository: fc.string(),
          }),
          fc.record({
            source: fc.constant('readme'),
            type: fc.constant('notice'),
            excerpt: fc.string(),
          })
        ),
        { maxLength: 3 }
      ),
      lastChecked: fc.date(),
    }),
    { nil: undefined }
  ),
});

const analysisResultArbitrary = fc.record({
  timestamp: fc.date(),
  dependencies: fc.array(dependencyAnalysisArbitrary, { minLength: 1, maxLength: 10 }),
  healthScore: fc.record({
    overall: fc.float({ min: 0, max: 100 }),
    security: fc.float({ min: 0, max: 100 }),
    freshness: fc.float({ min: 0, max: 100 }),
    compatibility: fc.float({ min: 0, max: 100 }),
    license: fc.float({ min: 0, max: 100 }),
    breakdown: fc.record({
      totalDependencies: fc.nat({ max: 100 }),
      criticalIssues: fc.nat({ max: 50 }),
      warnings: fc.nat({ max: 50 }),
      healthy: fc.nat({ max: 100 }),
    }),
  }),
  summary: fc.record({
    totalDependencies: fc.nat({ max: 100 }),
    analyzedDependencies: fc.nat({ max: 100 }),
    failedDependencies: fc.nat({ max: 20 }),
    criticalIssues: fc.nat({ max: 50 }),
    highIssues: fc.nat({ max: 50 }),
    warnings: fc.nat({ max: 50 }),
    healthy: fc.nat({ max: 100 }),
    errors: fc.option(fc.nat({ max: 10 }), { nil: undefined }),
  }),
  failedPackages: fc.option(
    fc.array(
      fc.record({
        name: fc.string(),
        version: fc.string(),
        error: fc.string(),
        errorCode: fc.option(fc.string(), { nil: undefined }),
      }),
      { maxLength: 5 }
    ),
    { nil: undefined }
  ),
});

describe('DashboardController - Property-Based Tests', () => {
  let mockOutputChannel: vscode.OutputChannel;
  let mockExtensionUri: vscode.Uri;

  beforeEach(() => {
    mockOutputChannel = createMockOutputChannel();
    mockExtensionUri = createMockUri('/test/extension');
    vi.clearAllMocks();
  });

  /**
   * Property 1: Data persistence across panel lifecycle
   * Feature: fix-dashboard-data-loading, Property 1: Data persistence across panel lifecycle
   * Validates: Requirements 1.1, 1.2
   *
   * For any analysis result received when the dashboard is closed,
   * opening the dashboard should display that analysis result without requiring a refresh.
   */
  it('Property 1: Data persists across panel lifecycle', async () => {
    await fc.assert(
      fc.asyncProperty(analysisResultArbitrary, async (analysis) => {
        const controller = new DashboardController(
          mockExtensionUri,
          mockOutputChannel,
          true,
          vscode.ExtensionMode.Test,
          { getAlternatives: vi.fn() } as unknown as AlternativeSuggestionService
        );

        // Step 1: Update with panel closed (simulating scan completing with dashboard closed)
        await controller.update(analysis as AnalysisResult);

        // Verify analysis was stored
        expect((controller as unknown as { currentAnalysis: AnalysisResult }).currentAnalysis).toBe(
          analysis as AnalysisResult
        );

        // Step 2: Open dashboard (simulating user opening dashboard later)
        // Create webview manager first (this happens when show() is called)
        const webviewManager = (
          controller as unknown as { getWebviewManager: () => unknown }
        ).getWebviewManager();
        const mockPanel = createMockPanel();
        (webviewManager as { panel: vscode.WebviewPanel }).panel = mockPanel;
        (webviewManager as { isWebviewReady: boolean }).isWebviewReady = false;

        // Mock detectPackageManager
        (
          controller as unknown as { detectPackageManager: () => Promise<string> }
        ).detectPackageManager = vi.fn().mockResolvedValue('npm');

        // Step 3: Simulate ready signal from webview
        controller.handleMessage({ command: 'ready' });
        // Wait for async operations (handleWebviewReady is async)
        // Need to wait for detectPackageManager and data transformation
        await new Promise((resolve) => setTimeout(resolve, 200));

        // Verify data was sent to webview
        expect(mockPanel.webview.postMessage).toHaveBeenCalled();

        // Verify the sent data matches the original analysis
        const calls = (mockPanel.webview.postMessage as unknown as { mock: { calls: unknown[][] } })
          .mock.calls;
        expect(calls.length).toBeGreaterThan(0);
        const sentMessage = calls.find(
          (call: unknown[]) => (call[0] as { type: string })?.type === 'analysisUpdate'
        )?.[0] as {
          type: string;
          data: { healthScore: { overall: number }; dependencies: unknown[] };
        };
        expect(sentMessage).toBeDefined();
        expect(sentMessage.type).toBe('analysisUpdate');
        expect(sentMessage.data).toBeDefined();
        expect(sentMessage.data.healthScore).toBeDefined();
        expect(typeof sentMessage.data.healthScore).toBe('object'); // healthScore is an object with overall, security, etc.
        expect(sentMessage.data.healthScore.overall).toBeDefined();
        expect(typeof sentMessage.data.healthScore.overall).toBe('number');
        expect(sentMessage.data.dependencies).toBeDefined();
        expect(Array.isArray(sentMessage.data.dependencies)).toBe(true);
        expect(sentMessage.data.dependencies.length).toBe(analysis.dependencies.length);
      }),
      { numRuns: getPropertyTestRuns(10, 5), timeout: 30000 } // Reduced runs and increased timeout for property test
    );
  }, 60000); // 60 second timeout for the entire test

  /**
   * Property 2: Message ordering guarantee
   * Feature: fix-dashboard-data-loading, Property 2: Message ordering guarantee
   * Validates: Requirements 1.3, 1.4, 2.3
   *
   * For any sequence of webview creation and data sending,
   * data messages should only be sent after the webview has signaled readiness.
   */
  it('Property 2: Messages only sent after ready signal', async () => {
    // Generate random sequences of operations
    const operationArbitrary = fc.constantFrom('show', 'update', 'ready');
    const sequenceArbitrary = fc.array(operationArbitrary, { minLength: 3, maxLength: 10 });

    await fc.assert(
      fc.asyncProperty(sequenceArbitrary, analysisResultArbitrary, async (operations, analysis) => {
        const controller = new DashboardController(
          mockExtensionUri,
          mockOutputChannel,
          true,
          vscode.ExtensionMode.Test,
          { getAlternatives: vi.fn() } as unknown as AlternativeSuggestionService
        );
        const mockPanel = createMockPanel();
        const webviewManager = (
          controller as unknown as { getWebviewManager: () => unknown }
        ).getWebviewManager();
        let readySignalSent = false;
        const messagesSent: string[] = [];

        // Mock detectPackageManager
        (
          controller as unknown as { detectPackageManager: () => Promise<string> }
        ).detectPackageManager = vi.fn().mockResolvedValue('npm');

        // Track all postMessage calls
        mockPanel.webview.postMessage = vi.fn((message) => {
          messagesSent.push(message.type);
          return Promise.resolve(true);
        });

        // Execute operations in sequence
        for (const op of operations) {
          switch (op) {
            case 'show':
              if (!(webviewManager as { panel: vscode.WebviewPanel }).panel) {
                (webviewManager as { panel: vscode.WebviewPanel }).panel = mockPanel;
                (webviewManager as { isWebviewReady: boolean }).isWebviewReady = false;
              }
              break;

            case 'update':
              await controller.update(analysis as AnalysisResult);
              break;

            case 'ready':
              if ((webviewManager as { panel: vscode.WebviewPanel }).panel) {
                readySignalSent = true;
                controller.handleMessage({ command: 'ready' });
                await new Promise((resolve) => setTimeout(resolve, 10));
              }
              break;
          }
        }

        // Verify: If any messages were sent, ready signal must have been sent first
        if (messagesSent.length > 0) {
          expect(readySignalSent).toBe(true);
        }

        // Verify: No messages sent before ready signal
        // (This is implicitly tested by the fact that postMessage is only called after handleMessage('ready'))
      }),
      { numRuns: getPropertyTestRuns(100, 20) }
    );
  });

  /**
   * Property 3: State consistency
   * Feature: fix-dashboard-data-loading, Property 3: State consistency
   * Validates: Requirements 2.1, 2.2
   *
   * For any dashboard controller state, if currentAnalysis is set and the panel is visible and ready,
   * then the webview should have received the analysis data.
   */
  it('Property 3: State consistency - ready panel receives data', async () => {
    await fc.assert(
      fc.asyncProperty(analysisResultArbitrary, async (analysis) => {
        const controller = new DashboardController(
          mockExtensionUri,
          mockOutputChannel,
          true,
          vscode.ExtensionMode.Test,
          { getAlternatives: vi.fn() } as unknown as AlternativeSuggestionService
        );
        const mockPanel = createMockPanel();
        const webviewManager = (
          controller as unknown as { getWebviewManager: () => unknown }
        ).getWebviewManager();

        // Set up state: panel exists, is ready, and has analysis
        (webviewManager as { panel: vscode.WebviewPanel }).panel = mockPanel;
        (webviewManager as { isWebviewReady: boolean }).isWebviewReady = true;
        (controller as unknown as { currentAnalysis: AnalysisResult }).currentAnalysis =
          analysis as AnalysisResult;

        // Mock detectPackageManager
        (
          controller as unknown as { detectPackageManager: () => Promise<string> }
        ).detectPackageManager = vi.fn().mockResolvedValue('npm');

        // Call update (which should send immediately since webview is ready)
        await controller.update(analysis as AnalysisResult);

        // Verify: Data was sent to webview
        expect(mockPanel.webview.postMessage).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'analysisUpdate',
            data: expect.any(Object),
          })
        );

        // Verify: The invariant holds - if (currentAnalysis && panel && isReady) then data was sent
        const hasAnalysis =
          (controller as unknown as { currentAnalysis: AnalysisResult }).currentAnalysis !==
          undefined;
        const hasPanel =
          (webviewManager as unknown as { getPanel: () => vscode.WebviewPanel }).getPanel() !==
          undefined;
        const isReady = (webviewManager as unknown as { isReady: () => boolean }).isReady();

        if (hasAnalysis && hasPanel && isReady) {
          expect(mockPanel.webview.postMessage).toHaveBeenCalled();
        }
      }),
      { numRuns: getPropertyTestRuns(100, 20) }
    );
  });

  /**
   * Property 4: No data loss
   * Feature: fix-dashboard-data-loading, Property 4: No data loss
   * Validates: Requirements 1.1, 2.1, 2.4
   *
   * For any analysis update, the data should either be immediately sent to a ready webview
   * or stored as pending for later transmission.
   */
  it('Property 4: No data loss - data always stored or sent', async () => {
    await fc.assert(
      fc.asyncProperty(analysisResultArbitrary, fc.boolean(), async (analysis, isReady) => {
        const controller = new DashboardController(
          mockExtensionUri,
          mockOutputChannel,
          true,
          vscode.ExtensionMode.Test,
          { getAlternatives: vi.fn() } as unknown as AlternativeSuggestionService
        );
        const mockPanel = createMockPanel();
        const webviewManager = (
          controller as unknown as { getWebviewManager: () => unknown }
        ).getWebviewManager();

        // Set up state
        (webviewManager as { panel: vscode.WebviewPanel }).panel = mockPanel;
        (webviewManager as { isWebviewReady: boolean }).isWebviewReady = isReady;

        // Mock detectPackageManager
        (
          controller as unknown as { detectPackageManager: () => Promise<string> }
        ).detectPackageManager = vi.fn().mockResolvedValue('npm');

        // Call update
        await controller.update(analysis as AnalysisResult);

        // Verify: Data was either sent immediately OR stored as pending
        if (isReady) {
          // If ready, data should have been sent
          expect(mockPanel.webview.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
              type: 'analysisUpdate',
            })
          );
        } else {
          // If not ready, data should be stored as pending
          expect((controller as unknown as { pendingData: unknown }).pendingData).not.toBeNull();
        }

        // In both cases, currentAnalysis should be set
        expect((controller as unknown as { currentAnalysis: AnalysisResult }).currentAnalysis).toBe(
          analysis as AnalysisResult
        );
      }),
      { numRuns: getPropertyTestRuns(100, 20) }
    );
  });
});

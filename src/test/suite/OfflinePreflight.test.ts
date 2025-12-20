import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { __test__ } from '../../extension';
import type { AnalysisResult, Dependency } from '../../types';
import type { DashboardController } from '../../ui/DashboardController';
import { NetworkStatusService } from '../../utils';
import type { CacheManager } from '../../utils/CacheManager';

const offlinePreflightCheck = __test__.offlinePreflightCheck;

// Mocks
const networkServiceMock = {
  reset: vi.fn(),
  checkConnectivity: vi.fn(),
  markDegraded: vi.fn(),
  markSuccess: vi.fn(),
};

vi.spyOn(NetworkStatusService, 'getInstance').mockReturnValue(
  networkServiceMock as unknown as NetworkStatusService
);

const sendMessageMock = vi.fn();
const dashboardControllerMock = { sendMessage: sendMessageMock } as unknown as DashboardController;

const cacheManagerMock = {
  getCachedNpmInfo: vi.fn(),
  getCachedOSVVulnerabilities: vi.fn(),
  getCachedGitHubVulnerabilities: vi.fn(),
};

// Mock vscode
vi.mock('vscode', () => ({
  window: {
    showErrorMessage: vi.fn(),
    createOutputChannel: vi.fn(() => ({
      appendLine: vi.fn(),
      show: vi.fn(),
    })),
  },
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vi.fn((_key: string, defaultValue: unknown) => defaultValue ?? 'osv'),
    })),
  },
}));

describe('offlinePreflightCheck (cache-enabled offline flow)', () => {
  const baseDeps: Dependency[] = [
    { name: 'a', version: '1.0.0', isTransitive: false },
    { name: 'b', version: '2.0.0', isTransitive: false },
  ] as unknown as Dependency[];

  beforeEach(() => {
    vi.clearAllMocks();
    cacheManagerMock.getCachedNpmInfo.mockResolvedValue({});
    cacheManagerMock.getCachedOSVVulnerabilities.mockResolvedValue({});
    cacheManagerMock.getCachedGitHubVulnerabilities.mockResolvedValue({});
    networkServiceMock.checkConnectivity.mockResolvedValue(false);
  });

  it('allows scan when offline but cache coverage is complete', async () => {
    const result = await offlinePreflightCheck({
      effectiveBypassCache: false,
      cacheManager: cacheManagerMock as unknown as CacheManager,
      previousResult: { dependencies: baseDeps } as unknown as AnalysisResult,
      dependencyChanges: { isFullScan: false, changed: [], removed: [] },
      projectInfo: { dependencies: baseDeps },
      dashboardController: dashboardControllerMock,
    });

    expect(result.shouldContinue).toBe(true);
    expect(sendMessageMock).toHaveBeenCalledWith({
      type: 'offlineStatus',
      data: expect.objectContaining({ mode: 'full-cache' }),
    });
    expect(networkServiceMock.markDegraded).toHaveBeenCalledTimes(2);
  });

  it('aborts scan when offline and required caches are missing', async () => {
    cacheManagerMock.getCachedNpmInfo.mockResolvedValueOnce(null); // first dep missing cache

    const result = await offlinePreflightCheck({
      effectiveBypassCache: false,
      cacheManager: cacheManagerMock as unknown as CacheManager,
      previousResult: { dependencies: baseDeps } as unknown as AnalysisResult,
      dependencyChanges: { isFullScan: false, changed: [], removed: [] },
      projectInfo: { dependencies: baseDeps },
      dashboardController: dashboardControllerMock,
    });

    expect(result.shouldContinue).toBe(false);
    if ('handled' in result) {
      expect(result.handled).toBe('missing-cache');
    }
    expect(sendMessageMock).toHaveBeenCalledWith({
      type: 'offlineStatus',
      data: expect.objectContaining({ mode: 'partial' }),
    });
    expect(sendMessageMock).toHaveBeenCalledWith({
      type: 'loading',
      data: { isLoading: false },
    });
    expect(vscode.window.showErrorMessage).toHaveBeenCalled();
  });
});

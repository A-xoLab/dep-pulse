// @ts-expect-error - jsdom types not installed in project
import { JSDOM } from 'jsdom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Stub globals required by dashboard-core.js
vi.stubGlobal(
  'acquireVsCodeApi',
  vi.fn(() => ({ postMessage: vi.fn() }))
);
vi.stubGlobal('Logger', {
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
});
vi.stubGlobal(
  'MutationObserver',
  class {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    observe(_target?: unknown, _options?: unknown) {}
    disconnect() {}
    takeRecords(): unknown[] {
      return [];
    }
  }
);

interface HTMLElementLike {
  classList: {
    contains(cls: string): boolean;
    add(...cls: string[]): void;
    remove(...cls: string[]): void;
  };
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  hasAttribute(name: string): boolean;
  getAttribute(name: string): string | null;
}

interface DocumentLike {
  getElementById(id: string): HTMLElementLike | null;
}

type TestWindow = {
  __dpTestHooks?: unknown;
  document: DocumentLike;
};

let testWindow: TestWindow;
let testDocument: DocumentLike;

describe('Dashboard webview visibility helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();

    const dom = new JSDOM(`<!doctype html><html><body>
      <div id="empty-state-no-deps" class="hidden" hidden></div>
      <div id="empty-state-healthy" class="hidden" hidden></div>
      <div id="offline-notification" class="hidden" hidden>
        <p id="offline-message"></p>
        <button id="close-offline-notification"></button>
      </div>
    </body></html>`);

    testWindow = dom.window as unknown as TestWindow;
    testDocument = dom.window.document as unknown as DocumentLike;

    const g = globalThis as typeof globalThis & { window: TestWindow; document: DocumentLike };
    g.window = testWindow;
    g.document = testDocument;
  });

  it('setVisibility toggles both class and hidden attribute', async () => {
    // @ts-expect-error - allow importing plain JS
    await import('../../../resources/webview/dashboard-core.js');
    const hooks = (globalThis as typeof globalThis & { window: TestWindow }).window
      .__dpTestHooks as {
      setVisibility: (el: HTMLElementLike, visible: boolean) => void;
    };
    const el = (
      globalThis as typeof globalThis & { document: DocumentLike }
    ).document.getElementById('empty-state-no-deps');
    if (!el) throw new Error('missing empty-state-no-deps');

    hooks.setVisibility(el, true);
    expect(el.classList.contains('hidden')).toBe(false);
    expect(el.hasAttribute('hidden')).toBe(false);

    hooks.setVisibility(el, false);
    expect(el.classList.contains('hidden')).toBe(true);
    expect(el.getAttribute('hidden')).toBe('true');
  });

  it('empty state helpers show/hide correct elements', async () => {
    // @ts-expect-error - allow importing plain JS
    await import('../../../resources/webview/dashboard-core.js');
    const hooks = (globalThis as typeof globalThis & { window: TestWindow }).window
      .__dpTestHooks as {
      showEmptyStateNoDeps: () => void;
      hideEmptyStates: () => void;
    };
    const noDeps = (
      globalThis as typeof globalThis & { document: DocumentLike }
    ).document.getElementById('empty-state-no-deps');
    const healthy = (
      globalThis as typeof globalThis & { document: DocumentLike }
    ).document.getElementById('empty-state-healthy');
    if (!noDeps || !healthy) throw new Error('missing empty states');

    hooks.showEmptyStateNoDeps();
    expect(noDeps.classList.contains('hidden')).toBe(false);
    expect(noDeps.hasAttribute('hidden')).toBe(false);
    expect(healthy.classList.contains('hidden')).toBe(true);

    hooks.hideEmptyStates();
    expect(noDeps.classList.contains('hidden')).toBe(true);
    expect(noDeps.getAttribute('hidden')).toBe('true');
    expect(healthy.classList.contains('hidden')).toBe(true);
  });
});

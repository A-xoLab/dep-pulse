import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it, beforeEach, vi } from 'vitest';

describe('Cleanup Widget', () => {
  let window;
  let document;
  let postMessageSpy;

  beforeEach(() => {
    const dom = new JSDOM(`<!DOCTYPE html><html><body>
      <div id="cleanup-card">
        <button id="cleanup-preview-btn"></button>
        <button id="cleanup-confirm-btn" class="hidden"></button>
        <div id="cleanup-status"></div>
        <div id="cleanup-impact"></div>
        <div id="cleanup-detail" class="hidden">
          <ul id="cleanup-list"></ul>
        </div>
        <span id="cleanup-badge"></span>
      </div>
    </body></html>`);
    window = dom.window;
    document = window.document;
    postMessageSpy = vi.fn();
    global.window = window;
    global.document = document;
    global.acquireVsCodeApi = () => ({ postMessage: postMessageSpy });

    const scriptContent = fs.readFileSync(path.resolve(__dirname, 'cleanup-widget.js'), 'utf8');
    const scriptFn = new Function('window', 'document', 'acquireVsCodeApi', scriptContent);
    scriptFn(window, document, global.acquireVsCodeApi);
  });

  it('sends preview request on button click', () => {
    const previewBtn = document.getElementById('cleanup-preview-btn');
    previewBtn.click();
    expect(postMessageSpy).toHaveBeenCalledWith({ command: 'cleanupUnusedPackages.preview' });
  });

  it('updates UI on preview ok', () => {
    window.updateCleanupWidget({
      type: 'unusedPackagesPreview',
      data: {
        status: 'ok',
        totalUnused: 3,
        plans: [
          { targetLabel: 'pkg-a', dependencies: ['a'], devDependencies: [], packageManager: 'npm' },
        ],
      },
    });

    const badge = document.getElementById('cleanup-badge').textContent;
    expect(badge).toContain('3');
    const detail = document.getElementById('cleanup-detail');
    expect(detail.classList.contains('hidden')).toBe(false);
    const confirmBtn = document.getElementById('cleanup-confirm-btn');
    expect(confirmBtn.classList.contains('hidden')).toBe(false);
  });

  it('shows error state', () => {
    window.updateCleanupWidget({
      type: 'unusedPackagesPreview',
      data: { status: 'error', message: 'Failed' },
    });
    const status = document.getElementById('cleanup-status').textContent;
    expect(status.toLowerCase()).toContain('failed');
  });
});

import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { beforeEach, describe, expect, it } from 'vitest';

describe('Dashboard Filters', () => {
  let window;
  let filterManager;

  beforeEach(() => {
    const dom = new JSDOM(`<!DOCTYPE html><html><body>
      <input id="search-input" />
      <select id="severity-filter">
        <option value="all">All</option>
        <option value="critical">Critical</option>
        <option value="high">High</option>
        <option value="medium">Medium</option>
        <option value="low">Low</option>
        <option value="none">None</option>
      </select>
      <select id="freshness-filter">
        <option value="all">All</option>
        <option value="current">Current</option>
        <option value="patch">Patch</option>
        <option value="minor">Minor</option>
        <option value="major">Major</option>
        <option value="unmaintained">Unmaintained</option>
      </select>
      <div id="active-filters-container" hidden></div>
    </body></html>`);
    window = dom.window;
    global.window = window;
    global.document = window.document;

    // Mock dependencies
    window.currentDashboardData = {
      dependencies: [],
    };

    // Load the script
    const scriptContent = fs.readFileSync(path.resolve(__dirname, 'dashboard-filters.js'), 'utf8');

    // Execute the script in the context of our mock window
    // We need to strip the "var filterManager = window.filterManager;" part or handle it
    // simpler way: just eval it.
    // However, the script checks if window.FilterManager is undefined.

    // We can use new Function to execute it
    const scriptFn = new Function('window', 'document', scriptContent);
    scriptFn(window, document);

    filterManager = new window.FilterManager();
  });

  it('should search by package name', () => {
    const dep = {
      packageName: 'react',
      cveIds: [],
      severity: 'none',
      freshness: 'current',
    };
    expect(filterManager.matchesSearch(dep, 'react')).toBe(true);
    expect(filterManager.matchesSearch(dep, 'vue')).toBe(false);
  });

  it('should search by CVE ID', () => {
    const dep = {
      packageName: 'lodash',
      cveIds: ['CVE-2023-1234'],
      severity: 'high',
      freshness: 'outdated',
    };
    expect(filterManager.matchesSearch(dep, 'cve-2023-1234')).toBe(true);
    expect(filterManager.matchesSearch(dep, '1234')).toBe(true);
  });

  it('should search by severity', () => {
    const dep = {
      packageName: 'express',
      cveIds: [],
      severity: 'critical',
      freshness: 'current',
    };
    // This is expected to fail currently
    expect(filterManager.matchesSearch(dep, 'critical')).toBe(true);
  });

  it('should search by freshness', () => {
    const dep = {
      packageName: 'moment',
      cveIds: [],
      severity: 'low',
      freshness: 'unmaintained',
    };
    // This is expected to fail currently
    expect(filterManager.matchesSearch(dep, 'unmaintained')).toBe(true);
  });

  it('applies chart filters and resets other dropdowns', () => {
    const severityFilter = window.document.getElementById('severity-filter');
    const freshnessFilter = window.document.getElementById('freshness-filter');

    filterManager.applyChartFilter('freshness', 'minor');
    expect(filterManager.state.freshness).toBe('minor');
    expect(filterManager.state.severity).toBe('all');
    expect(freshnessFilter.value).toBe('minor');
    expect(severityFilter.value).toBe('all');

    filterManager.applyChartFilter('severity', 'high');
    expect(filterManager.state.severity).toBe('high');
    expect(filterManager.state.freshness).toBe('all');
    expect(severityFilter.value).toBe('high');
    expect(freshnessFilter.value).toBe('all');
  });

  it('renders filter tags for active dropdowns and supports removal', () => {
    const container = window.document.getElementById('active-filters-container');

    filterManager.updateSeverity('high');
    filterManager.updateFreshness('minor');

    expect(container.hidden).toBe(false);
    expect(container.children.length).toBe(2);

    // Remove severity tag
    let removeButtons = container.querySelectorAll('button');
    removeButtons[0].click();
    expect(filterManager.state.severity).toBe('all');
    expect(container.children.length).toBe(1);

    // Remove freshness tag
    removeButtons = container.querySelectorAll('button');
    removeButtons[0].click();
    expect(filterManager.state.freshness).toBe('all');
    expect(container.hidden).toBe(true);
  });
});

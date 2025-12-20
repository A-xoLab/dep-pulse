// DepPulse Dashboard - State Management
// Global state variables shared across dashboard modules
// All variables are declared in global scope for cross-module access
// Note: These variables are used across multiple dashboard modules loaded as separate script tags

// Global state (use window to prevent re-declaration errors)
// Initialize window properties if they don't exist
if (typeof window.timestampUpdateInterval === 'undefined') {
  window.timestampUpdateInterval = null;
}
if (typeof window.lastScannedDate === 'undefined') {
  window.lastScannedDate = null;
}
if (typeof window.currentDashboardData === 'undefined') {
  window.currentDashboardData = null;
}
if (typeof window.isSinglePackageProject === 'undefined') {
  window.isSinglePackageProject = false;
}
if (typeof window.transitiveEnabled === 'undefined') {
  window.transitiveEnabled = true;
}
if (typeof window.packageJsonCount === 'undefined') {
  window.packageJsonCount = undefined;
}
// Use window properties directly to avoid shadowing issues
// These will be accessed via window object in other modules

// Table view is always shown (view toggle removed)
window.flippedCards = new Set(); // Track which cards are flipped
window.selectedPackagesForComparison = []; // For comparison view
window.alternativeTabState = {};
window.alternativeSuggestionData = {};
window.alternativeErrorState = {};

// Virtual scrolling state
window.virtualScrollState = {
  itemHeight: 60, // Estimated row height
  visibleCount: 20, // Number of visible rows
  scrollTop: 0,
  totalItems: 0,
  startIndex: 0,
  endIndex: 20,
  buffer: 5, // Extra rows to render above/below viewport
};

window.visibleColumns = {
  packageName: true,
  cveIds: true,
  severity: true,
  freshness: true,
  compatibility: true,
  cvssScore: true,
  currentVersion: true,
  latestVersion: true,
  lastUpdated: true,
  actions: true,
};

window.metricHistory = {
  critical: [],
  high: [],
  outdated: [],
  healthy: [],
};

// Global refresh timeout
if (typeof window.refreshTimeout === 'undefined') {
  window.refreshTimeout = null;
}

// Chart instances (will be initialized in dashboard-charts.js)
window.severityChartInstance = null;
window.freshnessChartInstance = null;

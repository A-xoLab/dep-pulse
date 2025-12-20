// DepPulse Dashboard - Chart Rendering
// Chart.js rendering functions for all dashboard charts

// Note: Chart.js must be loaded before this module
// Note: Uses state from dashboard-state.js and utils from dashboard-utils.js

// Chart data cache for lazy loading
const chartDataCache = {
  severity: null,
  freshness: null,
  cvss: null,
};

// Chart visibility observers
const chartObservers = new Map();

// Track which charts have been initialized
const initializedCharts = new Set();
var resizeTimeout = null;

/**
 * Get chart colors based on current theme
 * @param {boolean} isDark - Whether dark mode is active
 * @returns {Object} Color mappings for charts
 */
function getChartColors(isDark) {
  if (isDark) {
    return {
      critical: '#f87171', // Lighter red for dark mode
      high: '#fb923c', // Lighter orange for dark mode
      medium: '#fbbf24', // Lighter yellow for dark mode
      low: '#fde047', // Even lighter yellow for dark mode
      none: '#4ade80', // Lighter green for dark mode
      current: '#4ade80', // Lighter green for dark mode
      patch: '#bef264', // Lighter lime for dark mode
      minor: '#fbbf24', // Lighter yellow for dark mode
      major: '#fb923c', // Lighter orange for dark mode
      unmaintained: '#f87171', // Lighter red for dark mode
    };
  } else {
    return {
      critical: '#ef4444',
      high: '#f97316',
      medium: '#eab308',
      low: '#fbbf24',
      none: '#22c55e',
      current: '#22c55e',
      patch: '#a3e635',
      minor: '#eab308',
      major: '#f97316',
      unmaintained: '#ef4444',
    };
  }
}

/**
 * Check if dark mode is currently active
 * @returns {boolean} True if dark mode is active
 */
function isDarkMode() {
  return document.documentElement.classList.contains('dark');
}

/**
 * Initialize lazy loading for charts using Intersection Observer
 * Charts will only render when they become visible in the viewport
 */
function initializeLazyChartLoading() {
  if (chartObservers.size > 0) {
    // Already initialized
    return;
  }

  const chartConfigs = [
    { id: 'severity-chart', renderFn: () => renderSeverityChart(chartDataCache.severity) },
    { id: 'freshness-chart', renderFn: () => renderFreshnessChart(chartDataCache.freshness) },
    { id: 'cvss-chart', renderFn: () => renderCVSSChart(chartDataCache.cvss) },
  ];

  // Create Intersection Observer with 10% threshold
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          const chartId = entry.target.id;
          const config = chartConfigs.find((c) => c.id === chartId);
          if (config && !initializedCharts.has(chartId)) {
            // Render chart when it becomes visible
            initializedCharts.add(chartId);
            config.renderFn();
            // Unobserve after first render (chart will handle updates via direct calls)
            observer.unobserve(entry.target);
          }
        }
      });
    },
    {
      rootMargin: '50px', // Start loading 50px before chart enters viewport
      threshold: 0.1, // Trigger when 10% visible
    }
  );

  // Observe all chart elements
  chartConfigs.forEach((config) => {
    const element = document.getElementById(config.id);
    if (element) {
      chartObservers.set(config.id, observer);
      observer.observe(element);
    }
  });
}

/**
 * Render severity stacked bar chart using Chart.js
 * Supports lazy loading - will render immediately if element is visible, otherwise queues for lazy load
 * @param {Object} data - Severity data
 */
function renderSeverityChart(data) {
  // Store data in cache for lazy loading
  chartDataCache.severity = data;

  const chartEl = document.getElementById('severity-chart');
  if (!chartEl) return;
  chartEl.style.cursor = 'pointer';

  // If chart is already initialized, render immediately
  if (initializedCharts.has('severity-chart')) {
    // Chart already initialized, render immediately
  } else {
    // Check if chart is visible (for immediate rendering)
    const isVisible = chartEl.offsetParent !== null || chartEl.getBoundingClientRect().height > 0;

    // If not visible, queue for lazy loading
    if (!isVisible) {
      // Initialize lazy loading if not already done
      if (chartObservers.size === 0) {
        initializeLazyChartLoading();
      }
      return;
    }
    // Mark as initialized since we're rendering now
    initializedCharts.add('severity-chart');
  }

  // Destroy existing chart instance
  if (severityChartInstance) {
    severityChartInstance.destroy();
  }

  const isDark = isDarkMode();
  const colors = getChartColors(isDark);

  // Create gradient colors for each segment
  const ctx = chartEl.getContext('2d');

  const total = data.critical + data.high + data.medium + data.low + data.none;

  severityChartInstance = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: ['Severity Distribution'],
      datasets: [
        {
          label: 'Critical',
          data: [data.critical],
          backgroundColor: colors.critical,
          borderRadius: 4,
          barThickness: 40,
        },
        {
          label: 'High',
          data: [data.high],
          backgroundColor: colors.high,
          borderRadius: 4,
          barThickness: 40,
        },
        {
          label: 'Medium',
          data: [data.medium],
          backgroundColor: colors.medium,
          borderRadius: 4,
          barThickness: 40,
        },
        {
          label: 'Low',
          data: [data.low],
          backgroundColor: colors.low,
          borderRadius: 4,
          barThickness: 40,
        },
        {
          label: 'None',
          data: [data.none],
          backgroundColor: colors.none,
          borderRadius: 4,
          barThickness: 40,
        },
      ],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: true,
          position: 'bottom',
          labels: {
            color: isDark ? '#9ca3af' : '#4b5563',
            font: { size: 11 },
            padding: 8,
            usePointStyle: true,
            pointStyle: 'circle',
          },
        },
        tooltip: {
          backgroundColor: isDark ? '#1f2937' : '#ffffff',
          titleColor: isDark ? '#f3f4f6' : '#111827',
          bodyColor: isDark ? '#d1d5db' : '#4b5563',
          borderColor: isDark ? '#374151' : '#e5e7eb',
          borderWidth: 1,
          padding: 12,
          displayColors: true,
          callbacks: {
            label: (context) => {
              const value = context.parsed.x;
              const percentage = total > 0 ? ((value / total) * 100).toFixed(1) : 0;
              return `${context.dataset.label}: ${value} (${percentage}%)`;
            },
          },
        },
      },
      scales: {
        x: {
          stacked: true,
          display: false,
          grid: { display: false },
        },
        y: {
          stacked: true,
          display: false,
          grid: { display: false },
        },
      },
      onClick: (_event, elements) => {
        if (elements.length > 0) {
          const datasetIndex = elements[0].datasetIndex;
          const labels = ['critical', 'high', 'medium', 'low', 'none'];
          // applyChartFilter will be defined in dashboard-filters.js
          if (typeof applyChartFilter === 'function') {
            applyChartFilter('severity', labels[datasetIndex]);
          }
        }
      },
      animation: {
        duration: 750,
        easing: 'easeInOutQuart',
      },
    },
  });
}

/**
 * Render freshness bar chart using Chart.js
 * Supports lazy loading - will render immediately if element is visible, otherwise queues for lazy load
 * @param {Object} data - Freshness data
 */
function renderFreshnessChart(data) {
  // Store data in cache for lazy loading
  chartDataCache.freshness = data;

  const chartEl = document.getElementById('freshness-chart');
  if (!chartEl) return;
  chartEl.style.cursor = 'pointer';

  // If chart is already initialized, render immediately
  if (initializedCharts.has('freshness-chart')) {
    // Chart already initialized, render immediately
  } else {
    // Check if chart is visible (for immediate rendering)
    const isVisible = chartEl.offsetParent !== null || chartEl.getBoundingClientRect().height > 0;

    // If not visible, queue for lazy loading
    if (!isVisible) {
      // Initialize lazy loading if not already done
      if (chartObservers.size === 0) {
        initializeLazyChartLoading();
      }
      return;
    }
    // Mark as initialized since we're rendering now
    initializedCharts.add('freshness-chart');
  }

  // Destroy existing chart instance
  if (freshnessChartInstance) {
    freshnessChartInstance.destroy();
  }

  const isDark = isDarkMode();
  const colors = getChartColors(isDark);
  const ctx = chartEl.getContext('2d');

  freshnessChartInstance = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: ['Current', 'Patch', 'Minor', 'Major', 'Unmaint.'],
      datasets: [
        {
          label: 'Packages',
          data: [data.current, data.patch, data.minor, data.major, data.unmaintained],
          backgroundColor: [
            colors.current,
            colors.patch,
            colors.minor,
            colors.major,
            colors.unmaintained,
          ],
          borderRadius: 6,
          borderSkipped: false,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: false,
        },
        tooltip: {
          backgroundColor: isDark ? '#1f2937' : '#ffffff',
          titleColor: isDark ? '#f3f4f6' : '#111827',
          bodyColor: isDark ? '#d1d5db' : '#4b5563',
          borderColor: isDark ? '#374151' : '#e5e7eb',
          borderWidth: 1,
          padding: 12,
          displayColors: false,
          callbacks: {
            label: (context) => `${context.parsed.y} packages`,
          },
        },
      },
      scales: {
        x: {
          grid: {
            display: false,
          },
          ticks: {
            color: isDark ? '#9ca3af' : '#6b7280',
            font: { size: 11 },
          },
        },
        y: {
          beginAtZero: true,
          grid: {
            color: isDark ? '#374151' : '#e5e7eb',
            drawBorder: false,
          },
          ticks: {
            color: isDark ? '#9ca3af' : '#6b7280',
            font: { size: 11 },
            stepSize: 1,
          },
        },
      },
      onClick: (_event, elements) => {
        if (elements.length > 0) {
          const index = elements[0].index;
          const labels = ['current', 'patch', 'minor', 'major', 'unmaintained'];
          // applyChartFilter will be defined in dashboard-filters.js
          if (typeof applyChartFilter === 'function') {
            applyChartFilter('freshness', labels[index]);
          }
        }
      },
      animation: {
        duration: 750,
        easing: 'easeOutBounce',
      },
    },
  });
}

/**
 * Render CVSS score histogram using Chart.js
 * Supports lazy loading - will render immediately if element is visible, otherwise queues for lazy load
 * @param {Array} dependencies - Array of dependency objects
 */
function renderCVSSChart(dependencies) {
  if (!dependencies) return;

  // Store data in cache for lazy loading
  chartDataCache.cvss = dependencies;

  const chartEl = document.getElementById('cvss-chart');
  if (!chartEl) return;

  // If chart is already initialized, render immediately
  if (initializedCharts.has('cvss-chart')) {
    // Chart already initialized, render immediately
  } else {
    // Check if chart is visible (for immediate rendering)
    const isVisible = chartEl.offsetParent !== null || chartEl.getBoundingClientRect().height > 0;

    // If not visible, queue for lazy loading
    if (!isVisible) {
      // Initialize lazy loading if not already done
      if (chartObservers.size === 0) {
        initializeLazyChartLoading();
      }
      return;
    }
    // Mark as initialized since we're rendering now
    initializedCharts.add('cvss-chart');
  }

  // Destroy existing chart instance
  if (window.cvssChartInstance) {
    window.cvssChartInstance.destroy();
  }

  const isDark = isDarkMode();
  const ctx = chartEl.getContext('2d');

  // Group CVSS scores into ranges
  const ranges = {
    None: 0,
    '0-3': 0,
    '3-5': 0,
    '5-7': 0,
    '7-9': 0,
    '9-10': 0,
  };

  dependencies.forEach((dep) => {
    if (dep.cvssScore === null || dep.cvssScore === undefined) {
      ranges.None++;
    } else {
      const score = dep.cvssScore;
      if (score < 3) ranges['0-3']++;
      else if (score < 5) ranges['3-5']++;
      else if (score < 7) ranges['5-7']++;
      else if (score < 9) ranges['7-9']++;
      else ranges['9-10']++;
    }
  });

  window.cvssChartInstance = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: Object.keys(ranges),
      datasets: [
        {
          label: 'Packages',
          data: Object.values(ranges),
          backgroundColor: [
            isDark ? '#10b981' : '#34d399',
            isDark ? '#fbbf24' : '#fcd34d',
            isDark ? '#fb923c' : '#fca5a5',
            isDark ? '#f97316' : '#fb923c',
            isDark ? '#ef4444' : '#f87171',
            isDark ? '#dc2626' : '#ef4444',
          ],
          borderRadius: 6,
          borderSkipped: false,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: isDark ? '#1f2937' : '#ffffff',
          titleColor: isDark ? '#f3f4f6' : '#111827',
          bodyColor: isDark ? '#d1d5db' : '#4b5563',
          borderColor: isDark ? '#374151' : '#e5e7eb',
          borderWidth: 1,
          padding: 12,
          displayColors: false,
          callbacks: {
            label: (context) => `${context.parsed.y} packages`,
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: {
            color: isDark ? '#9ca3af' : '#6b7280',
            font: { size: 10 },
          },
        },
        y: {
          beginAtZero: true,
          grid: {
            color: isDark ? '#374151' : '#e5e7eb',
            drawBorder: false,
          },
          ticks: {
            color: isDark ? '#9ca3af' : '#6b7280',
            font: { size: 11 },
            stepSize: 1,
          },
        },
      },
      animation: {
        duration: 750,
        easing: 'easeInOutQuart',
      },
    },
  });
}

/**
 * Render health gauge using Chart.js doughnut chart
 * Supports lazy loading - will render immediately if element is visible, otherwise queues for lazy load
 * @param {number} score - Health score (0-100)
 */
/**
 * Hide chart skeleton (legacy function for compatibility)
 */
function _hideChartSkeleton() {
  // Chart skeleton functions removed - not used, we have full-screen loading overlay instead
}

// Handle window resize for charts (only register once)
if (!window.__depPulseResizeHandler) {
  window.__depPulseResizeHandler = true;
  // var resizeTimeout = null; // Moved to top level
  // Store resize listener reference for cleanup
  const resizeListener = () => {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
      if (severityChartInstance) severityChartInstance.resize();
      if (freshnessChartInstance) freshnessChartInstance.resize();
      if (window.cvssChartInstance) window.cvssChartInstance.resize();
    }, 300);
  };
  window.addEventListener('resize', resizeListener);
  // Store reference globally for cleanup if needed
  window.__depPulseResizeListener = resizeListener;
}

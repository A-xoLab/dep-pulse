/**
 * Utility functions for the DepPulse dashboard
 */

// Logger utility for webview
const Logger = {
  log: (message, ...args) => {
    if (window.isDevelopment) {
      console.log(`[DepPulse Webview] ${message}`, ...args);
    }
  },
  warn: (message, ...args) => {
    if (window.isDevelopment) {
      console.warn(`[DepPulse Webview] [WARN] ${message}`, ...args);
    }
  },
  error: (message, ...args) => {
    // Always log errors, or maybe conditionally?
    // For now, let's log errors even in production but maybe without the prefix if needed?
    // Or stick to the plan: suppress in production unless we want to send them to extension.
    // The plan said: "Logger.error might still send errors to extension for tracking even in production"
    // But for console output, let's respect isDevelopment for consistency,
    // OR allow errors to show up in console for debugging if something goes wrong in prod.
    // Let's suppress for now to be strict, as requested.
    if (window.isDevelopment) {
      console.error(`[DepPulse Webview] [ERROR] ${message}`, ...args);
    }
    // We can also send to extension if needed via vscode.postMessage
  },
};

// Expose Logger globally
window.Logger = Logger;

/**
 * Format a date string to a localized date string
 * @param {string} dateString - The ISO date string
 * @returns {string} The formatted date string
 */
function formatDate(dateString) {
  if (!dateString) return 'Unknown';
  try {
    const date = new Date(dateString);
    return date.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch (e) {
    Logger.error('Error formatting date', e);
    return dateString;
  }
}
window.formatDate = formatDate;

/**
 * Copy text to clipboard
 * @param {string} text - The text to copy
 */
function copyTextToClipboard(text) {
  if (!text) return;

  // Try using the Clipboard API
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).catch((err) => {
      Logger.warn('Failed to use Clipboard API', err);
      fallbackCopyTextToClipboard(text);
    });
  } else {
    fallbackCopyTextToClipboard(text);
  }
}
window.copyTextToClipboard = copyTextToClipboard;

/**
 * Fallback method to copy text to clipboard using document.execCommand
 * @param {string} text - The text to copy
 */
function fallbackCopyTextToClipboard(text) {
  const textArea = document.createElement('textarea');
  textArea.value = text;

  // Ensure the textarea is not visible
  textArea.style.position = 'fixed';
  textArea.style.left = '-9999px';
  textArea.style.top = '0';

  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();

  try {
    const successful = document.execCommand('copy');
    if (!successful) {
      Logger.warn('Fallback copy to clipboard failed');
    }
  } catch (err) {
    Logger.warn('Fallback copy to clipboard error', err);
  }

  document.body.removeChild(textArea);
}

/**
 * Debounce a function call
 * @param {Function} func - The function to debounce
 * @param {number} wait - The wait time in milliseconds
 * @returns {Function} The debounced function
 */
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}
window.debounce = debounce;

/**
 * Escape HTML special characters to prevent XSS
 * @param {string} unsafe - The unsafe string
 * @returns {string} The escaped string
 */
function escapeHtml(unsafe) {
  if (!unsafe) return '';
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
window.escapeHtml = escapeHtml;

/**
 * Escape string for use in HTML attributes
 * @param {string} unsafe - The unsafe string
 * @returns {string} The escaped string
 */
function escapeAttribute(unsafe) {
  if (!unsafe) return '';
  return String(unsafe)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
window.escapeAttribute = escapeAttribute;

/**
 * Normalize repository URL to a clean format
 * @param {string} url - The raw repository URL
 * @returns {string} The normalized URL
 */
function normalizeRepositoryUrl(url) {
  if (!url) return '';

  // Remove git+ prefix
  let cleanUrl = url.replace(/^git\+/, '');

  // Handle git:// protocol (convert to https://)
  cleanUrl = cleanUrl.replace(/^git:\/\//, 'https://');

  // Remove .git suffix
  cleanUrl = cleanUrl.replace(/\.git$/, '');

  // Handle ssh://git@github.com style
  cleanUrl = cleanUrl.replace(/^ssh:\/\/git@/, 'https://');

  // Handle git@github.com:user/repo style
  cleanUrl = cleanUrl.replace(/^git@([^:]+):/, 'https://$1/');

  return cleanUrl;
}
window.normalizeRepositoryUrl = normalizeRepositoryUrl;

/**
 * Format a date as a relative time string (e.g., "2 days ago")
 * @param {string} dateString - The date string to format
 * @returns {string} The relative time string
 */
function formatRelativeTime(dateString) {
  if (!dateString) return 'Unknown';

  try {
    const date = new Date(dateString);
    const now = new Date();
    const diffInSeconds = Math.floor((now - date) / 1000);

    if (diffInSeconds < 60) {
      return 'Just now';
    }

    const diffInMinutes = Math.floor(diffInSeconds / 60);
    if (diffInMinutes < 60) {
      return `${diffInMinutes} minute${diffInMinutes === 1 ? '' : 's'} ago`;
    }

    const diffInHours = Math.floor(diffInMinutes / 60);
    if (diffInHours < 24) {
      return `${diffInHours} hour${diffInHours === 1 ? '' : 's'} ago`;
    }

    const diffInDays = Math.floor(diffInHours / 24);
    if (diffInDays < 30) {
      return `${diffInDays} day${diffInDays === 1 ? '' : 's'} ago`;
    }

    const diffInMonths = Math.floor(diffInDays / 30);
    if (diffInMonths < 12) {
      return `${diffInMonths} month${diffInMonths === 1 ? '' : 's'} ago`;
    }

    const diffInYears = Math.floor(diffInDays / 365);
    return `${diffInYears} year${diffInYears === 1 ? '' : 's'} ago`;
  } catch (e) {
    Logger.error('Error formatting relative time', e);
    return dateString;
  }
}
window.formatRelativeTime = formatRelativeTime;

/**
 * Truncate text to a maximum length
 * @param {string} text - The text to truncate
 * @param {number} maxLength - The maximum length
 * @returns {string} The truncated text
 */
function truncateText(text, maxLength) {
  if (!text || text.length <= maxLength) return text;
  return `${text.substring(0, maxLength)}...`;
}
window.truncateText = truncateText;

/**
 * Convert URLs in text to clickable links
 * @param {string} text - The text that may contain URLs
 * @returns {string} The text with URLs converted to HTML links
 */
function linkifyText(text) {
  if (!text) return '';

  // URL regex pattern - matches http(s):// URLs
  const urlRegex = /(https?:\/\/[^\s]+)/g;

  // Escape HTML to prevent XSS
  const escapedText = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

  // Replace URLs with clickable links
  return escapedText.replace(urlRegex, (url) => {
    return `<a href="${url}" target="_blank" rel="noopener noreferrer" class="text-blue-600 dark:text-blue-400 hover:underline">${url}</a>`;
  });
}
window.linkifyText = linkifyText;

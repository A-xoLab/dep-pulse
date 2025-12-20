import type { OSVBatchResponse, OSVVulnerability } from '../../types';

/**
 * Mock OSV API responses for testing
 * These mocks simulate realistic OSV.dev API responses without making real network calls
 */

/**
 * Creates a mock OSV batch response with vulnerabilities for specified packages
 */
export function createMockOSVResponse(
  packageNames: string[],
  vulnerabilities: Record<string, OSVVulnerability[]>
): OSVBatchResponse {
  return {
    results: packageNames.map((packageName) => ({
      vulns: vulnerabilities[packageName] || [],
    })),
  };
}

/**
 * Creates an empty OSV response (no vulnerabilities)
 */
export function createEmptyOSVResponse(packageCount: number): OSVBatchResponse {
  return {
    results: Array.from({ length: packageCount }, () => ({
      vulns: [],
    })),
  };
}

/**
 * Mock vulnerability for lodash 4.17.20 (known vulnerable version)
 */
export function createLodashVulnerability(): OSVVulnerability {
  return {
    id: 'GHSA-p6mc-m468-83mg',
    summary: 'Prototype Pollution in lodash',
    details:
      'Versions of lodash before 4.17.21 are vulnerable to Prototype Pollution. The function defaultsDeep could be tricked into adding or modifying properties of Object.prototype using a constructor payload.',
    aliases: ['CVE-2021-23337'],
    modified: '2021-03-08T20:03:00Z',
    published: '2021-02-19T20:00:00Z',
    database_specific: {
      severity: 'HIGH',
      cwe_ids: ['CWE-1321'],
      github_reviewed: true,
    },
    severity: [
      {
        type: 'CVSS_V3',
        score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:L/A:L',
      },
    ],
    affected: [
      {
        package: {
          name: 'lodash',
          ecosystem: 'npm',
        },
        ranges: [
          {
            type: 'SEMVER',
            events: [
              {
                introduced: '0.0.0',
              },
              {
                fixed: '4.17.21',
              },
            ],
          },
        ],
      },
    ],
    references: [
      {
        type: 'ADVISORY',
        url: 'https://github.com/advisories/GHSA-p6mc-m468-83mg',
      },
      {
        type: 'FIX',
        url: 'https://github.com/lodash/lodash/pull/5081',
      },
    ],
  };
}

/**
 * Mock vulnerability for axios 0.21.1 (known vulnerable version)
 */
export function createAxiosVulnerability(): OSVVulnerability {
  return {
    id: 'GHSA-4w2v-q235-vp99',
    summary: 'Server-Side Request Forgery in axios',
    details:
      'Versions of axios before 0.21.1 are vulnerable to Server-Side Request Forgery (SSRF). An attacker can make the application send arbitrary HTTP requests to an arbitrary domain.',
    aliases: ['CVE-2021-3749'],
    modified: '2021-08-12T14:00:00Z',
    published: '2021-08-05T12:00:00Z',
    database_specific: {
      severity: 'HIGH',
      cwe_ids: ['CWE-918'],
      github_reviewed: true,
    },
    severity: [
      {
        type: 'CVSS_V3',
        score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
      },
    ],
    affected: [
      {
        package: {
          name: 'axios',
          ecosystem: 'npm',
        },
        ranges: [
          {
            type: 'SEMVER',
            events: [
              {
                introduced: '0.0.0',
              },
              {
                fixed: '0.21.1',
              },
            ],
          },
        ],
      },
    ],
    references: [
      {
        type: 'ADVISORY',
        url: 'https://github.com/advisories/GHSA-4w2v-q235-vp99',
      },
    ],
  };
}

/**
 * Mock vulnerability for @babel/core (scoped package example)
 */
export function createBabelVulnerability(): OSVVulnerability {
  return {
    id: 'GHSA-7v2p-p53q-7h4c',
    summary: 'Arbitrary Code Execution in @babel/core',
    details:
      'Versions of @babel/core before 7.12.0 are vulnerable to arbitrary code execution when processing maliciously crafted input.',
    aliases: ['CVE-2020-15168'],
    modified: '2020-10-07T12:00:00Z',
    published: '2020-10-01T12:00:00Z',
    database_specific: {
      severity: 'CRITICAL',
      cwe_ids: ['CWE-94'],
      github_reviewed: true,
    },
    severity: [
      {
        type: 'CVSS_V3',
        score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
      },
    ],
    affected: [
      {
        package: {
          name: '@babel/core',
          ecosystem: 'npm',
        },
        ranges: [
          {
            type: 'SEMVER',
            events: [
              {
                introduced: '0.0.0',
              },
              {
                fixed: '7.12.0',
              },
            ],
          },
        ],
      },
    ],
    references: [
      {
        type: 'ADVISORY',
        url: 'https://github.com/advisories/GHSA-7v2p-p53q-7h4c',
      },
    ],
  };
}

/**
 * Creates a mock response for a batch of packages with mixed vulnerabilities
 */
export function createMixedBatchResponse(packageNames: string[]): OSVBatchResponse {
  const vulnerabilities: Record<string, OSVVulnerability[]> = {};

  // Add vulnerabilities for known vulnerable packages
  if (packageNames.includes('lodash')) {
    vulnerabilities.lodash = [createLodashVulnerability()];
  }
  if (packageNames.includes('axios')) {
    vulnerabilities.axios = [createAxiosVulnerability()];
  }
  if (packageNames.includes('@babel/core')) {
    vulnerabilities['@babel/core'] = [createBabelVulnerability()];
  }

  // All other packages have no vulnerabilities
  return createMockOSVResponse(packageNames, vulnerabilities);
}

/**
 * Creates a mock response for a large batch (e.g., 50, 100, 150 packages)
 * Most packages have no vulnerabilities, a few have vulnerabilities
 */
export function createLargeBatchResponse(packageNames: string[]): OSVBatchResponse {
  const vulnerabilities: Record<string, OSVVulnerability[]> = {};

  // Add vulnerabilities to first 2-3 packages as examples
  if (packageNames.length > 0) {
    vulnerabilities[packageNames[0]] = [createLodashVulnerability()];
  }
  if (packageNames.length > 1) {
    vulnerabilities[packageNames[1]] = [createAxiosVulnerability()];
  }

  // All other packages have no vulnerabilities
  return createMockOSVResponse(packageNames, vulnerabilities);
}

/**
 * Mock vulnerability for vulnerable-pkg (used in integration tests)
 */
export function createVulnerablePkgVulnerability(): OSVVulnerability {
  return {
    id: 'GHSA-test-vulnerable-pkg',
    summary: 'Critical Vulnerability in vulnerable-pkg',
    details: 'Versions of vulnerable-pkg before 2.0.0 are vulnerable to a critical security issue.',
    aliases: ['CVE-2021-1234'],
    modified: '2021-01-15T12:00:00Z',
    published: '2021-01-10T12:00:00Z',
    database_specific: {
      severity: 'CRITICAL',
      cwe_ids: ['CWE-79'],
      github_reviewed: true,
    },
    severity: [
      {
        type: 'CVSS_V3',
        score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
      },
    ],
    affected: [
      {
        package: {
          name: 'vulnerable-pkg',
          ecosystem: 'npm',
        },
        ranges: [
          {
            type: 'SEMVER',
            events: [
              {
                introduced: '0.0.0',
                fixed: '2.0.0',
              },
            ],
          },
        ],
      },
    ],
    references: [
      {
        type: 'ADVISORY',
        url: 'https://github.com/advisories/GHSA-test-vulnerable-pkg',
      },
    ],
  };
}

/**
 * Creates a mock individual query response (for /v1/query endpoint)
 * This is what getVulnerabilitiesIndividual actually uses
 */
export function createMockIndividualResponse(
  packageName: string,
  hasVulnerabilities: boolean = false
): { vulns?: OSVVulnerability[] } {
  if (!hasVulnerabilities) {
    return { vulns: [] };
  }

  // Return appropriate vulnerability based on package name
  if (packageName === 'lodash') {
    return { vulns: [createLodashVulnerability()] };
  }
  if (packageName === 'axios') {
    return { vulns: [createAxiosVulnerability()] };
  }
  if (packageName === '@babel/core') {
    return { vulns: [createBabelVulnerability()] };
  }
  if (packageName === 'vulnerable-pkg') {
    return { vulns: [createVulnerablePkgVulnerability()] };
  }

  // Default: no vulnerabilities
  return { vulns: [] };
}

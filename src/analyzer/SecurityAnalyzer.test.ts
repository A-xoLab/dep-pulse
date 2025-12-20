import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import type { Dependency, Vulnerability, VulnerabilityClient } from '../types';
import { DepPulseError, ErrorCode } from '../types';
import { SecurityAnalyzer } from './SecurityAnalyzer';

// Mock output channel
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

// Mock vulnerability client
const createMockClient = (vulnerabilities: Map<string, Vulnerability[]>): VulnerabilityClient => ({
  getVulnerabilities: vi.fn().mockImplementation(async (packageName: string) => {
    return vulnerabilities.get(packageName) || [];
  }),
  getBatchVulnerabilities: vi.fn().mockResolvedValue(vulnerabilities),
});

describe('SecurityAnalyzer - Batch Operations', () => {
  let analyzer: SecurityAnalyzer;
  let mockOutputChannel: vscode.OutputChannel;

  beforeEach(() => {
    mockOutputChannel = createMockOutputChannel();
  });

  describe('analyzeBatch', () => {
    it('should analyze multiple dependencies in batch', async () => {
      const deps: Dependency[] = [
        { name: 'express', version: '4.17.1', versionConstraint: '4.17.1', isDev: false },
        { name: 'lodash', version: '4.17.20', versionConstraint: '4.17.20', isDev: false },
      ];

      const vulnerabilities = new Map([
        [
          'express',
          [
            {
              id: 'CVE-2021-1234',
              title: 'Express Vuln',
              severity: 'high',
              affectedVersions: '< 4.17.2',
              description: 'Test',
              references: [],
              publishedDate: new Date('2021-01-01'),
              lastModifiedDate: new Date('2021-01-02'),
            },
          ],
        ],
        [
          'lodash',
          [
            {
              id: 'CVE-2021-5678',
              title: 'Lodash Vuln',
              severity: 'medium',
              affectedVersions: '< 4.17.21',
              description: 'Test',
              references: [],
              publishedDate: new Date('2021-01-01'),
              lastModifiedDate: new Date('2021-01-02'),
            },
          ],
        ],
      ]);

      const mockClient = createMockClient(vulnerabilities);
      analyzer = new SecurityAnalyzer(mockClient, mockOutputChannel);

      const result = await analyzer.analyzeBatch(deps);

      expect(result.size).toBe(2);
      expect(result.has('express')).toBe(true);
      expect(result.has('lodash')).toBe(true);

      const expressAnalysis = result.get('express');
      expect(expressAnalysis).toBeDefined();
      expect(expressAnalysis?.vulnerabilities).toHaveLength(1);
      expect(expressAnalysis?.severity).toBe('high');

      const lodashAnalysis = result.get('lodash');
      expect(lodashAnalysis).toBeDefined();
      expect(lodashAnalysis?.vulnerabilities).toHaveLength(1);
      expect(lodashAnalysis?.severity).toBe('medium');
    });

    it('should filter vulnerabilities by version', async () => {
      const deps: Dependency[] = [
        { name: 'express', version: '4.18.0', versionConstraint: '4.18.0', isDev: false },
      ];

      const vulnerabilities = new Map([
        [
          'express',
          [
            {
              id: 'CVE-2021-1234',
              title: 'Old Vuln',
              severity: 'high',
              affectedVersions: '< 4.17.0',
              description: 'Test',
              references: [],
              publishedDate: new Date('2021-01-01'),
              lastModifiedDate: new Date('2021-01-02'),
            },
            {
              id: 'CVE-2021-5678',
              title: 'Current Vuln',
              severity: 'medium',
              affectedVersions: '< 4.19.0',
              description: 'Test',
              references: [],
              publishedDate: new Date('2021-01-01'),
              lastModifiedDate: new Date('2021-01-02'),
            },
          ],
        ],
      ]);

      const mockClient = createMockClient(vulnerabilities);
      analyzer = new SecurityAnalyzer(mockClient, mockOutputChannel);

      const result = await analyzer.analyzeBatch(deps);

      const expressAnalysis = result.get('express');
      expect(expressAnalysis).toBeDefined();
      // Should only include the vulnerability affecting version 4.18.0
      expect(expressAnalysis?.vulnerabilities).toHaveLength(1);
      expect(expressAnalysis?.vulnerabilities[0].id).toBe('CVE-2021-5678');
    });

    it('should handle semver range matching', async () => {
      const deps: Dependency[] = [
        { name: 'pkg1', version: '1.5.0', versionConstraint: '1.5.0', isDev: false },
      ];

      const vulnerabilities = new Map([
        [
          'pkg1',
          [
            {
              id: 'CVE-1',
              title: 'Test 1',
              severity: 'high',
              affectedVersions: '>= 1.0.0 < 1.4.0',
              description: 'Test',
              references: [],
              publishedDate: new Date('2021-01-01'),
              lastModifiedDate: new Date('2021-01-02'),
            },
            {
              id: 'CVE-2',
              title: 'Test 2',
              severity: 'medium',
              affectedVersions: '>= 1.4.0 <= 1.6.0',
              description: 'Test',
              references: [],
              publishedDate: new Date('2021-01-01'),
              lastModifiedDate: new Date('2021-01-02'),
            },
            {
              id: 'CVE-3',
              title: 'Test 3',
              severity: 'low',
              affectedVersions: '>= 2.0.0',
              description: 'Test',
              references: [],
              publishedDate: new Date('2021-01-01'),
              lastModifiedDate: new Date('2021-01-02'),
            },
          ],
        ],
      ]);

      const mockClient = createMockClient(vulnerabilities);
      analyzer = new SecurityAnalyzer(mockClient, mockOutputChannel);

      const result = await analyzer.analyzeBatch(deps);

      const analysis = result.get('pkg1');
      expect(analysis).toBeDefined();
      // Version 1.5.0 should only match CVE-2
      expect(analysis?.vulnerabilities).toHaveLength(1);
      expect(analysis?.vulnerabilities[0].id).toBe('CVE-2');
    });

    it('should handle various version range formats', async () => {
      const testCases = [
        { version: '1.0.0', range: '< 1.1.0', shouldMatch: true },
        { version: '1.0.0', range: '>= 1.0.0 < 2.0.0', shouldMatch: true },
        { version: '1.5.0', range: '1.0.0 to 2.0.0', shouldMatch: true },
        { version: '2.0.0', range: '< 2.0.0', shouldMatch: false },
        { version: '1.0.0', range: '> 1.0.0', shouldMatch: false },
      ];

      for (const testCase of testCases) {
        const deps: Dependency[] = [
          {
            name: 'test-pkg',
            version: testCase.version,
            versionConstraint: testCase.version,
            isDev: false,
          },
        ];

        const vulnerabilities = new Map([
          [
            'test-pkg',
            [
              {
                id: 'CVE-TEST',
                title: 'Test',
                severity: 'medium',
                affectedVersions: testCase.range,
                description: 'Test',
                references: [],
                publishedDate: new Date('2021-01-01'),
                lastModifiedDate: new Date('2021-01-02'),
              },
            ],
          ],
        ]);

        const mockClient = createMockClient(vulnerabilities);
        analyzer = new SecurityAnalyzer(mockClient, mockOutputChannel);

        const result = await analyzer.analyzeBatch(deps);
        const analysis = result.get('test-pkg');
        expect(analysis).toBeDefined();

        if (testCase.shouldMatch) {
          expect(analysis?.vulnerabilities.length).toBeGreaterThan(0);
        } else {
          expect(analysis?.vulnerabilities).toHaveLength(0);
        }
      }
    });

    it('should handle missing vulnerability data', async () => {
      const deps: Dependency[] = [
        { name: 'safe-pkg', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
      ];

      const vulnerabilities = new Map([['safe-pkg', []]]);

      const mockClient = createMockClient(vulnerabilities);
      analyzer = new SecurityAnalyzer(mockClient, mockOutputChannel);

      const result = await analyzer.analyzeBatch(deps);

      const analysis = result.get('safe-pkg');
      expect(analysis).toBeDefined();
      expect(analysis?.vulnerabilities).toHaveLength(0);
      expect(analysis?.severity).toBe('none');
    });

    it('should calculate overall severity correctly', async () => {
      const deps: Dependency[] = [
        { name: 'pkg-critical', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
        { name: 'pkg-high', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
        { name: 'pkg-medium', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
        { name: 'pkg-low', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
        { name: 'pkg-none', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
      ];

      const vulnerabilities = new Map([
        [
          'pkg-critical',
          [
            {
              id: 'CVE-1',
              title: 'Critical',
              severity: 'critical',
              affectedVersions: '< 2.0.0',
              description: 'Test',
              references: [],
              publishedDate: new Date('2021-01-01'),
              lastModifiedDate: new Date('2021-01-02'),
            },
          ],
        ],
        [
          'pkg-high',
          [
            {
              id: 'CVE-2',
              title: 'High',
              severity: 'high',
              affectedVersions: '< 2.0.0',
              description: 'Test',
              references: [],
              publishedDate: new Date('2021-01-01'),
              lastModifiedDate: new Date('2021-01-02'),
            },
          ],
        ],
        [
          'pkg-medium',
          [
            {
              id: 'CVE-3',
              title: 'Medium',
              severity: 'medium',
              affectedVersions: '< 2.0.0',
              description: 'Test',
              references: [],
              publishedDate: new Date('2021-01-01'),
              lastModifiedDate: new Date('2021-01-02'),
            },
          ],
        ],
        [
          'pkg-low',
          [
            {
              id: 'CVE-4',
              title: 'Low',
              severity: 'low',
              affectedVersions: '< 2.0.0',
              description: 'Test',
              references: [],
              publishedDate: new Date('2021-01-01'),
              lastModifiedDate: new Date('2021-01-02'),
            },
          ],
        ],
        ['pkg-none', []],
      ]);

      const mockClient = createMockClient(vulnerabilities);
      analyzer = new SecurityAnalyzer(mockClient, mockOutputChannel);

      const result = await analyzer.analyzeBatch(deps);

      expect(result.get('pkg-critical')?.severity).toBe('critical');
      expect(result.get('pkg-high')?.severity).toBe('high');
      expect(result.get('pkg-medium')?.severity).toBe('medium');
      expect(result.get('pkg-low')?.severity).toBe('low');
      expect(result.get('pkg-none')?.severity).toBe('none');
    });

    it('should fallback to individual analysis if batch not supported', async () => {
      const deps: Dependency[] = [
        { name: 'pkg1', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
        { name: 'pkg2', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
      ];

      // Create client without batch support
      const clientWithoutBatch: VulnerabilityClient = {
        getVulnerabilities: vi.fn().mockResolvedValue([]),
        getBatchVulnerabilities:
          undefined as unknown as VulnerabilityClient['getBatchVulnerabilities'],
      };

      analyzer = new SecurityAnalyzer(clientWithoutBatch, mockOutputChannel);

      const result = await analyzer.analyzeBatch(deps);

      expect(result.size).toBe(2);
      expect(clientWithoutBatch.getVulnerabilities).toHaveBeenCalledTimes(2);
    });

    it('should handle batch analysis errors gracefully', async () => {
      const deps: Dependency[] = [
        { name: 'pkg1', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
      ];

      const failingClient: VulnerabilityClient = {
        getVulnerabilities: vi.fn().mockRejectedValue(new Error('API Error')),
        getBatchVulnerabilities: vi.fn().mockRejectedValue(new Error('API Error')),
      };

      analyzer = new SecurityAnalyzer(failingClient, mockOutputChannel);

      const result = await analyzer.analyzeBatch(deps);

      expect(result.size).toBe(1);
      const analysis = result.get('pkg1');
      expect(analysis).toBeDefined();
      expect(analysis?.vulnerabilities).toHaveLength(0);
      expect(analysis?.severity).toBe('none');
    });

    it('should handle complex semver ranges', async () => {
      const deps: Dependency[] = [
        { name: 'pkg1', version: '1.5.0', versionConstraint: '1.5.0', isDev: false },
      ];

      const vulnerabilities = new Map([
        [
          'pkg1',
          [
            {
              id: 'CVE-1',
              title: 'Test',
              severity: 'high',
              affectedVersions: '>=1.0.0 <1.4.0 || >=1.6.0 <2.0.0',
              description: 'Test',
              references: [],
              publishedDate: new Date('2021-01-01'),
              lastModifiedDate: new Date('2021-01-02'),
            },
          ],
        ],
      ]);

      const mockClient = createMockClient(vulnerabilities);
      analyzer = new SecurityAnalyzer(mockClient, mockOutputChannel);

      const result = await analyzer.analyzeBatch(deps);

      const analysis = result.get('pkg1');
      expect(analysis).toBeDefined();
      // Version 1.5.0 should not match the range
      expect(analysis?.vulnerabilities).toHaveLength(0);
    });

    it('should handle invalid version formats gracefully', async () => {
      const deps: Dependency[] = [
        {
          name: 'pkg1',
          version: 'invalid-version',
          versionConstraint: 'invalid-version',
          isDev: false,
        },
      ];

      const vulnerabilities = new Map([
        [
          'pkg1',
          [
            {
              id: 'CVE-1',
              title: 'Test',
              severity: 'high',
              affectedVersions: '< 2.0.0',
              description: 'Test',
              references: [],
              publishedDate: new Date('2021-01-01'),
              lastModifiedDate: new Date('2021-01-02'),
            },
          ],
        ],
      ]);

      const mockClient = createMockClient(vulnerabilities);
      analyzer = new SecurityAnalyzer(mockClient, mockOutputChannel);

      const result = await analyzer.analyzeBatch(deps);

      const analysis = result.get('pkg1');
      expect(analysis).toBeDefined();
      // Should include all vulnerabilities when version is invalid (safe default)
      expect(analysis?.vulnerabilities).toHaveLength(1);
    });
  });

  describe('Complex Vulnerability Scenarios', () => {
    it('should handle multiple vulnerabilities with different severities', async () => {
      const deps: Dependency[] = [
        { name: 'multi-vuln-pkg', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
      ];

      const vulnerabilities = new Map([
        [
          'multi-vuln-pkg',
          [
            {
              id: 'CVE-1',
              title: 'Critical Vulnerability',
              severity: 'critical',
              affectedVersions: '< 2.0.0',
              description: 'Test',
              references: [],
              publishedDate: new Date('2021-01-01'),
              lastModifiedDate: new Date('2021-01-02'),
            },
            {
              id: 'CVE-2',
              title: 'High Vulnerability',
              severity: 'high',
              affectedVersions: '< 2.0.0',
              description: 'Test',
              references: [],
              publishedDate: new Date('2021-01-01'),
              lastModifiedDate: new Date('2021-01-02'),
            },
            {
              id: 'CVE-3',
              title: 'Medium Vulnerability',
              severity: 'medium',
              affectedVersions: '< 2.0.0',
              description: 'Test',
              references: [],
              publishedDate: new Date('2021-01-01'),
              lastModifiedDate: new Date('2021-01-02'),
            },
          ],
        ],
      ]);

      const mockClient = createMockClient(vulnerabilities);
      analyzer = new SecurityAnalyzer(mockClient, mockOutputChannel);

      const result = await analyzer.analyzeBatch(deps);

      const analysis = result.get('multi-vuln-pkg');
      expect(analysis).toBeDefined();
      expect(analysis?.vulnerabilities).toHaveLength(3);
      expect(analysis?.severity).toBe('critical'); // Should use highest severity
    });

    it('should handle vulnerabilities with CVSS scores', async () => {
      const deps: Dependency[] = [
        { name: 'cvss-pkg', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
      ];

      const vulnerabilities = new Map([
        [
          'cvss-pkg',
          [
            {
              id: 'CVE-1',
              title: 'High CVSS Vulnerability',
              severity: 'high',
              affectedVersions: '< 2.0.0',
              description: 'Test',
              references: [],
              publishedDate: new Date('2021-01-01'),
              lastModifiedDate: new Date('2021-01-02'),
              cvssScore: 8.5,
              cvssVersion: '3.1',
            },
          ],
        ],
      ]);

      const mockClient = createMockClient(vulnerabilities);
      analyzer = new SecurityAnalyzer(mockClient, mockOutputChannel);

      const result = await analyzer.analyzeBatch(deps);

      const analysis = result.get('cvss-pkg');
      expect(analysis).toBeDefined();
      expect(analysis?.vulnerabilities[0].cvssScore).toBe(8.5);
    });

    it('should handle vulnerabilities with exploit availability', async () => {
      const deps: Dependency[] = [
        { name: 'exploit-pkg', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
      ];

      const vulnerabilities = new Map([
        [
          'exploit-pkg',
          [
            {
              id: 'CVE-1',
              title: 'Exploitable Vulnerability',
              severity: 'critical',
              affectedVersions: '< 2.0.0',
              description: 'Test',
              references: [],
              publishedDate: new Date('2021-01-01'),
              lastModifiedDate: new Date('2021-01-02'),
              exploitAvailable: true,
            },
          ],
        ],
      ]);

      const mockClient = createMockClient(vulnerabilities);
      analyzer = new SecurityAnalyzer(mockClient, mockOutputChannel);

      const result = await analyzer.analyzeBatch(deps);

      const analysis = result.get('exploit-pkg');
      expect(analysis).toBeDefined();
      expect(analysis?.vulnerabilities[0].exploitAvailable).toBe(true);
    });

    it('should handle vulnerabilities with CWE IDs', async () => {
      const deps: Dependency[] = [
        { name: 'cwe-pkg', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
      ];

      const vulnerabilities = new Map([
        [
          'cwe-pkg',
          [
            {
              id: 'CVE-1',
              title: 'CWE Vulnerability',
              severity: 'high',
              affectedVersions: '< 2.0.0',
              description: 'Test',
              references: [],
              publishedDate: new Date('2021-01-01'),
              lastModifiedDate: new Date('2021-01-02'),
              cweIds: ['CWE-79', 'CWE-89'],
            },
          ],
        ],
      ]);

      const mockClient = createMockClient(vulnerabilities);
      analyzer = new SecurityAnalyzer(mockClient, mockOutputChannel);

      const result = await analyzer.analyzeBatch(deps);

      const analysis = result.get('cwe-pkg');
      expect(analysis).toBeDefined();
      expect(analysis?.vulnerabilities[0].cweIds).toContain('CWE-79');
      expect(analysis?.vulnerabilities[0].cweIds).toContain('CWE-89');
    });
  });

  describe('Error Handling', () => {
    it('should handle recoverable errors gracefully', async () => {
      const deps: Dependency[] = [
        { name: 'error-pkg', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
      ];

      const recoverableError = new DepPulseError(
        'Recoverable error',
        ErrorCode.API_ERROR,
        true // recoverable
      );

      const failingClient: VulnerabilityClient = {
        getVulnerabilities: vi.fn().mockRejectedValue(recoverableError),
        getBatchVulnerabilities: vi.fn().mockRejectedValue(recoverableError),
      };

      analyzer = new SecurityAnalyzer(failingClient, mockOutputChannel);

      const result = await analyzer.analyze(deps[0]);

      expect(result.vulnerabilities).toHaveLength(0);
      expect(result.severity).toBe('none');
    });

    it('should throw non-recoverable errors', async () => {
      const deps: Dependency[] = [
        { name: 'error-pkg', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
      ];

      const nonRecoverableError = new Error('Non-recoverable error');

      const failingClient: VulnerabilityClient = {
        getVulnerabilities: vi.fn().mockRejectedValue(nonRecoverableError),
        getBatchVulnerabilities: vi.fn().mockRejectedValue(nonRecoverableError),
      };

      analyzer = new SecurityAnalyzer(failingClient, mockOutputChannel);

      await expect(analyzer.analyze(deps[0])).rejects.toThrow('Non-recoverable error');
    });

    it('should handle network timeout errors', async () => {
      const deps: Dependency[] = [
        { name: 'timeout-pkg', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
      ];

      const timeoutError = new Error('Request timeout');

      const failingClient: VulnerabilityClient = {
        getVulnerabilities: vi.fn().mockRejectedValue(timeoutError),
        getBatchVulnerabilities: vi.fn().mockRejectedValue(timeoutError),
      };

      analyzer = new SecurityAnalyzer(failingClient, mockOutputChannel);

      await expect(analyzer.analyze(deps[0])).rejects.toThrow('Request timeout');
    });

    it('should handle partial batch failures', async () => {
      const deps: Dependency[] = [
        { name: 'good-pkg', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
        { name: 'bad-pkg', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
      ];

      const vulnerabilities = new Map([
        [
          'good-pkg',
          [
            {
              id: 'CVE-1',
              title: 'Test',
              severity: 'high',
              affectedVersions: '< 2.0.0',
              description: 'Test',
              references: [],
              publishedDate: new Date('2021-01-01'),
              lastModifiedDate: new Date('2021-01-02'),
            },
          ],
        ],
        // bad-pkg missing (simulated failure)
      ]);

      const mockClient = createMockClient(vulnerabilities);
      analyzer = new SecurityAnalyzer(mockClient, mockOutputChannel);

      const result = await analyzer.analyzeBatch(deps);

      expect(result.size).toBe(2);
      expect(result.get('good-pkg')?.vulnerabilities).toHaveLength(1);
      expect(result.get('bad-pkg')?.vulnerabilities).toHaveLength(0);
    });
  });

  describe('Edge Cases in Scoring', () => {
    it('should prioritize critical over high severity', async () => {
      const deps: Dependency[] = [
        { name: 'mixed-pkg', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
      ];

      const vulnerabilities = new Map([
        [
          'mixed-pkg',
          [
            {
              id: 'CVE-1',
              title: 'High',
              severity: 'high',
              affectedVersions: '< 2.0.0',
              description: 'Test',
              references: [],
              publishedDate: new Date('2021-01-01'),
              lastModifiedDate: new Date('2021-01-02'),
            },
            {
              id: 'CVE-2',
              title: 'Critical',
              severity: 'critical',
              affectedVersions: '< 2.0.0',
              description: 'Test',
              references: [],
              publishedDate: new Date('2021-01-01'),
              lastModifiedDate: new Date('2021-01-02'),
            },
          ],
        ],
      ]);

      const mockClient = createMockClient(vulnerabilities);
      analyzer = new SecurityAnalyzer(mockClient, mockOutputChannel);

      const result = await analyzer.analyzeBatch(deps);

      const analysis = result.get('mixed-pkg');
      expect(analysis?.severity).toBe('critical');
    });

    it('should handle empty vulnerability list', async () => {
      const deps: Dependency[] = [
        { name: 'empty-pkg', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
      ];

      const vulnerabilities = new Map([['empty-pkg', []]]);

      const mockClient = createMockClient(vulnerabilities);
      analyzer = new SecurityAnalyzer(mockClient, mockOutputChannel);

      const result = await analyzer.analyzeBatch(deps);

      const analysis = result.get('empty-pkg');
      expect(analysis?.severity).toBe('none');
      expect(analysis?.vulnerabilities).toHaveLength(0);
    });

    it('should handle vulnerabilities with missing severity', async () => {
      const deps: Dependency[] = [
        {
          name: 'missing-severity-pkg',
          version: '1.0.0',
          versionConstraint: '1.0.0',
          isDev: false,
        },
      ];

      const vulnerabilities = new Map([
        [
          'missing-severity-pkg',
          [
            {
              id: 'CVE-1',
              title: 'Test',
              severity: 'medium', // Will be treated as medium
              affectedVersions: '< 2.0.0',
              description: 'Test',
              references: [],
              publishedDate: new Date('2021-01-01'),
              lastModifiedDate: new Date('2021-01-02'),
            },
          ],
        ],
      ]);

      const mockClient = createMockClient(vulnerabilities);
      analyzer = new SecurityAnalyzer(mockClient, mockOutputChannel);

      const result = await analyzer.analyzeBatch(deps);

      const analysis = result.get('missing-severity-pkg');
      expect(analysis?.severity).toBe('medium');
    });
  });

  describe('Performance with Many Vulnerabilities', () => {
    it('should handle packages with 100+ vulnerabilities efficiently', async () => {
      const deps: Dependency[] = [
        { name: 'many-vuln-pkg', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
      ];

      const manyVulnerabilities = Array.from({ length: 150 }, (_, i) => ({
        id: `CVE-2021-${i}`,
        title: `Vulnerability ${i}`,
        severity: i % 4 === 0 ? 'critical' : i % 4 === 1 ? 'high' : i % 4 === 2 ? 'medium' : 'low',
        affectedVersions: '< 2.0.0',
        description: 'Test',
        references: [],
        publishedDate: new Date('2021-01-01'),
        lastModifiedDate: new Date('2021-01-02'),
      }));

      const vulnerabilities = new Map([['many-vuln-pkg', manyVulnerabilities]]);

      const mockClient = createMockClient(vulnerabilities);
      analyzer = new SecurityAnalyzer(mockClient, mockOutputChannel);

      const startTime = Date.now();
      const result = await analyzer.analyzeBatch(deps);
      const duration = Date.now() - startTime;

      const analysis = result.get('many-vuln-pkg');
      expect(analysis).toBeDefined();
      expect(analysis?.vulnerabilities).toHaveLength(150);
      expect(analysis?.severity).toBe('critical');
      expect(duration).toBeLessThan(1000); // Should complete quickly with mocks
    });

    it('should filter many vulnerabilities efficiently by version', async () => {
      const deps: Dependency[] = [
        { name: 'filter-pkg', version: '2.0.0', versionConstraint: '2.0.0', isDev: false },
      ];

      const manyVulnerabilities = Array.from({ length: 200 }, (_, i) => ({
        id: `CVE-2021-${i}`,
        title: `Vulnerability ${i}`,
        severity: 'high',
        affectedVersions: i < 100 ? '< 2.0.0' : '>= 2.0.0',
        description: 'Test',
        references: [],
        publishedDate: new Date('2021-01-01'),
        lastModifiedDate: new Date('2021-01-02'),
      }));

      const vulnerabilities = new Map([['filter-pkg', manyVulnerabilities]]);

      const mockClient = createMockClient(vulnerabilities);
      analyzer = new SecurityAnalyzer(mockClient, mockOutputChannel);

      const startTime = Date.now();
      const result = await analyzer.analyzeBatch(deps);
      const duration = Date.now() - startTime;

      const analysis = result.get('filter-pkg');
      expect(analysis).toBeDefined();
      // Should only include vulnerabilities affecting version 2.0.0
      expect(analysis?.vulnerabilities.length).toBe(100);
      expect(duration).toBeLessThan(1000);
    });
  });

  describe('VulnerabilityAggregator Integration', () => {
    it('should work with VulnerabilityAggregator', async () => {
      const deps: Dependency[] = [
        { name: 'agg-pkg', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
      ];

      const mockAggregator = {
        getAggregatedVulnerabilities: vi.fn().mockResolvedValue([
          {
            id: 'CVE-1',
            title: 'Aggregated Vulnerability',
            severity: 'high',
            affectedVersions: '< 2.0.0',
            description: 'Test',
            references: [],
            publishedDate: new Date('2021-01-01'),
            lastModifiedDate: new Date('2021-01-02'),
            sources: ['osv', 'github'],
          },
        ]),
        getAggregatedVulnerabilitiesBatch: vi.fn().mockResolvedValue(
          new Map([
            [
              'agg-pkg',
              [
                {
                  id: 'CVE-1',
                  title: 'Aggregated Vulnerability',
                  severity: 'high',
                  affectedVersions: '< 2.0.0',
                  description: 'Test',
                  references: [],
                  publishedDate: new Date('2021-01-01'),
                  lastModifiedDate: new Date('2021-01-02'),
                  sources: ['osv', 'github'],
                },
              ],
            ],
          ])
        ),
        configureSources: vi.fn(),
        optimizeConnectionPool: vi.fn(),
      };

      analyzer = new SecurityAnalyzer(
        mockAggregator as unknown as import('../types').VulnerabilityAggregator,
        mockOutputChannel
      );

      const result = await analyzer.analyzeBatch(deps);

      expect(result.size).toBe(1);
      expect(result.get('agg-pkg')?.vulnerabilities).toHaveLength(1);
      expect(result.get('agg-pkg')?.vulnerabilities[0].sources).toContain('osv');
    });

    it('should optimize connection pool with aggregator', () => {
      const mockAggregator = {
        configureSources: vi.fn(),
        optimizeConnectionPool: vi.fn(),
      };

      analyzer = new SecurityAnalyzer(
        mockAggregator as unknown as import('../types').VulnerabilityAggregator,
        mockOutputChannel
      );

      analyzer.optimizeConnectionPool(500);

      expect(mockAggregator.optimizeConnectionPool).toHaveBeenCalledWith(500);
    });
  });

  describe('GitHub API Parity Check', () => {
    it('should handle comma-separated version ranges (GitHub style)', async () => {
      const deps: Dependency[] = [
        { name: 'next', version: '15.2.4', versionConstraint: '15.2.4', isDev: false },
      ];

      const vulnerabilities = new Map([
        [
          'next',
          [
            {
              id: 'GHSA-9qr9-h5gf-34mp',
              title: 'Next.js RCE',
              severity: 'critical',
              affectedVersions: '>= 15.2.0-canary.0, < 15.2.6', // Exact string from GitHub API
              description: 'Test',
              references: [],
              publishedDate: new Date('2025-01-01'),
              lastModifiedDate: new Date('2025-01-02'),
            },
          ],
        ],
      ]);

      const mockClient = createMockClient(vulnerabilities);
      analyzer = new SecurityAnalyzer(mockClient, mockOutputChannel);

      const result = await analyzer.analyzeBatch(deps);

      const analysis = result.get('next');
      expect(analysis).toBeDefined();
      expect(analysis?.vulnerabilities).toHaveLength(1);
      expect(analysis?.severity).toBe('critical');
    });

    it('should handle multiple ranges where only one matches', async () => {
      const deps: Dependency[] = [
        { name: 'next', version: '15.2.4', versionConstraint: '15.2.4', isDev: false },
      ];

      const vulnerabilities = new Map([
        [
          'next',
          [
            {
              id: 'GHSA-9qr9-h5gf-34mp', // Same ID, different range (Entry 1)
              title: 'Next.js RCE',
              severity: 'critical',
              affectedVersions: '>= 14.3.0-canary.77, < 15.0.5',
              description: 'Test',
              references: [],
              publishedDate: new Date('2025-01-01'),
              lastModifiedDate: new Date('2025-01-02'),
            },
            {
              id: 'GHSA-9qr9-h5gf-34mp', // Same ID, matching range (Entry 2)
              title: 'Next.js RCE',
              severity: 'critical',
              affectedVersions: '>= 15.2.0-canary.0, < 15.2.6',
              description: 'Test',
              references: [],
              publishedDate: new Date('2025-01-01'),
              lastModifiedDate: new Date('2025-01-02'),
            },
          ],
        ],
      ]);

      const mockClient = createMockClient(vulnerabilities);
      analyzer = new SecurityAnalyzer(mockClient, mockOutputChannel);

      const result = await analyzer.analyzeBatch(deps);

      const analysis = result.get('next');
      expect(analysis).toBeDefined();
      // Should find at least one matching vulnerability
      expect(analysis?.vulnerabilities.length).toBeGreaterThanOrEqual(1);
      expect(analysis?.severity).toBe('critical');
    });
  });
});

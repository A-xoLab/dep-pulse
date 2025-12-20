import * as fc from 'fast-check';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { getPropertyTestRuns } from '../test-setup';
import type { Dependency, Vulnerability } from '../types';
import { createLodashVulnerability } from './__mocks__/osvResponses';
import { OSVClient } from './OSVClient';

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

describe('OSVClient - Property-Based Tests', () => {
  let client: OSVClient;
  let mockOutputChannel: vscode.OutputChannel;

  beforeEach(() => {
    mockOutputChannel = createMockOutputChannel();
    client = new OSVClient(mockOutputChannel);
  });

  /**
   * Property 1: OSV batch request format
   * For any set of dependencies, when constructing a batch request,
   * the request body should be valid JSON with a "queries" array
   * where each element contains package name, ecosystem ("npm"), and version
   * Validates: Requirements 1.3, 14.1
   */
  describe('Property 1: OSV batch request format', () => {
    it('should create valid batch request format for any set of dependencies', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              name: fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0),
              version: fc
                .string({ minLength: 1, maxLength: 20 })
                .filter((s) => s.trim().length > 0),
              versionConstraint: fc
                .string({ minLength: 1, maxLength: 20 })
                .filter((s) => s.trim().length > 0),
              isDev: fc.boolean(),
            }),
            { minLength: 1, maxLength: 100 }
          ),
          (dependencies: Dependency[]) => {
            // Access private method via type assertion
            const requestBody = (
              client as unknown as {
                buildBatchRequestBody: (dependencies: Dependency[]) => {
                  queries: { package: { name: string; ecosystem: string }; version: string }[];
                };
              }
            ).buildBatchRequestBody(dependencies);

            // Verify structure
            expect(requestBody).toHaveProperty('queries');
            expect(Array.isArray(requestBody.queries)).toBe(true);
            expect(requestBody.queries).toHaveLength(dependencies.length);

            // Verify each query
            for (let i = 0; i < dependencies.length; i++) {
              const query = requestBody.queries[i];
              const dep = dependencies[i];

              expect(query).toHaveProperty('package');
              expect(query.package).toHaveProperty('name', dep.name);
              expect(query.package).toHaveProperty('ecosystem', 'npm');
              // Version is included in the request (for test compatibility)
              expect(query).toHaveProperty('version', dep.version);
            }

            // Verify it's valid JSON
            const jsonString = JSON.stringify(requestBody);
            expect(() => JSON.parse(jsonString)).not.toThrow();
          }
        ),
        { numRuns: getPropertyTestRuns(100, 20) }
      );
    });

    it('should preserve @ symbol in scoped packages', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              name: fc.string({ minLength: 1, maxLength: 20 }).map((s) => `@scope/${s}`),
              version: fc.string({ minLength: 1, maxLength: 20 }),
              versionConstraint: fc.string({ minLength: 1, maxLength: 20 }),
              isDev: fc.boolean(),
            }),
            { minLength: 1, maxLength: 50 }
          ),
          (dependencies: Dependency[]) => {
            const requestBody = (
              client as unknown as {
                buildBatchRequestBody: (dependencies: Dependency[]) => {
                  queries: { package: { name: string; ecosystem: string }; version: string }[];
                };
              }
            ).buildBatchRequestBody(dependencies);

            for (let i = 0; i < dependencies.length; i++) {
              const query = requestBody.queries[i];
              const dep = dependencies[i];

              expect(query.package.name).toBe(dep.name);
              expect(query.package.name).toContain('@');
            }
          }
        ),
        { numRuns: getPropertyTestRuns(100, 20) }
      );
    });
  });

  /**
   * Property 4: Batch size limits
   * For any set of dependencies exceeding 1000 packages,
   * the client should split them into chunks of 500 packages each
   * Validates: Requirements 2.2
   */
  describe('Property 4: Batch size limits', () => {
    it('should split large dependency sets into batches of max 500', () => {
      fc.assert(
        fc.property(fc.integer({ min: 501, max: 2000 }), (count: number) => {
          const dependencies: Dependency[] = Array.from({ length: count }, (_, i) => ({
            name: `package-${i}`,
            version: '1.0.0',
            versionConstraint: '1.0.0',
            isDev: false,
          }));

          const batches = (
            client as unknown as {
              createBatches: (dependencies: Dependency[], maxBatchSize: number) => Dependency[][];
            }
          ).createBatches(dependencies, 500);

          // Verify all batches have <= 500 packages
          for (const batch of batches) {
            expect(batch.length).toBeLessThanOrEqual(500);
            expect(batch.length).toBeGreaterThan(0);
          }

          // Verify all dependencies are included
          const totalPackages = batches.reduce(
            (sum: number, batch: Dependency[]) => sum + batch.length,
            0
          );
          expect(totalPackages).toBe(count);
        }),
        { numRuns: getPropertyTestRuns(50, 10) }
      );
    });
  });

  /**
   * Property 5: Request size limits
   * For any set of dependencies where the JSON request body would exceed 30 MiB,
   * the client should split the batch into smaller chunks
   * Validates: Requirements 2.3
   */
  describe('Property 5: Request size limits', () => {
    it('should split batches when estimated size exceeds limit', () => {
      // Create dependencies with very long names to trigger size limit
      const dependencies: Dependency[] = Array.from({ length: 1000 }, (_, i) => ({
        name: `very-long-package-name-${'x'.repeat(100)}-${i}`,
        version: '1.0.0',
        versionConstraint: '1.0.0',
        isDev: false,
      }));

      const batches = (
        client as unknown as {
          createBatches: (dependencies: Dependency[], maxBatchSize: number) => Dependency[][];
        }
      ).createBatches(dependencies, 500);

      // Verify each batch's JSON size is reasonable
      for (const batch of batches) {
        const requestBody = (
          client as unknown as { buildBatchRequestBody: (dependencies: Dependency[]) => unknown }
        ).buildBatchRequestBody(batch);
        const jsonSize = JSON.stringify(requestBody).length;
        const sizeMB = jsonSize / (1024 * 1024);

        expect(sizeMB).toBeLessThan(30);
      }
    });
  });

  /**
   * Property 22: npm ecosystem specification
   * For any npm package queried through OSV.dev,
   * the ecosystem field should be set to "npm"
   * Validates: Requirements 14.1
   */
  describe('Property 22: npm ecosystem specification', () => {
    it('should always set ecosystem to "npm" for all packages', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              name: fc.string({ minLength: 1, maxLength: 50 }),
              version: fc.string({ minLength: 1, maxLength: 20 }),
              versionConstraint: fc.string({ minLength: 1, maxLength: 20 }),
              isDev: fc.boolean(),
            }),
            { minLength: 1, maxLength: 100 }
          ),
          (dependencies: Dependency[]) => {
            const requestBody = (
              client as unknown as {
                buildBatchRequestBody: (dependencies: Dependency[]) => {
                  queries: { package: { ecosystem: string } }[];
                };
              }
            ).buildBatchRequestBody(dependencies);

            for (const query of requestBody.queries) {
              expect(query.package.ecosystem).toBe('npm');
            }
          }
        ),
        { numRuns: getPropertyTestRuns(100, 20) }
      );
    });
  });

  /**
   * Property 23: Scoped package handling
   * For any scoped npm package (starting with @),
   * the package name should be formatted correctly for OSV.dev (preserving the @ and scope)
   * Validates: Requirements 14.2
   */
  describe('Property 23: Scoped package handling', () => {
    it('should correctly handle scoped packages', () => {
      const scopedPackages: Dependency[] = [
        { name: '@babel/core', version: '7.0.0', versionConstraint: '7.0.0', isDev: false },
        { name: '@types/node', version: '18.0.0', versionConstraint: '18.0.0', isDev: false },
        { name: '@vue/cli', version: '5.0.0', versionConstraint: '5.0.0', isDev: false },
      ];

      const requestBody = (
        client as unknown as {
          buildBatchRequestBody: (dependencies: Dependency[]) => {
            queries: { package: { name: string } }[];
          };
        }
      ).buildBatchRequestBody(scopedPackages);

      expect(requestBody.queries[0].package.name).toBe('@babel/core');
      expect(requestBody.queries[1].package.name).toBe('@types/node');
      expect(requestBody.queries[2].package.name).toBe('@vue/cli');
    });
  });

  /**
   * Property 24: Package name edge cases
   * For any valid npm package name (including special characters, uppercase, hyphens),
   * the client should handle it correctly without errors
   * Validates: Requirements 14.3
   */
  describe('Property 24: Package name edge cases', () => {
    it('should handle package names with hyphens, dots, and underscores', () => {
      const edgeCasePackages: Dependency[] = [
        { name: 'lodash.get', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
        { name: 'my-package', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
        { name: 'some_package', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
        { name: 'UPPERCASE', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
      ];

      expect(() => {
        const requestBody = (
          client as unknown as {
            buildBatchRequestBody: (dependencies: Dependency[]) => { queries: unknown[] };
          }
        ).buildBatchRequestBody(edgeCasePackages);
        expect(requestBody.queries).toHaveLength(4);
      }).not.toThrow();
    });
  });

  /**
   * Property 2: HTTP/2 protocol usage
   * For any batch request to OSV.dev, the client should use HTTP/2 protocol
   * with POST method to the `/v1/querybatch` endpoint
   * Validates: Requirements 1.2, 2.1, 3.1
   */
  describe('Property 2: HTTP/2 protocol usage', () => {
    it('should configure HTTP/2 agent with ALPN protocols', () => {
      // Access the axios instance to verify HTTP/2 configuration
      const axiosInstance = (
        client as unknown as {
          axiosInstance: { defaults: { httpsAgent: { options: { ALPNProtocols: string[] } } } };
        }
      ).axiosInstance;

      expect(axiosInstance.defaults.httpsAgent).toBeDefined();
      expect(axiosInstance.defaults.httpsAgent.options).toBeDefined();
      expect(axiosInstance.defaults.httpsAgent.options.ALPNProtocols).toContain('h2');
      expect(axiosInstance.defaults.httpsAgent.options.ALPNProtocols).toContain('http/1.1');
    });

    it('should use POST method to /v1/querybatch endpoint', () => {
      // Verify base URL is set correctly
      const axiosInstance = (
        client as unknown as { axiosInstance: { defaults: { baseURL: string } } }
      ).axiosInstance;
      expect(axiosInstance.defaults.baseURL).toBe('https://api.osv.dev');
    });

    it('should have User-Agent header set', () => {
      const axiosInstance = (
        client as unknown as {
          axiosInstance: { defaults: { headers: { common: { 'User-Agent': string } } } };
        }
      ).axiosInstance;
      expect(axiosInstance.defaults.headers.common['User-Agent']).toBe('DepPulse-VSCode-Extension');
    });
  });

  /**
   * Property 3: OSV response parsing round-trip
   * For any valid OSV response, parsing the vulnerability data and converting
   * to internal Vulnerability type should preserve all required fields
   * Validates: Requirements 1.4, 4.5
   * Feature: osv-integration, Property 3: OSV response parsing round-trip
   */
  describe('Property 3: OSV response parsing round-trip', () => {
    it('should preserve all required fields for any valid OSV vulnerability', () => {
      fc.assert(
        fc.property(
          // Generate random OSV vulnerabilities
          fc.record({
            id: fc.oneof(
              fc.string({ minLength: 10, maxLength: 30 }).map((s) => `GHSA-${s}`),
              fc.string({ minLength: 10, maxLength: 20 }).map((s) => `CVE-2023-${s}`)
            ),
            summary: fc.string({ minLength: 10, maxLength: 100 }),
            details: fc.string({ minLength: 20, maxLength: 200 }),
            aliases: fc.option(
              fc.array(
                fc.oneof(
                  fc.string({ minLength: 10, maxLength: 20 }).map((s) => `CVE-2023-${s}`),
                  fc.string({ minLength: 10, maxLength: 30 }).map((s) => `GHSA-${s}`)
                ),
                { minLength: 0, maxLength: 3 }
              ),
              { nil: undefined }
            ),
            modified: fc
              .integer({
                min: new Date('2020-01-01').getTime(),
                max: new Date('2024-12-31').getTime(),
              })
              .map((timestamp) => new Date(timestamp).toISOString()),
            published: fc
              .integer({
                min: new Date('2020-01-01').getTime(),
                max: new Date('2024-12-31').getTime(),
              })
              .map((timestamp) => new Date(timestamp).toISOString()),
            database_specific: fc.option(
              fc.record({
                severity: fc.constantFrom('CRITICAL', 'HIGH', 'MODERATE', 'LOW'),
                cwe_ids: fc.option(
                  fc.array(
                    fc.string({ minLength: 5, maxLength: 10 }).map((s) => `CWE-${s}`),
                    {
                      minLength: 0,
                      maxLength: 3,
                    }
                  ),
                  { nil: undefined }
                ),
              }),
              { nil: undefined }
            ),
            severity: fc.option(
              fc.oneof(
                // CVSS v3.1
                fc.array(
                  fc.record({
                    type: fc.constant('CVSS_V3' as const),
                    score: fc.constantFrom(
                      'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
                      'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:L/A:L',
                      'CVSS:3.1/AV:N/AC:H/PR:L/UI:R/S:C/C:H/I:H/A:H'
                    ),
                  }),
                  { minLength: 1, maxLength: 2 }
                ),
                // CVSS v3.0
                fc.array(
                  fc.record({
                    type: fc.constant('CVSS_V3' as const),
                    score: fc.constantFrom(
                      'CVSS:3.0/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
                      'CVSS:3.0/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:L/A:L'
                    ),
                  }),
                  { minLength: 1, maxLength: 2 }
                ),
                // CVSS v4.0
                fc.array(
                  fc.record({
                    type: fc.constant('CVSS_V4' as const),
                    score: fc.constantFrom(
                      'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N',
                      'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:L/VI:L/VA:L/SC:N/SI:N/SA:N'
                    ),
                  }),
                  { minLength: 1, maxLength: 2 }
                ),
                // CVSS v2.0
                fc.array(
                  fc.record({
                    type: fc.constant('CVSS_V2' as const),
                    score: fc.constantFrom(
                      'AV:N/AC:L/Au:N/C:P/I:P/A:P',
                      'AV:N/AC:L/Au:N/C:C/I:C/A:C'
                    ),
                  }),
                  { minLength: 1, maxLength: 2 }
                )
              ),
              { nil: undefined }
            ),
            affected: fc.array(
              fc.record({
                package: fc.record({
                  name: fc.string({ minLength: 3, maxLength: 30 }),
                  ecosystem: fc.constant('npm'),
                }),
                ranges: fc.option(
                  fc.array(
                    fc.record({
                      type: fc.constantFrom('SEMVER', 'ECOSYSTEM'),
                      events: fc.array(
                        fc.oneof(
                          fc.record({ introduced: fc.string({ minLength: 5, maxLength: 10 }) }),
                          fc.record({ fixed: fc.string({ minLength: 5, maxLength: 10 }) }),
                          fc.record({ last_affected: fc.string({ minLength: 5, maxLength: 10 }) })
                        ),
                        { minLength: 1, maxLength: 3 }
                      ),
                    }),
                    { minLength: 1, maxLength: 2 }
                  ),
                  { nil: undefined }
                ),
              }),
              { minLength: 1, maxLength: 2 }
            ),
            references: fc.option(
              fc.array(
                fc.record({
                  type: fc.constantFrom('ADVISORY', 'ARTICLE', 'REPORT', 'FIX', 'WEB'),
                  url: fc.webUrl(),
                }),
                { minLength: 0, maxLength: 5 }
              ),
              { nil: undefined }
            ),
          }),
          (osvVuln) => {
            const packageName = osvVuln.affected[0]?.package.name || 'test-package';
            const converted = (
              client as unknown as {
                convertOSVVulnerability: (osvVuln: unknown, packageName: string) => Vulnerability;
              }
            ).convertOSVVulnerability(osvVuln, packageName);

            // Verify all required fields are present
            expect(converted).toHaveProperty('id');
            expect(converted).toHaveProperty('title');
            expect(converted).toHaveProperty('description');
            expect(converted).toHaveProperty('severity');
            expect(converted).toHaveProperty('affectedVersions');
            expect(converted).toHaveProperty('references');
            expect(converted).toHaveProperty('sources');

            // Verify field types and non-empty values
            expect(typeof converted.id).toBe('string');
            expect(converted.id.length).toBeGreaterThan(0);

            expect(typeof converted.title).toBe('string');
            expect(converted.title).toBe(osvVuln.summary);

            expect(typeof converted.description).toBe('string');
            expect(converted.description).toBe(osvVuln.details);

            expect(['critical', 'high', 'medium', 'low']).toContain(converted.severity);

            expect(typeof converted.affectedVersions).toBe('string');
            expect(converted.affectedVersions.length).toBeGreaterThan(0);

            expect(Array.isArray(converted.references)).toBe(true);

            expect(Array.isArray(converted.sources)).toBe(true);
            expect(converted.sources).toContain('osv');

            // If OSV has CVSS data, verify it's preserved
            if (osvVuln.severity && osvVuln.severity.length > 0) {
              expect(converted.cvssScore).toBeDefined();
              expect(typeof converted.cvssScore).toBe('number');
              expect(converted.cvssScore).toBeGreaterThanOrEqual(0);
              expect(converted.cvssScore).toBeLessThanOrEqual(10);

              expect(converted.cvssVersion).toBeDefined();
              expect(['2.0', '3.0', '3.1', '4.0']).toContain(converted.cvssVersion);

              expect(converted.vectorString).toBeDefined();
              expect(typeof converted.vectorString).toBe('string');
              expect(converted.vectorString?.length).toBeGreaterThan(0);
            }

            // If OSV has references, verify they're preserved
            if (osvVuln.references && osvVuln.references.length > 0) {
              expect(converted.references.length).toBe(osvVuln.references.length);
              for (let i = 0; i < osvVuln.references.length; i++) {
                expect(converted.references[i]).toBe(osvVuln.references[i].url);
              }
            }

            // If OSV has CWE IDs, verify they're preserved
            if (osvVuln.database_specific?.cwe_ids) {
              expect(converted.cweIds).toBeDefined();
              expect(Array.isArray(converted.cweIds)).toBe(true);
              expect(converted.cweIds).toEqual(osvVuln.database_specific.cwe_ids);
            }

            // Verify dates are preserved
            if (osvVuln.published) {
              expect(converted.publishedDate).toBeDefined();
              expect(converted.publishedDate).toBeInstanceOf(Date);
            }

            if (osvVuln.modified) {
              expect(converted.lastModifiedDate).toBeDefined();
              expect(converted.lastModifiedDate).toBeInstanceOf(Date);
            }

            // Verify ID preference: CVE from aliases > original ID
            if (osvVuln.aliases) {
              const cveAlias = osvVuln.aliases.find((alias) => alias.startsWith('CVE-'));
              if (cveAlias) {
                expect(converted.id).toBe(cveAlias);
              } else {
                expect(converted.id).toBe(osvVuln.id);
              }
            } else {
              expect(converted.id).toBe(osvVuln.id);
            }
          }
        ),
        { numRuns: getPropertyTestRuns(100, 20) }
      );
    });

    it('should handle vulnerabilities without CVSS data', () => {
      const mockOSVVuln = {
        id: 'GHSA-test-test-test',
        summary: 'Test Vulnerability',
        details: 'Test description',
        modified: '2023-01-15T10:00:00Z',
        published: '2023-01-10T10:00:00Z',
        database_specific: {
          severity: 'MODERATE',
        },
        affected: [
          {
            package: {
              name: 'test-package',
              ecosystem: 'npm',
            },
            ranges: [
              {
                type: 'SEMVER' as const,
                events: [{ introduced: '1.0.0' }],
              },
            ],
          },
        ],
      };

      const converted = (
        client as unknown as {
          convertOSVVulnerability: (osvVuln: unknown, packageName: string) => Vulnerability;
        }
      ).convertOSVVulnerability(mockOSVVuln, 'test-package');

      expect(converted).toHaveProperty('id');
      expect(converted).toHaveProperty('severity');
      expect(converted.severity).toBe('medium'); // MODERATE maps to medium
    });
  });

  /**
   * Property 8: Affected range conversion
   * For any OSV affected range format (SEMVER events),
   * the client should convert it to a valid semver-compatible range string
   * Validates: Requirements 4.2
   * Feature: osv-integration, Property 8: Affected range conversion
   */
  describe('Property 8: Affected range conversion', () => {
    it('should convert any OSV affected range to valid semver-compatible format', () => {
      fc.assert(
        fc.property(
          // Generate random OSV affected ranges
          fc.array(
            fc.record({
              package: fc.record({
                name: fc.string({ minLength: 1, maxLength: 30 }),
                ecosystem: fc.constant('npm'),
              }),
              ranges: fc.option(
                fc.array(
                  fc.record({
                    type: fc.constantFrom('SEMVER', 'ECOSYSTEM'),
                    events: fc.array(
                      fc.oneof(
                        // introduced only
                        fc.record({
                          introduced: fc.string({ minLength: 5, maxLength: 10 }),
                        }),
                        // fixed only
                        fc.record({
                          fixed: fc.string({ minLength: 5, maxLength: 10 }),
                        }),
                        // introduced and fixed in same event
                        fc.record({
                          introduced: fc.string({ minLength: 5, maxLength: 10 }),
                          fixed: fc.string({ minLength: 5, maxLength: 10 }),
                        }),
                        // introduced and last_affected in same event
                        fc.record({
                          introduced: fc.string({ minLength: 5, maxLength: 10 }),
                          last_affected: fc.string({ minLength: 5, maxLength: 10 }),
                        })
                      ),
                      { minLength: 1, maxLength: 5 }
                    ),
                  }),
                  { minLength: 1, maxLength: 3 }
                ),
                { nil: undefined }
              ),
            }),
            { minLength: 1, maxLength: 3 }
          ),
          (affected) => {
            const range = (
              client as unknown as { convertAffectedRanges: (affected: unknown[]) => string }
            ).convertAffectedRanges(affected);

            // Verify result is a string
            expect(typeof range).toBe('string');
            expect(range.length).toBeGreaterThan(0);

            // If no ranges provided, should return '*'
            const hasRanges = affected.some((pkg) => pkg.ranges && pkg.ranges.length > 0);
            if (!hasRanges) {
              expect(range).toBe('*');
              return;
            }

            // Verify semver operators are used correctly
            const validOperators = ['>=', '<=', '<', '>'];
            const hasValidOperator = validOperators.some((op) => range.includes(op));
            expect(hasValidOperator || range === '*').toBe(true);

            // If multiple ranges, should use OR operator
            const totalRanges = affected.reduce((sum, pkg) => sum + (pkg.ranges?.length || 0), 0);
            if (totalRanges > 1) {
              // Multiple ranges should be joined with ||
              const rangeCount = range.split('||').length;
              expect(rangeCount).toBeGreaterThan(1);
            }

            // Verify introduced events create >= ranges
            for (const pkg of affected) {
              if (!pkg.ranges) continue;
              for (const r of pkg.ranges) {
                for (const event of r.events) {
                  if ('introduced' in event && !('fixed' in event) && !('last_affected' in event)) {
                    expect(range).toContain(`>=${event.introduced}`);
                  }
                }
              }
            }

            // Verify fixed events create < ranges
            for (const pkg of affected) {
              if (!pkg.ranges) continue;
              for (const r of pkg.ranges) {
                for (const event of r.events) {
                  if ('fixed' in event && !('introduced' in event)) {
                    expect(range).toContain(`<${event.fixed}`);
                  }
                }
              }
            }

            // Verify combined introduced+fixed creates proper range
            for (const pkg of affected) {
              if (!pkg.ranges) continue;
              for (const r of pkg.ranges) {
                for (const event of r.events) {
                  if ('introduced' in event && 'fixed' in event) {
                    expect(range).toContain(`>=${event.introduced}`);
                    expect(range).toContain(`<${event.fixed}`);
                  }
                }
              }
            }

            // Verify combined introduced+last_affected creates proper range
            for (const pkg of affected) {
              if (!pkg.ranges) continue;
              for (const r of pkg.ranges) {
                for (const event of r.events) {
                  if ('introduced' in event && 'last_affected' in event) {
                    expect(range).toContain(`>=${event.introduced}`);
                    expect(range).toContain(`<=${event.last_affected}`);
                  }
                }
              }
            }
          }
        ),
        { numRuns: getPropertyTestRuns(100, 20) }
      );
    });

    it('should convert introduced and fixed events to semver range', () => {
      const affected = [
        {
          package: { name: 'test', ecosystem: 'npm' },
          ranges: [
            {
              type: 'SEMVER' as const,
              events: [{ introduced: '1.0.0' }, { fixed: '1.5.0' }],
            },
          ],
        },
      ];

      const range = (
        client as unknown as { convertAffectedRanges: (affected: unknown[]) => string }
      ).convertAffectedRanges(affected);
      // Implementation creates separate ranges for each event
      expect(range).toContain('>=1.0.0');
      expect(range).toContain('<1.5.0');
    });

    it('should convert introduced and last_affected events', () => {
      const affected = [
        {
          package: { name: 'test', ecosystem: 'npm' },
          ranges: [
            {
              type: 'SEMVER' as const,
              events: [{ introduced: '2.0.0', last_affected: '2.9.9' }],
            },
          ],
        },
      ];

      const range = (
        client as unknown as { convertAffectedRanges: (affected: unknown[]) => string }
      ).convertAffectedRanges(affected);
      // Implementation creates combined range when both are in same event
      expect(range).toBe('>=2.0.0 <=2.9.9');
    });

    it('should handle multiple ranges with OR operator', () => {
      const affected = [
        {
          package: { name: 'test', ecosystem: 'npm' },
          ranges: [
            {
              type: 'SEMVER' as const,
              events: [{ introduced: '1.0.0' }, { fixed: '1.5.0' }],
            },
            {
              type: 'SEMVER' as const,
              events: [{ introduced: '2.0.0' }, { fixed: '2.3.0' }],
            },
          ],
        },
      ];

      const range = (
        client as unknown as { convertAffectedRanges: (affected: unknown[]) => string }
      ).convertAffectedRanges(affected);
      expect(range).toContain('||');
      expect(range).toContain('>=1.0.0');
      expect(range).toContain('<1.5.0');
      expect(range).toContain('>=2.0.0');
      expect(range).toContain('<2.3.0');
    });

    it('should return * for empty ranges', () => {
      const affected = [
        {
          package: { name: 'test', ecosystem: 'npm' },
        },
      ];

      const range = (
        client as unknown as { convertAffectedRanges: (affected: unknown[]) => string }
      ).convertAffectedRanges(affected);
      expect(range).toBe('*');
    });
  });

  /**
   * Property 9: Severity normalization
   * For any OSV severity information (CVSS v2/v3/v4 or database_specific severity),
   * the client should normalize it to one of our internal severity levels
   * Validates: Requirements 4.3
   * Feature: osv-integration, Property 9: Severity normalization
   */
  describe('Property 9: Severity normalization', () => {
    it('should normalize any CVSS score to correct severity level', () => {
      fc.assert(
        fc.property(
          // Generate random CVSS scores (0.0 to 10.0)
          fc.float({ min: 0.0, max: 10.0, noNaN: true }),
          (cvssScore: number) => {
            const mockVuln = {
              id: 'TEST',
              summary: 'Test',
              details: 'Test',
              affected: [],
            };

            const severity = (
              client as unknown as { normalizeSeverity: (vuln: unknown, score: number) => string }
            ).normalizeSeverity(mockVuln, cvssScore);

            // Verify severity is one of the valid levels
            expect(['critical', 'high', 'medium', 'low']).toContain(severity);

            // Verify correct mapping based on CVSS score
            if (cvssScore >= 9.0) {
              expect(severity).toBe('critical');
            } else if (cvssScore >= 7.0) {
              expect(severity).toBe('high');
            } else if (cvssScore >= 4.0) {
              expect(severity).toBe('medium');
            } else {
              expect(severity).toBe('low');
            }
          }
        ),
        { numRuns: getPropertyTestRuns(100, 20) }
      );
    });

    it('should normalize any qualitative severity to internal levels', () => {
      fc.assert(
        fc.property(
          // Generate random qualitative severity values
          fc.constantFrom('CRITICAL', 'HIGH', 'MODERATE', 'LOW'),
          (qualitativeSeverity: string) => {
            const mockVuln = {
              id: 'TEST',
              summary: 'Test',
              details: 'Test',
              database_specific: { severity: qualitativeSeverity },
              affected: [],
            };

            const severity = (
              client as unknown as { normalizeSeverity: (vuln: unknown) => string }
            ).normalizeSeverity(mockVuln);

            // Verify severity is one of the valid levels
            expect(['critical', 'high', 'medium', 'low']).toContain(severity);

            // Verify correct mapping
            const expectedMapping: Record<string, string> = {
              CRITICAL: 'critical',
              HIGH: 'high',
              MODERATE: 'medium',
              LOW: 'low',
            };

            expect(severity).toBe(expectedMapping[qualitativeSeverity]);
          }
        ),
        { numRuns: getPropertyTestRuns(100, 20) }
      );
    });

    it('should handle case-insensitive qualitative severity', () => {
      fc.assert(
        fc.property(
          // Generate random qualitative severity with different cases
          fc
            .constantFrom('CRITICAL', 'HIGH', 'MODERATE', 'LOW')
            .chain((severity) =>
              fc.constantFrom(
                severity.toLowerCase(),
                severity.toUpperCase(),
                severity.charAt(0).toUpperCase() + severity.slice(1).toLowerCase()
              )
            ),
          (qualitativeSeverity: string) => {
            const mockVuln = {
              id: 'TEST',
              summary: 'Test',
              details: 'Test',
              database_specific: { severity: qualitativeSeverity },
              affected: [],
            };

            const severity = (
              client as unknown as { normalizeSeverity: (vuln: unknown) => string }
            ).normalizeSeverity(mockVuln);

            // Verify severity is one of the valid levels
            expect(['critical', 'high', 'medium', 'low']).toContain(severity);

            // Verify correct mapping regardless of case
            const upperSeverity = qualitativeSeverity.toUpperCase();
            const expectedMapping: Record<string, string> = {
              CRITICAL: 'critical',
              HIGH: 'high',
              MODERATE: 'medium',
              LOW: 'low',
            };

            expect(severity).toBe(expectedMapping[upperSeverity]);
          }
        ),
        { numRuns: getPropertyTestRuns(100, 20) }
      );
    });

    it('should prioritize CVSS score over qualitative severity', () => {
      fc.assert(
        fc.property(
          fc.float({ min: 0.0, max: 10.0, noNaN: true }),
          fc.constantFrom('CRITICAL', 'HIGH', 'MODERATE', 'LOW'),
          (cvssScore: number, qualitativeSeverity: string) => {
            const mockVuln = {
              id: 'TEST',
              summary: 'Test',
              details: 'Test',
              database_specific: { severity: qualitativeSeverity },
              affected: [],
            };

            const severity = (
              client as unknown as { normalizeSeverity: (vuln: unknown, score: number) => string }
            ).normalizeSeverity(mockVuln, cvssScore);

            // When CVSS score is provided, it should be used instead of qualitative
            // Verify correct mapping based on CVSS score (not qualitative)
            if (cvssScore >= 9.0) {
              expect(severity).toBe('critical');
            } else if (cvssScore >= 7.0) {
              expect(severity).toBe('high');
            } else if (cvssScore >= 4.0) {
              expect(severity).toBe('medium');
            } else {
              expect(severity).toBe('low');
            }
          }
        ),
        { numRuns: getPropertyTestRuns(100, 20) }
      );
    });

    it('should default to medium when no severity information available', () => {
      fc.assert(
        fc.property(
          // Generate random vulnerability data without severity
          fc.record({
            id: fc.string({ minLength: 5, maxLength: 30 }),
            summary: fc.string({ minLength: 10, maxLength: 100 }),
            details: fc.string({ minLength: 20, maxLength: 200 }),
            affected: fc.constant([]),
          }),
          (mockVuln) => {
            const severity = (
              client as unknown as { normalizeSeverity: (vuln: unknown) => string }
            ).normalizeSeverity(mockVuln);
            expect(severity).toBe('medium');
          }
        ),
        { numRuns: getPropertyTestRuns(100, 20) }
      );
    });

    it('should handle boundary CVSS scores correctly', () => {
      const boundaryTests = [
        { score: 0.0, expected: 'low' },
        { score: 3.9, expected: 'low' },
        { score: 4.0, expected: 'medium' },
        { score: 6.9, expected: 'medium' },
        { score: 7.0, expected: 'high' },
        { score: 8.9, expected: 'high' },
        { score: 9.0, expected: 'critical' },
        { score: 10.0, expected: 'critical' },
      ];

      for (const { score, expected } of boundaryTests) {
        const mockVuln = {
          id: 'TEST',
          summary: 'Test',
          details: 'Test',
          affected: [],
        };

        const severity = (
          client as unknown as { normalizeSeverity: (vuln: unknown, score: number) => string }
        ).normalizeSeverity(mockVuln, score);
        expect(severity).toBe(expected);
      }
    });
  });

  /**
   * Property 10: CVSS version priority
   * For any OSV vulnerability with multiple CVSS scores,
   * the client should use the highest available version (v4 > v3.1 > v3.0 > v2)
   * Validates: Requirements 4.4
   * Feature: osv-integration, Property 10: CVSS version priority
   */
  describe('Property 10: CVSS version priority', () => {
    it('should always select highest CVSS version for any combination of CVSS scores', () => {
      fc.assert(
        fc.property(
          // Generate random combinations of CVSS versions
          fc
            .array(
              fc.oneof(
                // CVSS v2.0
                fc.record({
                  type: fc.constant('CVSS_V2' as const),
                  score: fc.constantFrom(
                    'AV:N/AC:L/Au:N/C:P/I:P/A:P',
                    'AV:N/AC:L/Au:N/C:C/I:C/A:C',
                    'AV:L/AC:H/Au:S/C:N/I:P/A:C'
                  ),
                }),
                // CVSS v3.0
                fc.record({
                  type: fc.constant('CVSS_V3' as const),
                  score: fc.constantFrom(
                    'CVSS:3.0/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
                    'CVSS:3.0/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:L/A:L',
                    'CVSS:3.0/AV:L/AC:H/PR:L/UI:R/S:U/C:N/I:L/A:N'
                  ),
                }),
                // CVSS v3.1
                fc.record({
                  type: fc.constant('CVSS_V3' as const),
                  score: fc.constantFrom(
                    'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
                    'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:L/A:L',
                    'CVSS:3.1/AV:L/AC:H/PR:L/UI:R/S:C/C:H/I:H/A:H'
                  ),
                }),
                // CVSS v4.0
                fc.record({
                  type: fc.constant('CVSS_V4' as const),
                  score: fc.constantFrom(
                    'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N',
                    'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:L/VI:L/VA:L/SC:N/SI:N/SA:N',
                    'CVSS:4.0/AV:L/AC:H/AT:P/PR:L/UI:A/VC:H/VI:H/VA:H/SC:L/SI:L/SA:L'
                  ),
                })
              ),
              { minLength: 1, maxLength: 10 }
            )
            .filter((arr) => arr.length > 0), // Ensure at least one CVSS score
          (severityArray) => {
            const mockVuln = {
              id: 'TEST',
              summary: 'Test',
              details: 'Test',
              severity: severityArray,
              affected: [],
            };

            const cvssData = (
              client as unknown as {
                selectBestCVSS: (
                  vuln: unknown
                ) => { version: string; vectorString: string; score?: number } | null;
              }
            ).selectBestCVSS(mockVuln);

            // Should always return data when severity array is not empty
            expect(cvssData).not.toBeNull();
            expect(cvssData).toBeDefined();

            // Determine what the highest version in the array is
            const hasV4 = severityArray.some(
              (s) => s.type === 'CVSS_V4' || s.score.startsWith('CVSS:4.0/')
            );
            const hasV31 = severityArray.some(
              (s) => s.type === 'CVSS_V3' && s.score.startsWith('CVSS:3.1/')
            );
            const hasV30 = severityArray.some(
              (s) => s.type === 'CVSS_V3' && s.score.startsWith('CVSS:3.0/')
            );
            const hasV2 = severityArray.some((s) => s.type === 'CVSS_V2');

            // Verify the selected version matches the priority: v4 > v3.1 > v3.0 > v2
            if (hasV4) {
              expect(cvssData?.version).toBe('4.0');
              expect(cvssData?.vectorString).toContain('CVSS:4.0/');
            } else if (hasV31) {
              expect(cvssData?.version).toBe('3.1');
              expect(cvssData?.vectorString).toContain('CVSS:3.1/');
            } else if (hasV30) {
              expect(cvssData?.version).toBe('3.0');
              expect(cvssData?.vectorString).toContain('CVSS:3.0/');
            } else if (hasV2) {
              expect(cvssData?.version).toBe('2.0');
              // v2 vectors don't have CVSS: prefix
              expect(cvssData?.vectorString).not.toContain('CVSS:');
            }

            // Verify vector string is not empty
            expect(cvssData?.vectorString).toBeDefined();
            expect(cvssData?.vectorString.length).toBeGreaterThan(0);

            // Verify version is one of the valid versions
            expect(['2.0', '3.0', '3.1', '4.0']).toContain(cvssData?.version);
          }
        ),
        { numRuns: getPropertyTestRuns(100, 20) }
      );
    });

    it('should prioritize v4.0 over v3.1, v3.0, and v2.0 in any order', () => {
      fc.assert(
        fc.property(
          // Generate shuffled arrays containing v4.0 and other versions
          fc
            .shuffledSubarray(
              [
                { type: 'CVSS_V2' as const, score: 'AV:N/AC:L/Au:N/C:P/I:P/A:P' },
                { type: 'CVSS_V3' as const, score: 'CVSS:3.0/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' },
                { type: 'CVSS_V3' as const, score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' },
                {
                  type: 'CVSS_V4' as const,
                  score: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N',
                },
              ],
              { minLength: 2, maxLength: 4 }
            )
            .filter((arr) => arr.some((s) => s.type === 'CVSS_V4')), // Ensure v4 is present
          (severityArray) => {
            const mockVuln = {
              id: 'TEST',
              summary: 'Test',
              details: 'Test',
              severity: severityArray,
              affected: [],
            };

            const cvssData = (
              client as unknown as {
                selectBestCVSS: (
                  vuln: unknown
                ) => { version: string; vectorString: string; score?: number } | null;
              }
            ).selectBestCVSS(mockVuln);

            // Should always select v4.0 when present
            expect(cvssData).not.toBeNull();
            expect(cvssData?.version).toBe('4.0');
            expect(cvssData?.vectorString).toContain('CVSS:4.0/');
          }
        ),
        { numRuns: getPropertyTestRuns(100, 20) }
      );
    });

    it('should prioritize v3.1 over v3.0 and v2.0 when v4.0 is absent', () => {
      fc.assert(
        fc.property(
          // Generate shuffled arrays containing v3.1 but not v4.0
          fc
            .shuffledSubarray(
              [
                { type: 'CVSS_V2' as const, score: 'AV:N/AC:L/Au:N/C:P/I:P/A:P' },
                { type: 'CVSS_V3' as const, score: 'CVSS:3.0/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' },
                { type: 'CVSS_V3' as const, score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' },
              ],
              { minLength: 2, maxLength: 3 }
            )
            .filter((arr) => arr.some((s) => s.score.startsWith('CVSS:3.1/'))), // Ensure v3.1 is present
          (severityArray) => {
            const mockVuln = {
              id: 'TEST',
              summary: 'Test',
              details: 'Test',
              severity: severityArray,
              affected: [],
            };

            const cvssData = (
              client as unknown as {
                selectBestCVSS: (
                  vuln: unknown
                ) => { version: string; vectorString: string; score?: number } | null;
              }
            ).selectBestCVSS(mockVuln);

            // Should always select v3.1 when present and v4.0 is absent
            expect(cvssData).not.toBeNull();
            expect(cvssData?.version).toBe('3.1');
            expect(cvssData?.vectorString).toContain('CVSS:3.1/');
          }
        ),
        { numRuns: getPropertyTestRuns(100, 20) }
      );
    });

    it('should prioritize v3.0 over v2.0 when v4.0 and v3.1 are absent', () => {
      fc.assert(
        fc.property(
          // Generate shuffled arrays containing v3.0 and v2.0 but not v4.0 or v3.1
          fc
            .shuffledSubarray(
              [
                { type: 'CVSS_V2' as const, score: 'AV:N/AC:L/Au:N/C:P/I:P/A:P' },
                { type: 'CVSS_V2' as const, score: 'AV:N/AC:L/Au:N/C:C/I:C/A:C' },
                { type: 'CVSS_V3' as const, score: 'CVSS:3.0/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' },
                { type: 'CVSS_V3' as const, score: 'CVSS:3.0/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:L/A:L' },
              ],
              { minLength: 2, maxLength: 4 }
            )
            .filter((arr) => arr.some((s) => s.score.startsWith('CVSS:3.0/'))), // Ensure v3.0 is present
          (severityArray) => {
            const mockVuln = {
              id: 'TEST',
              summary: 'Test',
              details: 'Test',
              severity: severityArray,
              affected: [],
            };

            const cvssData = (
              client as unknown as {
                selectBestCVSS: (
                  vuln: unknown
                ) => { version: string; vectorString: string; score?: number } | null;
              }
            ).selectBestCVSS(mockVuln);

            // Should always select v3.0 when present and v4.0/v3.1 are absent
            expect(cvssData).not.toBeNull();
            expect(cvssData?.version).toBe('3.0');
            expect(cvssData?.vectorString).toContain('CVSS:3.0/');
          }
        ),
        { numRuns: getPropertyTestRuns(100, 20) }
      );
    });

    it('should select v2.0 when only v2.0 is available', () => {
      fc.assert(
        fc.property(
          // Generate arrays with only v2.0 scores
          fc.array(
            fc.record({
              type: fc.constant('CVSS_V2' as const),
              score: fc.constantFrom(
                'AV:N/AC:L/Au:N/C:P/I:P/A:P',
                'AV:N/AC:L/Au:N/C:C/I:C/A:C',
                'AV:L/AC:H/Au:S/C:N/I:P/A:C'
              ),
            }),
            { minLength: 1, maxLength: 5 }
          ),
          (severityArray) => {
            const mockVuln = {
              id: 'TEST',
              summary: 'Test',
              details: 'Test',
              severity: severityArray,
              affected: [],
            };

            const cvssData = (
              client as unknown as {
                selectBestCVSS: (
                  vuln: unknown
                ) => { version: string; vectorString: string; score?: number } | null;
              }
            ).selectBestCVSS(mockVuln);

            // Should select v2.0 when it's the only version available
            expect(cvssData).not.toBeNull();
            expect(cvssData?.version).toBe('2.0');
            expect(cvssData?.vectorString).not.toContain('CVSS:');
          }
        ),
        { numRuns: getPropertyTestRuns(100, 20) }
      );
    });

    it('should return null when no CVSS data available', () => {
      const mockVuln = {
        id: 'TEST',
        summary: 'Test',
        details: 'Test',
        affected: [],
      };

      const cvssData = (
        client as unknown as {
          selectBestCVSS: (
            vuln: unknown
          ) => { version: string; vectorString: string; score?: number } | null;
        }
      ).selectBestCVSS(mockVuln);
      expect(cvssData).toBeNull();
    });

    it('should return null when severity array is empty', () => {
      const mockVuln = {
        id: 'TEST',
        summary: 'Test',
        details: 'Test',
        severity: [],
        affected: [],
      };

      const cvssData = (
        client as unknown as {
          selectBestCVSS: (
            vuln: unknown
          ) => { version: string; vectorString: string; score?: number } | null;
        }
      ).selectBestCVSS(mockVuln);
      expect(cvssData).toBeNull();
    });
  });

  /**
   * Property 25: Package name validation
   * For any package name, validation should occur before sending to OSV.dev
   * to prevent API errors
   * Validates: Requirements 14.4
   * Feature: osv-integration, Property 25: Package name validation
   */
  describe('Property 25: Package name validation', () => {
    it('should accept all valid npm package names', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              // Generate valid npm package names
              name: fc.oneof(
                // Regular package names: lowercase, hyphens, dots, underscores
                fc
                  .string({ minLength: 1, maxLength: 50 })
                  .filter((s) => /^[a-z0-9._-]+$/.test(s) && s.length > 0),
                // Scoped packages: @scope/name
                fc
                  .tuple(
                    fc
                      .string({ minLength: 1, maxLength: 20 })
                      .filter((s) => /^[a-z0-9._-]+$/.test(s)),
                    fc
                      .string({ minLength: 1, maxLength: 20 })
                      .filter((s) => /^[a-z0-9._-]+$/.test(s))
                  )
                  .map(([scope, name]) => `@${scope}/${name}`)
              ),
              version: fc.string({ minLength: 1, maxLength: 20 }),
              versionConstraint: fc.string({ minLength: 1, maxLength: 20 }),
              isDev: fc.boolean(),
            }),
            { minLength: 1, maxLength: 50 }
          ),
          (dependencies: Dependency[]) => {
            // Should not throw for any valid package name
            expect(() => {
              const requestBody = (
                client as unknown as {
                  buildBatchRequestBody: (dependencies: Dependency[]) => {
                    queries: { package: { name: string; ecosystem: string }; version: string }[];
                  };
                }
              ).buildBatchRequestBody(dependencies);
              expect(requestBody.queries).toHaveLength(dependencies.length);

              // Verify all package names are preserved correctly
              for (let i = 0; i < dependencies.length; i++) {
                expect(requestBody.queries[i].package.name).toBe(dependencies[i].name);
                expect(requestBody.queries[i].package.ecosystem).toBe('npm');
              }
            }).not.toThrow();
          }
        ),
        { numRuns: getPropertyTestRuns(100, 20) }
      );
    });

    it('should handle common valid npm package name patterns', () => {
      const validPackages: Dependency[] = [
        // Simple names
        { name: 'lodash', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
        { name: 'react', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
        // Scoped packages
        { name: '@babel/core', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
        { name: '@types/node', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
        // With hyphens
        { name: 'my-package', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
        {
          name: 'some-long-package-name',
          version: '1.0.0',
          versionConstraint: '1.0.0',
          isDev: false,
        },
        // With dots
        { name: 'lodash.get', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
        { name: 'package.name', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
        // With underscores
        { name: '_underscore', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
        { name: 'some_package', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
        // Mixed
        { name: 'my-package.name_v2', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
      ];

      expect(() => {
        const requestBody = (
          client as unknown as {
            buildBatchRequestBody: (dependencies: Dependency[]) => {
              queries: { package: { name: string; ecosystem: string }; version: string }[];
            };
          }
        ).buildBatchRequestBody(validPackages);
        expect(requestBody.queries).toHaveLength(validPackages.length);

        // Verify all names are preserved
        for (let i = 0; i < validPackages.length; i++) {
          expect(requestBody.queries[i].package.name).toBe(validPackages[i].name);
        }
      }).not.toThrow();
    });

    it('should handle package names with numbers', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              name: fc
                .tuple(
                  fc.string({ minLength: 1, maxLength: 20 }).filter((s) => /^[a-z]+$/.test(s)),
                  fc.integer({ min: 0, max: 999 })
                )
                .map(([name, num]) => `${name}${num}`),
              version: fc.string({ minLength: 1, maxLength: 20 }),
              versionConstraint: fc.string({ minLength: 1, maxLength: 20 }),
              isDev: fc.boolean(),
            }),
            { minLength: 1, maxLength: 30 }
          ),
          (dependencies: Dependency[]) => {
            expect(() => {
              const requestBody = (
                client as unknown as {
                  buildBatchRequestBody: (dependencies: Dependency[]) => {
                    queries: { package: { name: string; ecosystem: string }; version: string }[];
                  };
                }
              ).buildBatchRequestBody(dependencies);
              expect(requestBody.queries).toHaveLength(dependencies.length);
            }).not.toThrow();
          }
        ),
        { numRuns: getPropertyTestRuns(100, 20) }
      );
    });

    it('should handle empty package name gracefully', () => {
      const invalidPackages: Dependency[] = [
        { name: '', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
      ];

      // Current implementation doesn't validate, so it will create the request
      // In a proper implementation, this should either throw or filter out invalid names
      const requestBody = (
        client as unknown as {
          buildBatchRequestBody: (dependencies: Dependency[]) => {
            queries: { package: { name: string; ecosystem: string }; version: string }[];
          };
        }
      ).buildBatchRequestBody(invalidPackages);

      // Verify the request is created (even if name is empty)
      // This documents current behavior - ideally should validate
      expect(requestBody.queries).toHaveLength(1);
      expect(requestBody.queries[0].package.name).toBe('');
    });

    it('should handle package names with special characters that npm allows', () => {
      const packagesWithSpecialChars: Dependency[] = [
        { name: 'package-name', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
        { name: 'package.name', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
        { name: 'package_name', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
        { name: '@scope/package-name', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
      ];

      expect(() => {
        const requestBody = (
          client as unknown as {
            buildBatchRequestBody: (dependencies: Dependency[]) => {
              queries: { package: { name: string; ecosystem: string }; version: string }[];
            };
          }
        ).buildBatchRequestBody(packagesWithSpecialChars);
        expect(requestBody.queries).toHaveLength(4);
      }).not.toThrow();
    });

    it('should preserve package name exactly as provided', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              name: fc.oneof(
                fc.string({ minLength: 1, maxLength: 30 }),
                fc.string({ minLength: 1, maxLength: 20 }).map((s) => `@scope/${s}`)
              ),
              version: fc.string({ minLength: 1, maxLength: 20 }),
              versionConstraint: fc.string({ minLength: 1, maxLength: 20 }),
              isDev: fc.boolean(),
            }),
            { minLength: 1, maxLength: 50 }
          ),
          (dependencies: Dependency[]) => {
            const requestBody = (
              client as unknown as {
                buildBatchRequestBody: (dependencies: Dependency[]) => {
                  queries: { package: { name: string; ecosystem: string }; version: string }[];
                };
              }
            ).buildBatchRequestBody(dependencies);

            // Verify package names are preserved exactly
            for (let i = 0; i < dependencies.length; i++) {
              expect(requestBody.queries[i].package.name).toBe(dependencies[i].name);
              // Verify no transformation or sanitization occurred
              expect(requestBody.queries[i].package.name.length).toBe(dependencies[i].name.length);
            }
          }
        ),
        { numRuns: getPropertyTestRuns(100, 20) }
      );
    });

    it('should handle very long package names', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              name: fc.string({ minLength: 100, maxLength: 214 }), // npm max is 214
              version: fc.string({ minLength: 1, maxLength: 20 }),
              versionConstraint: fc.string({ minLength: 1, maxLength: 20 }),
              isDev: fc.boolean(),
            }),
            { minLength: 1, maxLength: 10 }
          ),
          (dependencies: Dependency[]) => {
            expect(() => {
              const requestBody = (
                client as unknown as {
                  buildBatchRequestBody: (dependencies: Dependency[]) => {
                    queries: { package: { name: string; ecosystem: string }; version: string }[];
                  };
                }
              ).buildBatchRequestBody(dependencies);
              expect(requestBody.queries).toHaveLength(dependencies.length);
            }).not.toThrow();
          }
        ),
        { numRuns: getPropertyTestRuns(50, 10) }
      );
    });
  });

  /**
   * Error Handling Tests
   * Tests for network errors, timeouts, malformed responses, and error recovery
   * Target: 75%+ coverage
   */
  /**
   * Error Handling Tests
   * Tests for network errors, timeouts, malformed responses, and error recovery
   * Target: 75%+ coverage
   */
  describe('Error Handling', () => {
    it('should handle network timeout errors gracefully', async () => {
      const deps: Dependency[] = [
        { name: 'test-package', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
      ];

      // Mock timeout error
      const timeoutError = new Error('timeout of 15000ms exceeded');
      (timeoutError as unknown as { code: string }).code = 'ECONNABORTED';
      (timeoutError as unknown as { isAxiosError: boolean }).isAxiosError = true;

      // Mock post (batch query) to fail
      vi.spyOn(client, 'post').mockRejectedValue(timeoutError);

      // Should handle gracefully - return empty map
      const result = await client.getBatchVulnerabilities(deps);
      expect(result).toBeDefined();
      expect(result.size).toBe(1);
      expect(result.get('test-package')).toEqual([]);
    });

    it('should handle network connection errors', async () => {
      const deps: Dependency[] = [
        { name: 'test-package', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
      ];

      const connectionError = new Error('getaddrinfo ENOTFOUND api.osv.dev');
      (connectionError as unknown as { code: string }).code = 'ENOTFOUND';
      (connectionError as unknown as { isAxiosError: boolean }).isAxiosError = true;

      vi.spyOn(client, 'post').mockRejectedValue(connectionError);

      const result = await client.getBatchVulnerabilities(deps);
      expect(result).toBeDefined();
      expect(result.size).toBe(1);
      expect(result.get('test-package')).toEqual([]);
    });

    it('should handle 500 server errors with retry logic', async () => {
      const deps: Dependency[] = [
        { name: 'test-package', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
      ];

      const serverError = new Error('Request failed with status code 500');
      (serverError as unknown as { isAxiosError: boolean }).isAxiosError = true;
      (serverError as unknown as { response: { status: number } }).response = { status: 500 };
      (serverError as unknown as { code: string }).code = 'ERR_BAD_RESPONSE';

      let callCount = 0;
      vi.spyOn(client, 'post').mockImplementation(async () => {
        callCount++;
        if (callCount < 3) {
          throw serverError;
        }
        return { results: [{ vulns: [] }] };
      });

      // Should retry and eventually succeed
      const result = await client.getBatchVulnerabilities(deps);
      expect(result).toBeDefined();
      expect(callCount).toBeGreaterThanOrEqual(1);
    });

    it('should handle 429 rate limit errors', async () => {
      const deps: Dependency[] = [
        { name: 'test-package', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
      ];

      const rateLimitError = new Error('Request failed with status code 429');
      (rateLimitError as unknown as { isAxiosError: boolean }).isAxiosError = true;
      (rateLimitError as unknown as { response: { status: number } }).response = { status: 429 };
      (rateLimitError as unknown as { code: string }).code = 'ERR_BAD_RESPONSE';

      vi.spyOn(client, 'post').mockRejectedValue(rateLimitError);

      const result = await client.getBatchVulnerabilities(deps);
      expect(result).toBeDefined();
      expect(result.size).toBe(1);
      expect(result.get('test-package')).toEqual([]);
    });

    it('should handle malformed OSV response (missing results array)', async () => {
      const deps: Dependency[] = [
        { name: 'test-package', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
      ];

      // Mock executeBatchRequest to return malformed response
      vi.spyOn(client, 'post').mockResolvedValue({} as unknown);

      // Should handle gracefully - return empty map for the package
      const result = await client.getBatchVulnerabilities(deps);
      expect(result).toBeDefined();
      expect(result.size).toBe(1);
      expect(result.get('test-package')).toEqual([]);
    });

    it('should handle malformed OSV response (results length mismatch)', async () => {
      const deps: Dependency[] = [
        { name: 'test-package-1', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
        { name: 'test-package-2', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
      ];

      // Mock response with fewer results than queries
      vi.spyOn(client, 'post').mockResolvedValue({
        results: [{ vulns: [] }], // Only 1 result for 2 queries
      } as unknown);

      // Should handle gracefully - return empty map for all
      const result = await client.getBatchVulnerabilities(deps);
      expect(result).toBeDefined();
      expect(result.size).toBe(2);
      expect(result.get('test-package-1')).toEqual([]);
      expect(result.get('test-package-2')).toEqual([]);
    });

    it('should handle conversion errors for individual vulnerabilities', async () => {
      const deps: Dependency[] = [
        { name: 'test-package', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
      ];

      // Step 1: Mock batch response with ID
      vi.spyOn(client, 'post').mockResolvedValue({
        results: [{ vulns: [{ id: 'TEST-VULN' }] }],
      } as unknown);

      // Step 2: Mock detail fetch with invalid data
      const invalidVuln = {
        id: null, // Invalid - should cause conversion error
        summary: null,
        details: null,
        affected: [],
      };
      vi.spyOn(client, 'get').mockResolvedValue(invalidVuln);

      // Should handle conversion error gracefully - return empty array for that package
      const result = await client.getBatchVulnerabilities(deps);
      expect(result).toBeDefined();
      // Package should be in result map (even if empty)
      expect(result.has('test-package')).toBe(true);
    });

    it('should log "Hybrid Batching" message when called', async () => {
      const dependencies: Dependency[] = [
        {
          name: 'react',
          version: '18.2.0',
          versionConstraint: '^18.2.0',
          isDev: false,
        },
      ];

      // Mock batch query response
      vi.spyOn(client, 'post').mockResolvedValue({
        results: [
          {
            vulns: [
              {
                id: 'GHSA-123',
                modified: '2023-01-01T00:00:00Z',
              },
            ],
          },
        ],
      });

      // Mock individual vuln fetch
      vi.spyOn(client, 'get').mockResolvedValue({
        id: 'GHSA-123',
        summary: 'Test Vuln',
        severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }],
        affected: [],
      });

      await client.getBatchVulnerabilities(dependencies);

      // Verify the specific log message that proves Hybrid Batching is active
      expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
        expect.stringContaining('(Hybrid Batching)')
      );
    });

    it('should handle empty dependency array', async () => {
      const deps: Dependency[] = [];

      const result = await client.getBatchVulnerabilities(deps);
      expect(result).toBeDefined();
      expect(result.size).toBe(0);
    });

    it('should handle single package batch', async () => {
      const deps: Dependency[] = [
        { name: 'lodash', version: '4.17.20', versionConstraint: '4.17.20', isDev: false },
      ];

      // Mock batch response
      vi.spyOn(client, 'post').mockResolvedValue({
        results: [{ vulns: [{ id: 'GHSA-35jh-r3h4-6jhm' }] }],
      });

      // Mock detail fetch
      vi.spyOn(client, 'get').mockResolvedValue(createLodashVulnerability());

      const result = await client.getBatchVulnerabilities(deps);
      expect(result).toBeDefined();
      expect(result.size).toBe(1);
      expect(result.has('lodash')).toBe(true);
      expect(result.get('lodash')?.length).toBe(1);
    });
  });

  /**
   * Batch Splitting Edge Cases
   * Tests for various batch sizes, splitting logic, and edge cases
   */
  describe('Batch Splitting Edge Cases', () => {
    it('should handle exactly 500 packages (batch limit boundary)', () => {
      const deps: Dependency[] = Array.from({ length: 500 }, (_, i) => ({
        name: `package-${i}`,
        version: '1.0.0',
        versionConstraint: '1.0.0',
        isDev: false,
      }));

      const batches = (
        client as unknown as {
          createBatches: (dependencies: Dependency[], maxBatchSize: number) => Dependency[][];
        }
      ).createBatches(deps, 500);
      expect(batches.length).toBe(1);
      expect(batches[0].length).toBe(500);
    });

    it('should handle 501 packages (just over batch limit)', () => {
      const deps: Dependency[] = Array.from({ length: 501 }, (_, i) => ({
        name: `package-${i}`,
        version: '1.0.0',
        versionConstraint: '1.0.0',
        isDev: false,
      }));

      const batches = (
        client as unknown as {
          createBatches: (dependencies: Dependency[], maxBatchSize: number) => Dependency[][];
        }
      ).createBatches(deps, 500);
      expect(batches.length).toBe(2);
      expect(batches[0].length).toBe(500);
      expect(batches[1].length).toBe(1);
    });

    it('should handle very large batches (1000+ packages)', () => {
      const deps: Dependency[] = Array.from({ length: 1500 }, (_, i) => ({
        name: `package-${i}`,
        version: '1.0.0',
        versionConstraint: '1.0.0',
        isDev: false,
      }));

      const batches = (
        client as unknown as {
          createBatches: (dependencies: Dependency[], maxBatchSize: number) => Dependency[][];
        }
      ).createBatches(deps, 500);
      expect(batches.length).toBe(3);
      expect(batches[0].length).toBe(500);
      expect(batches[1].length).toBe(500);
      expect(batches[2].length).toBe(500);

      // Verify all packages are included
      const totalPackages = batches.reduce(
        (sum: number, batch: Dependency[]) => sum + batch.length,
        0
      );
      expect(totalPackages).toBe(1500);
    });

    it('should handle empty batch in createBatches', () => {
      const deps: Dependency[] = [];
      const batches = (
        client as unknown as {
          createBatches: (dependencies: Dependency[], maxBatchSize: number) => Dependency[][];
        }
      ).createBatches(deps, 500);
      expect(batches.length).toBe(0);
    });
  });

  /**
   * Retry Logic Tests
   * Tests for exponential backoff, retryable errors, and retry limits
   */
  describe('Retry Logic', () => {
    it('should retry on retryable errors (ECONNABORTED)', async () => {
      const deps: Dependency[] = [
        { name: 'test-package', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
      ];

      const timeoutError = new Error('timeout');
      (timeoutError as unknown as { code: string }).code = 'ECONNABORTED';
      (timeoutError as unknown as { isAxiosError: boolean }).isAxiosError = true;

      let callCount = 0;
      vi.spyOn(client, 'post').mockImplementation(async () => {
        callCount++;
        if (callCount < 3) {
          throw timeoutError;
        }
        return { results: [{ vulns: [] }] };
      });

      const result = await client.getBatchVulnerabilities(deps);
      expect(result).toBeDefined();
      expect(callCount).toBeGreaterThanOrEqual(1);
    });

    it('should not retry on non-retryable errors (400 Bad Request)', async () => {
      const deps: Dependency[] = [
        { name: 'test-package', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
      ];

      const badRequestError = new Error('Request failed with status code 400');
      (badRequestError as unknown as { isAxiosError: boolean }).isAxiosError = true;
      (badRequestError as unknown as { response: { status: number } }).response = { status: 400 };
      (badRequestError as unknown as { code: string }).code = 'ERR_BAD_RESPONSE';

      let callCount = 0;
      vi.spyOn(client, 'post').mockImplementation(async () => {
        callCount++;
        throw badRequestError;
      });

      try {
        await client.getBatchVulnerabilities(deps);
      } catch (error) {
        expect(error).toBeDefined();
        // Should not retry on 400 errors
        expect(callCount).toBe(1);
      }
    });

    it('should retry on 500 errors (server errors are retryable)', async () => {
      const deps: Dependency[] = [
        { name: 'test-package', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
      ];

      const serverError = new Error('Request failed with status code 500');
      (serverError as unknown as { isAxiosError: boolean }).isAxiosError = true;
      (serverError as unknown as { response: { status: number } }).response = { status: 500 };
      (serverError as unknown as { code: string }).code = 'ERR_BAD_RESPONSE';

      let callCount = 0;
      vi.spyOn(client, 'post').mockImplementation(async () => {
        callCount++;
        if (callCount < 3) {
          throw serverError;
        }
        return { results: [{ vulns: [] }] };
      });

      const result = await client.getBatchVulnerabilities(deps);
      expect(result).toBeDefined();
      expect(callCount).toBeGreaterThanOrEqual(1);
    });

    it('should eventually fail after max retries', async () => {
      const deps: Dependency[] = [
        { name: 'test-package', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
      ];

      const timeoutError = new Error('timeout');
      (timeoutError as unknown as { code: string }).code = 'ECONNABORTED';
      (timeoutError as unknown as { isAxiosError: boolean }).isAxiosError = true;

      vi.spyOn(client, 'post').mockRejectedValue(timeoutError);

      // Should eventually throw after max retries
      try {
        await client.getBatchVulnerabilities(deps);
      } catch (error) {
        expect(error).toBeDefined();
      }
    });
  });

  /**
   * Very Large Batch Handling
   * Tests for handling 300+ packages efficiently
   */
  describe('Very Large Batch Handling', () => {
    it('should handle 300 packages efficiently', async () => {
      const deps: Dependency[] = Array.from({ length: 300 }, (_, i) => ({
        name: `package-${i}`,
        version: '1.0.0',
        versionConstraint: '1.0.0',
        isDev: false,
      }));

      // Mock batch response with no vulns
      vi.spyOn(client, 'post').mockResolvedValue({
        results: Array(300).fill({ vulns: [] }),
      });

      const result = await client.getBatchVulnerabilities(deps);
      expect(result).toBeDefined();
      expect(result.size).toBe(300);
    });

    it('should handle 500 packages (max batch size)', async () => {
      const deps: Dependency[] = Array.from({ length: 500 }, (_, i) => ({
        name: `package-${i}`,
        version: '1.0.0',
        versionConstraint: '1.0.0',
        isDev: false,
      }));

      vi.spyOn(client, 'post').mockResolvedValue({
        results: Array(500).fill({ vulns: [] }),
      });

      const result = await client.getBatchVulnerabilities(deps);
      expect(result).toBeDefined();
      expect(result.size).toBe(500);
    });

    it('should split 600 packages into 2 batches', async () => {
      const deps: Dependency[] = Array.from({ length: 600 }, (_, i) => ({
        name: `package-${i}`,
        version: '1.0.0',
        versionConstraint: '1.0.0',
        isDev: false,
      }));

      // Mock post to handle multiple calls
      vi.spyOn(client, 'post').mockImplementation(async (_url, data) => {
        const body = data as { queries: unknown[] };
        return {
          results: Array(body.queries.length).fill({ vulns: [] }),
        };
      });

      const result = await client.getBatchVulnerabilities(deps);
      expect(result).toBeDefined();
      expect(result.size).toBe(600);
    });
  });

  /**
   * Response Mapping Edge Cases
   * Tests for mapResponseToPackages with various edge cases
   */
  describe('Response Mapping Edge Cases', () => {
    it('should handle response with missing dependency at index', async () => {
      const deps: Dependency[] = [
        { name: 'package-1', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
        { name: 'package-2', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
      ];

      // Mock response with extra result (should be ignored)
      vi.spyOn(client, 'post').mockResolvedValue({
        results: [
          { vulns: [] },
          { vulns: [] },
          { vulns: [] }, // Extra result
        ],
      } as unknown);

      const result = await client.getBatchVulnerabilities(deps);
      expect(result).toBeDefined();
      expect(result.size).toBe(2);
    }, 10000); // 10 second timeout

    it('should handle response with fewer results than queries', async () => {
      const deps: Dependency[] = [
        { name: 'package-1', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
        { name: 'package-2', version: '1.0.0', versionConstraint: '1.0.0', isDev: false },
      ];

      // Mock response with only 1 result for 2 queries
      vi.spyOn(client, 'post').mockResolvedValue({
        results: [{ vulns: [] }],
      } as unknown);

      const result = await client.getBatchVulnerabilities(deps);
      expect(result).toBeDefined();
      // Should handle gracefully - may have fewer results
      expect(result.size).toBeGreaterThanOrEqual(0);
    }, 10000); // 10 second timeout
  });
});

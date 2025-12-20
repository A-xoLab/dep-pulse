import { beforeEach, describe, expect, it } from 'vitest';
import type { LicenseConfig } from '../config/LicenseConfig';
import type { LicenseAnalysis } from '../types';
import { LicenseCompatibilityChecker } from './LicenseCompatibilityChecker';

describe('LicenseCompatibilityChecker', () => {
  let checker: LicenseCompatibilityChecker;

  beforeEach(() => {
    checker = new LicenseCompatibilityChecker();
  });

  const createLicense = (overrides: Partial<LicenseAnalysis> = {}): LicenseAnalysis => ({
    license: 'MIT',
    spdxId: 'MIT',
    spdxIds: ['MIT'],
    isCompatible: false,
    licenseType: 'permissive',
    riskLevel: 'low',
    requiresAttribution: true,
    requiresSourceCode: false,
    ...overrides,
  });

  const createConfig = (overrides: Partial<LicenseConfig> = {}): LicenseConfig => ({
    acceptableLicenses: ['MIT', 'Apache-2.0', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause'],
    strictMode: false,
    ...overrides,
  });

  describe('checkCompatibility', () => {
    it('should mark license as compatible if in acceptable list', () => {
      const license = createLicense({ spdxIds: ['MIT'] });
      const config = createConfig();
      const result = checker.checkCompatibility(license, config);

      expect(result.isCompatible).toBe(true);
      expect(result.reason).toContain('MIT');
      expect(result.reason).toContain('acceptable');
    });

    it('should mark license as incompatible if not in acceptable list', () => {
      const license = createLicense({ spdxIds: ['GPL-3.0'], licenseType: 'copyleft' });
      const config = createConfig();
      const result = checker.checkCompatibility(license, config);

      expect(result.isCompatible).toBe(false);
      expect(result.reason).toContain('copyleft');
    });

    it('should handle multiple SPDX IDs with one acceptable', () => {
      const license = createLicense({ spdxIds: ['MIT', 'Apache-2.0'] });
      const config = createConfig();
      const result = checker.checkCompatibility(license, config);

      expect(result.isCompatible).toBe(true);
    });

    it('should mark unknown license as incompatible', () => {
      const license = createLicense({
        license: 'Unknown',
        spdxIds: [],
        licenseType: 'unknown',
      });
      const config = createConfig();
      const result = checker.checkCompatibility(license, config);

      expect(result.isCompatible).toBe(false);
      expect(result.reason).toContain('unknown');
    });

    it('should handle proprietary license', () => {
      const license = createLicense({
        license: 'UNLICENSED',
        spdxIds: ['UNLICENSED'],
        licenseType: 'proprietary',
      });
      const config = createConfig();
      const result = checker.checkCompatibility(license, config);

      expect(result.isCompatible).toBe(false);
      expect(result.reason).toContain('Proprietary');
    });

    it('should handle copyleft license in non-strict mode', () => {
      const license = createLicense({
        license: 'GPL-3.0',
        spdxIds: ['GPL-3.0'],
        licenseType: 'copyleft',
      });
      const config = createConfig({ strictMode: false });
      const result = checker.checkCompatibility(license, config);

      expect(result.isCompatible).toBe(false);
      expect(result.reason).toContain('copyleft');
    });

    it('should handle copyleft license in strict mode', () => {
      const license = createLicense({
        license: 'GPL-3.0',
        spdxIds: ['GPL-3.0'],
        licenseType: 'copyleft',
      });
      const config = createConfig({ strictMode: true });
      const result = checker.checkCompatibility(license, config);

      expect(result.isCompatible).toBe(false);
      expect(result.reason).toContain('Strict mode');
    });
  });

  describe('compatibility matrix', () => {
    it('should detect GPL conflict with proprietary project license', () => {
      const license = createLicense({
        license: 'MIT',
        spdxIds: ['MIT'],
        licenseType: 'permissive',
      });
      const config = createConfig();
      const result = checker.checkCompatibility(license, config, 'UNLICENSED');

      // MIT is acceptable, but check if there are conflicts
      // In this case, MIT should be compatible even with proprietary project
      expect(result.isCompatible).toBe(true);
    });

    it('should detect conflict when dependency is GPL and project is proprietary', () => {
      const license = createLicense({
        license: 'GPL-3.0',
        spdxIds: ['GPL-3.0'],
        licenseType: 'copyleft',
      });
      const config = createConfig({ acceptableLicenses: ['GPL-3.0', 'MIT'] });
      const result = checker.checkCompatibility(license, config, 'UNLICENSED');

      // Even if GPL-3.0 is in acceptable list, it conflicts with proprietary project
      expect(result.isCompatible).toBe(false);
      expect(result.conflictsWith).toBeDefined();
      expect(result.conflictsWith?.length).toBeGreaterThan(0);
    });

    it('should detect conflict when project is GPL and dependency is proprietary', () => {
      const license = createLicense({
        license: 'UNLICENSED',
        spdxIds: ['UNLICENSED'],
        licenseType: 'proprietary',
      });
      const config = createConfig({ acceptableLicenses: ['UNLICENSED', 'MIT'] });
      const result = checker.checkCompatibility(license, config, 'GPL-3.0');

      expect(result.isCompatible).toBe(false);
      expect(result.conflictsWith).toBeDefined();
      expect(result.conflictsWith?.some((c) => c.includes('proprietary'))).toBe(true);
    });

    it('should handle AGPL conflicts', () => {
      const license = createLicense({
        license: 'AGPL-3.0',
        spdxIds: ['AGPL-3.0'],
        licenseType: 'copyleft',
      });
      const config = createConfig({ acceptableLicenses: ['AGPL-3.0'] });
      const result = checker.checkCompatibility(license, config, 'UNLICENSED');

      expect(result.isCompatible).toBe(false);
      expect(result.conflictsWith).toBeDefined();
    });

    it('should handle GPL variations in matrix', () => {
      const variations = [
        'GPL-2.0',
        'GPL-2.0-only',
        'GPL-2.0-or-later',
        'GPL-3.0',
        'GPL-3.0-only',
        'GPL-3.0-or-later',
      ];

      for (const gplVersion of variations) {
        const license = createLicense({
          license: gplVersion,
          spdxIds: [gplVersion],
          licenseType: 'copyleft',
        });
        const config = createConfig({ acceptableLicenses: [gplVersion] });
        const result = checker.checkCompatibility(license, config, 'UNLICENSED');

        expect(result.isCompatible).toBe(false);
        expect(result.conflictsWith).toBeDefined();
      }
    });
  });

  describe('explainCompatibility', () => {
    it('should return compatibility reason for compatible license', () => {
      const license = createLicense({
        isCompatible: true,
        compatibilityReason: 'License is in acceptable list',
      });
      const result = checker.explainCompatibility(license);

      expect(result).toBe('License is in acceptable list');
    });

    it('should return default reason if no compatibility reason provided', () => {
      const license = createLicense({
        isCompatible: true,
        compatibilityReason: undefined,
      });
      const result = checker.explainCompatibility(license);

      expect(result).toBe('License is compatible with your project.');
    });

    it('should return incompatibility reason', () => {
      const license = createLicense({
        isCompatible: false,
        compatibilityReason: 'Strict mode violation',
      });
      const result = checker.explainCompatibility(license);

      expect(result).toBe('Strict mode violation');
    });

    it('should return default incompatibility reason for proprietary', () => {
      const license = createLicense({
        isCompatible: false,
        licenseType: 'proprietary',
        compatibilityReason: undefined,
      });
      const result = checker.explainCompatibility(license);

      expect(result).toContain('Proprietary');
    });

    it('should return default incompatibility reason for copyleft', () => {
      const license = createLicense({
        isCompatible: false,
        licenseType: 'copyleft',
        compatibilityReason: undefined,
      });
      const result = checker.explainCompatibility(license);

      expect(result).toContain('Copyleft');
    });

    it('should return default incompatibility reason for unknown', () => {
      const license = createLicense({
        isCompatible: false,
        licenseType: 'unknown',
        compatibilityReason: undefined,
      });
      const result = checker.explainCompatibility(license);

      expect(result).toContain('Unknown');
    });
  });

  describe('edge cases', () => {
    it('should handle empty acceptable licenses list', () => {
      const license = createLicense({ spdxIds: ['MIT'] });
      const config = createConfig({ acceptableLicenses: [] });
      const result = checker.checkCompatibility(license, config);

      expect(result.isCompatible).toBe(false);
    });

    it('should handle license with no SPDX ID but has license string', () => {
      const license = createLicense({
        license: 'Custom License',
        spdxId: undefined,
        spdxIds: [],
        licenseType: 'unknown',
      });
      const config = createConfig();
      const result = checker.checkCompatibility(license, config);

      expect(result.isCompatible).toBe(false);
      expect(result.reason).toContain('unknown');
    });

    it('should handle permissive license not in list', () => {
      const license = createLicense({
        license: 'Zlib',
        spdxIds: ['Zlib'],
        licenseType: 'permissive',
      });
      const config = createConfig();
      const result = checker.checkCompatibility(license, config);

      expect(result.isCompatible).toBe(false);
      expect(result.reason).toContain('not in your acceptable licenses list');
    });

    it('should handle case-insensitive project license matching', () => {
      const license = createLicense({
        license: 'GPL-3.0',
        spdxIds: ['GPL-3.0'],
        licenseType: 'copyleft',
      });
      const config = createConfig({ acceptableLicenses: ['GPL-3.0'] });
      const result = checker.checkCompatibility(license, config, 'unlicensed');

      expect(result.isCompatible).toBe(false);
      expect(result.conflictsWith).toBeDefined();
    });

    it('should handle multiple conflicts', () => {
      const license = createLicense({
        license: 'GPL-3.0',
        spdxIds: ['GPL-3.0', 'GPL-2.0'],
        licenseType: 'copyleft',
      });
      const config = createConfig({ acceptableLicenses: ['GPL-3.0', 'GPL-2.0'] });
      const result = checker.checkCompatibility(license, config, 'UNLICENSED');

      expect(result.isCompatible).toBe(false);
      expect(result.conflictsWith).toBeDefined();
      expect(result.conflictsWith?.length).toBeGreaterThan(0);
    });
  });

  describe('strict mode behavior', () => {
    it('should be more restrictive in strict mode for copyleft', () => {
      const license = createLicense({
        license: 'LGPL-2.1',
        spdxIds: ['LGPL-2.1'],
        licenseType: 'copyleft',
      });
      const nonStrict = createConfig({ strictMode: false });
      const strict = createConfig({ strictMode: true });

      const nonStrictResult = checker.checkCompatibility(license, nonStrict);
      const strictResult = checker.checkCompatibility(license, strict);

      // Both should be incompatible if not in acceptable list
      expect(nonStrictResult.isCompatible).toBe(false);
      expect(strictResult.isCompatible).toBe(false);
      // But strict mode should mention strict mode in reason
      expect(strictResult.reason).toContain('Strict mode');
    });

    it('should allow permissive licenses in strict mode if in list', () => {
      const license = createLicense({
        license: 'MIT',
        spdxIds: ['MIT'],
        licenseType: 'permissive',
      });
      const config = createConfig({ strictMode: true });
      const result = checker.checkCompatibility(license, config);

      expect(result.isCompatible).toBe(true);
    });
  });
});

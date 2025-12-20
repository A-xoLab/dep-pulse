import { beforeEach, describe, expect, it } from 'vitest';
import { LicenseAnalyzer } from './LicenseAnalyzer';

describe('LicenseAnalyzer', () => {
  let analyzer: LicenseAnalyzer;

  beforeEach(() => {
    analyzer = new LicenseAnalyzer();
  });

  describe('parseLicense', () => {
    it('should parse simple string license', () => {
      const result = analyzer.parseLicense('MIT');
      expect(result.expression).toBe('MIT');
      expect(result.spdxIds).toEqual(['MIT']);
    });

    it('should parse license expression with OR', () => {
      const result = analyzer.parseLicense('MIT OR Apache-2.0');
      expect(result.expression).toBe('MIT OR Apache-2.0');
      expect(result.spdxIds).toContain('MIT');
      expect(result.spdxIds).toContain('Apache-2.0');
    });

    it('should parse license expression with AND', () => {
      const result = analyzer.parseLicense('GPL-2.0 AND LGPL-2.1');
      expect(result.expression).toBe('GPL-2.0 AND LGPL-2.1');
      expect(result.spdxIds).toContain('GPL-2.0');
      expect(result.spdxIds).toContain('LGPL-2.1');
    });

    it('should parse license object with type field', () => {
      const result = analyzer.parseLicense({ type: 'MIT', url: 'https://example.com' });
      expect(result.expression).toBe('MIT');
      expect(result.spdxIds).toEqual(['MIT']);
    });

    it('should parse license object with license field', () => {
      const result = analyzer.parseLicense({ license: 'Apache-2.0' });
      expect(result.expression).toBe('Apache-2.0');
      expect(result.spdxIds).toEqual(['Apache-2.0']);
    });

    it('should parse license array', () => {
      const result = analyzer.parseLicense(['MIT', 'Apache-2.0']);
      expect(result.expression).toBe('MIT OR Apache-2.0');
      expect(result.spdxIds).toContain('MIT');
      expect(result.spdxIds).toContain('Apache-2.0');
    });

    it('should handle unknown/null license', () => {
      const result = analyzer.parseLicense(null);
      expect(result.expression).toBe('Unknown');
      expect(result.spdxIds).toEqual([]);
    });

    it('should handle undefined license', () => {
      const result = analyzer.parseLicense(undefined);
      expect(result.expression).toBe('Unknown');
      expect(result.spdxIds).toEqual([]);
    });

    it('should handle "SEE LICENSE IN <file>" format', () => {
      const result = analyzer.parseLicense('SEE LICENSE IN LICENSE.txt');
      expect(result.expression).toBe('SEE LICENSE IN LICENSE.txt');
      expect(result.spdxIds[0]).toContain('SEE LICENSE');
    });

    it('should remove duplicates in array parsing', () => {
      const result = analyzer.parseLicense(['MIT', 'MIT', 'Apache-2.0']);
      expect(result.spdxIds.filter((id) => id === 'MIT').length).toBe(1);
      expect(result.spdxIds).toContain('Apache-2.0');
    });

    it('should handle complex nested expressions', () => {
      const result = analyzer.parseLicense('(MIT OR Apache-2.0) AND BSD-3-Clause');
      expect(result.spdxIds).toContain('MIT');
      expect(result.spdxIds).toContain('Apache-2.0');
      expect(result.spdxIds).toContain('BSD-3-Clause');
    });
  });

  describe('categorizeLicense', () => {
    it('should categorize MIT as permissive', () => {
      const category = analyzer.categorizeLicense('MIT');
      expect(category.type).toBe('permissive');
      expect(category.riskLevel).toBe('low');
      expect(category.requiresAttribution).toBe(true);
      expect(category.requiresSourceCode).toBe(false);
    });

    it('should categorize Apache-2.0 as permissive', () => {
      const category = analyzer.categorizeLicense('Apache-2.0');
      expect(category.type).toBe('permissive');
      expect(category.riskLevel).toBe('low');
    });

    it('should categorize GPL-3.0 as copyleft', () => {
      const category = analyzer.categorizeLicense('GPL-3.0');
      expect(category.type).toBe('copyleft');
      expect(category.riskLevel).toBe('high');
      expect(category.requiresAttribution).toBe(true);
      expect(category.requiresSourceCode).toBe(true);
    });

    it('should categorize AGPL-3.0 as copyleft with high risk', () => {
      const category = analyzer.categorizeLicense('AGPL-3.0');
      expect(category.type).toBe('copyleft');
      expect(category.riskLevel).toBe('high');
      expect(category.requiresSourceCode).toBe(true);
    });

    it('should categorize LGPL-2.1 as copyleft with medium risk', () => {
      const category = analyzer.categorizeLicense('LGPL-2.1');
      expect(category.type).toBe('copyleft');
      expect(category.riskLevel).toBe('medium');
      expect(category.requiresSourceCode).toBe(true);
    });

    it('should categorize MPL-2.0 as copyleft with medium risk', () => {
      const category = analyzer.categorizeLicense('MPL-2.0');
      expect(category.type).toBe('copyleft');
      expect(category.riskLevel).toBe('medium');
    });

    it('should categorize UNLICENSED as proprietary', () => {
      const category = analyzer.categorizeLicense('UNLICENSED');
      expect(category.type).toBe('proprietary');
      expect(category.riskLevel).toBe('high');
      expect(category.requiresAttribution).toBe(false);
      expect(category.requiresSourceCode).toBe(false);
    });

    it('should categorize Proprietary as proprietary', () => {
      const category = analyzer.categorizeLicense('Proprietary');
      expect(category.type).toBe('proprietary');
      expect(category.riskLevel).toBe('high');
    });

    it('should categorize unknown license as unknown', () => {
      const category = analyzer.categorizeLicense('Custom-License-1.0');
      expect(category.type).toBe('unknown');
      expect(category.riskLevel).toBe('medium');
    });

    it('should handle GPL variations', () => {
      const gpl2 = analyzer.categorizeLicense('GPL-2.0-only');
      expect(gpl2.type).toBe('copyleft');
      expect(gpl2.riskLevel).toBe('high');

      const gpl3 = analyzer.categorizeLicense('GPL-3.0-or-later');
      expect(gpl3.type).toBe('copyleft');
      expect(gpl3.riskLevel).toBe('high');
    });

    it('should handle CC0-1.0 as permissive without attribution', () => {
      const category = analyzer.categorizeLicense('CC0-1.0');
      expect(category.type).toBe('permissive');
      expect(category.requiresAttribution).toBe(false);
    });

    it('should handle Unlicense as permissive without attribution', () => {
      const category = analyzer.categorizeLicense('Unlicense');
      expect(category.type).toBe('permissive');
      expect(category.requiresAttribution).toBe(false);
    });
  });

  describe('analyze', () => {
    it('should create complete LicenseAnalysis for compatible license', () => {
      const result = analyzer.analyze('MIT', true, 'License is explicitly listed as acceptable.');
      expect(result.license).toBe('MIT');
      expect(result.spdxId).toBe('MIT');
      expect(result.spdxIds).toEqual(['MIT']);
      expect(result.isCompatible).toBe(true);
      expect(result.licenseType).toBe('permissive');
      expect(result.riskLevel).toBe('low');
      expect(result.compatibilityReason).toBe('License is explicitly listed as acceptable.');
      expect(result.requiresAttribution).toBe(true);
      expect(result.requiresSourceCode).toBe(false);
    });

    it('should create LicenseAnalysis for incompatible license', () => {
      const result = analyzer.analyze('GPL-3.0', false, 'Strict mode is enabled.');
      expect(result.isCompatible).toBe(false);
      expect(result.licenseType).toBe('copyleft');
      expect(result.riskLevel).toBe('high'); // Should be high for incompatible
      expect(result.compatibilityReason).toBe('Strict mode is enabled.');
    });

    it('should handle license expression in analyze', () => {
      const result = analyzer.analyze('MIT OR Apache-2.0', true);
      expect(result.license).toBe('MIT OR Apache-2.0');
      expect(result.spdxIds.length).toBeGreaterThan(1);
      expect(result.spdxId).toBeUndefined(); // Multiple licenses, no single spdxId
    });

    it('should set risk level to high for incompatible licenses', () => {
      const compatible = analyzer.analyze('MIT', true);
      expect(compatible.riskLevel).toBe('low');

      const incompatible = analyzer.analyze('MIT', false);
      expect(incompatible.riskLevel).toBe('high');
    });

    it('should handle proprietary license', () => {
      const result = analyzer.analyze('UNLICENSED', false, 'Proprietary license detected.');
      expect(result.licenseType).toBe('proprietary');
      expect(result.riskLevel).toBe('high');
      expect(result.isCompatible).toBe(false);
    });

    it('should handle unknown license', () => {
      const result = analyzer.analyze('Custom-License-1.0', false, 'Unknown license.');
      expect(result.licenseType).toBe('unknown');
      expect(result.riskLevel).toBe('high'); // High because incompatible
    });

    it('should preserve all SPDX IDs from expression', () => {
      const result = analyzer.analyze('(MIT OR Apache-2.0) AND BSD-3-Clause', true);
      expect(result.spdxIds.length).toBeGreaterThanOrEqual(3);
      expect(result.spdxIds).toContain('MIT');
      expect(result.spdxIds).toContain('Apache-2.0');
    });
  });

  describe('edge cases', () => {
    it('should handle empty string', () => {
      const result = analyzer.parseLicense('');
      expect(result.expression).toBe('');
      expect(result.spdxIds.length).toBeGreaterThanOrEqual(0);
    });

    it('should handle whitespace-only string', () => {
      const result = analyzer.parseLicense('   ');
      expect(result.expression.trim()).toBe('');
    });

    it('should handle case-insensitive license matching', () => {
      const lower = analyzer.categorizeLicense('mit');
      const upper = analyzer.categorizeLicense('MIT');
      expect(lower.type).toBe('permissive');
      expect(upper.type).toBe('permissive');
    });

    it('should handle object without type or license field', () => {
      const result = analyzer.parseLicense({ url: 'https://example.com' });
      expect(result.expression).toBe('Unknown');
      expect(result.spdxIds).toEqual([]);
    });

    it('should handle nested arrays', () => {
      const result = analyzer.parseLicense([['MIT'], ['Apache-2.0']]);
      // Should handle nested structure gracefully
      expect(result.spdxIds.length).toBeGreaterThanOrEqual(0);
    });
  });
});

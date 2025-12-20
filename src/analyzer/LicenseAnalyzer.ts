import type { LicenseAnalysis } from '../types';

/**
 * Parsed license information from npm registry
 */
export interface ParsedLicense {
  spdxIds: string[];
  expression: string;
}

/**
 * License category metadata
 */
export interface LicenseCategory {
  type: 'permissive' | 'copyleft' | 'proprietary' | 'unknown';
  riskLevel: 'low' | 'medium' | 'high';
  requiresAttribution: boolean;
  requiresSourceCode: boolean;
  description: string;
}

/**
 * Analyzes and categorizes licenses from npm packages
 * Handles SPDX identifiers, license expressions, and various npm license formats
 */
export class LicenseAnalyzer {
  // Common permissive licenses (SPDX identifiers)
  private readonly PERMISSIVE_LICENSES = new Set([
    'MIT',
    'ISC',
    'Apache-2.0',
    'BSD-2-Clause',
    'BSD-3-Clause',
    'BSD-4-Clause',
    'CC0-1.0',
    'Unlicense',
    'WTFPL',
    '0BSD',
    'Artistic-2.0',
    'Zlib',
  ]);

  // Common copyleft licenses
  private readonly COPYLEFT_LICENSES = new Set([
    'GPL-2.0',
    'GPL-2.0-only',
    'GPL-2.0-or-later',
    'GPL-3.0',
    'GPL-3.0-only',
    'GPL-3.0-or-later',
    'AGPL-1.0',
    'AGPL-3.0',
    'AGPL-3.0-only',
    'AGPL-3.0-or-later',
    'LGPL-2.1',
    'LGPL-2.1-only',
    'LGPL-2.1-or-later',
    'LGPL-3.0',
    'LGPL-3.0-only',
    'LGPL-3.0-or-later',
    'MPL-2.0',
    'EPL-1.0',
    'EPL-2.0',
  ]);

  // Proprietary/commercial indicators (all uppercase for case-insensitive matching)
  private readonly PROPRIETARY_INDICATORS = new Set([
    'UNLICENSED',
    'PROPRIETARY',
    'COMMERCIAL',
    'PRIVATE',
  ]);

  /**
   * Parses license information from npm registry format
   * Handles: string, object, expression, and array formats
   */
  parseLicense(license: unknown): ParsedLicense {
    if (typeof license === 'string') {
      // Check if it's a license expression (contains OR/AND)
      if (license.includes(' OR ') || license.includes(' AND ')) {
        return this.parseExpression(license);
      }
      // Single license identifier
      return {
        spdxIds: [this.normalizeSpdxId(license)],
        expression: license,
      };
    }

    if (typeof license === 'object' && license !== null) {
      const obj = license as { type?: string; url?: string; [key: string]: unknown };
      if (obj.type) {
        return this.parseLicense(obj.type);
      }
      // Some packages use 'license' field in object
      if ('license' in obj && typeof obj.license === 'string') {
        return this.parseLicense(obj.license);
      }
    }

    // Array format (less common)
    if (Array.isArray(license)) {
      const spdxIds: string[] = [];
      for (const item of license) {
        const parsed = this.parseLicense(item);
        spdxIds.push(...parsed.spdxIds);
      }
      return {
        spdxIds: [...new Set(spdxIds)], // Remove duplicates
        expression: spdxIds.join(' OR '),
      };
    }

    return {
      spdxIds: [],
      expression: 'Unknown',
    };
  }

  /**
   * Parses SPDX license expression (e.g., "MIT OR Apache-2.0")
   */
  private parseExpression(expression: string): ParsedLicense {
    // Simple expression parser - handles basic OR/AND
    // For complex expressions, we extract all license identifiers
    const spdxIds: string[] = [];
    const parts = expression.split(/\s+(?:OR|AND)\s+/i);

    for (const part of parts) {
      // Remove parentheses and whitespace
      const cleaned = part.replace(/[()]/g, '').trim();
      if (cleaned) {
        spdxIds.push(this.normalizeSpdxId(cleaned));
      }
    }

    return {
      spdxIds: [...new Set(spdxIds)], // Remove duplicates
      expression,
    };
  }

  /**
   * Normalizes SPDX identifier (handles variations)
   */
  private normalizeSpdxId(identifier: string): string {
    // Remove common prefixes/suffixes
    let normalized = identifier.trim();

    // Handle "SEE LICENSE IN <file>" format
    if (normalized.startsWith('SEE LICENSE')) {
      return 'SEE LICENSE IN FILE';
    }

    // Handle version variations (GPL-2.0 vs GPL-2.0-only)
    // We keep the original but normalize common patterns
    normalized = normalized.replace(/\s+/g, '-');

    return normalized;
  }

  /**
   * Categorizes a license by SPDX identifier
   */
  categorizeLicense(spdxId: string): LicenseCategory {
    const upperId = spdxId.toUpperCase();

    // Check proprietary indicators (case-insensitive)
    if (this.PROPRIETARY_INDICATORS.has(upperId)) {
      return {
        type: 'proprietary',
        riskLevel: 'high',
        requiresAttribution: false,
        requiresSourceCode: false,
        description: 'Proprietary license - commercial use may be restricted',
      };
    }

    // Check permissive licenses (case-insensitive for common ones)
    const permissiveMatch = Array.from(this.PERMISSIVE_LICENSES).find(
      (license) => license.toUpperCase() === upperId
    );
    if (permissiveMatch || this.PERMISSIVE_LICENSES.has(spdxId)) {
      const matchedId = permissiveMatch || spdxId;
      return {
        type: 'permissive',
        riskLevel: 'low',
        requiresAttribution: this.requiresAttribution(matchedId),
        requiresSourceCode: false,
        description: this.getPermissiveDescription(matchedId),
      };
    }

    // Check copyleft licenses
    if (this.isCopyleftLicense(spdxId)) {
      return {
        type: 'copyleft',
        riskLevel: this.getCopyleftRiskLevel(spdxId),
        requiresAttribution: true,
        requiresSourceCode: this.requiresSourceCode(spdxId),
        description: this.getCopyleftDescription(spdxId),
      };
    }

    // Unknown license
    return {
      type: 'unknown',
      riskLevel: 'medium',
      requiresAttribution: false,
      requiresSourceCode: false,
      description: 'Unknown license - review terms before use',
    };
  }

  /**
   * Checks if a license is copyleft (including variations)
   */
  private isCopyleftLicense(spdxId: string): boolean {
    // Check exact match
    if (this.COPYLEFT_LICENSES.has(spdxId)) {
      return true;
    }

    // Check variations (GPL-2.0, GPL-2.0-only, GPL-2.0-or-later, etc.)
    const upperId = spdxId.toUpperCase();
    for (const copyleft of this.COPYLEFT_LICENSES) {
      if (upperId.startsWith(copyleft.toUpperCase().split('-')[0])) {
        return true;
      }
    }

    return false;
  }

  /**
   * Gets risk level for copyleft licenses
   */
  private getCopyleftRiskLevel(spdxId: string): 'medium' | 'high' {
    const upperId = spdxId.toUpperCase();
    // AGPL is highest risk (affects SaaS/web apps)
    if (upperId.includes('AGPL')) {
      return 'high';
    }
    // LGPL and MPL are medium risk (more permissive) - check before GPL
    if (upperId.includes('LGPL') || upperId.includes('MPL') || upperId.includes('EPL')) {
      return 'medium';
    }
    // GPL is high risk (requires open-sourcing)
    if (upperId.includes('GPL')) {
      return 'high';
    }
    // Default to medium for other copyleft licenses
    return 'medium';
  }

  /**
   * Checks if license requires attribution
   */
  private requiresAttribution(spdxId: string): boolean {
    // Most permissive licenses require attribution
    // CC0 and Unlicense don't
    return !['CC0-1.0', 'Unlicense', '0BSD'].includes(spdxId);
  }

  /**
   * Checks if license requires source code disclosure (copyleft)
   */
  private requiresSourceCode(spdxId: string): boolean {
    const upperId = spdxId.toUpperCase();
    // Strong copyleft (GPL, AGPL) requires source code
    return upperId.includes('GPL') || upperId.includes('AGPL');
  }

  /**
   * Gets description for permissive license
   */
  private getPermissiveDescription(spdxId: string): string {
    const descriptions: Record<string, string> = {
      MIT: 'MIT License - Very permissive, allows commercial use',
      'Apache-2.0': 'Apache 2.0 - Permissive with patent grant',
      ISC: 'ISC License - Similar to MIT, very permissive',
      'BSD-2-Clause': 'BSD 2-Clause - Permissive, minimal restrictions',
      'BSD-3-Clause': 'BSD 3-Clause - Permissive with no-endorsement clause',
      'CC0-1.0': 'CC0 - Public domain dedication, no restrictions',
      Unlicense: 'Unlicense - Public domain dedication',
      WTFPL: 'WTFPL - Do What The F*ck You Want To Public License',
    };

    return descriptions[spdxId] || 'Permissive license - allows commercial use';
  }

  /**
   * Gets description for copyleft license
   */
  private getCopyleftDescription(spdxId: string): string {
    const upperId = spdxId.toUpperCase();
    if (upperId.includes('AGPL')) {
      return 'AGPL - Strong copyleft, affects SaaS/web applications';
    }
    if (upperId.includes('GPL') && !upperId.includes('LGPL')) {
      return 'GPL - Strong copyleft, requires open-sourcing derivative works';
    }
    if (upperId.includes('LGPL')) {
      return 'LGPL - Weak copyleft, allows linking with proprietary code';
    }
    if (upperId.includes('MPL')) {
      return 'MPL - Weak copyleft, file-level copyleft only';
    }
    return 'Copyleft license - may require open-sourcing derivative works';
  }

  /**
   * Analyzes license and returns complete LicenseAnalysis
   */
  analyze(license: unknown, isCompatible: boolean, compatibilityReason?: string): LicenseAnalysis {
    const parsed = this.parseLicense(license);
    const primarySpdxId = parsed.spdxIds[0] || 'Unknown';
    const category = this.categorizeLicense(primarySpdxId);

    // Determine risk level based on category and compatibility
    let riskLevel: 'low' | 'medium' | 'high' = category.riskLevel;
    if (!isCompatible) {
      riskLevel = 'high';
    }

    return {
      license: parsed.expression,
      spdxId: parsed.spdxIds.length === 1 ? parsed.spdxIds[0] : undefined,
      spdxIds: parsed.spdxIds,
      isCompatible,
      licenseType: category.type,
      riskLevel,
      compatibilityReason,
      requiresAttribution: category.requiresAttribution,
      requiresSourceCode: category.requiresSourceCode,
    };
  }
}

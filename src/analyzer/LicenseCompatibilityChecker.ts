import type { LicenseConfig } from '../config/LicenseConfig';
import type { LicenseAnalysis } from '../types';

/**
 * Result of license compatibility check
 */
export interface CompatibilityResult {
  isCompatible: boolean;
  reason: string;
  conflictsWith?: string[];
}

/**
 * Checks license compatibility based on user configuration and compatibility matrix
 */
export class LicenseCompatibilityChecker {
  // Known incompatible license combinations
  // Key: license identifier, Value: array of incompatible license types/identifiers
  private readonly INCOMPATIBILITY_MATRIX = new Map<string, string[]>([
    // GPL requires open source - incompatible with proprietary
    ['GPL-2.0', ['proprietary', 'commercial', 'UNLICENSED']],
    ['GPL-2.0-only', ['proprietary', 'commercial', 'UNLICENSED']],
    ['GPL-2.0-or-later', ['proprietary', 'commercial', 'UNLICENSED']],
    ['GPL-3.0', ['proprietary', 'commercial', 'UNLICENSED']],
    ['GPL-3.0-only', ['proprietary', 'commercial', 'UNLICENSED']],
    ['GPL-3.0-or-later', ['proprietary', 'commercial', 'UNLICENSED']],
    // AGPL is even stricter
    ['AGPL-1.0', ['proprietary', 'commercial', 'UNLICENSED']],
    ['AGPL-3.0', ['proprietary', 'commercial', 'UNLICENSED']],
    ['AGPL-3.0-only', ['proprietary', 'commercial', 'UNLICENSED']],
    ['AGPL-3.0-or-later', ['proprietary', 'commercial', 'UNLICENSED']],
  ]);

  /**
   * Checks if a dependency license is compatible with user's configuration
   */
  checkCompatibility(
    depLicense: LicenseAnalysis,
    config: LicenseConfig,
    projectLicense?: string
  ): CompatibilityResult {
    // If license is unknown, mark as incompatible (needs review)
    if (depLicense.licenseType === 'unknown' && depLicense.spdxIds.length === 0) {
      return {
        isCompatible: false,
        reason: 'License is unknown or not specified. Review package license before use.',
      };
    }

    // Check if any of the license SPDX IDs are in acceptable list
    const hasAcceptableLicense = depLicense.spdxIds.some((spdxId) =>
      config.acceptableLicenses.includes(spdxId)
    );

    if (hasAcceptableLicense) {
      // Still check compatibility matrix for conflicts
      const conflicts = this.checkCompatibilityMatrix(depLicense, projectLicense);
      if (conflicts.length > 0) {
        return {
          isCompatible: false,
          reason: `License conflicts with project license or other dependencies: ${conflicts.join(', ')}`,
          conflictsWith: conflicts,
        };
      }

      return {
        isCompatible: true,
        reason: `License ${depLicense.spdxId || depLicense.license} is in your acceptable licenses list.`,
      };
    }

    // License not in acceptable list
    const reason = this.explainIncompatibility(depLicense, config);
    return {
      isCompatible: false,
      reason,
    };
  }

  /**
   * Checks license compatibility matrix for known conflicts
   */
  private checkCompatibilityMatrix(depLicense: LicenseAnalysis, projectLicense?: string): string[] {
    const conflicts: string[] = [];

    // Check each SPDX ID in the dependency license
    for (const spdxId of depLicense.spdxIds) {
      const incompatibleWith = this.INCOMPATIBILITY_MATRIX.get(spdxId);
      if (incompatibleWith) {
        // Check if project license is incompatible
        if (projectLicense) {
          const projectUpper = projectLicense.toUpperCase();
          for (const incompatible of incompatibleWith) {
            if (projectUpper.includes(incompatible.toUpperCase())) {
              conflicts.push(`${spdxId} conflicts with ${projectLicense}`);
            }
          }
        }
      }

      // Check reverse: if project license is GPL/AGPL and dependency is proprietary
      if (projectLicense) {
        const projectUpper = projectLicense.toUpperCase();
        if (
          (projectUpper.includes('GPL') || projectUpper.includes('AGPL')) &&
          depLicense.licenseType === 'proprietary'
        ) {
          conflicts.push(`${projectLicense} (copyleft) conflicts with proprietary dependency`);
        }
      }
    }

    return conflicts;
  }

  /**
   * Explains why a license is incompatible
   */
  private explainIncompatibility(depLicense: LicenseAnalysis, config: LicenseConfig): string {
    if (depLicense.licenseType === 'proprietary') {
      return 'Proprietary license detected. Commercial use may be restricted. Review license terms before use.';
    }

    if (depLicense.licenseType === 'copyleft') {
      const spdxId = depLicense.spdxId || depLicense.license;
      if (config.strictMode) {
        return `${spdxId} is a copyleft license. Strict mode only allows permissive licenses. Consider adding it to acceptableLicenses if appropriate for your project.`;
      }
      return `${spdxId} is a copyleft license. It may require open-sourcing derivative works. Review license terms and add to acceptableLicenses if appropriate.`;
    }

    if (depLicense.licenseType === 'unknown') {
      return `License "${depLicense.license}" is not recognized. Review package license and add to acceptableLicenses if appropriate.`;
    }

    // Permissive but not in list
    return `License "${depLicense.license}" is not in your acceptable licenses list. Add it to depPulse.licenses.acceptableLicenses if appropriate for your project.`;
  }

  /**
   * Gets compatibility explanation for UI display
   */
  explainCompatibility(license: LicenseAnalysis): string {
    if (license.isCompatible) {
      return license.compatibilityReason || 'License is compatible with your project.';
    }

    return license.compatibilityReason || this.getDefaultIncompatibilityReason(license);
  }

  /**
   * Gets default incompatibility reason based on license type
   */
  private getDefaultIncompatibilityReason(license: LicenseAnalysis): string {
    switch (license.licenseType) {
      case 'proprietary':
        return 'Proprietary license - commercial use may be restricted.';
      case 'copyleft':
        return 'Copyleft license - may require open-sourcing derivative works.';
      case 'unknown':
        return 'Unknown license - review terms before use.';
      default:
        return 'License not in acceptable licenses list.';
    }
  }
}

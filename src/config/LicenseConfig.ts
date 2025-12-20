import * as vscode from 'vscode';

/**
 * License configuration loaded from VS Code settings
 */
export interface LicenseConfig {
  acceptableLicenses: string[];
  strictMode: boolean;
  projectLicense?: string;
}

/**
 * Default acceptable licenses (permissive only)
 * Matches current behavior for backward compatibility
 */
const DEFAULT_ACCEPTABLE_LICENSES = [
  'MIT',
  'ISC',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'CC0-1.0',
  'Unlicense',
  'WTFPL',
];

/**
 * Additional copyleft licenses that may be acceptable in non-strict mode
 */
const COMMON_COPYLEFT_LICENSES = ['LGPL-2.1', 'LGPL-3.0', 'MPL-2.0'];

/**
 * Normalizes license identifiers (removes duplicates, trims whitespace)
 */
function normalizeLicenses(licenses: string[] | undefined): string[] {
  if (!licenses || !Array.isArray(licenses)) {
    return [];
  }
  return licenses
    .map((license) => license.trim())
    .filter((license) => license.length > 0)
    .filter((license, index, self) => self.indexOf(license) === index); // Remove duplicates
}

/**
 * Loads license configuration from workspace settings
 */
export function loadLicenseConfig(workspaceFolder?: vscode.WorkspaceFolder): LicenseConfig {
  const config = vscode.workspace.getConfiguration('depPulse', workspaceFolder?.uri);

  // Get acceptable licenses from config
  const acceptableLicenses =
    config.get<string[]>('licenses.acceptableLicenses', DEFAULT_ACCEPTABLE_LICENSES) ||
    DEFAULT_ACCEPTABLE_LICENSES;

  // Get strict mode setting
  const strictMode = config.get<boolean>('licenses.strictMode', false);

  // Get project license (optional)
  const projectLicense = config.get<string>('licenses.projectLicense', '');

  // Validate and normalize acceptable licenses
  const normalizedLicenses = normalizeLicenses(acceptableLicenses);
  const effectiveLicenses =
    normalizedLicenses.length > 0 ? normalizedLicenses : DEFAULT_ACCEPTABLE_LICENSES;

  // If not in strict mode, add common copyleft licenses that are generally acceptable
  const finalAcceptableLicenses = strictMode
    ? effectiveLicenses
    : [...effectiveLicenses, ...COMMON_COPYLEFT_LICENSES];

  return {
    acceptableLicenses: [...new Set(finalAcceptableLicenses)], // Remove duplicates
    strictMode,
    projectLicense: projectLicense || undefined,
  };
}

/**
 * Validates that a license identifier is a valid SPDX format
 * (Basic validation - checks for common patterns)
 */
export function validateSpdxId(spdxId: string): boolean {
  if (!spdxId || spdxId.trim().length === 0) {
    return false;
  }

  // Basic SPDX identifier pattern
  // Allows alphanumeric, hyphens, dots, and version numbers
  const spdxPattern = /^[A-Za-z0-9][A-Za-z0-9.\-+]*$/;
  return spdxPattern.test(spdxId);
}

/**
 * Gets project license from package.json if available
 * Falls back to configuration setting
 */
export async function getProjectLicense(
  workspaceFolder?: vscode.WorkspaceFolder
): Promise<string | undefined> {
  // First check configuration
  const config = vscode.workspace.getConfiguration('depPulse', workspaceFolder?.uri);
  const configLicense = config.get<string>('licenses.projectLicense', '');
  if (configLicense) {
    return configLicense;
  }

  // Try to read from package.json
  if (workspaceFolder) {
    try {
      const packageJsonUri = vscode.Uri.joinPath(workspaceFolder.uri, 'package.json');
      const packageJsonContent = await vscode.workspace.fs.readFile(packageJsonUri);
      const packageJson = JSON.parse(new TextDecoder().decode(packageJsonContent));

      // Handle different license formats in package.json
      if (typeof packageJson.license === 'string') {
        return packageJson.license;
      }
      if (typeof packageJson.license === 'object' && packageJson.license?.type) {
        return packageJson.license.type;
      }
    } catch {
      // Ignore errors - package.json might not exist or be invalid
    }
  }

  return undefined;
}

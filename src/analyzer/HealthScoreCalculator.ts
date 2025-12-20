import type * as vscode from 'vscode';
import type { DependencyAnalysis, HealthScore, ScoreBreakdown, ScoreWeights } from '../types';

/**
 * Default weight configuration for health score calculation
 * These weights determine the relative importance of each analysis dimension
 */
const DEFAULT_WEIGHTS: ScoreWeights = {
  security: 0.4, // 40% weight
  freshness: 0.3, // 30% weight
  compatibility: 0.2, // 20% weight
  license: 0.1, // 10% weight
};

/**
 * Calculates health scores for project dependencies based on weighted analysis factors
 * Supports user-configurable weights and generates detailed score breakdowns
 */
export class HealthScoreCalculator {
  private weights: ScoreWeights;
  private outputChannel: vscode.OutputChannel;

  constructor(outputChannel: vscode.OutputChannel, weights?: ScoreWeights) {
    this.outputChannel = outputChannel;
    this.weights = weights || DEFAULT_WEIGHTS;
  }

  /**
   * Calculates the overall health score for an analysis result
   * @param dependencies List of analyzed dependencies
   * @returns HealthScore object with overall score, component scores, and breakdown
   */
  calculate(dependencies: DependencyAnalysis[]): HealthScore {
    // Filter out failed packages (fake/non-existent) - only score real packages
    // Only exclude packages explicitly marked as failed (isFailed === true)
    const realDependencies = dependencies.filter((d) => d.isFailed !== true);

    this.log(
      'info',
      `Calculating health score for ${realDependencies.length} real dependencies (${dependencies.length - realDependencies.length} invalid packages excluded - not found in NPM registry)`
    );

    const totalDeps = realDependencies.length;

    if (totalDeps === 0) {
      this.log('warn', 'No real dependencies to analyze, returning default score');
      return this.createDefaultScore();
    }

    // Calculate individual component scores (using only real packages)
    const securityScore = this.calculateSecurityScore(realDependencies);
    const freshnessScore = this.calculateFreshnessScore(realDependencies);
    const compatibilityScore = this.calculateCompatibilityScore(realDependencies);
    const licenseScore = this.calculateLicenseScore(realDependencies);

    // Calculate weighted overall score
    const overallScore = Math.round(
      securityScore * this.weights.security +
        freshnessScore * this.weights.freshness +
        compatibilityScore * this.weights.compatibility +
        licenseScore * this.weights.license
    );

    // Generate breakdown (using only real packages)
    const breakdown = this.generateBreakdown(realDependencies);

    const healthScore: HealthScore = {
      overall: overallScore,
      security: securityScore,
      freshness: freshnessScore,
      compatibility: compatibilityScore,
      license: licenseScore,
      breakdown,
    };

    this.log(
      'info',
      `Health score calculated: Overall=${overallScore}, Security=${securityScore}, Freshness=${freshnessScore}, Compatibility=${compatibilityScore}, License=${licenseScore}`
    );

    return healthScore;
  }

  /**
   * Gets the current weight configuration
   * @returns Current ScoreWeights
   */
  getWeights(): ScoreWeights {
    return { ...this.weights };
  }

  /**
   * Updates the weight configuration
   * @param weights New weight configuration
   */
  setWeights(weights: ScoreWeights): void {
    // Validate weights sum to approximately 1.0 (allow small floating point errors)
    const sum = weights.security + weights.freshness + weights.compatibility + weights.license;
    if (Math.abs(sum - 1.0) > 0.01) {
      this.log(
        'warn',
        `Weight sum is ${sum}, expected 1.0. Weights may not be properly normalized.`
      );
    }

    this.weights = { ...weights };
    this.log('info', `Updated health score weights: ${JSON.stringify(this.weights)}`);
  }

  /**
   * Calculates security score using industry-standard hybrid approach
   * Based on Mend Priority Score and MCDM methodology
   *
   * Reference: Mend Priority Score (https://docs.mend.io/legacy-sca/latest/mend-priority-score)
   * Reference: MDPI Multi-Criteria Decision Making (https://www.mdpi.com/2071-1050/15/10/8114)
   *
   * Formula (Hybrid Approach):
   * 1. Base score from percentage: 100 × (1 - vulnerablePercentage)
   * 2. Severity penalties (capped at 60 points):
   *    - Critical: 8 points each
   *    - High: 4 points each
   *    - Medium: 2 points each
   *    - Low: 0.5 points each
   * 3. Final score: max(0, baseScore - severityPenalty)
   *
   * This approach:
   * - Reflects percentage of clean dependencies (like Snyk/Mend)
   * - Applies severity-based deductions (CVSS-aligned)
   * - Caps penalties to avoid frequent 0 scores
   * - Provides better differentiation between poor and critical states
   */
  private calculateSecurityScore(dependencies: DependencyAnalysis[]): number {
    const totalDeps = dependencies.length;
    let criticalCount = 0;
    let highCount = 0;
    let mediumCount = 0;
    let lowCount = 0;

    for (const dep of dependencies) {
      const severity = dep.security.severity;
      if (severity === 'critical') {
        criticalCount++;
      } else if (severity === 'high') {
        highCount++;
      } else if (severity === 'medium') {
        mediumCount++;
      } else if (severity === 'low') {
        lowCount++;
      }
    }

    // Calculate percentage of vulnerable dependencies
    const vulnerableCount = criticalCount + highCount + mediumCount + lowCount;
    const vulnerablePercentage = vulnerableCount / totalDeps;

    // Base score from percentage (0% vulnerable = 100, 50% vulnerable = 50, 100% vulnerable = 0)
    const baseScore = Math.round(100 * (1 - vulnerablePercentage));

    // Severity-based penalty (capped to avoid 0 scores and provide differentiation)
    const severityPenalty = Math.min(
      criticalCount * 8 + highCount * 4 + mediumCount * 2 + lowCount * 0.5,
      60 // Maximum 60 points penalty from severity
    );

    // Final score
    const score = Math.max(0, Math.round(baseScore - severityPenalty));

    this.log(
      'debug',
      `Security score: ${score} (Base: ${baseScore}, Penalty: ${severityPenalty.toFixed(1)}, Critical: ${criticalCount}, High: ${highCount}, Medium: ${mediumCount}, Low: ${lowCount}, Vulnerable: ${(vulnerablePercentage * 100).toFixed(1)}%)`
    );

    return score;
  }

  /**
   * Calculates freshness score using industry-standard hybrid approach
   * Based on ISO/IEC 25010 maintainability metrics
   *
   * Reference: ISO/IEC 25010 Software Quality Model
   * Reference: SQALE Method for technical debt assessment
   *
   * Formula (Hybrid Approach):
   * 1. Base score from percentage: 100 × (1 - stalePercentage)
   *    - Only counts unmaintained, major, and minor as "stale" for base score
   *    - Patch updates are excluded from base score (low risk)
   * 2. Severity penalties (capped at 30% of base score):
   *    - Unmaintained: 3 points each (critical maintenance risk)
   *    - Major outdated: 2 points each (breaking changes risk)
   *    - Minor outdated: 1 point each (feature gap)
   *    - Patch outdated: 0.1 points each (bug fixes only, minimal impact)
   * 3. Final score: max(0, baseScore - severityPenalty)
   *
   * This approach:
   * - Reflects percentage of significantly outdated dependencies (excluding patches)
   * - Applies reduced maintenance-based deductions to avoid double-penalization
   * - Caps penalties at 30% of base score for better score distribution
   * - Encourages incremental improvements without being overly punitive
   */
  private calculateFreshnessScore(dependencies: DependencyAnalysis[]): number {
    const totalDeps = dependencies.length;
    let majorOutdated = 0;
    let minorOutdated = 0;
    let patchOutdated = 0;
    let unmaintained = 0;

    for (const dep of dependencies) {
      const freshness = dep.freshness;

      if (freshness.isUnmaintained) {
        unmaintained++;
      }

      if (freshness.isOutdated) {
        if (freshness.versionGap === 'major') {
          majorOutdated++;
        } else if (freshness.versionGap === 'minor') {
          minorOutdated++;
        } else if (freshness.versionGap === 'patch') {
          patchOutdated++;
        }
      }
    }

    // Calculate percentage of stale dependencies (excluding patch updates for base score)
    // Patch updates are low risk and shouldn't heavily impact the base score
    const staleCount = unmaintained + majorOutdated + minorOutdated;
    const stalePercentage = staleCount / totalDeps;

    // Base score from percentage (0% stale = 100, 50% stale = 50, 100% stale = 0)
    // Only counts unmaintained, major, and minor as "stale"
    const baseScore = Math.round(100 * (1 - stalePercentage));

    // Calculate raw penalty with reduced weights to avoid double-penalization
    const rawPenalty =
      unmaintained * 3 + majorOutdated * 2 + minorOutdated * 1 + patchOutdated * 0.1;

    // Cap penalty at 30% of base score to prevent excessive score reduction
    // This ensures scores remain meaningful and differentiate between states
    const maxPenalty = Math.max(10, baseScore * 0.3); // Minimum 10 points cap for very low base scores
    const maintenancePenalty = Math.min(rawPenalty, maxPenalty);

    // Final score
    const score = Math.max(0, Math.round(baseScore - maintenancePenalty));

    this.log(
      'debug',
      `Freshness score: ${score} (Base: ${baseScore}, Raw Penalty: ${rawPenalty.toFixed(1)}, Applied Penalty: ${maintenancePenalty.toFixed(1)}, Unmaintained: ${unmaintained}, Major: ${majorOutdated}, Minor: ${minorOutdated}, Patch: ${patchOutdated}, Stale: ${(stalePercentage * 100).toFixed(1)}%)`
    );

    return score;
  }

  /**
   * Calculates compatibility score using industry-standard hybrid approach
   * Based on ISO/IEC 25010 maintainability metrics
   *
   * Formula (Hybrid Approach):
   * 1. Base score from percentage: 100 × (1 - issuesPercentage)
   * 2. Severity penalties (capped at 50 points):
   *    - Deprecated versions: 8 points each (critical compatibility risk)
   *    - Breaking changes: 4 points each (high priority)
   *    - Version conflicts: 6 points each (high priority)
   * 3. Final score: max(0, baseScore - severityPenalty)
   *
   * This approach:
   * - Reflects percentage of compatible dependencies
   * - Applies severity-based deductions
   * - Caps penalties for better score distribution
   * - Encourages incremental improvements
   */
  private calculateCompatibilityScore(dependencies: DependencyAnalysis[]): number {
    const totalDeps = dependencies.length;
    let deprecatedCount = 0;
    let breakingChangesCount = 0;
    let versionConflictsCount = 0;
    let analyzedCount = 0;

    for (const dep of dependencies) {
      if (!dep.compatibility) continue; // Skip if not analyzed

      analyzedCount++;
      const compat = dep.compatibility;

      if (compat.status === 'version-deprecated') {
        deprecatedCount++;
      } else if (compat.status === 'breaking-changes') {
        breakingChangesCount++;
      }

      // Count version conflicts if any
      if (compat.issues.some((issue) => issue.type === 'version-conflict')) {
        versionConflictsCount++;
      }
    }

    // If no dependencies have compatibility data, return 100 (assume safe)
    // This handles cases where compatibility analysis wasn't available (e.g., old cache)
    if (analyzedCount === 0) {
      this.log(
        'debug',
        `Compatibility score: 100 (No compatibility data available - ${totalDeps} dependencies not analyzed)`
      );
      return 100;
    }

    // Calculate percentage of packages with compatibility issues
    // Only count against analyzed dependencies, not total
    const issuesCount = deprecatedCount + breakingChangesCount + versionConflictsCount;
    const issuesPercentage = issuesCount / analyzedCount;

    // Base score from percentage (0% issues = 100, 50% issues = 50, 100% issues = 0)
    const baseScore = Math.round(100 * (1 - issuesPercentage));

    // Severity-based penalty (capped at 50 points)
    const severityPenalty = Math.min(
      deprecatedCount * 8 + // Deprecated versions are critical
        breakingChangesCount * 4 + // Breaking changes are high priority
        versionConflictsCount * 6, // Conflicts are high priority
      50 // Maximum 50 points penalty
    );

    // Final score
    const score = Math.max(0, Math.round(baseScore - severityPenalty));

    this.log(
      'debug',
      `Compatibility score: ${score} (Base: ${baseScore}, Penalty: ${severityPenalty.toFixed(1)}, Deprecated: ${deprecatedCount}, Breaking: ${breakingChangesCount}, Conflicts: ${versionConflictsCount}, Issues: ${(issuesPercentage * 100).toFixed(1)}%, Analyzed: ${analyzedCount}/${totalDeps})`
    );

    return score;
  }

  /**
   * Calculates license score based on license compatibility
   * Formula: 100 - (incompatible × 100) / totalDeps
   */
  private calculateLicenseScore(dependencies: DependencyAnalysis[]): number {
    const totalDeps = dependencies.length;
    let incompatibleCount = 0;

    for (const dep of dependencies) {
      // Treat undefined/null as compatible; only count explicit incompatibility
      if (dep.license.isCompatible === false) {
        incompatibleCount++;
      }
    }

    // Calculate penalty based on incompatible licenses
    const penalty = (incompatibleCount * 100) / totalDeps;
    const score = Math.max(0, Math.round(100 - penalty));

    this.log('debug', `License score: ${score} (Incompatible: ${incompatibleCount})`);

    return score;
  }

  /**
   * Generates a breakdown of dependency health status
   */
  private generateBreakdown(dependencies: DependencyAnalysis[]): ScoreBreakdown {
    let criticalIssues = 0;
    let warnings = 0;
    let healthy = 0;

    for (const dep of dependencies) {
      const hasCriticalVuln = dep.security.severity === 'critical';
      const hasHighVuln = dep.security.severity === 'high';
      const isMajorOutdated = dep.freshness.isOutdated && dep.freshness.versionGap === 'major';
      const isUnmaintained = dep.freshness.isUnmaintained;
      const hasLicenseIssue = !dep.license.isCompatible;

      if (hasCriticalVuln || isUnmaintained) {
        criticalIssues++;
      } else if (hasHighVuln || isMajorOutdated || hasLicenseIssue) {
        warnings++;
      } else {
        healthy++;
      }
    }

    return {
      totalDependencies: dependencies.length,
      criticalIssues,
      warnings,
      healthy,
    };
  }

  /**
   * Creates a default health score for empty projects
   */
  private createDefaultScore(): HealthScore {
    return {
      overall: 100,
      security: 100,
      freshness: 100,
      compatibility: 100,
      license: 100,
      breakdown: {
        totalDependencies: 0,
        criticalIssues: 0,
        warnings: 0,
        healthy: 0,
      },
    };
  }

  /**
   * Logs a message to the output channel with timestamp
   */
  private log(level: 'info' | 'warn' | 'error' | 'debug', message: string): void {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [HealthScoreCalculator] [${level.toUpperCase()}] ${message}`;
    this.outputChannel.appendLine(logMessage);
  }
}

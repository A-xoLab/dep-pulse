import * as vscode from 'vscode';
import type { AnalysisResult } from '../types';

/**
 * Manages the VS Code status bar item for DepPulse
 * Displays health score with color coding and provides quick access to dashboard
 */
export class StatusBarManager {
  private statusBarItem: vscode.StatusBarItem;
  private outputChannel: vscode.OutputChannel;

  constructor(outputChannel: vscode.OutputChannel) {
    this.outputChannel = outputChannel;

    // Create status bar item on the left side with priority 100
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);

    // Set command to open dashboard when clicked
    this.statusBarItem.command = 'depPulse.showDashboard';

    // Set default text and show
    this.statusBarItem.text = '$(pulse) DepPulse';
    this.statusBarItem.tooltip = 'DepPulse: Ready to scan';
    this.statusBarItem.show();

    this.log('StatusBarManager initialized');
  }

  /**
   * Update the status bar with new analysis results
   * Uses classification hierarchy to determine color and icon
   * @param analysis The analysis results to display
   */
  public update(analysis: AnalysisResult): void {
    const score = Math.round(analysis.healthScore.overall);

    // Use score-based color for status bar (green/yellow/red)
    const color = this.getColorForScore(score);

    // Set text with pulse icon and score
    this.statusBarItem.text = `$(pulse) DepPulse: ${score}`;
    this.statusBarItem.color = color;

    // Set tooltip with detailed information including classification
    const tooltip = this.buildTooltip(analysis);
    this.statusBarItem.tooltip = tooltip;

    this.log(`Status bar updated: Score ${score}, Color ${color}`);
  }

  /**
   * Get color code based on health score
   * @param score Health score (0-100)
   * @returns Color string
   */
  private getColorForScore(score: number): string {
    if (score >= 90) {
      return '#16a34a'; // Green (align with dashboard)
    }
    if (score >= 70) {
      return '#eab308'; // Yellow
    }
    if (score >= 50) {
      return '#f97316'; // Orange
    }
    if (score >= 30) {
      return '#d97706'; // Amber
    }
    return '#dc2626'; // Red
  }

  /**
   * Build tooltip text with classification breakdown
   * @param analysis The analysis results
   * @returns Formatted tooltip string
   */
  private buildTooltip(analysis: AnalysisResult): string {
    // Filter out failed packages for counts (only count real packages)
    // Only exclude packages explicitly marked as failed (isFailed === true)
    const realDependencies = analysis.dependencies.filter((d) => d.isFailed !== true);

    // Count dependencies by classification
    const counts = {
      criticalSecurity: 0,
      highSecurity: 0,
      mediumSecurity: 0,
      lowSecurity: 0,
      unmaintained: 0,
      outdated: 0,
      healthy: 0,
    };

    for (const dep of realDependencies) {
      if (!dep.classification) continue;

      const classification = dep.classification.primary;
      switch (classification.type) {
        case 'security':
          switch (classification.severity) {
            case 'critical':
              counts.criticalSecurity++;
              break;
            case 'high':
              counts.highSecurity++;
              break;
            case 'medium':
              counts.mediumSecurity++;
              break;
            case 'low':
              counts.lowSecurity++;
              break;
          }
          break;
        case 'unmaintained':
          counts.unmaintained++;
          break;
        case 'outdated':
          counts.outdated++;
          break;
        case 'healthy':
          counts.healthy++;
          break;
      }
    }

    const lines = [
      'DepPulse',
      '',
      `Health Score: ${Math.round(analysis.healthScore.overall)}`,
      `Dependencies: ${analysis.summary.analyzedDependencies}/${analysis.summary.totalDependencies}`,
    ];

    // Add warning about fake/invalid packages if any exist
    if (analysis.summary.failedDependencies > 0) {
      lines.push(`⚠️ ${analysis.summary.failedDependencies} invalid (not found in NPM registry)`);
    }

    lines.push('');
    lines.push('Security Issues:');

    if (counts.criticalSecurity > 0) {
      lines.push(`  Critical: ${counts.criticalSecurity}`);
    }
    if (counts.highSecurity > 0) {
      lines.push(`  High: ${counts.highSecurity}`);
    }
    if (counts.mediumSecurity > 0) {
      lines.push(`  Medium: ${counts.mediumSecurity}`);
    }
    if (counts.lowSecurity > 0) {
      lines.push(`  Low: ${counts.lowSecurity}`);
    }

    if (
      counts.criticalSecurity === 0 &&
      counts.highSecurity === 0 &&
      counts.mediumSecurity === 0 &&
      counts.lowSecurity === 0
    ) {
      lines.push('  None');
    }

    lines.push('');
    lines.push('Other Issues:');
    if (counts.unmaintained > 0) {
      lines.push(`  Unmaintained: ${counts.unmaintained}`);
    }
    if (counts.outdated > 0) {
      lines.push(`  Outdated: ${counts.outdated}`);
    }
    if (counts.healthy > 0) {
      lines.push(`  Healthy: ${counts.healthy}`);
    }

    lines.push('');
    lines.push('Click to open DepPulse Dashboard');

    return lines.join('\n');
  }

  /**
   * Hide the status bar item
   */
  public hide(): void {
    this.statusBarItem.hide();
    this.log('Status bar hidden');
  }

  /**
   * Show the status bar item
   */
  public show(): void {
    this.statusBarItem.show();
    this.log('Status bar shown');
  }

  /**
   * Dispose of the status bar item and clean up resources
   */
  public dispose(): void {
    this.statusBarItem.dispose();
    this.log('StatusBarManager disposed');
  }

  /**
   * Log message to output channel with timestamp
   * @param message Message to log
   */
  private log(message: string): void {
    const timestamp = new Date().toISOString();
    this.outputChannel.appendLine(`[${timestamp}] [StatusBarManager] ${message}`);
  }
}

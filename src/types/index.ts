// Core type definitions for DepPulse extension

import type * as vscode from 'vscode';

// ============================================================================
// Project and Dependency Types
// ============================================================================

export type ProjectType = 'npm' | 'pip' | 'maven';

export interface Dependency {
  name: string;
  version: string;
  versionConstraint: string;
  isDev: boolean;
  isInternal?: boolean;
  packageRoot?: string;
  workspaceFolder?: string;
  resolvedVersion?: string; // Exact version from lock file/CLI
  isTransitive?: boolean; // True if not a direct dependency
  children?: Dependency[]; // Transitive dependencies
}

export type ScanningStrategy = 'auto' | 'native' | 'static';

export interface DependencyFile {
  path: string;
  type: ProjectType;
  packageName?: string;
  packageRoot?: string;
  workspaceFolder?: string;
  dependencies: Dependency[];
  devDependencies?: Dependency[];
}

export interface ProjectInfo {
  type: ProjectType[];
  dependencyFiles: DependencyFile[];
  dependencies: Dependency[];
}

// ============================================================================
// Analysis Types
// ============================================================================

export interface AnalysisResult {
  timestamp: Date;
  dependencies: DependencyAnalysis[];
  healthScore: HealthScore;
  summary: AnalysisSummary;
  /**
   * True when multiple package.json files were detected in the workspace
   */
  isMonorepo?: boolean;
  /**
   * Count of discovered package.json files in the project
   */
  packageJsonCount?: number;
  failedPackages?: FailedPackage[]; // Packages that failed NPM registry lookup
  metadata?: {
    cacheHits: number;
    cacheRequests?: number;
    totalDependencies: number;
  };
  performanceMetrics?: PerformanceMetrics;
  networkStatus?: {
    isOnline: boolean;
    degradedFeatures: string[];
    errors: string[];
  };
}

export interface PerformanceMetrics {
  scanDuration: number; // milliseconds
  memoryUsage: {
    heapUsed: number; // bytes
    heapTotal: number; // bytes
    rss: number; // bytes
  };
  dependencyCount: number;
  validDependencyCount: number;
  invalidDependencyCount: number;
  transitiveDependencyCount: number;
}

export interface DependencyAnalysis {
  dependency: Dependency;
  security: SecurityAnalysis;
  freshness: FreshnessAnalysis;
  license: LicenseAnalysis;
  compatibility?: CompatibilityAnalysis;
  performance?: PerformanceAnalysis;
  alternatives?: Alternative[];
  classification?: DependencyClassification; // Enhanced classification
  packageInfo?: PackageInfo;
  isFailed?: boolean; // True if this is a failed/fake package (excluded from health score)
  maintenanceSignals?: MaintenanceSignals;
  children?: DependencyAnalysis[]; // Transitive dependency analyses
}

export interface FailedPackage {
  name: string;
  version: string;
  error: string; // Error message (e.g., "Package not found")
  errorCode?: string; // Error code (e.g., "PACKAGE_NOT_FOUND")
  isTransitive?: boolean;
}

// ============================================================================
// Classification Types
// ============================================================================

export type ClassificationCategory =
  | { type: 'security'; severity: 'critical' | 'high' | 'medium' | 'low' }
  | { type: 'unmaintained'; daysSinceUpdate: number }
  | { type: 'outdated'; gap: 'major' | 'minor' | 'patch'; gracePeriod: boolean }
  | { type: 'healthy' }
  | { type: 'unknown' };

export interface DependencyClassification {
  primary: ClassificationCategory;
  allIssues: DependencyIssue[];
  displayPriority: number; // For sorting in UI (lower = higher priority)
}

export interface DependencyIssue {
  category: 'security' | 'maintenance' | 'freshness';
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  title: string;
  description: string;
  actionable: boolean;
  suggestedAction?: string;
}

export interface DependencyStatus {
  primary: 'security' | 'unmaintained' | 'outdated' | 'healthy';
  severity?: 'critical' | 'high' | 'medium' | 'low';
  details: string;
}

export interface AnalysisSummary {
  totalDependencies: number; // Total declared in package.json
  analyzedDependencies: number; // Successfully analyzed (real packages)
  failedDependencies: number; // Failed NPM registry lookup (fake/non-existent)
  criticalIssues: number;
  highIssues: number;
  warnings: number;
  healthy: number;
  errors?: number; // Other errors during analysis
}

// ============================================================================
// Security Analysis Types
// ============================================================================

export interface SecurityAnalysis {
  vulnerabilities: Vulnerability[];
  severity: 'critical' | 'high' | 'medium' | 'low' | 'none';
}

/**
 * Result of a batch vulnerability query for a single package
 */
export interface BatchVulnerabilityResult {
  packageName: string;
  version: string;
  vulnerabilities: Vulnerability[];
  error?: string; // If this specific package failed
}

export type VulnerabilitySource = 'github' | 'osv';

export interface Vulnerability {
  id: string; // CVE or advisory ID
  title: string;
  severity: string;
  cvssScore?: number;
  cvssVersion?: string; // CVSS version: "2.0", "3.0", "3.1", "4.0"
  vectorString?: string; // CVSS vector string (e.g., "CVSS:3.1/AV:N/AC:L/...")
  affectedVersions: string;
  patchedVersions?: string;
  description: string;
  references: string[];
  // Enhanced fields for multi-source detection
  sources?: VulnerabilitySource[]; // Which databases reported this vulnerability
  publishedDate?: Date;
  lastModifiedDate?: Date;
  cweIds?: string[]; // Common Weakness Enumeration IDs
  exploitAvailable?: boolean;
}

export interface AggregatedVulnerability extends Vulnerability {
  sources: VulnerabilitySource[]; // Required for aggregated vulnerabilities
  highestSeverity: string; // Highest severity across all sources
  allSeverities: Record<string, string>; // Severity per source
}

// ============================================================================
// Freshness Analysis Types
// ============================================================================

export interface FreshnessAnalysis {
  currentVersion: string;
  latestVersion: string;
  versionGap: 'major' | 'minor' | 'patch' | 'current';
  releaseDate: Date;
  isOutdated: boolean;
  isUnmaintained: boolean;
  maintenanceSignals?: MaintenanceSignals;
}

export interface OutdatedStatus {
  isOutdated: boolean;
  reason: 'patch' | 'minor' | 'major' | 'current';
  gracePeriodActive: boolean;
}

// ============================================================================
// Compatibility Analysis Types
// ============================================================================

export interface CompatibilityAnalysis {
  status: 'safe' | 'breaking-changes' | 'version-deprecated' | 'unknown';
  issues: CompatibilityIssue[];
  upgradeWarnings?: UpgradeWarning[];
  affectedPackages?: string[]; // Packages that may conflict
}

export interface CompatibilityIssue {
  type: 'version-deprecated' | 'breaking-change' | 'version-conflict';
  severity: 'critical' | 'high' | 'medium' | 'low';
  message: string;
  affectedVersions?: string; // Version range affected
  recommendation?: string;
  migrationGuide?: string; // URL to migration guide if available
}

export interface UpgradeWarning {
  breakingChange: string; // Brief description
  description: string; // Detailed explanation
  affectedAPIs?: string[]; // API names that changed
  migrationGuide?: string; // URL to migration guide
}

// ============================================================================
// License Analysis Types
// ============================================================================

export interface LicenseAnalysis {
  license: string; // Original license string/expression
  spdxId?: string; // Normalized SPDX identifier (if single license)
  spdxIds: string[]; // All SPDX IDs in expression
  isCompatible: boolean;
  licenseType: 'permissive' | 'copyleft' | 'proprietary' | 'unknown';
  riskLevel?: 'low' | 'medium' | 'high'; // Based on category and project context
  compatibilityReason?: string; // Why it's compatible/incompatible
  requiresAttribution?: boolean;
  requiresSourceCode?: boolean; // Copyleft requirement
  conflictsWith?: string[]; // License IDs that conflict
}

// ============================================================================
// Performance Analysis Types
// ============================================================================

export interface PerformanceAnalysis {
  bundleSize: number; // bytes
  gzipSize: number;
  isLarge: boolean;
}

// ============================================================================
// Alternative Package Types
// ============================================================================

export interface Alternative {
  name: string;
  description: string;
  weeklyDownloads: number;
  lastUpdate: Date;
  healthScore: number;
  bundleSize?: number;
}

// ============================================================================
// Health Score Types
// ============================================================================

export interface HealthScore {
  overall: number; // 0-100
  security: number;
  freshness: number;
  compatibility: number;
  license: number;
  breakdown: ScoreBreakdown;
}

export interface ScoreWeights {
  security: number; // default 0.4
  freshness: number; // default 0.3
  compatibility: number; // default 0.2
  license: number; // default 0.1
}

export interface ScoreBreakdown {
  totalDependencies: number;
  criticalIssues: number;
  warnings: number;
  healthy: number;
}

// ============================================================================
// Package Registry Types
// ============================================================================

export interface PackageInfo {
  name: string;
  version: string;
  description: string;
  license: string;
  repository?: string;
  homepage?: string;
  publishedAt: Date;
  downloads?: DownloadStats;
  deprecatedMessage?: string;
  repositoryArchived?: boolean;
  readme?: string;
}

export interface DownloadStats {
  weekly: number;
  monthly: number;
  total: number;
}

export interface MaintenanceSignals {
  isLongTermUnmaintained: boolean;
  reasons: MaintenanceReason[];
  lastChecked: Date;
}

export type MaintenanceReason =
  | {
      source: 'npm';
      type: 'deprecated' | 'version-deprecated';
      message?: string;
    }
  | {
      source: 'github';
      type: 'archived';
      repository: string;
    }
  | {
      source: 'readme';
      type: 'notice';
      excerpt: string;
    };

export interface AlternativeSuggestion {
  name: string;
  description: string;
  weeklyDownloads: number;
  npmUrl: string;
  installCommand: string;
}

// ============================================================================
// LLM / AI Types
// ============================================================================

export type LLMProvider = 'openrouter' | 'openai' | 'gemini';

export interface LLMAlternativeCandidate {
  name: string;
  description?: string;
  reason?: string;
}

export interface PackageSearchResult {
  name: string;
  description: string;
  version: string;
  downloads: number;
}

// ============================================================================
// Extension Services Types
// ============================================================================

export interface ExtensionServices {
  scanner: DependencyScanner;
  analyzer: AnalysisEngine;
  dashboard: DashboardController;
  notificationManager: NotificationManager;
  outputChannel: vscode.OutputChannel;
}

// ============================================================================
// Scanner Interface
// ============================================================================

export interface DependencyScanner {
  scanWorkspace(): Promise<ProjectInfo>;
  parseDependencyFile(filePath: string): Promise<DependencyFile>;
  watchForChanges(callback: (changes: FileChange[]) => void): vscode.Disposable;
}

export interface FileChange {
  type: 'created' | 'modified' | 'deleted';
  path: string;
}

// ============================================================================
// Analysis Engine Interface
// ============================================================================

export interface AnalysisEngine {
  analyze(
    projectInfo: ProjectInfo,
    options?: { bypassCache?: boolean; includeTransitiveDependencies?: boolean }
  ): Promise<AnalysisResult>;
  analyzeIncremental(
    changes: Dependency[],
    options?: { bypassCache?: boolean; includeTransitiveDependencies?: boolean }
  ): Promise<AnalysisResult>;
  getAnalysisStatus(): AnalysisStatus;
}

export interface AnalysisStatus {
  isRunning: boolean;
  progress: number;
  currentDependency?: string;
}

// ============================================================================
// Dashboard Controller Interface
// ============================================================================

export interface DashboardController {
  show(): void;
  isVisible(): boolean;
  updateAlternativeService(service: import('../utils').LLMAlternativeSuggestionService): void;
  notifyLlmConfigChanged(status: import('../extension').LlmConfigStatus): void;
  hide(): void;
  update(
    analysis: AnalysisResult,
    performanceMetrics?: PerformanceMetrics,
    cacheStatus?: { isCached: boolean; cacheAge?: number },
    cacheEnabled?: boolean,
    transitiveEnabled?: boolean
  ): void;
  handleMessage(message: WebviewMessage): void;
  sendProgressUpdate(progress: number, message?: string): void;
}

export interface WebviewMessage {
  command: string;
  data?: unknown;
}

export type WebviewCommand =
  | { command: 'refresh' }
  | { command: 'updateDependency'; data: { name: string; version: string } }
  | { command: 'viewDetails'; data: { name: string } }
  | { command: 'filterChange'; data: { filters: FilterOptions } }
  | { command: 'exportReport' }
  | { command: 'showAlternatives'; data: { name: string } }
  | {
      command: 'openSettings';
      data?: {
        query?: string;
        provider?: 'github' | 'openrouter' | 'openai' | 'gemini';
        scope?: 'key' | 'model' | 'both';
      };
    };

export type ExtensionMessage =
  | { type: 'analysisUpdate'; data: AnalysisResult }
  | { type: 'error'; data: { message: string } }
  | { type: 'loading'; data: { isLoading: boolean } }
  | { type: 'progressUpdate'; data: { progress: number; message?: string } };

export interface FilterOptions {
  severity?: 'critical' | 'high' | 'medium' | 'low' | 'all';
  type?: ProjectType | 'all';
  status?: 'outdated' | 'vulnerable' | 'healthy' | 'all';
  searchTerm?: string;
}

// ============================================================================
// Notification Manager Interface
// ============================================================================

export interface NotificationManager {
  notify(alert: Alert): void;
  configure(thresholds: AlertThresholds): void;
  suppressAlert(alertId: string, duration: number): void;
}

export interface Alert {
  id: string;
  severity: 'critical' | 'warning' | 'info';
  title: string;
  message: string;
  actions?: AlertAction[];
}

export interface AlertAction {
  label: string;
  command: string;
  args?: unknown[];
}

export interface AlertThresholds {
  securitySeverity: 'critical' | 'high' | 'medium' | 'low';
  freshnessGap: 'major' | 'minor' | 'patch';
  licenseIncompatibility: boolean;
}

// ============================================================================
// Health Score Calculator Interface
// ============================================================================

export interface HealthScoreCalculator {
  calculate(analysis: AnalysisResult): HealthScore;
  getWeights(): ScoreWeights;
  setWeights(weights: ScoreWeights): void;
}

// ============================================================================
// API Client Interfaces
// ============================================================================

export interface APIClient {
  get<T>(url: string, options?: RequestOptions): Promise<T>;
  post<T, D = unknown>(url: string, data: D, options?: RequestOptions): Promise<T>;
}

export interface RequestOptions {
  headers?: Record<string, string>;
  timeout?: number;
  retries?: number;
}

export interface PackageRegistryClient {
  getPackageInfo(name: string): Promise<PackageInfo>;
  getLatestVersion(name: string): Promise<string>;
  searchPackages(query: string): Promise<PackageSearchResult[]>;
  getVersionDeprecationStatus(packageName: string, version: string): Promise<string | null>;
}

export interface VulnerabilityClient {
  getVulnerabilities(
    packageName: string,
    version: string,
    bypassCache?: boolean
  ): Promise<Vulnerability[]>;

  /**
   * Fetches vulnerabilities for multiple packages in a single batch request
   * @param dependencies Array of dependencies to check
   * @param bypassCache Optional: bypass cache and fetch fresh data
   * @returns Map of package names to their vulnerabilities
   */
  getBatchVulnerabilities(
    dependencies: Dependency[],
    bypassCache?: boolean
  ): Promise<Map<string, Vulnerability[]>>;
}

export interface VulnerabilityAggregator {
  getAggregatedVulnerabilities(
    packageName: string,
    version: string,
    bypassCache?: boolean
  ): Promise<AggregatedVulnerability[]>;
  getBatchAggregatedVulnerabilities(
    dependencies: Dependency[],
    bypassCache?: boolean
  ): Promise<Map<string, AggregatedVulnerability[]>>;
  /**
   * Configures which databases to query
   */
  configureSources(sources: VulnerabilitySource[]): void;
}

// ============================================================================
// Error Types
// ============================================================================

export enum ErrorCode {
  FILE_NOT_FOUND = 'FILE_NOT_FOUND',
  PARSE_ERROR = 'PARSE_ERROR',
  NETWORK_ERROR = 'NETWORK_ERROR',
  API_ERROR = 'API_ERROR',
  RATE_LIMIT = 'RATE_LIMIT',
  AUTH_ERROR = 'AUTH_ERROR',
  UNKNOWN = 'UNKNOWN',
}

export interface ErrorContext {
  originalError?: unknown;
  url?: string;
  method?: string;
  status?: number;
  packageName?: string;
  [key: string]: unknown;
}

export class DepPulseError extends Error {
  constructor(
    message: string,
    public code: ErrorCode,
    public recoverable: boolean,
    public context?: ErrorContext
  ) {
    super(message);
    this.name = 'DepPulseError';
  }
}

// ============================================================================
// Configuration Types
// ============================================================================

export interface VulnerabilityDetectionConfig {
  // Which databases to query
  sources: {
    github: boolean;
    nvd: boolean;
    snyk: boolean;
    osv: boolean;
  };
  // Primary source for vulnerability detection
  primarySource: 'osv' | 'github';
  // Cross-verification settings
  requireMultipleSourcesForCritical: boolean; // Require 2+ sources for critical
}

export interface FreshnessConfig {
  unmaintainedThresholdDays: number; // Default: 730 (2 years)
  majorVersionGracePeriodDays: number; // Default: 90
  excludePreReleases: boolean; // Default: true
}

export interface DepPulseConfiguration {
  analysis: {
    autoScanOnStartup: boolean;
    scanOnSave: boolean;
    includeDevDependencies: boolean;
    includeTransitiveDependencies: boolean;
  };
  healthScore: {
    weights: ScoreWeights;
  };
  alerts: {
    enabled: boolean;
    thresholds: AlertThresholds;
    suppressDuration: number;
  };
  licenses: {
    acceptableLicenses: string[];
    strictMode: boolean;
  };
  performance: {
    largeBundleThreshold: number;
  };
  vulnerabilityDetection?: VulnerabilityDetectionConfig;
  freshness?: FreshnessConfig;
  api: {
    githubToken?: string;
    timeout: number;
    retryAttempts: number;
  };
  cache: {
    vulnerabilityTTLMinutes: number;
    bypassCacheForCritical: boolean;
  };
}

// ============================================================================
// OSV.dev API Types
// ============================================================================

/**
 * OSV batch query request format
 */
export interface OSVBatchRequest {
  queries: OSVQuery[];
}

export interface OSVQuery {
  package: {
    name: string;
    ecosystem: string; // "npm" for npm packages
  };
  version?: string; // Optional: if omitted, returns all vulnerabilities
}

/**
 * OSV batch query response format
 */
export interface OSVBatchResponse {
  results: OSVQueryResult[];
}

export interface OSVQueryResult {
  vulns?: OSVVulnerability[]; // Array of vulnerabilities (empty if none found)
}

export interface OSVVulnerability {
  id: string; // CVE-XXXX-XXXX or GHSA-XXXX-XXXX-XXXX
  summary: string;
  details: string;
  aliases?: string[]; // Other IDs for same vulnerability
  modified: string; // ISO 8601 timestamp
  published: string; // ISO 8601 timestamp
  database_specific?: {
    severity?: string; // OSV severity (CRITICAL, HIGH, MODERATE, LOW)
    cwe_ids?: string[];
    github_reviewed?: boolean;
  };
  severity?: OSVSeverity[]; // CVSS scores
  affected: OSVAffected[];
  references?: OSVReference[];
}

export interface OSVSeverity {
  type: 'CVSS_V2' | 'CVSS_V3' | 'CVSS_V4';
  score: string; // CVSS vector string
}

export interface OSVAffected {
  package: {
    name: string;
    ecosystem: string;
    purl?: string; // Package URL
  };
  ranges?: OSVRange[];
  versions?: string[]; // Specific affected versions
  database_specific?: {
    source?: string;
  };
}

export interface OSVRange {
  type: 'ECOSYSTEM' | 'SEMVER' | 'GIT';
  events: OSVEvent[];
  repo?: string; // For GIT type
}

export interface OSVEvent {
  introduced?: string; // Version where vulnerability was introduced
  fixed?: string; // Version where vulnerability was fixed
  last_affected?: string; // Last version affected
  limit?: string; // Upper bound (exclusive)
}

export interface OSVReference {
  type: 'ADVISORY' | 'ARTICLE' | 'REPORT' | 'FIX' | 'PACKAGE' | 'WEB';
  url: string;
}

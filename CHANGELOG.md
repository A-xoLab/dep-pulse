# Changelog

All notable changes to DepPulse will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).


## [0.1.0] - 2025-12-19

### Added

- Initial release
- Dependency scanning for npm/pnpm/yarn projects
- Security vulnerability detection via OSV and GitHub Advisory Database
- Freshness analysis with outdated package detection
- License compliance checking
- Interactive dashboard UI
- Health score calculation
- Monorepo support
- Real-time analysis with automatic scanning on workspace open
- Smart caching with severity-based TTL
- Offline support with cached data
- CVSS scoring with version tracking (v2.0, v3.0, v3.1, v4.0)
- Accurate semver range matching for affected versions
- Unmaintained package detection (configurable threshold)
- Version gap detection (major, minor, patch levels)
- Grace period support for major version updates
- Pre-release filtering for outdated detection
- License detection and compatibility checking
- Configurable acceptable licenses
- Strict mode for permissive licenses only
- Weighted health scoring system (customizable weights)
- Status bar integration for quick health indicator
- Incremental scanning for changed dependencies only
- Chunked processing for large projects
- Request queue management with retry logic
- Multi-source security scanning with automatic fallback
- Source attribution badges
- Filterable and searchable dashboard
- Unused dependency detection (monorepo-aware)
- LLM-powered alternatives for problematic packages

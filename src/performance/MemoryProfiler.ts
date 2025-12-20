import * as v8 from 'node:v8';

/**
 * Memory statistics snapshot
 */
export interface MemorySnapshot {
  timestamp: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  rss: number;
  arrayBuffers: number;
}

/**
 * Memory growth tracking data
 */
export interface MemoryGrowth {
  baseline: MemorySnapshot;
  current: MemorySnapshot;
  growth: {
    heapUsed: number;
    heapTotal: number;
    external: number;
    rss: number;
    arrayBuffers: number;
  };
  growthPercent: {
    heapUsed: number;
    heapTotal: number;
    external: number;
    rss: number;
    arrayBuffers: number;
  };
}

/**
 * Memory profiling utilities for measuring baseline and tracking improvements
 * Provides functions for measuring heap usage, tracking memory growth, and reporting statistics
 */
export class MemoryProfiler {
  private baseline: MemorySnapshot | null = null;
  private snapshots: MemorySnapshot[] = [];
  private readonly maxSnapshots = 100; // Limit snapshots to prevent memory bloat

  /**
   * Take a memory snapshot
   * @returns Current memory statistics
   */
  public takeSnapshot(): MemorySnapshot {
    const usage = process.memoryUsage();
    const _heapStats = v8.getHeapStatistics();

    const snapshot: MemorySnapshot = {
      timestamp: Date.now(),
      heapUsed: usage.heapUsed,
      heapTotal: usage.heapTotal,
      external: usage.external,
      rss: usage.rss,
      arrayBuffers: usage.arrayBuffers,
    };

    // Store snapshot (with limit)
    this.snapshots.push(snapshot);
    if (this.snapshots.length > this.maxSnapshots) {
      this.snapshots.shift(); // Remove oldest snapshot
    }

    return snapshot;
  }

  /**
   * Set baseline memory snapshot
   * This should be called at the start of an operation to measure against
   */
  public setBaseline(): MemorySnapshot {
    this.baseline = this.takeSnapshot();
    return this.baseline;
  }

  /**
   * Get current baseline snapshot
   * @returns Baseline snapshot or null if not set
   */
  public getBaseline(): MemorySnapshot | null {
    return this.baseline;
  }

  /**
   * Measure memory growth since baseline
   * @returns Memory growth data or null if baseline not set
   */
  public measureGrowth(): MemoryGrowth | null {
    if (!this.baseline) {
      return null;
    }

    const current = this.takeSnapshot();

    const growth: MemoryGrowth = {
      baseline: this.baseline,
      current,
      growth: {
        heapUsed: current.heapUsed - this.baseline.heapUsed,
        heapTotal: current.heapTotal - this.baseline.heapTotal,
        external: current.external - this.baseline.external,
        rss: current.rss - this.baseline.rss,
        arrayBuffers: current.arrayBuffers - this.baseline.arrayBuffers,
      },
      growthPercent: {
        heapUsed:
          this.baseline.heapUsed > 0
            ? ((current.heapUsed - this.baseline.heapUsed) / this.baseline.heapUsed) * 100
            : 0,
        heapTotal:
          this.baseline.heapTotal > 0
            ? ((current.heapTotal - this.baseline.heapTotal) / this.baseline.heapTotal) * 100
            : 0,
        external:
          this.baseline.external > 0
            ? ((current.external - this.baseline.external) / this.baseline.external) * 100
            : 0,
        rss:
          this.baseline.rss > 0 ? ((current.rss - this.baseline.rss) / this.baseline.rss) * 100 : 0,
        arrayBuffers:
          this.baseline.arrayBuffers > 0
            ? ((current.arrayBuffers - this.baseline.arrayBuffers) / this.baseline.arrayBuffers) *
              100
            : 0,
      },
    };

    return growth;
  }

  /**
   * Get memory statistics report
   * @param includeGrowth Include growth data if baseline is set
   * @returns Formatted memory statistics report
   */
  public getReport(includeGrowth = true): string {
    const current = this.takeSnapshot();
    const lines: string[] = [];

    lines.push('=== Memory Statistics ===');
    lines.push(`Timestamp: ${new Date(current.timestamp).toISOString()}`);
    lines.push('');
    lines.push('Current Memory:');
    lines.push(`  Heap Used: ${this.formatBytes(current.heapUsed)}`);
    lines.push(`  Heap Total: ${this.formatBytes(current.heapTotal)}`);
    lines.push(`  External: ${this.formatBytes(current.external)}`);
    lines.push(`  RSS: ${this.formatBytes(current.rss)}`);
    lines.push(`  Array Buffers: ${this.formatBytes(current.arrayBuffers)}`);

    if (includeGrowth && this.baseline) {
      const growth = this.measureGrowth();
      if (growth) {
        lines.push('');
        lines.push('Memory Growth (since baseline):');
        lines.push(
          `  Heap Used: ${this.formatBytes(growth.growth.heapUsed)} (${growth.growthPercent.heapUsed.toFixed(2)}%)`
        );
        lines.push(
          `  Heap Total: ${this.formatBytes(growth.growth.heapTotal)} (${growth.growthPercent.heapTotal.toFixed(2)}%)`
        );
        lines.push(
          `  External: ${this.formatBytes(growth.growth.external)} (${growth.growthPercent.external.toFixed(2)}%)`
        );
        lines.push(
          `  RSS: ${this.formatBytes(growth.growth.rss)} (${growth.growthPercent.rss.toFixed(2)}%)`
        );
        lines.push(
          `  Array Buffers: ${this.formatBytes(growth.growth.arrayBuffers)} (${growth.growthPercent.arrayBuffers.toFixed(2)}%)`
        );
      }
    }

    if (this.snapshots.length > 1) {
      const first = this.snapshots[0];
      const last = this.snapshots[this.snapshots.length - 1];
      const totalGrowth = {
        heapUsed: last.heapUsed - first.heapUsed,
        heapTotal: last.heapTotal - first.heapTotal,
        rss: last.rss - first.rss,
      };

      lines.push('');
      lines.push(`Total Growth (${this.snapshots.length} snapshots):`);
      lines.push(`  Heap Used: ${this.formatBytes(totalGrowth.heapUsed)}`);
      lines.push(`  Heap Total: ${this.formatBytes(totalGrowth.heapTotal)}`);
      lines.push(`  RSS: ${this.formatBytes(totalGrowth.rss)}`);
    }

    lines.push('========================');

    return lines.join('\n');
  }

  /**
   * Get memory statistics as JSON
   * @param includeGrowth Include growth data if baseline is set
   * @returns Memory statistics object
   */
  public getStats(includeGrowth = true): {
    current: MemorySnapshot;
    baseline?: MemorySnapshot;
    growth?: MemoryGrowth['growth'];
    growthPercent?: MemoryGrowth['growthPercent'];
  } {
    const current = this.takeSnapshot();
    const stats: {
      current: MemorySnapshot;
      baseline?: MemorySnapshot;
      growth?: MemoryGrowth['growth'];
      growthPercent?: MemoryGrowth['growthPercent'];
    } = {
      current,
    };

    if (includeGrowth && this.baseline) {
      const growth = this.measureGrowth();
      if (growth) {
        stats.baseline = this.baseline;
        stats.growth = growth.growth;
        stats.growthPercent = growth.growthPercent;
      }
    }

    return stats;
  }

  /**
   * Clear all snapshots and reset baseline
   */
  public reset(): void {
    this.baseline = null;
    this.snapshots = [];
  }

  /**
   * Get all stored snapshots
   * @returns Array of memory snapshots
   */
  public getSnapshots(): MemorySnapshot[] {
    return [...this.snapshots];
  }

  /**
   * Format bytes to human-readable string
   * @param bytes Number of bytes
   * @returns Formatted string (e.g., "1.5 MB")
   */
  private formatBytes(bytes: number): string {
    if (bytes === 0) {
      return '0 B';
    }

    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return `${(bytes / k ** i).toFixed(2)} ${sizes[i]}`;
  }
}

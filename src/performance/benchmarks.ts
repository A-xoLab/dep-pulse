import type * as vscode from 'vscode';
import type { AnalysisResult } from '../types';
import { MemoryProfiler, type MemorySnapshot } from './MemoryProfiler';

/**
 * Performance metrics for a benchmark run
 */
export interface BenchmarkMetrics {
  memory: {
    baseline: MemorySnapshot;
    peak: MemorySnapshot;
    final: MemorySnapshot;
    peakGrowth: number; // bytes
    peakGrowthPercent: number;
    finalGrowth: number; // bytes
    finalGrowthPercent: number;
  };
  cpu: {
    startTime: number;
    endTime: number;
    duration: number; // milliseconds
  };
  scan: {
    startTime: number;
    endTime: number;
    duration: number; // milliseconds
    dependencyCount: number;
  };
}

/**
 * Benchmark result for a project size category
 */
export interface BenchmarkResult {
  category: 'small' | 'mid' | 'large';
  dependencyCount: number;
  metrics: BenchmarkMetrics;
  success: boolean;
  error?: string;
}

/**
 * Benchmark configuration
 */
export interface BenchmarkConfig {
  dependencyCount: number;
  category: 'small' | 'mid' | 'large';
  iterations?: number;
  warmup?: boolean;
}

/**
 * Automated benchmark suite for measuring DepPulse performance
 * Supports small/mid/large projects with performance metrics (memory, CPU, scan time)
 * Includes baseline and optimized comparisons
 */
export class BenchmarkSuite {
  private profiler: MemoryProfiler;
  private outputChannel: vscode.OutputChannel;
  private cpuStartTime: number = 0;
  private scanStartTime: number = 0;

  constructor(outputChannel: vscode.OutputChannel) {
    this.profiler = new MemoryProfiler();
    this.outputChannel = outputChannel;
  }

  /**
   * Run a single benchmark with the provided analysis function
   * @param config Benchmark configuration
   * @param analysisFn Function that performs the analysis (should return AnalysisResult)
   * @returns Benchmark result
   */
  public async runBenchmark(
    config: BenchmarkConfig,
    analysisFn: () => Promise<AnalysisResult>
  ): Promise<BenchmarkResult> {
    this.log(
      `Starting benchmark: ${config.category} project (${config.dependencyCount} dependencies)`
    );

    // Warmup run if configured
    if (config.warmup) {
      this.log('Running warmup iteration...');
      try {
        await analysisFn();
      } catch (error) {
        this.log(`Warmup failed (non-fatal): ${error}`);
      }
      // Force GC hint
      if (global.gc) {
        global.gc();
      }
      await this.delay(1000); // Wait for GC
    }

    const iterations = config.iterations || 1;
    const results: BenchmarkMetrics[] = [];
    let benchmarkError: string | undefined;

    for (let i = 0; i < iterations; i++) {
      this.log(`Iteration ${i + 1}/${iterations}`);

      // Reset profiler
      this.profiler.reset();

      // Set baseline
      const baseline = this.profiler.setBaseline();
      this.log(`Baseline memory: ${this.formatBytes(baseline.heapUsed)} heap used`);

      // Start CPU timing
      this.cpuStartTime = performance.now();

      // Start scan timing
      this.scanStartTime = performance.now();

      let analysisResult: AnalysisResult | null = null;
      let peakSnapshot: MemorySnapshot = baseline;

      try {
        // Perform analysis
        analysisResult = await analysisFn();

        // Track peak memory during analysis
        const currentSnapshot = this.profiler.takeSnapshot();
        if (currentSnapshot.heapUsed > peakSnapshot.heapUsed) {
          peakSnapshot = currentSnapshot;
        }

        // End scan timing
        const scanEndTime = performance.now();
        const scanDuration = scanEndTime - this.scanStartTime;

        // Wait a bit for cleanup
        await this.delay(500);

        // Take final snapshot
        const finalSnapshot = this.profiler.takeSnapshot();

        // End CPU timing
        const cpuEndTime = performance.now();
        const cpuDuration = cpuEndTime - this.cpuStartTime;

        // Calculate metrics
        const peakGrowth = peakSnapshot.heapUsed - baseline.heapUsed;
        const peakGrowthPercent =
          baseline.heapUsed > 0 ? (peakGrowth / baseline.heapUsed) * 100 : 0;
        const finalGrowth = finalSnapshot.heapUsed - baseline.heapUsed;
        const finalGrowthPercent =
          baseline.heapUsed > 0 ? (finalGrowth / baseline.heapUsed) * 100 : 0;

        const metrics: BenchmarkMetrics = {
          memory: {
            baseline,
            peak: peakSnapshot,
            final: finalSnapshot,
            peakGrowth,
            peakGrowthPercent,
            finalGrowth,
            finalGrowthPercent,
          },
          cpu: {
            startTime: this.cpuStartTime,
            endTime: cpuEndTime,
            duration: cpuDuration,
          },
          scan: {
            startTime: this.scanStartTime,
            endTime: scanEndTime,
            duration: scanDuration,
            dependencyCount: analysisResult.dependencies.length,
          },
        };

        results.push(metrics);

        this.log(`Iteration ${i + 1} completed:`);
        this.log(`  Scan duration: ${scanDuration.toFixed(2)}ms`);
        this.log(
          `  Peak memory growth: ${this.formatBytes(peakGrowth)} (${peakGrowthPercent.toFixed(2)}%)`
        );
        this.log(
          `  Final memory growth: ${this.formatBytes(finalGrowth)} (${finalGrowthPercent.toFixed(2)}%)`
        );
      } catch (err) {
        benchmarkError = err instanceof Error ? err.message : String(err);
        this.log(`Iteration ${i + 1} failed: ${benchmarkError}`);
      }

      // Wait between iterations
      if (i < iterations - 1) {
        await this.delay(2000);
        // Force GC hint
        if (global.gc) {
          global.gc();
        }
        await this.delay(1000);
      }
    }

    // Calculate average metrics if multiple iterations
    let avgMetrics: BenchmarkMetrics;
    if (results.length === 0) {
      throw new Error('All benchmark iterations failed');
    } else if (results.length === 1) {
      const firstResult = results[0];
      if (!firstResult) {
        throw new Error('Unexpected empty results array');
      }
      avgMetrics = firstResult;
    } else {
      // Average all metrics
      avgMetrics = this.averageMetrics(results);
    }

    const result: BenchmarkResult = {
      category: config.category,
      dependencyCount: avgMetrics.scan.dependencyCount,
      metrics: avgMetrics,
      success: benchmarkError === undefined,
      error: benchmarkError,
    };

    this.log(`Benchmark completed: ${result.success ? 'SUCCESS' : 'FAILED'}`);
    return result;
  }

  /**
   * Run benchmarks for all project sizes
   * @param analysisFns Object with analysis functions for each category
   * @returns Array of benchmark results
   */
  public async runAllBenchmarks(analysisFns: {
    small?: () => Promise<AnalysisResult>;
    mid?: () => Promise<AnalysisResult>;
    large?: () => Promise<AnalysisResult>;
  }): Promise<BenchmarkResult[]> {
    const results: BenchmarkResult[] = [];

    if (analysisFns.small) {
      const result = await this.runBenchmark(
        { category: 'small', dependencyCount: 25, iterations: 3, warmup: true },
        analysisFns.small
      );
      results.push(result);
    }

    if (analysisFns.mid) {
      const result = await this.runBenchmark(
        { category: 'mid', dependencyCount: 100, iterations: 2, warmup: true },
        analysisFns.mid
      );
      results.push(result);
    }

    if (analysisFns.large) {
      const result = await this.runBenchmark(
        { category: 'large', dependencyCount: 500, iterations: 1, warmup: true },
        analysisFns.large
      );
      results.push(result);
    }

    return results;
  }

  /**
   * Generate a formatted report from benchmark results
   * @param results Array of benchmark results
   * @returns Formatted report string
   */
  public generateReport(results: BenchmarkResult[]): string {
    const lines: string[] = [];
    lines.push('='.repeat(80));
    lines.push('DepPulse Performance Benchmark Report');
    lines.push('='.repeat(80));
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push('');

    for (const result of results) {
      lines.push(
        `\n${result.category.toUpperCase()} Project (${result.dependencyCount} dependencies)`
      );
      lines.push('-'.repeat(80));

      if (!result.success) {
        lines.push(`Status: FAILED`);
        lines.push(`Error: ${result.error}`);
        continue;
      }

      const m = result.metrics;
      lines.push(`Status: SUCCESS`);
      lines.push('');
      lines.push('Scan Performance:');
      lines.push(
        `  Duration: ${m.scan.duration.toFixed(2)}ms (${(m.scan.duration / 1000).toFixed(2)}s)`
      );
      lines.push(`  Dependencies: ${m.scan.dependencyCount}`);
      lines.push(
        `  Avg per dependency: ${(m.scan.duration / m.scan.dependencyCount).toFixed(2)}ms`
      );
      lines.push('');
      lines.push('Memory Usage:');
      lines.push(`  Baseline: ${this.formatBytes(m.memory.baseline.heapUsed)} heap used`);
      lines.push(`  Peak: ${this.formatBytes(m.memory.peak.heapUsed)} heap used`);
      lines.push(`  Final: ${this.formatBytes(m.memory.final.heapUsed)} heap used`);
      lines.push(
        `  Peak Growth: ${this.formatBytes(m.memory.peakGrowth)} (${m.memory.peakGrowthPercent.toFixed(2)}%)`
      );
      lines.push(
        `  Final Growth: ${this.formatBytes(m.memory.finalGrowth)} (${m.memory.finalGrowthPercent.toFixed(2)}%)`
      );
      lines.push('');
      lines.push('CPU Usage:');
      lines.push(
        `  Total Duration: ${m.cpu.duration.toFixed(2)}ms (${(m.cpu.duration / 1000).toFixed(2)}s)`
      );
    }

    lines.push('');
    lines.push('='.repeat(80));
    lines.push('Performance Targets:');
    lines.push('  Small projects: <30 MB RAM, <15% CPU during scan');
    lines.push('  Mid projects: <50 MB RAM, <25% CPU during scan');
    lines.push('  Large projects: <70 MB RAM, <45% CPU during scan');
    lines.push('='.repeat(80));

    return lines.join('\n');
  }

  /**
   * Average multiple benchmark metrics
   * @param metrics Array of metrics to average
   * @returns Averaged metrics
   */
  private averageMetrics(metrics: BenchmarkMetrics[]): BenchmarkMetrics {
    if (metrics.length === 0) {
      throw new Error('Cannot average empty metrics array');
    }

    const avg = (values: number[]): number => {
      return values.reduce((sum, val) => sum + val, 0) / values.length;
    };

    const firstMetric = metrics[0];
    if (!firstMetric) {
      throw new Error('Cannot average empty metrics array');
    }

    return {
      memory: {
        baseline: firstMetric.memory.baseline, // Use first baseline
        peak: {
          ...firstMetric.memory.peak,
          heapUsed: avg(metrics.map((m) => m.memory.peak.heapUsed)),
          heapTotal: avg(metrics.map((m) => m.memory.peak.heapTotal)),
          rss: avg(metrics.map((m) => m.memory.peak.rss)),
        },
        final: {
          ...firstMetric.memory.final,
          heapUsed: avg(metrics.map((m) => m.memory.final.heapUsed)),
          heapTotal: avg(metrics.map((m) => m.memory.final.heapTotal)),
          rss: avg(metrics.map((m) => m.memory.final.rss)),
        },
        peakGrowth: avg(metrics.map((m) => m.memory.peakGrowth)),
        peakGrowthPercent: avg(metrics.map((m) => m.memory.peakGrowthPercent)),
        finalGrowth: avg(metrics.map((m) => m.memory.finalGrowth)),
        finalGrowthPercent: avg(metrics.map((m) => m.memory.finalGrowthPercent)),
      },
      cpu: {
        startTime: firstMetric.cpu.startTime,
        endTime: avg(metrics.map((m) => m.cpu.endTime)),
        duration: avg(metrics.map((m) => m.cpu.duration)),
      },
      scan: {
        startTime: firstMetric.scan.startTime,
        endTime: avg(metrics.map((m) => m.scan.endTime)),
        duration: avg(metrics.map((m) => m.scan.duration)),
        dependencyCount: Math.round(avg(metrics.map((m) => m.scan.dependencyCount))),
      },
    };
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

  /**
   * Delay execution
   * @param ms Milliseconds to delay
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Log message to output channel
   * @param message Message to log
   */
  private log(message: string): void {
    const timestamp = new Date().toISOString();
    this.outputChannel.appendLine(`[${timestamp}] [Benchmark] ${message}`);
  }
}

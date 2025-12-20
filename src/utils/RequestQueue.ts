/**
 * Rate limit configuration for a specific source
 */
export interface RateLimit {
  maxRequests: number;
  windowMs: number;
}

/**
 * Request priority levels
 */
export type RequestPriority = 'high' | 'normal' | 'low';

/**
 * Tracks rate limit state for a source
 */
interface RateLimitState {
  requests: number[];
  limit: RateLimit;
}

type Task = {
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
};

/**
 * Request queue for limiting concurrent API requests with per-source rate limiting
 */
export class RequestQueue {
  private activeRequests = 0;
  private isProcessing = false; // Flag to prevent concurrent processQueue execution
  private rateLimitStates: Map<string, RateLimitState> = new Map();
  private highPriorityQueue: Array<Task> = [];
  private normalPriorityQueue: Array<Task> = [];
  private lowPriorityQueue: Array<Task> = [];

  constructor(private maxConcurrent: number = 10) {}

  /**
   * Task wrapper for queued work
   */
  private createTask<T>(
    requestFn: () => Promise<T>,
    resolve: (value: T) => void,
    reject: (reason?: unknown) => void
  ): Task {
    return {
      run: requestFn as () => Promise<unknown>,
      resolve: (value: unknown) => resolve(value as T),
      reject,
    };
  }

  /**
   * Adds a request to the queue and executes it when a slot is available
   */
  async enqueue<T>(requestFn: () => Promise<T>, priority: RequestPriority = 'normal'): Promise<T> {
    return new Promise((resolve, reject) => {
      const task = this.createTask(requestFn, resolve, reject);

      // Add to appropriate priority queue
      switch (priority) {
        case 'high':
          this.highPriorityQueue.push(task);
          break;
        case 'low':
          this.lowPriorityQueue.push(task);
          break;
        default:
          this.normalPriorityQueue.push(task);
      }

      // Process queue
      this.processQueue();
    });
  }

  /**
   * Enqueues request with source-specific rate limiting
   */
  async enqueueWithRateLimit<T>(
    requestFn: () => Promise<T>,
    source: string,
    rateLimit: RateLimit,
    priority: RequestPriority = 'normal'
  ): Promise<T> {
    // Initialize rate limit state for source if not exists
    if (!this.rateLimitStates.has(source)) {
      this.rateLimitStates.set(source, {
        requests: [],
        limit: rateLimit,
      });
    }

    // Wait for rate limit availability
    await this.waitForRateLimit(source);

    // Record this request
    this.recordRequest(source);

    // Enqueue with retry logic
    return this.retryWithBackoff(requestFn, 3, 1000, priority);
  }

  /**
   * Implements retry logic with exponential backoff
   */
  private async retryWithBackoff<T>(
    requestFn: () => Promise<T>,
    maxRetries: number,
    baseDelay: number,
    priority: RequestPriority = 'normal'
  ): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.enqueue(requestFn, priority);
      } catch (error) {
        lastError = error as Error;

        // Check if error is retryable
        if (!this.isRetryableError(error)) {
          throw error;
        }

        // Don't retry on last attempt
        if (attempt === maxRetries) {
          break;
        }

        // Calculate delay with exponential backoff
        const delay = baseDelay * 2 ** attempt;
        await this.sleep(delay);
      }
    }

    throw lastError || new Error('Request failed after retries');
  }

  /**
   * Checks if an error is retryable
   */
  private isRetryableError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
      return false;
    }

    const err = error as { code?: string; status?: number; message?: string };

    // Retry on network errors
    if (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.code === 'ENOTFOUND') {
      return true;
    }

    // Retry on rate limit errors (429)
    if (err.status === 429) {
      return true;
    }

    // Retry on timeout errors
    if (err.message?.includes('timeout')) {
      return true;
    }

    // Retry on 5xx server errors
    if (err.status && err.status >= 500 && err.status < 600) {
      return true;
    }

    return false;
  }

  /**
   * Waits until rate limit allows another request for the source
   */
  private async waitForRateLimit(source: string): Promise<void> {
    const state = this.rateLimitStates.get(source);
    if (!state) {
      return;
    }

    while (this.isRateLimitExceeded(source)) {
      await this.sleep(100);
    }
  }

  /**
   * Checks if rate limit is exceeded for a source
   */
  private isRateLimitExceeded(source: string): boolean {
    const state = this.rateLimitStates.get(source);
    if (!state) {
      return false;
    }

    // Clean up old requests outside the window
    const now = Date.now();
    state.requests = state.requests.filter((timestamp) => now - timestamp < state.limit.windowMs);

    return state.requests.length >= state.limit.maxRequests;
  }

  /**
   * Records a request for rate limiting
   */
  private recordRequest(source: string): void {
    const state = this.rateLimitStates.get(source);
    if (!state) {
      return;
    }

    state.requests.push(Date.now());
  }

  /**
   * Processes the request queue based on priority
   * Uses isProcessing flag to prevent concurrent execution
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing) {
      return;
    }

    this.isProcessing = true;

    try {
      // Drain the queue while we have capacity
      while (this.activeRequests < this.maxConcurrent) {
        const nextTask =
          this.highPriorityQueue.shift() ??
          this.normalPriorityQueue.shift() ??
          this.lowPriorityQueue.shift();

        if (!nextTask) {
          break;
        }

        this.activeRequests++;

        nextTask
          .run()
          .then((result) => {
            this.activeRequests--;
            nextTask.resolve(result);
          })
          .catch((error) => {
            this.activeRequests--;
            nextTask.reject(error);
          })
          .finally(() => {
            // Schedule another drain attempt when a slot frees up
            setImmediate(() => this.processQueue());
          });
      }
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Gets the current number of active requests
   */
  getActiveCount(): number {
    return this.activeRequests;
  }

  /**
   * Gets the number of queued requests by priority
   */
  getQueuedCount(): { high: number; normal: number; low: number; total: number } {
    return {
      high: this.highPriorityQueue.length,
      normal: this.normalPriorityQueue.length,
      low: this.lowPriorityQueue.length,
      total:
        this.highPriorityQueue.length +
        this.normalPriorityQueue.length +
        this.lowPriorityQueue.length,
    };
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

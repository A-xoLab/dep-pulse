import axios, { type AxiosError, type AxiosInstance, type AxiosRequestConfig } from 'axios';
import type * as vscode from 'vscode';
import {
  DepPulseError,
  ErrorCode,
  type APIClient as IAPIClient,
  type RequestOptions,
} from '../types';
import { RequestQueue } from '../utils/RequestQueue';

/**
 * Base HTTP client for making API requests
 * Provides common functionality like logging, error handling, and retries
 */
export class BaseAPIClient implements IAPIClient {
  protected axiosInstance: AxiosInstance;
  protected outputChannel: vscode.OutputChannel;
  protected requestQueue: RequestQueue;

  constructor(
    baseURL: string,
    outputChannel: vscode.OutputChannel,
    defaultTimeout: number = 30000,
    maxConcurrentRequests: number = 10
  ) {
    this.outputChannel = outputChannel;
    this.requestQueue = new RequestQueue(maxConcurrentRequests);

    // Create axios instance with default configuration
    this.axiosInstance = axios.create({
      baseURL,
      timeout: defaultTimeout,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'DepPulse-VSCode-Extension',
      },
    });

    // Add request interceptor for logging
    this.axiosInstance.interceptors.request.use(
      (config) => {
        this.log('info', `API Request: ${config.method?.toUpperCase()} ${config.url}`);
        return config;
      },
      (error) => {
        this.log('error', 'Request interceptor error', error);
        return Promise.reject(error);
      }
    );

    // Add response interceptor for logging
    this.axiosInstance.interceptors.response.use(
      (response) => {
        this.log('info', `API Response: ${response.status} ${response.config.url}`);
        return response;
      },
      (error) => {
        // Reduce verbosity for 404 errors (expected for test/fake packages)
        const status = error.response?.status;
        if (status === 404) {
          this.log('debug', `API Error: ${error.message}`, {
            url: error.config?.url,
            status: 404,
          });
        } else {
          this.log('error', `API Error: ${error.message}`, {
            url: error.config?.url,
            status: error.response?.status,
          });
        }
        return Promise.reject(error);
      }
    );
  }

  /**
   * Makes a GET request with retry logic and request queuing
   */
  async get<T>(url: string, options?: RequestOptions): Promise<T> {
    const retries = options?.retries ?? 3;

    // Queue the request to limit concurrency
    return this.requestQueue.enqueue(() =>
      this.executeWithRetry(
        async () => {
          const config = this.buildRequestConfig(options);
          const response = await this.axiosInstance.get<T>(url, config);
          return response.data;
        },
        retries,
        'GET',
        url
      )
    );
  }

  /**
   * Makes a POST request with retry logic and request queuing
   */
  async post<T, D = unknown>(url: string, data: D, options?: RequestOptions): Promise<T> {
    const retries = options?.retries ?? 3;

    // Queue the request to limit concurrency
    return this.requestQueue.enqueue(() =>
      this.executeWithRetry(
        async () => {
          const config = this.buildRequestConfig(options);
          const response = await this.axiosInstance.post<T>(url, data, config);
          return response.data;
        },
        retries,
        'POST',
        url
      )
    );
  }

  /**
   * Executes a request with exponential backoff retry logic
   */
  private async executeWithRetry<T>(
    requestFn: () => Promise<T>,
    maxRetries: number,
    method: string,
    url: string
  ): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await requestFn();
        this.log('info', `Request succeeded: ${method} ${url}`);
        return result;
      } catch (error: unknown) {
        lastError = error;

        // Check if error is retryable
        const isRetryable = this.isRetryableError(error);
        const isLastAttempt = attempt === maxRetries;

        if (!isRetryable || isLastAttempt) {
          throw this.handleError(error as AxiosError, method, url);
        }

        // Calculate delay with exponential backoff: 1s, 2s, 4s
        const delay = 2 ** attempt * 1000;
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        this.log(
          'warn',
          `Request failed, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`,
          {
            url,
            error: errorMessage,
          }
        );

        await this.sleep(delay);
      }
    }

    throw this.handleError(lastError as AxiosError, method, url);
  }

  /**
   * Determines if an error is retryable
   */
  private isRetryableError(error: unknown): boolean {
    // Type guard for error with code property
    if (this.hasErrorCode(error)) {
      if (
        error.code === 'ECONNABORTED' ||
        error.code === 'ETIMEDOUT' ||
        error.code === 'ENOTFOUND'
      ) {
        return true;
      }
    }

    // Type guard for axios error with response
    if (this.isAxiosError(error) && error.response) {
      const status = error.response.status;
      return status === 429 || (status >= 500 && status < 600);
    }

    // Retry if no response received
    if (this.isAxiosError(error) && error.request && !error.response) {
      return true;
    }

    return false;
  }

  /**
   * Type guard to check if error has a code property
   */
  private hasErrorCode(error: unknown): error is { code: string } {
    return typeof error === 'object' && error !== null && 'code' in error;
  }

  /**
   * Type guard to check if error is an AxiosError
   */
  protected isAxiosError(error: unknown): error is AxiosError {
    return typeof error === 'object' && error !== null && 'isAxiosError' in error;
  }

  /**
   * Sleep utility for delays
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Builds axios request configuration from options
   */
  private buildRequestConfig(options?: RequestOptions): AxiosRequestConfig {
    const config: AxiosRequestConfig = {};

    if (options?.headers) {
      config.headers = options.headers;
    }

    if (options?.timeout) {
      config.timeout = options.timeout;
    }

    return config;
  }

  /**
   * Handles API errors and converts them to DepPulseError
   */
  protected handleError(error: AxiosError, method: string, url: string): DepPulseError {
    let code = ErrorCode.API_ERROR;
    let recoverable = true;
    let message = `${method} ${url} failed`;

    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
      code = ErrorCode.NETWORK_ERROR;
      message = `Request timeout: ${url}`;
    } else if (error.response) {
      // Server responded with error status
      const status = error.response.status;

      if (status === 404) {
        code = ErrorCode.API_ERROR;
        message = `Resource not found: ${url}`;
        // Log 404s at debug level to reduce noise (expected for test/fake packages)
        this.log('debug', `Package not found: ${url}`);
      } else if (status === 429) {
        code = ErrorCode.RATE_LIMIT;
        message = `Rate limit exceeded: ${url}`;
      } else if (status === 401 || status === 403) {
        code = ErrorCode.AUTH_ERROR;
        message = `Authentication failed (${status}): ${url}. GitHub API requires authentication for vulnerability scanning. Please set a GitHub Personal Access Token via “DepPulse: Configure API Secrets”.`;
        recoverable = false;
      } else {
        message = `API error (${status}): ${url}`;
      }
    } else if (error.request) {
      // Request made but no response received
      code = ErrorCode.NETWORK_ERROR;
      message = `No response from server: ${url}`;
    }

    return new DepPulseError(message, code, recoverable, {
      originalError: error,
      url,
      method,
      status: error.response?.status,
    });
  }

  /**
   * Logs messages to the output channel
   */
  protected log(level: 'info' | 'warn' | 'error' | 'debug', message: string, data?: unknown): void {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${level.toUpperCase()}] ${message}`;
    this.outputChannel.appendLine(logMessage);

    if (data) {
      // Handle Error objects specially
      if (data instanceof Error) {
        this.outputChannel.appendLine(`  Error: ${data.message}`);
        if (data.stack) {
          this.outputChannel.appendLine(`  Stack: ${data.stack}`);
        }
      } else if (typeof data === 'object' && data !== null) {
        try {
          this.outputChannel.appendLine(JSON.stringify(data, null, 2));
        } catch {
          // Fallback for circular references or non-serializable objects
          this.outputChannel.appendLine(`  ${String(data)}`);
        }
      } else {
        this.outputChannel.appendLine(`  ${String(data)}`);
      }
    }
  }
}

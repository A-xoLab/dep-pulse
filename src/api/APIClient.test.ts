import type { AxiosError, AxiosInstance, InternalAxiosRequestConfig } from 'axios';
import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { DepPulseError, ErrorCode } from '../types';
import { BaseAPIClient } from './APIClient';

// Mock axios
vi.mock('axios', () => ({
  default: {
    create: vi.fn(),
  },
  create: vi.fn(),
}));

// Mock RequestQueue
vi.mock('../utils/RequestQueue', () => {
  class MockRequestQueue {
    maxConcurrent: number;
    enqueue: ReturnType<typeof vi.fn>;
    clear: ReturnType<typeof vi.fn>;
    getQueueSize: ReturnType<typeof vi.fn>;
    getActiveCount: ReturnType<typeof vi.fn>;

    constructor(maxConcurrent: number) {
      this.maxConcurrent = maxConcurrent;
      this.enqueue = vi.fn((fn: () => Promise<unknown>) => {
        return fn();
      });
      this.clear = vi.fn();
      this.getQueueSize = vi.fn().mockReturnValue(0);
      this.getActiveCount = vi.fn().mockReturnValue(0);
    }
  }
  return {
    RequestQueue: MockRequestQueue,
  };
});

// Mock output channel
const createMockOutputChannel = (): vscode.OutputChannel => ({
  name: 'test',
  append: vi.fn(),
  appendLine: vi.fn(),
  replace: vi.fn(),
  clear: vi.fn(),
  show: vi.fn(),
  hide: vi.fn(),
  dispose: vi.fn(),
});

describe('BaseAPIClient', () => {
  let client: BaseAPIClient;
  let mockOutputChannel: vscode.OutputChannel;
  let mockAxiosInstance: AxiosInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    mockOutputChannel = createMockOutputChannel();

    // Create mock axios instance
    mockAxiosInstance = {
      get: vi.fn(),
      post: vi.fn(),
      defaults: {
        baseURL: 'https://api.test.com',
        timeout: 30000,
        headers: {
          common: {
            'Content-Type': 'application/json',
            'User-Agent': 'DepPulse-VSCode-Extension',
          },
        },
      },
      interceptors: {
        request: {
          use: vi.fn(),
        },
        response: {
          use: vi.fn(),
        },
      },
    } as unknown as AxiosInstance;

    (axios.create as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockAxiosInstance);

    client = new BaseAPIClient('https://api.test.com', mockOutputChannel);
  });

  describe('Constructor', () => {
    it('should initialize with correct base URL and timeout', () => {
      expect(axios.create).toHaveBeenCalledWith({
        baseURL: 'https://api.test.com',
        timeout: 30000,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'DepPulse-VSCode-Extension',
        },
      });
    });

    it('should set up request interceptor', () => {
      expect(mockAxiosInstance.interceptors.request.use).toHaveBeenCalled();
    });

    it('should set up response interceptor', () => {
      expect(mockAxiosInstance.interceptors.response.use).toHaveBeenCalled();
    });

    it('should use custom timeout when provided', () => {
      const _customClient = new BaseAPIClient('https://api.test.com', mockOutputChannel, 60000);
      expect(axios.create).toHaveBeenCalledWith(
        expect.objectContaining({
          timeout: 60000,
        })
      );
    });
  });

  describe('GET requests', () => {
    it('should make successful GET request', async () => {
      const mockData = { id: 1, name: 'test' };
      vi.mocked(mockAxiosInstance.get).mockResolvedValue({
        data: mockData,
        status: 200,
        statusText: 'OK',
        headers: {},
        config: {} as unknown as InternalAxiosRequestConfig,
      });

      const result = await client.get<typeof mockData>('/test');

      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/test', {});
      expect(result).toEqual(mockData);
    });

    it('should use custom retry count (GET)', async () => {
      const mockData = { id: 1 };
      vi.mocked(mockAxiosInstance.get).mockResolvedValue({
        data: mockData,
        status: 200,
        statusText: 'OK',
        headers: {},
        config: {} as unknown as InternalAxiosRequestConfig,
      });

      await client.get('/test', { retries: 5 });

      expect(mockAxiosInstance.get).toHaveBeenCalled();
    });

    it('should pass custom headers', async () => {
      const mockData = { id: 1 };
      vi.mocked(mockAxiosInstance.get).mockResolvedValue({
        data: mockData,
        status: 200,
        statusText: 'OK',
        headers: {},
        config: {} as unknown as InternalAxiosRequestConfig,
      });

      await client.get('/test', { headers: { Authorization: 'Bearer token' } });

      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/test', {
        headers: { Authorization: 'Bearer token' },
      });
    });

    it('should pass custom timeout', async () => {
      const mockData = { id: 1 };
      vi.mocked(mockAxiosInstance.get).mockResolvedValue({
        data: mockData,
        status: 200,
        statusText: 'OK',
        headers: {},
        config: {} as unknown as InternalAxiosRequestConfig,
      });

      await client.get('/test', { timeout: 10000 });

      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/test', {
        timeout: 10000,
      });
    });
  });

  describe('POST requests', () => {
    it('should make successful POST request', async () => {
      const requestData = { name: 'test' };
      const mockData = { id: 1, name: 'test' };
      vi.mocked(mockAxiosInstance.post).mockResolvedValue({
        data: mockData,
        status: 200,
        statusText: 'OK',
        headers: {},
        config: {} as unknown as InternalAxiosRequestConfig,
      });

      const result = await client.post<typeof mockData, typeof requestData>('/test', requestData);

      expect(mockAxiosInstance.post).toHaveBeenCalledWith('/test', requestData, {});
      expect(result).toEqual(mockData);
    });

    it('should use custom retry count (POST)', async () => {
      const requestData = { name: 'test' };
      const mockData = { id: 1 };
      vi.mocked(mockAxiosInstance.post).mockResolvedValue({
        data: mockData,
        status: 200,
        statusText: 'OK',
        headers: {},
        config: {} as unknown as InternalAxiosRequestConfig,
      });

      await client.post('/test', requestData, { retries: 5 });

      expect(mockAxiosInstance.post).toHaveBeenCalled();
    });

    it('should pass custom headers and timeout', async () => {
      const requestData = { name: 'test' };
      const mockData = { id: 1 };
      vi.mocked(mockAxiosInstance.post).mockResolvedValue({
        data: mockData,
        status: 200,
        statusText: 'OK',
        headers: {},
        config: {} as unknown as InternalAxiosRequestConfig,
      });

      await client.post('/test', requestData, {
        headers: { Authorization: 'Bearer token' },
        timeout: 10000,
      });

      expect(mockAxiosInstance.post).toHaveBeenCalledWith('/test', requestData, {
        headers: { Authorization: 'Bearer token' },
        timeout: 10000,
      });
    });
  });

  describe('Error Handling', () => {
    it('should handle timeout errors (ECONNABORTED)', async () => {
      // Mock sleep to avoid real delays
      vi.spyOn(
        client as unknown as { sleep: (ms: number) => Promise<void> },
        'sleep'
      ).mockResolvedValue(undefined);

      const timeoutError: Partial<AxiosError> = {
        code: 'ECONNABORTED',
        message: 'timeout of 30000ms exceeded',
        isAxiosError: true,
        config: {} as unknown as InternalAxiosRequestConfig,
      };

      vi.mocked(mockAxiosInstance.get).mockRejectedValue(timeoutError as AxiosError);

      await expect(client.get('/test')).rejects.toThrow(
        expect.objectContaining({ message: expect.stringContaining('Request timeout') })
      );
    });

    it('should handle network timeout errors (ETIMEDOUT)', async () => {
      // Mock sleep to avoid real delays
      vi.spyOn(
        client as unknown as { sleep: (ms: number) => Promise<void> },
        'sleep'
      ).mockResolvedValue(undefined);

      const timeoutError: Partial<AxiosError> = {
        code: 'ETIMEDOUT',
        message: 'timeout',
        isAxiosError: true,
        config: {} as unknown as InternalAxiosRequestConfig,
      };

      vi.mocked(mockAxiosInstance.get).mockRejectedValue(timeoutError as AxiosError);

      await expect(client.get('/test')).rejects.toThrow(
        expect.objectContaining({ message: expect.stringContaining('Request timeout') })
      );
    });

    it('should handle 404 Not Found errors', async () => {
      const notFoundError: Partial<AxiosError> = {
        code: 'ERR_BAD_RESPONSE',
        message: 'Request failed with status code 404',
        isAxiosError: true,
        response: {
          status: 404,
          statusText: 'Not Found',
          data: {},
          headers: {},
          config: {} as unknown as InternalAxiosRequestConfig,
        },
        config: {} as unknown as InternalAxiosRequestConfig,
      };

      vi.mocked(mockAxiosInstance.get).mockRejectedValue(notFoundError as AxiosError);

      await expect(client.get('/test')).rejects.toThrow(DepPulseError);
      const error = await client.get('/test').catch((e) => e);
      expect(error).toBeInstanceOf(DepPulseError);
      expect((error as DepPulseError).message).toContain('Resource not found');
    });

    it('should handle 429 Rate Limit errors', async () => {
      // Mock sleep to avoid real delays
      vi.spyOn(
        client as unknown as { sleep: (ms: number) => Promise<void> },
        'sleep'
      ).mockResolvedValue(undefined);

      const rateLimitError: Partial<AxiosError> = {
        code: 'ERR_BAD_RESPONSE',
        message: 'Request failed with status code 429',
        isAxiosError: true,
        response: {
          status: 429,
          statusText: 'Too Many Requests',
          data: {},
          headers: {},
          config: {} as unknown as InternalAxiosRequestConfig,
        },
        config: {} as unknown as InternalAxiosRequestConfig,
      };

      vi.mocked(mockAxiosInstance.get).mockRejectedValue(rateLimitError as AxiosError);

      await expect(client.get('/test')).rejects.toThrow(
        expect.objectContaining({ message: expect.stringContaining('Rate limit') })
      );
    });

    it('should handle 401 Unauthorized errors', async () => {
      const authError: Partial<AxiosError> = {
        code: 'ERR_BAD_RESPONSE',
        message: 'Request failed with status code 401',
        isAxiosError: true,
        response: {
          status: 401,
          statusText: 'Unauthorized',
          data: {},
          headers: {},
          config: {} as unknown as InternalAxiosRequestConfig,
        },
        config: {} as unknown as InternalAxiosRequestConfig,
      };

      vi.mocked(mockAxiosInstance.get).mockRejectedValue(authError as AxiosError);

      await expect(client.get('/test')).rejects.toThrow(DepPulseError);
      const error = await client.get('/test').catch((e) => e);
      expect(error).toBeInstanceOf(DepPulseError);
      expect((error as DepPulseError).recoverable).toBe(false);
    });

    it('should handle 403 Forbidden errors', async () => {
      const forbiddenError: Partial<AxiosError> = {
        code: 'ERR_BAD_RESPONSE',
        message: 'Request failed with status code 403',
        isAxiosError: true,
        response: {
          status: 403,
          statusText: 'Forbidden',
          data: {},
          headers: {},
          config: {} as unknown as InternalAxiosRequestConfig,
        },
        config: {} as unknown as InternalAxiosRequestConfig,
      };

      vi.mocked(mockAxiosInstance.get).mockRejectedValue(forbiddenError as AxiosError);

      await expect(client.get('/test')).rejects.toThrow(DepPulseError);
      const error = await client.get('/test').catch((e) => e);
      expect(error).toBeInstanceOf(DepPulseError);
      expect((error as DepPulseError).recoverable).toBe(false);
    });

    it('should handle 500 Server errors', async () => {
      // Mock sleep to avoid real delays
      vi.spyOn(
        client as unknown as { sleep: (ms: number) => Promise<void> },
        'sleep'
      ).mockResolvedValue(undefined);

      const serverError: Partial<AxiosError> = {
        code: 'ERR_BAD_RESPONSE',
        message: 'Request failed with status code 500',
        isAxiosError: true,
        response: {
          status: 500,
          statusText: 'Internal Server Error',
          data: {},
          headers: {},
          config: {} as unknown as InternalAxiosRequestConfig,
        },
        config: {} as unknown as InternalAxiosRequestConfig,
      };

      vi.mocked(mockAxiosInstance.get).mockRejectedValue(serverError as AxiosError);

      await expect(client.get('/test')).rejects.toThrow(
        expect.objectContaining({ message: expect.stringContaining('API error') })
      );
    });

    it('should handle network errors (no response)', async () => {
      // Mock sleep to avoid real delays
      vi.spyOn(
        client as unknown as { sleep: (ms: number) => Promise<void> },
        'sleep'
      ).mockResolvedValue(undefined);

      const networkError: Partial<AxiosError> = {
        code: 'ENOTFOUND',
        message: 'getaddrinfo ENOTFOUND api.test.com',
        isAxiosError: true,
        request: {},
        config: {} as unknown as InternalAxiosRequestConfig,
      };

      vi.mocked(mockAxiosInstance.get).mockRejectedValue(networkError as AxiosError);

      await expect(client.get('/test')).rejects.toThrow(
        expect.objectContaining({ message: expect.stringContaining('No response from server') })
      );
    });

    it('should include error details in DepPulseError', async () => {
      // Mock sleep to avoid real delays
      vi.spyOn(
        client as unknown as { sleep: (ms: number) => Promise<void> },
        'sleep'
      ).mockResolvedValue(undefined);

      const serverError: Partial<AxiosError> = {
        code: 'ERR_BAD_RESPONSE',
        message: 'Request failed with status code 500',
        isAxiosError: true,
        response: {
          status: 500,
          statusText: 'Internal Server Error',
          data: {},
          headers: {},
          config: {} as unknown as InternalAxiosRequestConfig,
        },
        config: {} as unknown as InternalAxiosRequestConfig,
      };

      vi.mocked(mockAxiosInstance.get).mockRejectedValue(serverError as AxiosError);

      await expect(client.get('/test')).rejects.toThrow(
        expect.objectContaining({ code: ErrorCode.API_ERROR, recoverable: true })
      );
    });
  });

  describe('Retry Logic', () => {
    it('should retry on retryable errors (ECONNABORTED)', async () => {
      const timeoutError: Partial<AxiosError> = {
        code: 'ECONNABORTED',
        message: 'timeout',
        isAxiosError: true,
        config: {} as unknown as InternalAxiosRequestConfig,
      };

      let callCount = 0;
      vi.mocked(mockAxiosInstance.get).mockImplementation(async () => {
        callCount++;
        if (callCount < 3) {
          throw timeoutError as AxiosError;
        }
        return {
          data: { success: true },
          status: 200,
          statusText: 'OK',
          headers: {},
          config: {} as unknown as InternalAxiosRequestConfig,
        };
      });

      const result = await client.get('/test', { retries: 3 });
      expect(result).toEqual({ success: true });
      expect(callCount).toBe(3);
    });

    it('should retry on 500 server errors', async () => {
      const serverError: Partial<AxiosError> = {
        code: 'ERR_BAD_RESPONSE',
        message: 'Request failed with status code 500',
        isAxiosError: true,
        response: {
          status: 500,
          statusText: 'Internal Server Error',
          data: {},
          headers: {},
          config: {} as unknown as InternalAxiosRequestConfig,
        },
        config: {} as unknown as InternalAxiosRequestConfig,
      };

      let callCount = 0;
      vi.mocked(mockAxiosInstance.get).mockImplementation(async () => {
        callCount++;
        if (callCount < 2) {
          throw serverError as AxiosError;
        }
        return {
          data: { success: true },
          status: 200,
          statusText: 'OK',
          headers: {},
          config: {} as unknown as InternalAxiosRequestConfig,
        };
      });

      const result = await client.get('/test', { retries: 3 });
      expect(result).toEqual({ success: true });
      expect(callCount).toBe(2);
    });

    it('should retry on 429 rate limit errors', async () => {
      const rateLimitError: Partial<AxiosError> = {
        code: 'ERR_BAD_RESPONSE',
        message: 'Request failed with status code 429',
        isAxiosError: true,
        response: {
          status: 429,
          statusText: 'Too Many Requests',
          data: {},
          headers: {},
          config: {} as unknown as InternalAxiosRequestConfig,
        },
        config: {} as unknown as InternalAxiosRequestConfig,
      };

      let callCount = 0;
      vi.mocked(mockAxiosInstance.get).mockImplementation(async () => {
        callCount++;
        if (callCount < 2) {
          throw rateLimitError as AxiosError;
        }
        return {
          data: { success: true },
          status: 200,
          statusText: 'OK',
          headers: {},
          config: {} as unknown as InternalAxiosRequestConfig,
        };
      });

      const result = await client.get('/test', { retries: 3 });
      expect(result).toEqual({ success: true });
      expect(callCount).toBe(2);
    });

    it('should not retry on non-retryable errors (400 Bad Request)', async () => {
      const badRequestError: Partial<AxiosError> = {
        code: 'ERR_BAD_RESPONSE',
        message: 'Request failed with status code 400',
        isAxiosError: true,
        response: {
          status: 400,
          statusText: 'Bad Request',
          data: {},
          headers: {},
          config: {} as unknown as InternalAxiosRequestConfig,
        },
        config: {} as unknown as InternalAxiosRequestConfig,
      };

      let callCount = 0;
      vi.mocked(mockAxiosInstance.get).mockImplementation(async () => {
        callCount++;
        throw badRequestError as AxiosError;
      });

      await expect(client.get('/test', { retries: 3 })).rejects.toThrow();
      expect(callCount).toBe(1); // Should not retry
    });

    it('should not retry on 401/403 auth errors', async () => {
      const authError: Partial<AxiosError> = {
        code: 'ERR_BAD_RESPONSE',
        message: 'Request failed with status code 401',
        isAxiosError: true,
        response: {
          status: 401,
          statusText: 'Unauthorized',
          data: {},
          headers: {},
          config: {} as unknown as InternalAxiosRequestConfig,
        },
        config: {} as unknown as InternalAxiosRequestConfig,
      };

      let callCount = 0;
      vi.mocked(mockAxiosInstance.get).mockImplementation(async () => {
        callCount++;
        throw authError as AxiosError;
      });

      await expect(client.get('/test', { retries: 3 })).rejects.toThrow();
      expect(callCount).toBe(1); // Should not retry
    });

    it('should eventually fail after max retries', async () => {
      const timeoutError: Partial<AxiosError> = {
        code: 'ECONNABORTED',
        message: 'timeout',
        isAxiosError: true,
        config: {} as unknown as InternalAxiosRequestConfig,
      };

      vi.mocked(mockAxiosInstance.get).mockRejectedValue(timeoutError as AxiosError);

      await expect(client.get('/test', { retries: 2 })).rejects.toThrow(DepPulseError);
    });

    it('should use exponential backoff for retries', async () => {
      const timeoutError: Partial<AxiosError> = {
        code: 'ECONNABORTED',
        message: 'timeout',
        isAxiosError: true,
        config: {} as unknown as InternalAxiosRequestConfig,
      };

      let callCount = 0;
      const delays: number[] = [];
      const originalSleep = (client as unknown as { sleep: (ms: number) => Promise<void> }).sleep;
      vi.spyOn(
        client as unknown as { sleep: (ms: number) => Promise<void> },
        'sleep'
      ).mockImplementation(async (ms: number) => {
        const delay = ms as number;
        delays.push(delay);
        return originalSleep.call(client, delay);
      });

      vi.mocked(mockAxiosInstance.get).mockImplementation(async () => {
        callCount++;
        if (callCount < 3) {
          throw timeoutError as AxiosError;
        }
        return {
          data: { success: true },
          status: 200,
          statusText: 'OK',
          headers: {},
          config: {} as unknown as InternalAxiosRequestConfig,
        };
      });

      await client.get('/test', { retries: 3 });
      // Exponential backoff: 1s (2^0), 2s (2^1)
      expect(delays.length).toBe(2);
      expect(delays[0]).toBe(1000); // 2^0 * 1000
      expect(delays[1]).toBe(2000); // 2^1 * 1000
    });
  });

  describe('Logging', () => {
    it('should log successful requests', async () => {
      const mockData = { id: 1 };
      vi.mocked(mockAxiosInstance.get).mockResolvedValue({
        data: mockData,
        status: 200,
        statusText: 'OK',
        headers: {},
        config: { url: '/test', method: 'get' } as unknown as InternalAxiosRequestConfig,
      });

      await client.get('/test');

      expect(mockOutputChannel.appendLine).toHaveBeenCalled();
    });

    it('should log errors', async () => {
      // Mock sleep to avoid real delays
      vi.spyOn(
        client as unknown as { sleep: (ms: number) => Promise<void> },
        'sleep'
      ).mockResolvedValue(undefined);

      const error: Partial<AxiosError> = {
        code: 'ERR_BAD_RESPONSE',
        message: 'Request failed',
        isAxiosError: true,
        response: {
          status: 500,
          statusText: 'Internal Server Error',
          data: {},
          headers: {},
          config: {} as unknown as InternalAxiosRequestConfig,
        },
        config: {} as unknown as InternalAxiosRequestConfig,
      };

      vi.mocked(mockAxiosInstance.get).mockRejectedValue(error as AxiosError);

      await expect(client.get('/test')).rejects.toThrow();

      expect(mockOutputChannel.appendLine).toHaveBeenCalled();
    });

    it('should log retry attempts', async () => {
      const timeoutError: Partial<AxiosError> = {
        code: 'ECONNABORTED',
        message: 'timeout',
        isAxiosError: true,
        config: {} as unknown as InternalAxiosRequestConfig,
      };

      let callCount = 0;
      vi.mocked(mockAxiosInstance.get).mockImplementation(async () => {
        callCount++;
        if (callCount < 2) {
          throw timeoutError as AxiosError;
        }
        return {
          data: { success: true },
          status: 200,
          statusText: 'OK',
          headers: {},
          config: {} as unknown as InternalAxiosRequestConfig,
        };
      });

      await client.get('/test', { retries: 3 });

      // Should log retry attempts
      const logCalls = vi.mocked(mockOutputChannel.appendLine).mock.calls;
      const retryLogs = logCalls.filter((call) => call[0]?.includes('retrying'));
      expect(retryLogs.length).toBeGreaterThan(0);
    });
  });

  describe('Request Interceptors', () => {
    it('should log request information', () => {
      // Interceptors are set up in constructor
      expect(mockAxiosInstance.interceptors.request.use).toHaveBeenCalled();
      const interceptorCall = vi.mocked(mockAxiosInstance.interceptors.request.use).mock.calls[0];
      expect(interceptorCall[0]).toBeInstanceOf(Function);
    });

    it('should handle request interceptor errors', () => {
      expect(mockAxiosInstance.interceptors.request.use).toHaveBeenCalled();
      const interceptorCall = vi.mocked(mockAxiosInstance.interceptors.request.use).mock.calls[0];
      expect(interceptorCall[1]).toBeInstanceOf(Function); // Error handler
    });
  });

  describe('Response Interceptors', () => {
    it('should log response information', () => {
      // Interceptors are set up in constructor
      expect(mockAxiosInstance.interceptors.response.use).toHaveBeenCalled();
      const interceptorCall = vi.mocked(mockAxiosInstance.interceptors.response.use).mock.calls[0];
      expect(interceptorCall[0]).toBeInstanceOf(Function);
    });

    it('should handle response interceptor errors', () => {
      expect(mockAxiosInstance.interceptors.response.use).toHaveBeenCalled();
      const interceptorCall = vi.mocked(mockAxiosInstance.interceptors.response.use).mock.calls[0];
      expect(interceptorCall[1]).toBeInstanceOf(Function); // Error handler
    });
  });
});

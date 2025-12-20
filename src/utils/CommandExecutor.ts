import * as cp from 'node:child_process';
import * as util from 'node:util';
import { DepPulseError, ErrorCode } from '../types';
import { Logger } from './Logger';

const exec = util.promisify(cp.exec);

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export class CommandExecutor {
  private static instance: CommandExecutor;
  private logger = Logger.getInstance();

  private constructor() {}

  public static getInstance(): CommandExecutor {
    if (!CommandExecutor.instance) {
      CommandExecutor.instance = new CommandExecutor();
    }
    return CommandExecutor.instance;
  }

  /**
   * Executes a shell command with timeout and error handling
   * @param command The command to execute
   * @param cwd Current working directory
   * @param timeout Timeout in milliseconds (default: 10000)
   */
  public async execute(
    command: string,
    cwd: string,
    timeout: number = 10000
  ): Promise<CommandResult> {
    this.logger.debug(`Executing command: ${command} in ${cwd}`);

    try {
      const { stdout, stderr } = await exec(command, {
        cwd,
        timeout,
        // Increase buffer to handle large monorepo trees
        maxBuffer: 50 * 1024 * 1024,
      });

      return { stdout, stderr };
    } catch (error: unknown) {
      // Handle specific error cases
      const err = error as Error & {
        killed?: boolean;
        code?: number;
        stdout?: string;
        stderr?: string;
      };
      if (err.killed) {
        throw new DepPulseError(
          `Command timed out after ${timeout}ms: ${command}`,
          ErrorCode.UNKNOWN,
          true
        );
      }

      if (err.code === 127 || err.message.includes('command not found')) {
        throw new DepPulseError(`Command not found: ${command}`, ErrorCode.UNKNOWN, true);
      }

      // For non-zero exit codes, we might still want the stdout/stderr if available
      // But usually it means failure.
      const stderr = err.stderr?.trim();
      const stdout = err.stdout?.trim();
      const detail = stderr || stdout;
      const combinedMessage = detail
        ? `Command failed: ${command}. ${detail.slice(0, 500)}`
        : `Command failed: ${command}. Error: ${err.message}`;

      throw new DepPulseError(combinedMessage, ErrorCode.UNKNOWN, true, {
        stderr,
        stdout,
        code: err.code,
      });
    }
  }
}

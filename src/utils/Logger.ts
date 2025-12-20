import * as vscode from 'vscode';

export enum LogLevel {
  DEBUG = 'DEBUG',
  INFO = 'INFO',
  WARN = 'WARN',
  ERROR = 'ERROR',
}

export class Logger {
  private static instance: Logger;
  private outputChannel: vscode.OutputChannel;

  private constructor() {
    this.outputChannel = vscode.window.createOutputChannel('DepPulse');
  }

  public static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  public static initialize(): void {
    Logger.getInstance();
  }

  public getOutputChannel(): vscode.OutputChannel {
    return this.outputChannel;
  }

  private getTimestamp(): string {
    return new Date().toISOString();
  }

  private formatMessage(level: LogLevel, message: string): string {
    return `[${this.getTimestamp()}] [${level}] ${message}`;
  }

  public log(level: LogLevel, message: string): void {
    this.outputChannel.appendLine(this.formatMessage(level, message));
  }

  public debug(message: string): void {
    this.log(LogLevel.DEBUG, message);
  }

  public info(message: string): void {
    this.log(LogLevel.INFO, message);
  }

  public warn(message: string): void {
    this.log(LogLevel.WARN, message);
  }

  public error(message: string, error?: unknown): void {
    let errorMessage = message;
    if (error) {
      if (error instanceof Error) {
        errorMessage += `: ${error.message}`;
        if (error.stack) {
          errorMessage += `\n${error.stack}`;
        }
      } else {
        errorMessage += `: ${String(error)}`;
      }
    }
    this.log(LogLevel.ERROR, errorMessage);
  }

  public show(): void {
    this.outputChannel.show();
  }
}

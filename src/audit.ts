import * as winston from 'winston';
import * as path from 'path';
import { AuditEntry, BrokerConfig } from './types';

export class AuditLogger {
  private logger: winston.Logger;

  constructor(config: BrokerConfig['audit']) {
    const logDir = path.resolve(config.logDir);

    this.logger = winston.createLogger({
      level: 'info',
      format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
        winston.format.json()
      ),
      transports: [
        new winston.transports.File({
          filename: path.join(logDir, 'audit.log'),
          maxsize: config.maxFileSizeMb * 1024 * 1024,
          maxFiles: config.maxFiles,
          tailable: true,
        }),
        new winston.transports.File({
          filename: path.join(logDir, 'audit-error.log'),
          level: 'error',
          maxsize: config.maxFileSizeMb * 1024 * 1024,
          maxFiles: config.maxFiles,
        }),
      ],
    });

    // Also log to console in development
    if (process.env.NODE_ENV !== 'production') {
      this.logger.add(
        new winston.transports.Console({
          format: winston.format.combine(
            winston.format.colorize(),
            winston.format.printf(({ timestamp, message, ...meta }) => {
              const entry = meta as unknown as AuditEntry;
              const cmd = entry.command ? ` cmd="${entry.command}"` : '';
              const result = entry.result ? ` result=${entry.result}` : '';
              return `${timestamp} [AUDIT] ${message}${cmd}${result} session=${entry.sessionId || 'n/a'}`;
            })
          ),
        })
      );
    }
  }

  log(entry: AuditEntry): void {
    const level = entry.result === 'error' ? 'error' : 'info';
    this.logger.log(level, entry.action, entry);
  }

  sessionCreated(sessionId: string, hostId: string, ip?: string): void {
    this.log({
      timestamp: new Date().toISOString(),
      sessionId,
      hostId,
      action: 'session_created',
      result: 'success',
      ip,
    });
  }

  sessionClosed(sessionId: string, hostId: string, reason: string): void {
    this.log({
      timestamp: new Date().toISOString(),
      sessionId,
      hostId,
      action: 'session_closed',
      result: 'success',
      error: reason,
    });
  }

  commandExecuted(
    sessionId: string,
    hostId: string,
    command: string,
    exitCode: number,
    durationMs: number,
    ip?: string
  ): void {
    this.log({
      timestamp: new Date().toISOString(),
      sessionId,
      hostId,
      action: 'command_executed',
      command,
      result: 'success',
      exitCode,
      durationMs,
      ip,
    });
  }

  commandDenied(sessionId: string, hostId: string, command: string, reason: string, ip?: string): void {
    this.log({
      timestamp: new Date().toISOString(),
      sessionId,
      hostId,
      action: 'command_denied',
      command,
      result: 'denied',
      error: reason,
      ip,
    });
  }

  commandError(sessionId: string, hostId: string, command: string, error: string, ip?: string): void {
    this.log({
      timestamp: new Date().toISOString(),
      sessionId,
      hostId,
      action: 'command_error',
      command,
      result: 'error',
      error,
      ip,
    });
  }
}

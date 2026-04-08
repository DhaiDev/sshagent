export interface HostConfig {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  // Auth: password or private key path — never exposed via API
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
}

export interface SessionInfo {
  sessionId: string;
  hostId: string;
  createdAt: Date;
  lastActivityAt: Date;
  ttlMs: number;
  commandCount: number;
  status: 'connecting' | 'active' | 'closed' | 'error';
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

export interface WhitelistRule {
  // Exact command prefix or regex pattern
  pattern: string;
  type: 'prefix' | 'regex';
  description?: string;
}

export interface BrokerConfig {
  hosts: HostConfig[];
  securityMode: 'whitelist' | 'confirm' | 'bypass';
  whitelist: WhitelistRule[];
  session: {
    defaultTtlMs: number;
    maxTtlMs: number;
    maxConcurrentSessions: number;
    cleanupIntervalMs: number;
  };
  rateLimit: {
    windowMs: number;
    maxRequestsPerWindow: number;
  };
  server: {
    port: number;
    host: string;
    apiKey?: string; // Optional API key for authentication
  };
  audit: {
    logDir: string;
    maxFileSizeMb: number;
    maxFiles: number;
  };
  exec: {
    defaultTimeoutMs: number;
    maxTimeoutMs: number;
    maxOutputBytes: number;
  };
}

export interface AuditEntry {
  timestamp: string;
  sessionId: string;
  hostId: string;
  action: string;
  command?: string;
  result?: 'success' | 'denied' | 'error';
  exitCode?: number;
  durationMs?: number;
  error?: string;
  ip?: string;
}

import * as fs from 'fs';
import * as path from 'path';
import { BrokerConfig } from './types';

const DEFAULT_CONFIG: BrokerConfig = {
  hosts: [],
  securityMode: 'confirm',
  whitelist: [
    { pattern: 'ls', type: 'prefix', description: 'List files' },
    { pattern: 'cat', type: 'prefix', description: 'Read files' },
    { pattern: 'pwd', type: 'prefix', description: 'Print working directory' },
    { pattern: 'whoami', type: 'prefix', description: 'Current user' },
    { pattern: 'df', type: 'prefix', description: 'Disk usage' },
    { pattern: 'free', type: 'prefix', description: 'Memory usage' },
    { pattern: 'uptime', type: 'prefix', description: 'System uptime' },
    { pattern: 'ps aux', type: 'prefix', description: 'Process list' },
    { pattern: 'systemctl status', type: 'prefix', description: 'Service status' },
    { pattern: 'docker ps', type: 'prefix', description: 'Docker containers' },
    { pattern: 'docker logs', type: 'prefix', description: 'Docker logs' },
    { pattern: 'tail', type: 'prefix', description: 'Tail files' },
    { pattern: 'head', type: 'prefix', description: 'Head files' },
    { pattern: 'grep', type: 'prefix', description: 'Search in files' },
    { pattern: 'find', type: 'prefix', description: 'Find files' },
    { pattern: 'wc', type: 'prefix', description: 'Word count' },
    { pattern: 'date', type: 'prefix', description: 'Current date' },
    { pattern: 'hostname', type: 'prefix', description: 'Hostname' },
  ],
  session: {
    defaultTtlMs: 30 * 60 * 1000,      // 30 minutes
    maxTtlMs: 4 * 60 * 60 * 1000,      // 4 hours
    maxConcurrentSessions: 10,
    cleanupIntervalMs: 60 * 1000,       // 1 minute
  },
  rateLimit: {
    windowMs: 60 * 1000,               // 1 minute window
    maxRequestsPerWindow: 30,           // 30 requests per minute
  },
  server: {
    port: 3022,
    host: '127.0.0.1',                 // Localhost only by default
  },
  audit: {
    logDir: './logs',
    maxFileSizeMb: 50,
    maxFiles: 10,
  },
  exec: {
    defaultTimeoutMs: 30_000,           // 30 seconds
    maxTimeoutMs: 300_000,              // 5 minutes
    maxOutputBytes: 1_048_576,          // 1 MB
  },
};

export function loadConfig(configPath?: string): BrokerConfig {
  const filePath = configPath || path.resolve(process.cwd(), 'config.json');

  if (!fs.existsSync(filePath)) {
    return DEFAULT_CONFIG;
  }

  const raw = fs.readFileSync(filePath, 'utf-8');
  const userConfig = JSON.parse(raw) as Partial<BrokerConfig>;

  // Deep merge with defaults
  return {
    hosts: userConfig.hosts || DEFAULT_CONFIG.hosts,
    securityMode: userConfig.securityMode || DEFAULT_CONFIG.securityMode,
    whitelist: userConfig.whitelist || DEFAULT_CONFIG.whitelist,
    session: { ...DEFAULT_CONFIG.session, ...userConfig.session },
    rateLimit: { ...DEFAULT_CONFIG.rateLimit, ...userConfig.rateLimit },
    server: { ...DEFAULT_CONFIG.server, ...userConfig.server },
    audit: { ...DEFAULT_CONFIG.audit, ...userConfig.audit },
    exec: { ...DEFAULT_CONFIG.exec, ...userConfig.exec },
  };
}

export function generateSampleConfig(): string {
  const sample: BrokerConfig = {
    ...DEFAULT_CONFIG,
    hosts: [
      {
        id: 'prod-web-1',
        name: 'Production Web Server 1',
        host: '192.168.1.100',
        port: 22,
        username: 'deploy',
        privateKeyPath: '~/.ssh/id_rsa',
      },
      {
        id: 'staging-db',
        name: 'Staging Database',
        host: '192.168.1.200',
        port: 22,
        username: 'admin',
        password: 'CHANGE_ME',
      },
    ],
  };
  return JSON.stringify(sample, null, 2);
}

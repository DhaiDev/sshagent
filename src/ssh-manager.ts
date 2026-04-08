import { Client, ConnectConfig } from 'ssh2';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { HostConfig, ExecResult, BrokerConfig } from './types';

export class SSHManager {
  private connections: Map<string, Client> = new Map();
  private hostConfigs: Map<string, HostConfig>;
  private execConfig: BrokerConfig['exec'];

  constructor(hosts: HostConfig[], execConfig: BrokerConfig['exec']) {
    this.hostConfigs = new Map(hosts.map((h) => [h.id, h]));
    this.execConfig = execConfig;
  }

  getHostIds(): string[] {
    return Array.from(this.hostConfigs.keys());
  }

  getHostInfo(hostId: string): { id: string; name: string } | undefined {
    const host = this.hostConfigs.get(hostId);
    if (!host) return undefined;
    // Return only safe metadata — never credentials
    return { id: host.id, name: host.name };
  }

  async connect(connectionId: string, hostId: string): Promise<void> {
    const hostConfig = this.hostConfigs.get(hostId);
    if (!hostConfig) {
      throw new Error(`Unknown host: ${hostId}`);
    }

    if (this.connections.has(connectionId)) {
      throw new Error(`Connection already exists: ${connectionId}`);
    }

    const client = new Client();
    const connectConfig = this.buildConnectConfig(hostConfig);

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        client.end();
        reject(new Error(`SSH connection timeout for host ${hostId}`));
      }, 15_000);

      client.on('ready', () => {
        clearTimeout(timeout);
        this.connections.set(connectionId, client);
        resolve();
      });

      client.on('error', (err) => {
        clearTimeout(timeout);
        this.connections.delete(connectionId);
        reject(new Error(`SSH connection error: ${err.message}`));
      });

      client.on('close', () => {
        this.connections.delete(connectionId);
      });

      // Handle keyboard-interactive auth (used by Windows OpenSSH for password login)
      client.on('keyboard-interactive', (_name, _instructions, _instructionsLang, prompts, finish) => {
        if (hostConfig.password) {
          // Respond to all prompts with the password (typically just one "Password:" prompt)
          finish(prompts.map(() => hostConfig.password!));
        } else {
          finish([]);
        }
      });

      client.connect(connectConfig);
    });
  }

  async exec(connectionId: string, command: string, timeoutMs?: number): Promise<ExecResult> {
    const client = this.connections.get(connectionId);
    if (!client) {
      throw new Error(`No active connection: ${connectionId}`);
    }

    const timeout = Math.min(
      timeoutMs || this.execConfig.defaultTimeoutMs,
      this.execConfig.maxTimeoutMs
    );
    const maxOutput = this.execConfig.maxOutputBytes;

    return new Promise<ExecResult>((resolve, reject) => {
      const startTime = Date.now();
      let timer: ReturnType<typeof setTimeout>;

      client.exec(command, (err, stream) => {
        if (err) {
          return reject(new Error(`Exec error: ${err.message}`));
        }

        let stdout = '';
        let stderr = '';
        let stdoutTruncated = false;
        let stderrTruncated = false;

        timer = setTimeout(() => {
          stream.close();
          reject(new Error(`Command timed out after ${timeout}ms`));
        }, timeout);

        stream.on('data', (data: Buffer) => {
          if (stdout.length < maxOutput) {
            stdout += data.toString();
            if (stdout.length > maxOutput) {
              stdout = stdout.substring(0, maxOutput);
              stdoutTruncated = true;
            }
          }
        });

        stream.stderr.on('data', (data: Buffer) => {
          if (stderr.length < maxOutput) {
            stderr += data.toString();
            if (stderr.length > maxOutput) {
              stderr = stderr.substring(0, maxOutput);
              stderrTruncated = true;
            }
          }
        });

        stream.on('close', (code: number | null) => {
          clearTimeout(timer);
          const durationMs = Date.now() - startTime;

          if (stdoutTruncated) stdout += '\n... [output truncated]';
          if (stderrTruncated) stderr += '\n... [output truncated]';

          resolve({
            stdout,
            stderr,
            exitCode: code ?? -1,
            durationMs,
          });
        });
      });
    });
  }

  disconnect(connectionId: string): void {
    const client = this.connections.get(connectionId);
    if (client) {
      client.end();
      this.connections.delete(connectionId);
    }
  }

  disconnectAll(): void {
    for (const [id, client] of this.connections) {
      client.end();
      this.connections.delete(id);
    }
  }

  isConnected(connectionId: string): boolean {
    return this.connections.has(connectionId);
  }

  private buildConnectConfig(host: HostConfig): ConnectConfig {
    const config: ConnectConfig = {
      host: host.host,
      port: host.port,
      username: host.username,
      readyTimeout: 15_000,
      keepaliveInterval: 10_000,
      keepaliveCountMax: 3,
    };

    if (host.privateKeyPath) {
      const keyPath = host.privateKeyPath.startsWith('~')
        ? path.join(os.homedir(), host.privateKeyPath.slice(1))
        : host.privateKeyPath;
      config.privateKey = fs.readFileSync(keyPath);
      if (host.passphrase) {
        config.passphrase = host.passphrase;
      }
    } else if (host.password) {
      config.password = host.password;
      // Enable keyboard-interactive for Windows OpenSSH compatibility
      config.tryKeyboard = true;
    }

    return config;
  }
}

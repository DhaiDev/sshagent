import { Command } from 'commander';
import { loadConfig, generateSampleConfig } from './config';
import { SSHManager } from './ssh-manager';
import { SessionManager } from './session-manager';
import { WhitelistEngine } from './whitelist';
import { AuditLogger } from './audit';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import * as net from 'net';

export function createCli(): Command {
  const program = new Command();

  program
    .name('ssh-broker')
    .description('Secure SSH access broker for AI agents')
    .version('1.0.0');

  // --- init ---
  program
    .command('init')
    .description('Generate a sample config.json')
    .action(() => {
      const configPath = path.resolve('config.json');
      if (fs.existsSync(configPath)) {
        console.error('config.json already exists. Delete it first to regenerate.');
        process.exit(1);
      }
      fs.writeFileSync(configPath, generateSampleConfig(), 'utf-8');
      console.log('Created config.json — edit it with your SSH host details.');
    });

  // --- hosts ---
  program
    .command('hosts')
    .description('List configured SSH hosts')
    .option('-c, --config <path>', 'Config file path')
    .action((opts) => {
      const config = loadConfig(opts.config);
      if (config.hosts.length === 0) {
        console.log('No hosts configured. Run: ssh-broker init');
        return;
      }
      console.log('Configured hosts:');
      for (const h of config.hosts) {
        console.log(`  ${h.id} — ${h.name} (${h.username}@${h.host}:${h.port})`);
      }
    });

  // --- whitelist ---
  program
    .command('whitelist')
    .description('Show allowed commands')
    .option('-c, --config <path>', 'Config file path')
    .action((opts) => {
      const config = loadConfig(opts.config);
      console.log('Whitelisted commands:');
      for (const r of config.whitelist) {
        console.log(`  [${r.type}] ${r.pattern}${r.description ? ' — ' + r.description : ''}`);
      }
    });

  // --- shell (interactive session) ---
  program
    .command('shell <hostId>')
    .description('Open an interactive SSH session to a host')
    .option('-c, --config <path>', 'Config file path')
    .action(async (hostId: string, opts) => {
      const config = loadConfig(opts.config);
      const logDir = path.resolve(config.audit.logDir);
      if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

      const audit = new AuditLogger(config.audit);
      const sshManager = new SSHManager(config.hosts, config.exec);
      const sessionManager = new SessionManager(sshManager, config.session, audit);
      const whitelist = new WhitelistEngine(config.whitelist, config.securityMode);

      console.log(`Connecting to ${hostId}...`);
      let session;
      try {
        session = await sessionManager.createSession(hostId, undefined, 'cli');
      } catch (err: any) {
        console.error(`Failed: ${err.message}`);
        process.exit(1);
      }

      console.log(`Connected. Session: ${session.sessionId}`);
      console.log(`Security mode: ${config.securityMode}. Ctrl+C or 'exit' to quit.\n`);

      const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY ?? false });

      // Helper: ask user to confirm a dangerous command (TTY only)
      const askConfirm = (warning: string): Promise<boolean> => {
        return new Promise((resolve) => {
          rl.question(`${warning}\nProceed? [y/N] `, (answer) => {
            resolve(answer.trim().toLowerCase() === 'y');
          });
        });
      };

      // Helper: run a command through validation + execution
      const runCommand = async (cmd: string, canConfirm: boolean): Promise<void> => {
        const validation = whitelist.validate(cmd);
        if (validation.allowed === false) {
          console.error(`Denied: ${validation.reason}`);
          return;
        }
        if (validation.allowed === 'confirm') {
          if (!canConfirm) {
            console.error(`Skipped (needs confirmation, not interactive): ${validation.warning}`);
            return;
          }
          const confirmed = await askConfirm(validation.warning);
          if (!confirmed) {
            console.log('Cancelled.');
            return;
          }
        }
        try {
          sessionManager.touchSession(session.sessionId);
          const result = await sshManager.exec(session.sessionId, cmd);
          if (result.stdout) process.stdout.write(result.stdout);
          if (result.stderr) process.stderr.write(result.stderr);
          if (result.exitCode !== 0) console.log(`[exit code: ${result.exitCode}]`);
        } catch (err: any) {
          console.error(`Error: ${err.message}`);
        }
      };

      if (!process.stdin.isTTY) {
        // Piped mode
        const lines: string[] = [];
        for await (const line of rl) {
          lines.push(line);
        }
        for (const line of lines) {
          const cmd = line.trim();
          if (!cmd || cmd === 'exit' || cmd === 'quit') break;
          console.log(`$ ${cmd}`);
          await runCommand(cmd, false);
        }
        sessionManager.closeSession(session.sessionId, 'Pipe ended');
        console.log('Session closed.');
        process.exit(0);
      } else {
        // Interactive TTY mode
        const prompt = () => rl.question(`[${hostId}]$ `, async (line) => {
          const cmd = line.trim();
          if (!cmd || cmd === 'exit' || cmd === 'quit') {
            sessionManager.closeSession(session.sessionId, 'User exit');
            console.log('Session closed.');
            rl.close();
            process.exit(0);
          }
          await runCommand(cmd, true);
          prompt();
        });

        prompt();

        rl.on('close', () => {
          sessionManager.closeSession(session.sessionId, 'CLI closed');
          process.exit(0);
        });
      }
    });

  // --- tunnel (port forwarding with auto-reconnect) ---
  program
    .command('tunnel <hostId> <remotePort>')
    .description('SSH tunnel with auto-reconnect (e.g. tunnel myhost 18789)')
    .option('-c, --config <path>', 'Config file path')
    .option('-l, --local-port <port>', 'Local port (defaults to remote port)')
    .option('-r, --retries <n>', 'Max reconnect attempts, 0=infinite (default: 0)', '0')
    .option('-d, --delay <ms>', 'Reconnect delay in ms (default: 3000)', '3000')
    .action(async (hostId: string, remotePort: string, opts) => {
      const config = loadConfig(opts.config);
      const localPort = parseInt(opts.localPort || remotePort);
      const rPort = parseInt(remotePort);
      const maxRetries = parseInt(opts.retries);
      const delay = parseInt(opts.delay);

      const host = config.hosts.find(h => h.id === hostId);
      if (!host) {
        console.error(`Host not found: ${hostId}`);
        process.exit(1);
      }

      let attempt = 0;
      let server: net.Server | null = null;
      let sshClient: any = null;
      let shuttingDown = false;

      const connect = () => {
        if (shuttingDown) return;
        attempt++;
        const label = maxRetries > 0 ? `${attempt}/${maxRetries}` : `${attempt}`;
        console.log(`[tunnel] Connecting to ${hostId} (attempt ${label})...`);

        const { Client } = require('ssh2');
        sshClient = new Client();

        sshClient.on('ready', () => {
          attempt = 0; // reset on success
          console.log(`[tunnel] SSH connected.`);

          if (server) {
            // Already have a server, just reconnected the SSH side
            console.log(`[tunnel] Tunnel restored: localhost:${localPort} → ${hostId}:${rPort}`);
            return;
          }

          server = net.createServer((sock) => {
            if (!sshClient) {
              sock.end();
              return;
            }
            sshClient.forwardOut('127.0.0.1', sock.remotePort || 0, '127.0.0.1', rPort, (err: any, stream: any) => {
              if (err) {
                sock.end();
                return;
              }
              sock.pipe(stream).pipe(sock);
              sock.on('error', () => stream.end());
              stream.on('error', () => sock.end());
            });
          });

          server.on('error', (err: any) => {
            if (err.code === 'EADDRINUSE') {
              console.error(`[tunnel] Port ${localPort} already in use. Kill the other process or use -l <port>.`);
              process.exit(1);
            }
          });

          server.listen(localPort, '127.0.0.1', () => {
            console.log(`[tunnel] ✓ Tunnel ready: http://localhost:${localPort} → ${hostId}:${rPort}`);
            console.log(`[tunnel] Press Ctrl+C to stop.`);
          });
        });

        sshClient.on('error', (err: any) => {
          console.error(`[tunnel] SSH error: ${err.message}`);
          sshClient = null;
          scheduleReconnect();
        });

        sshClient.on('close', () => {
          if (shuttingDown) return;
          console.log(`[tunnel] SSH connection lost.`);
          sshClient = null;
          scheduleReconnect();
        });

        sshClient.on('keyboard-interactive', (_n: any, _i: any, _l: any, _p: any, finish: Function) => {
          finish([host.password || '']);
        });

        const connectConfig: any = {
          host: host.host,
          port: host.port,
          username: host.username,
          readyTimeout: 15000,
          keepaliveInterval: 10000,
          keepaliveCountMax: 3,
        };

        if (host.privateKeyPath) {
          const os = require('os');
          const keyPath = host.privateKeyPath.startsWith('~')
            ? path.join(os.homedir(), host.privateKeyPath.slice(1))
            : host.privateKeyPath;
          connectConfig.privateKey = fs.readFileSync(keyPath);
          if (host.passphrase) connectConfig.passphrase = host.passphrase;
        } else if (host.password) {
          connectConfig.password = host.password;
          connectConfig.tryKeyboard = true;
        }

        sshClient.connect(connectConfig);
      };

      const scheduleReconnect = () => {
        if (shuttingDown) return;
        if (maxRetries > 0 && attempt >= maxRetries) {
          console.error(`[tunnel] Max retries (${maxRetries}) reached. Giving up.`);
          process.exit(1);
        }
        console.log(`[tunnel] Reconnecting in ${delay / 1000}s...`);
        setTimeout(connect, delay);
      };

      const shutdown = () => {
        shuttingDown = true;
        console.log('\n[tunnel] Shutting down...');
        if (sshClient) sshClient.end();
        if (server) server.close();
        process.exit(0);
      };

      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);

      connect();
    });

  // --- serve (MCP mode) ---
  program
    .command('serve')
    .description('Start as MCP server (stdio) — used by Claude Code')
    .option('-c, --config <path>', 'Config file path')
    .action(async (opts) => {
      const { startMcpServer } = await import('./mcp-server');
      await startMcpServer(opts.config);
    });

  // --- help (extended, with examples) ---
  program
    .command('help')
    .description('Show extended help with usage examples')
    .action(() => {
      console.log(`
ssh-broker — Secure SSH access broker for AI agents

USAGE
  ssh-broker <command> [options]

COMMANDS
  init                       Generate a starter config.json in the current directory
  hosts                      List configured SSH hosts from config.json
  whitelist                  Show all allowed command patterns
  shell <hostId>             Open an interactive SSH shell to a host (whitelist enforced)
  tunnel <hostId> <rPort>    Local port-forward with auto-reconnect
  serve                      Run as an MCP server over stdio (for Claude Code / AI agents)
  help                       Show this extended help
  --help                     Show short auto-generated help
  --version                  Print version

GLOBAL OPTIONS
  -c, --config <path>        Use a non-default config file (default: ./config.json)

GETTING STARTED
  1. Install & build
       npm install
       npm run build
  2. Create your config
       cp config.example.json config.json
       # edit config.json — add your hosts, set apiKey, tune whitelist
  3. List your hosts
       ssh-broker hosts
  4. Open a shell
       ssh-broker shell prod-web-1

EXAMPLES
  # Generate a sample config
  ssh-broker init

  # Interactive shell, whitelist-enforced
  ssh-broker shell prod-web-1

  # Pipe commands non-interactively
  echo "uptime" | ssh-broker shell prod-web-1

  # Forward remote port 5432 to local 15432, with auto-reconnect
  ssh-broker tunnel staging-db 5432 -l 15432

  # Run as MCP server (Claude Code / Claude Desktop launches this)
  ssh-broker serve

  # One-line install into Claude Code CLI:
  claude mcp add ssh-broker -- node /path/to/sshagent/dist/index.js serve

SECURITY MODES (config.json → "securityMode")
  whitelist   Only commands matching the whitelist run. (default, safest)
  confirm     Non-whitelisted commands prompt for confirmation in TTY.
  bypass      No filtering — DANGEROUS, use only in trusted dev contexts.

CONFIG
  config.json is git-ignored. Commit config.example.json instead.
  See README.md for the full schema.

DOCS
  README.md  — features, tutorial, MCP integration
`);
    });

  return program;
}

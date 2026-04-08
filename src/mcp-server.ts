import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig } from './config';
import { SSHManager } from './ssh-manager';
import { SessionManager } from './session-manager';
import { WhitelistEngine } from './whitelist';
import { AuditLogger } from './audit';
import * as fs from 'fs';
import * as path from 'path';

export async function startMcpServer(configPath?: string): Promise<void> {
  const config = loadConfig(configPath);

  if (config.hosts.length === 0) {
    console.error('No hosts configured. Run: ssh-broker init');
    process.exit(1);
  }

  // Ensure log directory
  const logDir = path.resolve(config.audit.logDir);
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  const audit = new AuditLogger(config.audit);
  const sshManager = new SSHManager(config.hosts, config.exec);
  const sessionManager = new SessionManager(sshManager, config.session, audit);
  const whitelist = new WhitelistEngine(config.whitelist, config.securityMode);

  const server = new McpServer({
    name: 'ssh-broker',
    version: '1.0.0',
  });

  // --- Tool: List available hosts ---
  server.tool(
    'ssh_list_hosts',
    'List available SSH hosts (no credentials exposed)',
    {},
    async () => {
      const hostIds = sshManager.getHostIds();
      const hosts = hostIds.map((id) => sshManager.getHostInfo(id)).filter(Boolean);
      return {
        content: [{ type: 'text', text: JSON.stringify({ hosts }, null, 2) }],
      };
    }
  );

  // --- Tool: Connect to a host ---
  server.tool(
    'ssh_connect',
    'Open a new SSH session to a configured host. Returns a sessionId for subsequent commands.',
    {
      hostId: z.string().describe('Host ID from the configured hosts list'),
      ttlMinutes: z.number().optional().describe('Session time-to-live in minutes (default: 30)'),
    },
    async ({ hostId, ttlMinutes }) => {
      try {
        const ttlMs = ttlMinutes ? ttlMinutes * 60 * 1000 : undefined;
        const session = await sessionManager.createSession(hostId, ttlMs, 'mcp');
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              sessionId: session.sessionId,
              hostId: session.hostId,
              status: session.status,
              ttlMinutes: session.ttlMs / 60000,
              message: `Connected to ${hostId}. Use this sessionId for commands.`,
            }, null, 2),
          }],
        };
      } catch (err: any) {
        return {
          content: [{ type: 'text', text: `Connection failed: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // --- Tool: Execute command ---
  server.tool(
    'ssh_exec',
    'Execute a command on an active SSH session. Dangerous commands may need confirm: true.',
    {
      sessionId: z.string().describe('Session ID from ssh_connect'),
      command: z.string().describe('Command to execute'),
      confirm: z.boolean().optional().describe('Set true to confirm a dangerous command after being warned'),
      timeoutSeconds: z.number().optional().describe('Command timeout in seconds (default: 30)'),
    },
    async ({ sessionId, command, confirm: userConfirmed, timeoutSeconds }) => {
      // Check session
      const session = sessionManager.getSession(sessionId);
      if (!session) {
        return {
          content: [{ type: 'text', text: 'Session not found. Use ssh_connect first.' }],
          isError: true,
        };
      }
      if (session.status !== 'active') {
        return {
          content: [{ type: 'text', text: `Session is ${session.status}. Create a new one.` }],
          isError: true,
        };
      }

      // Security check
      const validation = whitelist.validate(command);
      if (validation.allowed === false) {
        audit.commandDenied(sessionId, session.hostId, command, validation.reason, 'mcp');
        const modeHint = whitelist.getMode() === 'whitelist'
          ? `\n\nAllowed commands: ${whitelist.getRules().map(r => r.pattern).join(', ')}`
          : '';
        return {
          content: [{ type: 'text', text: `Command denied: ${validation.reason}${modeHint}` }],
          isError: true,
        };
      }
      if (validation.allowed === 'confirm' && !userConfirmed) {
        audit.commandDenied(sessionId, session.hostId, command, 'Needs user confirmation', 'mcp');
        return {
          content: [{
            type: 'text',
            text: `${validation.warning}\n\nThis command needs user confirmation. Re-run with confirm: true to proceed.`,
          }],
          isError: true,
        };
      }

      // Execute
      try {
        const timeoutMs = timeoutSeconds ? timeoutSeconds * 1000 : undefined;
        sessionManager.touchSession(sessionId);
        const result = await sshManager.exec(sessionId, command, timeoutMs);
        audit.commandExecuted(sessionId, session.hostId, command, result.exitCode, result.durationMs, 'mcp');

        let output = '';
        if (result.stdout) output += result.stdout;
        if (result.stderr) output += (output ? '\n--- stderr ---\n' : '') + result.stderr;
        if (!output) output = '(no output)';
        output += `\n\n[exit code: ${result.exitCode}, duration: ${result.durationMs}ms]`;

        return {
          content: [{ type: 'text', text: output }],
        };
      } catch (err: any) {
        audit.commandError(sessionId, session.hostId, command, err.message, 'mcp');
        return {
          content: [{ type: 'text', text: `Execution error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // --- Tool: Disconnect session ---
  server.tool(
    'ssh_disconnect',
    'Close an active SSH session',
    {
      sessionId: z.string().describe('Session ID to close'),
    },
    async ({ sessionId }) => {
      const closed = sessionManager.closeSession(sessionId, 'MCP disconnect');
      if (!closed) {
        return {
          content: [{ type: 'text', text: 'Session not found.' }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text', text: 'Session closed.' }],
      };
    }
  );

  // --- Tool: List active sessions ---
  server.tool(
    'ssh_list_sessions',
    'List all active SSH sessions',
    {},
    async () => {
      const sessions = sessionManager.getActiveSessions();
      return {
        content: [{
          type: 'text',
          text: sessions.length === 0
            ? 'No active sessions.'
            : JSON.stringify(sessions.map(s => ({
                sessionId: s.sessionId,
                hostId: s.hostId,
                status: s.status,
                commands: s.commandCount,
                age: `${Math.round((Date.now() - s.createdAt.getTime()) / 60000)}min`,
              })), null, 2),
        }],
      };
    }
  );

  // --- Tool: Show whitelist ---
  server.tool(
    'ssh_whitelist',
    'Show the command whitelist — what commands are allowed',
    {},
    async () => {
      const rules = whitelist.getRules();
      const formatted = rules.map(r => `  ${r.pattern} (${r.type})${r.description ? ' — ' + r.description : ''}`).join('\n');
      return {
        content: [{ type: 'text', text: `Allowed commands:\n${formatted}` }],
      };
    }
  );

  // Connect via stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Graceful shutdown
  process.on('SIGTERM', () => sessionManager.shutdown());
  process.on('SIGINT', () => sessionManager.shutdown());
}

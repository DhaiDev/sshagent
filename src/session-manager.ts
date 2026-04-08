import { v4 as uuidv4 } from 'uuid';
import { SessionInfo, BrokerConfig } from './types';
import { SSHManager } from './ssh-manager';
import { AuditLogger } from './audit';

interface Session {
  info: SessionInfo;
  expiryTimer: ReturnType<typeof setTimeout>;
}

export class SessionManager {
  private sessions: Map<string, Session> = new Map();
  private cleanupTimer: ReturnType<typeof setInterval>;
  private sshManager: SSHManager;
  private config: BrokerConfig['session'];
  private audit: AuditLogger;

  constructor(sshManager: SSHManager, config: BrokerConfig['session'], audit: AuditLogger) {
    this.sshManager = sshManager;
    this.config = config;
    this.audit = audit;

    // Periodic cleanup of expired sessions
    this.cleanupTimer = setInterval(() => this.cleanup(), config.cleanupIntervalMs);
  }

  async createSession(hostId: string, ttlMs?: number, ip?: string): Promise<SessionInfo> {
    // Check concurrent session limit
    const activeSessions = this.getActiveSessions();
    if (activeSessions.length >= this.config.maxConcurrentSessions) {
      throw new Error(
        `Maximum concurrent sessions reached (${this.config.maxConcurrentSessions}). Close an existing session first.`
      );
    }

    const sessionId = uuidv4();
    const effectiveTtl = Math.min(ttlMs || this.config.defaultTtlMs, this.config.maxTtlMs);

    const info: SessionInfo = {
      sessionId,
      hostId,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      ttlMs: effectiveTtl,
      commandCount: 0,
      status: 'connecting',
    };

    // Set up expiry timer
    const expiryTimer = setTimeout(() => {
      this.closeSession(sessionId, 'TTL expired');
    }, effectiveTtl);

    this.sessions.set(sessionId, { info, expiryTimer });

    try {
      await this.sshManager.connect(sessionId, hostId);
      info.status = 'active';
      this.audit.sessionCreated(sessionId, hostId, ip);
      return { ...info };
    } catch (err) {
      clearTimeout(expiryTimer);
      info.status = 'error';
      this.sessions.delete(sessionId);
      throw err;
    }
  }

  getSession(sessionId: string): SessionInfo | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    return { ...session.info };
  }

  getActiveSessions(): SessionInfo[] {
    return Array.from(this.sessions.values())
      .filter((s) => s.info.status === 'active')
      .map((s) => ({ ...s.info }));
  }

  touchSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session && session.info.status === 'active') {
      session.info.lastActivityAt = new Date();
      session.info.commandCount++;

      // Reset TTL timer on activity
      clearTimeout(session.expiryTimer);
      session.expiryTimer = setTimeout(() => {
        this.closeSession(sessionId, 'TTL expired after inactivity');
      }, session.info.ttlMs);
    }
  }

  closeSession(sessionId: string, reason: string = 'User requested'): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    clearTimeout(session.expiryTimer);
    this.sshManager.disconnect(sessionId);
    session.info.status = 'closed';
    this.audit.sessionClosed(sessionId, session.info.hostId, reason);
    this.sessions.delete(sessionId);
    return true;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (session.info.status === 'closed' || session.info.status === 'error') {
        this.sessions.delete(id);
        continue;
      }

      // Check if SSH connection is actually still alive
      if (session.info.status === 'active' && !this.sshManager.isConnected(id)) {
        this.closeSession(id, 'Connection lost');
      }
    }
  }

  shutdown(): void {
    clearInterval(this.cleanupTimer);
    for (const [id] of this.sessions) {
      this.closeSession(id, 'Server shutdown');
    }
    this.sshManager.disconnectAll();
  }
}

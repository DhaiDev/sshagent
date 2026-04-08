import { WhitelistRule } from './types';

export type SecurityMode = 'whitelist' | 'confirm' | 'bypass';
export type ValidationResult =
  | { allowed: true; reason: string }
  | { allowed: false; reason: string }
  | { allowed: 'confirm'; reason: string; warning: string };

// Catastrophic commands — blocked even in bypass mode
const FATAL_PATTERNS = [
  { re: /\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rf][a-zA-Z]*\s+\/\s*$/, desc: 'rm -rf /' },
  { re: /\bmkfs\b/, desc: 'mkfs (format disk)' },
  { re: /\bdd\s+.*of=\/dev\//, desc: 'dd to raw device' },
  { re: />\s*\/dev\/[sh]d[a-z]/, desc: 'write to raw device' },
  { re: /\b:(){ :\|:& };:/, desc: 'fork bomb' },
  { re: />\s*\/etc\/(passwd|shadow|sudoers)/, desc: 'overwrite auth files' },
];

// Dangerous but sometimes legit — confirm in confirm mode, allow in bypass
const WARN_PATTERNS = [
  { re: /\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rf]/, desc: 'recursive/force delete' },
  { re: /\bshutdown\b/, desc: 'shutdown' },
  { re: /\breboot\b/, desc: 'reboot' },
  { re: /\binit\s+[06]\b/, desc: 'init runlevel change' },
  { re: /\bsystemctl\s+(halt|poweroff|reboot|stop)\b/, desc: 'systemctl stop/halt/reboot' },
  { re: /\bchmod\s+(-[a-zA-Z]*\s+)*777\b/, desc: 'chmod 777' },
  { re: /\bcurl\b.*\|\s*(ba)?sh/, desc: 'pipe to shell' },
  { re: /\bwget\b.*\|\s*(ba)?sh/, desc: 'pipe to shell' },
  { re: /\bkill\s+-9\b/, desc: 'force kill' },
  { re: /\bdrop\s+database\b/i, desc: 'drop database' },
  { re: /\bdrop\s+table\b/i, desc: 'drop table' },
];

export class WhitelistEngine {
  private rules: WhitelistRule[];
  private compiledRegex: Map<string, RegExp> = new Map();
  private mode: SecurityMode;

  constructor(rules: WhitelistRule[], mode: SecurityMode = 'whitelist') {
    this.rules = rules;
    this.mode = mode;

    for (const rule of rules) {
      if (rule.type === 'regex') {
        this.compiledRegex.set(rule.pattern, new RegExp(rule.pattern));
      }
    }
  }

  getMode(): SecurityMode {
    return this.mode;
  }

  validate(command: string): ValidationResult {
    const trimmed = command.trim();

    if (!trimmed) {
      return { allowed: false, reason: 'Empty command' };
    }

    // Fatal patterns — ALWAYS blocked, all modes
    for (const { re, desc } of FATAL_PATTERNS) {
      if (re.test(trimmed)) {
        return { allowed: false, reason: `BLOCKED (fatal): ${desc}` };
      }
    }

    // Warn patterns
    for (const { re, desc } of WARN_PATTERNS) {
      if (re.test(trimmed)) {
        if (this.mode === 'whitelist') {
          return { allowed: false, reason: `Dangerous command: ${desc}` };
        }
        if (this.mode === 'confirm') {
          return { allowed: 'confirm', reason: `Dangerous command needs confirmation`, warning: `⚠ ${desc}: ${trimmed}` };
        }
        // bypass — let it through
      }
    }

    // In bypass/confirm mode, everything else is allowed
    if (this.mode === 'bypass' || this.mode === 'confirm') {
      return { allowed: true, reason: `Allowed (mode: ${this.mode})` };
    }

    // Whitelist mode — check rules
    for (const rule of this.rules) {
      if (rule.type === 'prefix') {
        if (trimmed === rule.pattern || trimmed.startsWith(rule.pattern + ' ')) {
          return { allowed: true, reason: `Matched: ${rule.description || rule.pattern}` };
        }
      } else if (rule.type === 'regex') {
        const regex = this.compiledRegex.get(rule.pattern);
        if (regex && regex.test(trimmed)) {
          return { allowed: true, reason: `Matched regex: ${rule.description || rule.pattern}` };
        }
      }
    }

    return { allowed: false, reason: 'Command not in whitelist' };
  }

  getRules(): WhitelistRule[] {
    return [...this.rules];
  }
}

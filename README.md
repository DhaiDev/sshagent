# ssh-broker

A secure SSH access broker for AI agents and humans. Exposes a configurable, whitelist-enforced SSH gateway over a CLI **and** an [MCP server](https://modelcontextprotocol.io) so tools like Claude Code can safely run commands on remote hosts — without ever handing the model raw shell access.

> Think of it as a programmable jump host: you declare the hosts, you declare the commands that are allowed, and everything else is denied or requires a human in the loop.

---

## Features

- **Whitelist-first command execution** — only patterns you explicitly allow can run.
- **Three security modes** — `whitelist` (strict), `confirm` (prompt on unknown), `bypass` (dev only).
- **Multiple hosts** — manage prod, staging, dev, and one-offs from a single config.
- **Key & password auth** — supports `privateKeyPath` (with optional passphrase) or password, including keyboard-interactive.
- **Session management** — TTL, max concurrent sessions, idle cleanup, per-session audit trail.
- **Rate limiting** — per-window request caps to protect upstream hosts.
- **Audit logging** — rotating JSON logs of every command, decision, and session event (powered by Winston).
- **Interactive shell mode** — `ssh-broker shell <hostId>` with confirmation prompts for risky commands.
- **Pipe-friendly** — pipe commands into `shell` for scripted runs.
- **Auto-reconnecting tunnels** — `ssh-broker tunnel` handles flaky links with backoff and keepalives.
- **MCP server** — `ssh-broker serve` exposes tools to any MCP-compatible AI client over stdio.
- **TypeScript, zero-runtime-magic** — small, auditable codebase.

---

## Install

```bash
git clone <this-repo> sshagent
cd sshagent
npm install
npm run build
```

Optionally link it globally:

```bash
npm link
ssh-broker --version
```

---

## Quick start

```bash
# 1. Create your config from the example
cp config.example.json config.json

# 2. Edit config.json — add hosts, set apiKey, adjust whitelist
#    config.json is git-ignored; never commit secrets.

# 3. List configured hosts
ssh-broker hosts

# 4. Open an interactive shell
ssh-broker shell prod-web-1
```

---

## Tutorial

### 1. Configure a host

Edit `config.json`:

```json
{
  "hosts": [
    {
      "id": "prod-web-1",
      "name": "Production Web Server",
      "host": "10.0.0.5",
      "port": 22,
      "username": "deploy",
      "privateKeyPath": "~/.ssh/id_ed25519"
    }
  ]
}
```

Password auth works too — replace `privateKeyPath` with `"password": "..."`.

### 2. Define what commands are allowed

```json
"whitelist": [
  { "pattern": "ls",        "type": "prefix", "description": "List files" },
  { "pattern": "systemctl status", "type": "prefix", "description": "Service status" },
  { "pattern": "^docker logs [a-z0-9_-]+$", "type": "regex", "description": "Container logs" }
]
```

Supported `type` values: `prefix`, `exact`, `regex`.

### 3. Pick a security mode

```json
"securityMode": "whitelist"   // strict — only whitelist runs
"securityMode": "confirm"     // prompt for unknown commands in TTY
"securityMode": "bypass"      // no filtering — dev only, never in prod
```

### 4. Open a shell

```bash
ssh-broker shell prod-web-1
[prod-web-1]$ uptime
 14:02:11 up 32 days,  1:14,  0 users,  load average: 0.04, 0.03, 0.00
[prod-web-1]$ rm -rf /var/log
Denied: command does not match any whitelist rule
```

### 5. Use it non-interactively

```bash
echo "df -h" | ssh-broker shell prod-web-1
```

### 6. Forward a port

```bash
ssh-broker tunnel staging-db 5432 -l 15432
# Now psql -h localhost -p 15432 ... goes through SSH, with auto-reconnect.
```

### 7. Use it from Claude Code (MCP)

`ssh-broker serve` speaks MCP over stdio, so any MCP-compatible client can drive it — including the **Claude Code CLI**, the Claude desktop app, and other agents.

**Option A — Claude Code CLI (one command):**

```bash
claude mcp add ssh-broker -- node C:/path/to/sshagent/dist/index.js serve
```

Then in any Claude Code session:

```bash
claude
> /mcp        # confirm ssh-broker is connected
```

**Option B — manual config** (Claude Desktop, or editing `~/.claude.json` directly):

```json
{
  "mcpServers": {
    "ssh-broker": {
      "command": "node",
      "args": ["C:/path/to/sshagent/dist/index.js", "serve"]
    }
  }
}
```

Claude Code now sees ssh-broker's tools and can run whitelist-approved commands on your hosts — no key material ever leaves your machine, and every call is audited.

---

## CLI reference

| Command | Description |
|---|---|
| `ssh-broker init` | Generate a sample `config.json` |
| `ssh-broker hosts` | List configured hosts |
| `ssh-broker whitelist` | Show allowed command patterns |
| `ssh-broker shell <hostId>` | Interactive (or piped) SSH shell |
| `ssh-broker tunnel <hostId> <remotePort>` | Auto-reconnecting port-forward |
| `ssh-broker serve` | Start MCP server over stdio |
| `ssh-broker help` | Extended help with examples |
| `ssh-broker --help` | Short auto-generated help |

Global option: `-c, --config <path>` to use a custom config file.

Run `ssh-broker help` any time for the full reference inline.

---

## Configuration schema

`config.example.json` is the canonical, committed template. Key sections:

- **`hosts`** — array of SSH targets (`id`, `name`, `host`, `port`, `username`, `privateKeyPath`/`password`, `passphrase`).
- **`whitelist`** — allowed command patterns (`pattern`, `type`, `description`).
- **`securityMode`** — `whitelist` | `confirm` | `bypass`.
- **`session`** — `defaultTtlMs`, `maxTtlMs`, `maxConcurrentSessions`, `cleanupIntervalMs`.
- **`rateLimit`** — `windowMs`, `maxRequestsPerWindow`.
- **`server`** — `port`, `host`, `apiKey` (for HTTP API mode if used).
- **`audit`** — `logDir`, `maxFileSizeMb`, `maxFiles`.
- **`exec`** — `defaultTimeoutMs`, `maxTimeoutMs`, `maxOutputBytes`.

---

## Security notes

- `config.json` is **git-ignored**. Only `config.example.json` is committed. Never commit real credentials.
- Prefer key-based auth over passwords. Use a passphrase on your key.
- Start in `whitelist` mode. Only loosen to `confirm` after you trust your patterns.
- `bypass` disables all command filtering — use only on disposable dev hosts.
- All commands and decisions are written to the audit log under `logs/`.
- Treat the `apiKey` in `server.apiKey` as a secret if you enable the HTTP API mode.

---

## Project layout

```
src/
  cli.ts             # Commander-based CLI
  index.ts           # Entry point
  mcp-server.ts      # MCP stdio server
  ssh-manager.ts     # ssh2-based connection & exec
  session-manager.ts # Session lifecycle, TTLs, cleanup
  whitelist.ts       # Pattern matching & decision engine
  audit.ts           # Winston rotating audit logs
  config.ts          # Config loading & sample generation
  api.ts             # Optional HTTP API
  types.ts           # Shared types
```

---

## Development

```bash
npm run dev      # ts-node, no build step
npm run build    # tsc → dist/
npm run start    # node dist/index.js serve
npm run cli      # node dist/index.js (CLI entry)
```

---

## License

ISC

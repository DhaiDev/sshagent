<div align="center">

# 🔐 ssh-broker

### A secure SSH access broker for AI agents and humans

*Give Claude Code (and any MCP client) safe, whitelist-enforced access to your servers — without ever handing the model raw shell access.*

[![Node.js](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5%2B-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-compatible-8A2BE2)](https://modelcontextprotocol.io)
[![License](https://img.shields.io/badge/license-ISC-blue.svg)](#-license)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#-contributing)

[Features](#-features) • [Quick Start](#-quick-start) • [Tutorial](#-tutorial) • [CLI](#-cli-reference) • [MCP](#-use-from-claude-code) • [Security](#-security)

</div>

---

## 🧭 What is this?

`ssh-broker` is a **programmable SSH jump host** designed for the AI-agent era. You declare the hosts. You declare the commands that are allowed. Everything else is denied or requires a human in the loop. It speaks two protocols:

- 💻 **CLI** — `ssh-broker shell <hostId>` for humans, with confirmation prompts on risky commands.
- 🤖 **MCP server** — `ssh-broker serve` over stdio for [Claude Code](https://docs.claude.com/en/docs/claude-code), Claude Desktop, and any other MCP-compatible agent.

Every command is matched against a whitelist, optionally confirmed, executed inside a managed session, and written to an audit log. No key material ever leaves your machine.

---

## ✨ Features

| | |
|---|---|
| 🛡️ **Whitelist-first execution** | Only patterns you explicitly allow can run. Prefix, exact, or regex match. |
| 🚦 **Three security modes** | `whitelist` (strict) · `confirm` (prompt on unknown) · `bypass` (dev only) |
| 🖥️ **Multi-host** | Manage prod, staging, dev, one-offs from a single config |
| 🔑 **Key & password auth** | `privateKeyPath` (with passphrase) or password / keyboard-interactive |
| ⏱️ **Session management** | TTL, max concurrent sessions, idle cleanup, per-session audit trail |
| 🌊 **Rate limiting** | Per-window request caps to protect upstream hosts |
| 📜 **Audit logging** | Rotating JSON logs of every command, decision, and session event |
| 💬 **Interactive shell** | TTY mode with confirmation prompts; pipe-friendly for scripting |
| 🔁 **Auto-reconnecting tunnels** | Local port-forward with backoff and SSH keepalives |
| 🤖 **MCP server built-in** | Drop into Claude Code with one command |
| 📦 **Tiny & auditable** | TypeScript, no runtime magic, ~1k LOC core |

---

## 📦 Install

```bash
git clone https://github.com/DhaiDev/sshagent.git
cd sshagent
npm install
npm run build
```

Optionally link globally:

```bash
npm link
ssh-broker --version
```

> **Requirements:** Node.js 18+ on Windows / macOS / Linux.

---

## 🚀 Quick Start

```bash
# 1. Create your config from the template
cp config.example.json config.json

# 2. Edit config.json — add hosts, set whitelist, pick security mode
#    config.json is git-ignored. Never commit secrets.

# 3. List configured hosts
ssh-broker hosts

# 4. Open an interactive shell
ssh-broker shell prod-web-1
```

That's it. You're brokered. 🎉

---

## 📚 Tutorial

### 1️⃣ Configure a host

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

> 💡 Password auth works too — replace `privateKeyPath` with `"password": "..."`.

### 2️⃣ Define what commands are allowed

```json
"whitelist": [
  { "pattern": "ls",               "type": "prefix", "description": "List files" },
  { "pattern": "systemctl status", "type": "prefix", "description": "Service status" },
  { "pattern": "^docker logs [a-z0-9_-]+$", "type": "regex", "description": "Container logs" }
]
```

Supported `type` values: `prefix` · `exact` · `regex`.

### 3️⃣ Pick a security mode

| Mode | Behavior | When to use |
|---|---|---|
| 🟢 `whitelist` | Only whitelist runs. Everything else denied. | **Default. Always start here.** |
| 🟡 `confirm` | Unknown commands prompt for confirmation in TTY. | Trusted operator at the keyboard. |
| 🔴 `bypass` | No filtering. **Dangerous.** | Disposable dev hosts only. |

### 4️⃣ Open a shell

```console
$ ssh-broker shell prod-web-1
Connecting to prod-web-1...
Connected. Session: 8f3a...
Security mode: whitelist. Ctrl+C or 'exit' to quit.

[prod-web-1]$ uptime
 14:02:11 up 32 days,  1:14,  load average: 0.04, 0.03, 0.00
[prod-web-1]$ rm -rf /var/log
Denied: command does not match any whitelist rule
```

### 5️⃣ Use it non-interactively

```bash
echo "df -h" | ssh-broker shell prod-web-1
```

### 6️⃣ Forward a port

```bash
ssh-broker tunnel staging-db 5432 -l 15432
# Now: psql -h localhost -p 15432 ...  (auto-reconnects on drop)
```

### 7️⃣ Plug into Claude Code

See [Use from Claude Code](#-use-from-claude-code) below. ⬇️

---

## 🤖 Use from Claude Code

`ssh-broker serve` speaks **MCP over stdio**, so any MCP-compatible client can drive it — including the Claude Code CLI, Claude Desktop, and other agents.

### Option A — Claude Code CLI (one-liner)

```bash
claude mcp add ssh-broker -- node C:/path/to/sshagent/dist/index.js serve
```

Then in any Claude Code session:

```bash
claude
> /mcp        # confirm ssh-broker is connected
```

### Option B — Manual config

For Claude Desktop or editing `~/.claude.json` directly:

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

Claude Code now sees `ssh-broker`'s tools and can run **whitelist-approved** commands on your hosts. Every call is audited. No key material ever leaves your machine. 🔒

---

## 💻 CLI Reference

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

**Global option:** `-c, --config <path>` to use a custom config file.

> Run `ssh-broker help` any time for the full reference inline.

---

## ⚙️ Configuration Schema

`config.example.json` is the canonical, committed template. Key sections:

| Section | Purpose |
|---|---|
| `hosts` | SSH targets (`id`, `name`, `host`, `port`, `username`, `privateKeyPath`/`password`, `passphrase`) |
| `whitelist` | Allowed command patterns (`pattern`, `type`, `description`) |
| `securityMode` | `whitelist` · `confirm` · `bypass` |
| `session` | `defaultTtlMs`, `maxTtlMs`, `maxConcurrentSessions`, `cleanupIntervalMs` |
| `rateLimit` | `windowMs`, `maxRequestsPerWindow` |
| `server` | `port`, `host`, `apiKey` (HTTP API mode) |
| `audit` | `logDir`, `maxFileSizeMb`, `maxFiles` |
| `exec` | `defaultTimeoutMs`, `maxTimeoutMs`, `maxOutputBytes` |

---

## 🛡️ Security

- 🚫 `config.json` is **git-ignored**. Only `config.example.json` is committed. **Never commit real credentials.**
- 🔑 Prefer key-based auth over passwords. Always use a passphrase.
- 🟢 Start in `whitelist` mode. Loosen to `confirm` only after you trust your patterns.
- 🔴 `bypass` disables all filtering — use only on disposable dev hosts.
- 📜 Every command and decision is written to `logs/` via Winston.
- 🗝️ Treat `server.apiKey` as a secret if you enable HTTP API mode.

---

## 🗂️ Project Layout

```
src/
├── cli.ts             # Commander-based CLI
├── index.ts           # Entry point
├── mcp-server.ts      # MCP stdio server
├── ssh-manager.ts     # ssh2-based connection & exec
├── session-manager.ts # Session lifecycle, TTLs, cleanup
├── whitelist.ts       # Pattern matching & decision engine
├── audit.ts           # Winston rotating audit logs
├── config.ts          # Config loading & sample generation
├── api.ts             # Optional HTTP API
└── types.ts           # Shared types
```

---

## 🛠️ Development

```bash
npm run dev      # ts-node, no build step
npm run build    # tsc → dist/
npm run start    # node dist/index.js serve
npm run cli      # node dist/index.js (CLI entry)
```

---

## 🤝 Contributing

Issues and PRs welcome! If you find a security issue, please open a private advisory rather than a public issue.

---

## 📄 License

ISC © [DhaiDev](https://github.com/DhaiDev)

<div align="center">

**Built for the AI-agent era. Audited every step.** 🔐

⭐ Star this repo if `ssh-broker` makes your servers safer.

</div>

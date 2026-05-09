<div align="center">

<h1>Telegram for Gemini CLI</h1>

<p><strong>Your AI coding assistant, now on Telegram.</strong></p>

<p>
  <a href="https://www.npmjs.com/package/gemini-cli-telegram"><img src="https://img.shields.io/npm/v/gemini-cli-telegram?style=flat-square&color=blue" alt="npm version"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen?style=flat-square" alt="Node.js"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue?style=flat-square" alt="License"></a>
</p>

<p>
  <a href="#features">Features</a> •
  <a href="#installation">Installation</a> •
  <a href="#commands">Commands</a> •
  <a href="#schedule">Schedule</a> •
  <a href="#autopilot">Autopilot</a> •
  <a href="#configuration">Configuration</a>
</p>

</div>

---

## Features

| | Feature | Description |
|---|---------|-------------|
| 🤖 | **AI Chat** | Full Gemini CLI experience with streaming responses |
| 📁 | **Project Switching** | Auto-scan and switch between projects |
| 🕐 | **Scheduled Messages** | One-time or recurring scheduled tasks |
| 🚀 | **Autopilot Mode** | AI works autonomously toward a goal |
| 🖼️ | **Multimodal** | Text, photos, voice, audio, video, documents |
| 🔧 | **Tool Execution** | Auto-run tools — edit files, run commands, search web |
| 🎯 | **Model Switching** | Switch Gemini models on the fly |
| ⌨️ | **Interactive UI** | Inline keyboards, emoji indicators, HTML formatting |
| 🔒 | **Secure** | Restrict access to specific Telegram user IDs |

---

## Installation

### One-Click Setup (Recommended for new VMs)

Run this command to install Node.js, clone the repository, and start the interactive setup wizard:

```bash
curl -sSL https://raw.githubusercontent.com/ibidathoillah/gemini-cli-telegram/main/setup.sh | bash
```

The script will guide you through:
1. **Google Login** — Authenticate with your Google account.
2. **Telegram Token** — Input your bot token from [@BotFather](https://t.me/BotFather).
3. **Interactive Whitelist** — Simply send a message to your bot to automatically whitelist your User ID.

### Manual Installation

#### Quick Start (via npx)

```bash
npx gemini-cli-telegram start
```

#### Global Install

```bash
npm install -g gemini-cli-telegram
gemini-cli-telegram start
```

On first run, an interactive wizard guides you through the setup.

---

## CLI Commands

```bash
gemini-cli-telegram <command> [options]
```

| Command | Description |
|---------|-------------|
| `start` | Start daemon in background |
| `stop` | Stop daemon |
| `status` | Check daemon status |
| `logs` | Show recent logs |
| `setup [step]` | Run setup wizard |

---

## Running as a Service (Auto-Restart)

To ensure the bot stays running and automatically restarts on failure, you can install it as a **systemd service**:

```bash
sudo ./scripts/install-service.sh
```

This will create a service named `gemini-telegram` that starts on boot and restarts every 10 seconds if it crashes.

### Management Commands

| Action | Command |
|--------|---------|
| Start | `sudo systemctl start gemini-telegram` |
| Stop | `sudo systemctl stop gemini-telegram` |
| Restart | `sudo systemctl restart gemini-telegram` |
| Status | `sudo systemctl status gemini-telegram` |
| Live Logs | `sudo journalctl -u gemini-telegram -f` |

---

## Telegram Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome menu with inline keyboard |
| `/new` | Start fresh session |
| `/projects` | Browse and select projects |
| `/schedule` | Manage scheduled messages |
| `/autopilot <goal>` | AI auto-works on a goal |
| `/resume` | Resume previous session |
| `/model <name>` | Switch AI model |
| `/compact` | Compress chat history |
| `/stats` | Show session stats |
| `/help` | Show help |

---

## Schedule

Schedule one-time or recurring messages:

```
/schedule add in 1h Check server logs
/schedule recurring 60 Backup database
/schedule add tomorrow at 09:00 Daily standup
```

**Time formats:** `now`, `in 5m`, `in 1h`, `tomorrow`, `14:30`, `morning`, `evening`

Tasks persist across restarts in `~/.gemini-cli-telegram/scheduled-tasks.json`.

---

## Autopilot

Let the AI work autonomously on a goal:

```
/autopilot Refactor auth module to use JWT tokens
/autopilot Write unit tests for all API endpoints
/autopilot Fix all ESLint warnings in the project
```

**How it works:**
1. You set a clear goal
2. AI processes and responds
3. AI feeds its own response back as input
4. Repeats until done (max 10 iterations)
5. Delivers final result

Stop anytime with `/autopilot stop`.

---

## Project Selection

```
/projects
```

Auto-scans your home directory and detects projects by `package.json`, `.git`, `Cargo.toml`, `pyproject.toml`, etc. Switch working directory instantly with inline keyboard.

---

## Configuration

Stored at `~/.gemini-cli-telegram/config.json`:

```json
{
  "telegramBotToken": "YOUR_BOT_TOKEN",
  "allowedUsers": [123456789],
  "model": "gemini-2.5-pro"
}
```

| Key | Required | Description |
|-----|----------|-------------|
| `telegramBotToken` | Yes | Bot token from @BotFather |
| `allowedUsers` | Yes | Allowed Telegram user IDs |
| `model` | No | Default model |

---

## Authentication

Uses the same auth as Gemini CLI. The setup wizard auto-detects existing credentials.

- **OAuth** (recommended) — Browser sign-in with Google
- **API Key** — Paste your key or set `GEMINI_API_KEY`

---

## Technical Notes

- Runs `@google/gemini-cli-core` as a daemon via per-message loop
- Tools execute in YOLO mode (auto-execute, no prompts)
- Default permissions: read `~/`, write to daemon CWD
- Markdown streamed as plain text, formatted to HTML at the end

---

## Acknowledgments

Built on [Gemini CLI](https://github.com/google-gemini/gemini-cli) by Google. Open-sourced under Apache 2.0.

---

## License

[Apache 2.0](LICENSE)

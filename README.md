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

### 🚀 One-Command Setup (Recommended)

Run this single command to install everything (Node.js, the bot, and dependencies) and start the setup wizard:

```bash
curl -sSL https://raw.githubusercontent.com/ibidathoillah/gemini-cli-telegram/main/setup.sh | bash
```

The script will guide you through:
1. **Google Login** — Authenticate with your Google account.
2. **Telegram Token** — Input your bot token from [@BotFather](https://t.me/BotFather).
3. **Whitelist** — Send any message to your bot to automatically whitelist your ID.

---

### 📦 Manual Installation (via NPM)

If you already have Node.js 20+, you can install the bot globally:

```bash
# 1. Install globally
npm install -g gemini-cli-telegram

# 2. Run the setup wizard
gemini-cli-telegram setup

# 3. Start the bot
gemini-cli-telegram start
```

---

### 🐳 Docker (Recommended for Servers)

Run the bot as a container without installing Node.js:

```bash
docker run -d \
  --name gemini-bot \
  -v ~/.gemini-cli-telegram:/root/.gemini-cli-telegram \
  -v ~/.config/google-gemini-cli:/root/.config/google-gemini-cli \
  ghcr.io/ibidathoillah/gemini-cli-telegram:latest
```

### JSR (Modern Registry)

```bash
npx jsr add @ibidathoillah/gemini-cli-telegram
```

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
| Application Logs | `tail -f ~/.gemini-cli-telegram/daemon.log` |
| Systemd Logs | `sudo journalctl -u gemini-telegram -f` |

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
| `/status` | Show session stats |
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

## 📚 Official API Documentation

The official development guidelines and technical specifications for Telegram Bot API 10.1 and rich text formatting are located in the [**`telegramBotAPI/`**](file:///home/user/.gemini-cli-telegram/telegramBotAPI) folder:

- **[telegram_bot_api.md](file:///home/user/.gemini-cli-telegram/telegramBotAPI/telegram_bot_api.md)**: Telegram Bot API 10.1 core technical specifications, including schemas for outbound and inbound JSON protocols.
- **[telegram_bot_features.md](file:///home/user/.gemini-cli-telegram/telegramBotAPI/telegram_bot_features.md)**: Design guidelines for advanced features and interactive UI styling.
- **[from_botfather_to_hello_world.md](file:///home/user/.gemini-cli-telegram/telegramBotAPI/from_botfather_to_hello_world.md)**: Complete step-by-step practical manual for creating and setting up a bot.
- **[bots_an_introduction_for_developers.md](file:///home/user/.gemini-cli-telegram/telegramBotAPI/bots_an_introduction_for_developers.md)**: Tech overview of the Telegram Bot ecosystem.

---

## 🎨 Rich Messages Engine (Telegram Bot API 10.1)

This project has been upgraded with a high-fidelity **Rich Messages Engine** utilizing **Telegram Bot API 10.1**, enabling premium layouts and high resilience:

### ⚡ 3-Level Resilient Failover Pipeline

To guarantee 100% message delivery under all network conditions, the engine uses a progressive failover strategy:
1. **Option A (HTML via `sendRichMessage`)**: Transmits a fully formatted HTML block. Telegram renders it into a cloud-parsed native rich block, supporting zebra-striped tables, collapsible detail blocks, and LaTeX formulas. This avoids fragile local AST parsing overhead.
2. **Option B (Markdown fallback)**: Instantly falls back to native Telegram Markdown formatting with automatic character escaping.
3. **Option C (Standard HTML fallback)**: Reverts to standard `HTML` parse-mode via traditional `ctx.reply` in case of unexpected API anomalies.

### ✍️ Typewriter Stream with Native `<tg-thinking>` Animation

- **Typewriter Draft Routing**: Streaming plain-text outputs are dynamically routed as active draft messages (`sendRichMessageDraft`) for a smooth typing feel without message duplication.
- **Premium Thinking State**: During the reasoning phase, the engine appends a **`<tg-thinking>Thinking...</tg-thinking>`** tag. This triggers a highly premium, native thinking-bubble animation on official Telegram clients.

---

## Recent Changes

- **Setup Improvements:** `setup.sh` now automatically clones the repository if it's not present, making it truly "one-click" for fresh environments.
- **Bug Fixes:** Resolved a build error in the Telegram channel commands related to missing HTML escaping utilities.
- **Improved Reliability:** Enhanced dependency management and build process.

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

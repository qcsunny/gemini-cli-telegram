# gemini-cli-telegram

A local gateway that bridges the **Google Antigravity / Gemini CLI** to **Telegram**, so you can drive an AI coding assistant straight from a Telegram chat.

> International project. Documentation is primarily in English; community contributions are welcome via Issues and Pull Requests.

## Features
- Multi-project / multi-session management with atomic session reset and full history clearing.
- Tool execution inside chat: edit files, run shell commands, browse the web.
- Streaming "typewriter" output with the native `<tg-thinking>` animation (Telegram Bot API 10.1 Rich Messages).
- Multimodal input: text, photo, voice (auto-transcribed), video, documents.
- Rich text rendering: zebra-striped tables, collapsible `<details>`, and LaTeX formulas, with a 3-tier fallback (HTML → MarkdownV2 → legacy HTML).

## Requirements
- Node.js >= 20 (tested on 22)
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- A local Google CLI login session (or `GEMINI_API_KEY`); headless servers must run `gemini-cli-telegram setup auth` once in an interactive terminal
- Optional: a local HTTP/HTTPS proxy (e.g. Clash `http://127.0.0.1:7890`)

## Quick Start
1. Clone and install:
   ```bash
   git clone <repo-url>
   cd gemini-cli-telegram
   npm install
   npm run build
   ```
2. Configure `config.json`: set `allowedUsers` (your Telegram user id), proxy, and `projects`.

   `/save` command and the save-latest button write markdown files to the answer save dir.
   Set `paths.answerSaveDir` (no default; must be set in `config.json`) to control where they are stored:
3. Authenticate:
   ```bash
   node dist/cli.js setup auth
   ```
4. Run (systemd user service, recommended for always-on):
   ```bash
   # Linger keeps the bot alive after SSH logout (run once)
   loginctl enable-linger
   # The service runs dist/cli.js — always rebuild before restarting
   npm run build
   systemctl --user restart gemini-cli-telegram.service
   ```
   Or foreground: `node dist/cli.js start --live`

> ⚠️ Use the **user-space** systemd service (`systemctl --user`) — never `sudo`.
> After editing `src/`, you must run `npm run build` before restarting, otherwise
> the service keeps running the stale `dist/cli.js`.

## Bot Commands
| Command | Description |
|---|---|
| `/start` | Show the main keyboard and onboarding menu |
| `/new` | Reset the conversation and start a fresh atomic session |
| `/projects` | Browse and switch the active working directory / project |
| `/model <name>` | Switch model (Gemini 3.x / Gemma 4 / Web2API / DeepSeek / OpenCode) |
| `/settings` | Configure chat settings and output preferences |
| `/invest <symbol>` | Value investing 6-dimension report & multi-symbol comparison |
| `/stock <symbol>` | Real-time stock & crypto market quotes |
| `/sum [count]` | Summarize recent chat messages |
| `/schedule` | View and manage scheduled / recurring tasks |
| `/autopilot <goal>` | Launch an autonomous autopilot task |
| `/save` | Save the last formatted reply to the knowledge base |
| `/delete_session <index>` | Permanently delete a stored session |
| `/status` | Show live session statistics |
| `/help` | Show detailed command guidance |

## Diagnostics & Logs
- Main log: `logs/daemon.log` (pino, info+warn); errors: `logs/error.log`
- Live tail: `tail -f logs/daemon.log`
- Both files rotate in-process at 16 MiB, keeping 3 generations (`LOG_MAX_BYTES` / `LOG_KEEP_FILES`; set `LOG_MAX_BYTES=0` to disable). `LOG_DIR` moves the directory.
- The bot must be started via systemd (`systemctl --user start gemini-cli-telegram.service`).
  Directly running multiple `node dist/cli.js start --live` instances causes Telegram
  API 409 Conflict loops.

## Configuration Notes
- Personal/environment values (model name, proxy, API keys, user allow-list, ports)
  belong in `config.json` / `src/config/`, **never hard-coded in source**.
- `allowedUsers` is your numeric Telegram user id (allow-list).
- `paths.answerSaveDir` controls where `/save` writes markdown files; it has no
  default and must be set explicitly.

## Links
- Releases: https://github.com/qcsunny/gemini-cli-telegram/releases
- Issues: https://github.com/qcsunny/gemini-cli-telegram/issues
- Discussions: https://github.com/user/gemini-cli-telegram/discussions

---
*This is a starter skeleton. Expand the Setup, Troubleshooting, and FAQ sections as the project grows.*

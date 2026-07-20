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
3. Authenticate:
   ```bash
   node dist/cli.js setup auth
   ```
4. Run (systemd, recommended for always-on):
   ```bash
   sudo systemctl restart gemini-telegram.service
   ```
   Or foreground: `node dist/cli.js start --live`

## Bot Commands
| Command | Description |
|---|---|
| `/model <name>` | Switch model (Gemini 3.x / Gemma 4 / Web2API reverse models) |
| `/new` | Reset the conversation and start a fresh atomic session |
| `/undo` | Undo the last user + assistant exchange |
| `/save` | Save the last formatted reply to the knowledge base |
| `/delete_session <index>` | Permanently delete a stored session |

## Links
- Releases: https://github.com/qcsunny/gemini-cli-telegram/releases
- Issues: https://github.com/qcsunny/gemini-cli-telegram/issues
- Discussions: https://github.com/qcsunny/gemini-cli-telegram/discussions

---
*This is a starter skeleton. Expand the Setup, Troubleshooting, and FAQ sections as the project grows.*

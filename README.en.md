<div align="center">

# 🤖 Telegram for Gemini CLI

### **Your AI coding companion on the go — efficient coding anywhere, anytime.**

<p>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D20-339933?style=flat-square&logo=node.js" alt="Node.js"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-red?style=flat-square" alt="License"></a>
  <a href="https://t.me/BotFather"><img src="https://img.shields.io/badge/telegram-API%2010.2-0088cc?style=flat-square&logo=telegram" alt="Telegram"></a>
</p>

<p>
  <a href="#-core-features">Core Features</a> •
  <a href="#-installation--deployment">Installation</a> •
  <a href="#-telegram-commands">Commands</a> •
  <a href="#-message-rendering-engine--api-102">Rendering Engine</a> •
  <a href="#-global-configuration">Configuration</a>
</p>

</div>

---

> [!IMPORTANT]
> **`gemini-cli-telegram`** is a Telegram adapter gateway for the local **Google Antigravity CLI (`agy`)**. Running as a long-lived background daemon, it seamlessly connects the Telegram front-end with the Google Gemini core coding engine, letting you edit files, run system commands, and browse the web right from your phone or any Telegram client.

---

## ✨ Core Features

| Module | Feature | Description |
| :---: | :--- | :--- |
| 🤖 | **Full-featured AI chat** | A smooth Gemini CLI experience with streaming rendering and multi-turn context. |
| 📁 | **Smart multi-project switching** | Auto-detects all projects under your home directory (by `.git`, `package.json`, `Cargo.toml`, etc.) and lets you switch the working directory with one tap in chat. |
| 🕐 | **Advanced scheduled tasks** | Supports one-shot or periodic cron/scheduled jobs (e.g. daily inspection, monitoring). |
| 🚀 | **Autopilot** | Set a goal and the AI autonomously decomposes tasks, self-corrects, and runs until the goal is reached. |
| 🖼️ | **Full-modality input** | Text, photos, voice (auto-transcribed), video, and documents — all supported. |
| 🔧 | **Tool-chain sandbox execution** | The AI can run system commands, edit code files, and browse the web from within Telegram. |
| 🎯 | **One-tap model switching** | Switch between a wide range of preset models (Gemini 3.5/3.1/2.5 families, etc.) plus reverse-proxied web models. |
| 🔒 | **Dual allow-list** | Strictly restricts access to configured user IDs for local server safety. |

---

## 🚀 Installation & Deployment

Install, build, and launch locally by following the steps below:

### 🛠️ Build from source

If you have already cloned this repo (or are in the local directory `~/.gemini-cli-telegram`), install, build, and start with:

```bash
# 1. Make sure you are in the project root
cd ~/.gemini-cli-telegram

# 2. Install local project dependencies
npm install

# 3. Build the project (TypeScript compiler produces the JavaScript runtime bundle)
npm run build

# 4. Run the interactive setup wizard (Google Auth credentials + Telegram Bot Token)
node dist/cli.js setup

# 5. Register and launch the Telegram bot as a systemd service (first time)
sudo ./setup.sh
# Afterwards, restart/stop/start are unified under systemctl:
#   sudo systemctl restart gemini-telegram.service
#   sudo systemctl stop gemini-telegram.service
#   systemctl status gemini-telegram.service
# or: ./start.sh   (which internally runs systemctl restart)
```

---

## ⚙️ Operations & Service Management

Via the systemd script you can easily register the bot as a system-level service for boot-time autostart and automatic crash recovery (the daemon auto-restarts on failure):

```bash
# Register as a systemd service (for first deployment just run ./setup.sh, which already includes this step)
sudo ./setup.sh
```

### Common management commands

| Goal | Command |
| :--- | :--- |
| **Start service** | `sudo systemctl start gemini-telegram` |
| **Stop service** | `sudo systemctl stop gemini-telegram` |
| **Restart service** | `sudo systemctl restart gemini-telegram` |
| **Check status** | `sudo systemctl status gemini-telegram` |
| **Daemon log** | `tail -f ~/.gemini-cli-telegram/daemon.log` |
| **System journal** | `sudo journalctl -u gemini-telegram -f` |

> [!WARNING]
> The service is configured with `Restart=always`, so a crashed process is **automatically respawned** by systemd. Therefore **do not use `kill`/`pkill` directly** — this conflicts with systemd's auto-restart and causes the service to be repeatedly respawned in a short window, scrambling logs and process state. To restart, always use `sudo systemctl restart gemini-telegram`; to fully stop, use `sudo systemctl stop gemini-telegram`. After changing source code you must rebuild (`npm run build`) before restarting, otherwise the stale `dist` keeps running.

### 🔍 Multi-dimensional diagnostics & isolation
- **Detailed diagnostics**: when the local `agy` CLI hits auth expiry, proxy termination, timeout, or network errors, the system reports the specific failure reason to the Telegram front-end (e.g. auth failed, process terminated, timeout cancelled) and logs a full diagnostic trace including `ExitCode` and a `Stderr` preview.
- **Multi-route data isolation**: for Gemini direct calls (Google Direct SDK) versus web reverse-proxy calls (Web2API Proxy), conversation history is maintained independently in separate maps, preventing context cross-contamination under concurrent multi-channel requests.

### 🧪 Body-chunking experiment switch
The current version has body chunking **disabled by default** (single messages have no character limit — verified in practice). The relevant switches live at the top of the `src/core/messageLoop.ts` function scope:
- `NO_BODY_CHUNK` (`true`): the final body is not split at 4096 and is sent as one message.
- `NO_DRAFT_CHUNK` (`true`): the streaming draft is never truncated and always shows the full generated content (no 4096 sliding window).

If extremely long messages fail to send after changing environments (e.g. Telegram introduces a per-message limit), set both constants back to `false` to restore safe 4096-char chunking and the streaming sliding window. After changing, `npm run build` and `sudo systemctl restart gemini-telegram` are required.

---

## 🎮 Telegram Commands

Send these common commands to the Telegram Bot to take precise control of the AI:

| Command | Description |
| :--- | :--- |
| `/start` | Bring up the main keyboard and onboarding menu. |
| `/new` | Immediately reset the current chat and open a brand-new atomic session context. |
| `/projects` | Browse and directly switch the active working directory and project context. |
| `/model <name>` | One-tap switch of the underlying inference model. |
| `/schedule` | View and manage current scheduled/periodic tasks. |
| `/autopilot <goal>` | Launch an AI autopilot task. |
| `/undo` | Undo the last user/assistant conversation turn. |
| `/delete_session` | Safely and physically delete a specified historical session. |
| `/status` | Live output of current session statistics and resource consumption. |
| `/help` | Show detailed command guidance. |

---

## 🎨 Message Rendering Engine & API 10.2 Architecture

> [!TIP]
> This project has been fully refactored for the **Telegram Bot API 10.2 native Rich Message system**: the "dual message stream" is eliminated entirely; the whole AI reply lifecycle is strictly collapsed into **one RichMessageDraft + one state machine + a single Append-Only Block array**.

### 🔄 Single-message Append-Only State Machine

The entire reply lifecycle follows one strict data flow: `Gemini Stream → State Machine → Single RichMessageDraft → Final Commit`

1. **Strict state progression**:
   - **`PhaseThinking`**: on receiving a `<thought>` token, create `Blocks[0]` (a collapsible `details` / `thinking` block) and update typing progress in real time.
   - **`PhaseBody`**: on detecting `</thought>` or the first body token, **lock the thinking block**; subsequent Block array enters **Append-Only mode**.
   - **`PhaseFooter`**: after the stream ends, append the trailing `footer` block (model name, elapsed time, token usage, estimated cost).
   - **`PhaseCommitted`**: atomically persist to disk.
2. **Append-Only Block array management**:
   - Block indices are **permanently fixed in memory** (`[ThinkingBlock?, ...BodyBlocks, FooterBlock?]`).
   - Rebuild, reorder, or full-array replacement is forbidden, eliminating classic bugs like "thinking overwrites body", "body disappears", or "block order scrambling".
3. **Draft ↔ atomic Commit cooperation**:
   - **Streaming phase (`sendRichDraftBlocks`)**: uses the Telegram Bot API 10.2 `sendRichMessageDraft` endpoint to push the full current Block array as a preview. A single globally-bound `draft_id` prevents multiple draft bubbles.
   - **Completion phase (`editRichBlocks`)**: uses `sendRichMessage` with the same `draft_id` to seamlessly "promote" the draft into a persisted chat message in one shot, with no extra secondary message.

---

## ⚙️ Global Configuration

The config file lives at `~/.gemini-cli-telegram/config.json`:

```json
{
  "telegramBotToken": "YOUR_BOT_TOKEN",
  "allowedUsers": [
    123456789
  ],
  "model": "Gemini 3.1 Pro (High)",
  "proxy": "http://127.0.0.1:7890",
  "telegram": {
    "parseMode": "RichText"
  }
}
```

| Parameter | Required | Description |
| :--- | :--- | :--- |
| `telegramBotToken` | Yes | The official token obtained from @BotFather. |
| `allowedUsers` | Yes | Numeric allow-list of Telegram user IDs permitted to privately message/call the bot (array). |
| `model` | No | Default Gemini model; can be switched dynamically at any time. |
| `proxy` | No | Network proxy (e.g. local Clash `http://127.0.0.1:7890`) for stable Telegram API interaction. |
| `telegram.parseMode` | No | Message parse/render mode. `RichText` is recommended for advanced rich-text support. |

---

## 🔑 Account Authorization & Headless Compatibility

When running in a Headless environment the daemon cannot launch a browser for interactive Google login.

If credentials expire, you must run the following in a local or interactive terminal that can pop up a browser:
```bash
# Make sure you are in the project root
node dist/cli.js setup auth
```
This command auto-generates and stores the login state for the background service to read directly.

---

## ❤️ Acknowledgments

This project is a deep refactoring and feature upgrade built upon the open-source work of the original author [ibidathoillah](https://github.com/ibidathoillah) — [gemini-cli-telegram](https://github.com/ibidathoillah/gemini-cli-telegram).

Special thanks:
- 👤 **[ibidathoillah](https://github.com/ibidathoillah)**: for the original gateway inspiration and excellent open-source contribution.
- 🔗 **[gemini-web2api](https://github.com/Sophomoresty/gemini-web2api)**: special thanks to author [Sophomoresty](https://github.com/Sophomoresty) for the excellent web reverse-proxy API design, which provided crucial reference and inspiration for this project's advanced multi-model compatibility.
- 🧠 **Google Gemini & [Gemini CLI](https://github.com/google-gemini/gemini-cli)**: thanks to the Google team for the outstanding AI models and the excellent underlying CLI tooling that power this project's fluid and strong core.
- 🤖 **Independently produced by Google Gemini (AI)**: special thanks to the Gemini large model as the **sole full-time developer** of this project. Notably, **all code refactoring, new feature implementation, troubleshooting, and polished documentation were independently generated and implemented by Gemini (the user wrote no code by hand, only providing core ideas and direction)** — another achievement of human-AI collaborative development.

---

## 📄 License

This project follows the [Apache 2.0](LICENSE) open-source license; we fully preserve the copyright notices of the original author and all associated underlying libraries.

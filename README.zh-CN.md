<div align="center">

# 🤖 Telegram for Gemini CLI

### **你的随身 AI 编程助手 —— 随时随地高效编码。**

<p>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D20-339933?style=flat-square&logo=node.js" alt="Node.js"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-red?style=flat-square" alt="License"></a>
  <a href="https://t.me/BotFather"><img src="https://img.shields.io/badge/telegram-API%2010.2-0088cc?style=flat-square&logo=telegram" alt="Telegram"></a>
</p>

<p>
  <a href="#-核心特性">核心特性</a> •
  <a href="#-安装与部署">安装</a> •
  <a href="#-telegram-命令">命令</a> •
  <a href="#-消息渲染引擎--api-102-架构">渲染引擎</a> •
  <a href="#-全局配置">配置</a>
</p>

</div>

---

> [!IMPORTANT]
> **`gemini-cli-telegram`** 是本地 **Google Antigravity CLI（`agy`）** 的 Telegram 适配网关。它作为常驻后台守护进程运行，把 Telegram 前端与 Google Gemini 核心编码引擎无缝连接，让你在手机或任意 Telegram 客户端上直接编辑文件、执行系统命令、浏览网页。

> **其他语言**：[English](README.md)

---

## ✨ 核心特性

| 模块 | 特性 | 描述 |
| :---: | :--- | :--- |
| 🤖 | **全功能 AI 对话** | 流畅的 Gemini CLI 体验，流式渲染 + 多轮上下文。 |
| 📁 | **智能多项目切换** | 自动检测主目录下的所有项目（按 `.git`、`package.json`、`Cargo.toml` 等），在聊天中一键切换工作目录。 |
| 🕐 | **高级定时任务** | 支持一次性或周期 cron 定时任务（如每日巡检、监控）。 |
| 🚀 | **Autopilot 自动驾驶** | 设定目标后 AI 自主分解任务、自我纠错，直到达成目标。 |
| 🖼️ | **全模态输入** | 文本、图片、语音（自动转写）、视频、文档——全部支持。 |
| 🔧 | **工具链沙盒执行** | AI 可在 Telegram 内执行系统命令、编辑代码文件、浏览网页。 |
| 🎯 | **一键切换模型** | 在六大后端（agy / Web2API / DeepSeek / OpenCode / Claude CLI / Codex）的预置模型间自由切换，外加 🤖 Auto 智能分流。 |
| 🔒 | **双重白名单** | 严格限制为已配置的用户 ID，保障本地服务器安全。 |

---

## 🚀 安装与部署

按以下步骤在本地安装、构建并启动：

### 🛠️ 从源码构建

如果你已经克隆了本仓库（或在本地目录 `~/.gemini-cli-telegram` 中），安装、构建并启动：

```bash
# 1. 确认你在项目根目录
cd ~/.gemini-cli-telegram

# 2. 安装本地项目依赖
npm install

# 3. 构建项目（TypeScript 编译器产出 JavaScript 运行时产物）
npm run build

# 4. 运行交互式安装向导（Google 认证 + Telegram Bot Token）
node dist/cli.js setup

# 5. 注册并以「用户级」systemd 服务方式启动 Telegram bot
#    （首次——开启 linger 以便 SSH 退出后守护进程仍常驻）
loginctl enable-linger
# 服务单元位于 ~/.config/systemd/user/gemini-cli-telegram.service
systemctl --user daemon-reload
systemctl --user enable --now gemini-cli-telegram.service
# 之后 start/stop/restart 统一走用户级 systemctl：
#   systemctl --user restart gemini-cli-telegram.service
#   systemctl --user stop gemini-cli-telegram.service
#   systemctl --user status gemini-cli-telegram.service
```

---

## ⚙️ 运维与服务管理

bot 以 **用户级** systemd 服务（`gemini-cli-telegram.service`）运行，
通过 `Restart=on-failure` 提供开机自启和崩溃自动恢复。
**切勿使用 `sudo`**；用户级服务能保持日志/数据库权限与开发账号一致，避免权限提升风险。

### 用户级服务单元（首次部署）

```ini
# ~/.config/systemd/user/gemini-cli-telegram.service
[Unit]
Description=Gemini CLI Telegram Bot
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/gemini-cli-telegram
ExecStart=/path/to/node dist/cli.js start --live
Environment=NODE_ENV=production
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now gemini-cli-telegram.service
loginctl enable-linger   # 保持 bot 在 SSH 退出后存活
```

### 常用管理命令

| 目标 | 命令 |
| :--- | :--- |
| **启动服务** | `systemctl --user start gemini-cli-telegram` |
| **停止服务** | `systemctl --user stop gemini-cli-telegram` |
| **重启服务** | `systemctl --user restart gemini-cli-telegram` |
| **查看状态** | `systemctl --user status gemini-cli-telegram` |
| **守护进程日志** | `tail -f logs/daemon.log` |
| **错误日志** | `tail -f logs/error.log` |

> [!WARNING]
> 服务直接运行 `dist/cli.js`。**任何 `src/` 改动后必须先重新构建**（`npm run build`）再重启，
> 否则旧的 `dist` 会继续运行。服务使用 `Restart=on-failure`，进程崩溃会自动拉起——
> **绝不要用 `kill`/`pkill` 管理**（会与 systemd 自动重启冲突，导致 409 Conflict 重启循环）。
> 始终使用 `systemctl --user restart/stop`。另外，服务运行期间**绝不要**用
> `node dist/cli.js start --live` 手动启动——多个轮询实例会让 Telegram 永久返回 409 Conflict。

### 🔍 多维度诊断与隔离
- **详细诊断**：当本地 `agy` CLI 遇到认证过期、代理中断、超时或网络错误时，系统会向 Telegram 前端报告具体失败原因（如 auth failed、process terminated、timeout cancelled），并记录包含 `ExitCode` 与 `Stderr` 预览的完整诊断轨迹。
- **多路由数据隔离**：Gemini 直连（Google Direct SDK）与 Web 反向代理（Web2API Proxy）调用之间，会话历史在各自独立的内存映射中维护，防止并发多通道请求下上下文互相污染。

### 🧪 流式行为（长回复）
长回复在流式过程中会被切成约 600 字符的切片、间隔 400 ms 推送，让草稿编辑保持平滑，而不是一次性大跳变。超长尾部突发会自动重新分片（见 `src/core/messageLoop.ts` 的 `STREAM_RECHUNK_THRESHOLD` / `STREAM_SLICE_SIZE`）。

---

## 🎮 Telegram 命令

向 Telegram Bot 发送以下常用命令，精确掌控 AI：

| 命令 | 描述 |
| :--- | :--- |
| `/start` | 弹出主键盘与引导菜单。 |
| `/new` | 立即重置当前聊天，开启全新的原子会话上下文。 |
| `/projects` | 浏览并直接切换当前工作目录与项目上下文。 |
| `/model <name>` | 一键切换底层推理模型（`auto` = 🤖 智能分流）。 |
| `/settings` | 配置聊天设置与输出偏好。 |
| `/invest <symbol>` | 价值投资六维度报告与多标的对比。 |
| `/stock <symbol>` | 实时股票与加密货币行情。 |
| `/watchlist` | 管理股票自选列表与价格提醒。 |
| `/sum [count]` | 总结近期聊天消息。 |
| `/schedule` | 查看与管理当前定时/周期任务。 |
| `/autopilot <goal>` | 启动 AI 自动驾驶任务。 |
| `/read <url>` | 总结网页或 YouTube 视频。 |
| `/save` | 将最近一次格式化回复存入知识库。 |
| `/export` | 将会话导出为 markdown。 |
| `/usage` | 显示 Token 用量明细与预估费用。 |
| `/backends` | 监控后端健康状态（冷却状态）。 |
| `/delete_session` | 安全物理删除指定历史会话。 |
| `/status` | 实时输出当前会话统计与资源消耗。 |
| `/help` | 显示详细命令指引。 |

---

## 🎨 消息渲染引擎 & API 10.2 架构

> [!TIP]
> 本项目已为 **Telegram Bot API 10.2 原生 Rich Message 系统**全面重构：彻底消除「双消息流」；
> 整个 AI 回复生命周期严格收敛为 **一个 RichMessageDraft + 一个状态机 + 单一 Append-Only Block 数组**。

### 🔄 单消息 Append-Only 状态机

整个回复生命周期遵循一条严格数据流：`Gemini Stream → State Machine → Single RichMessageDraft → Final Commit`

1. **严格状态推进**：
   - **`PhaseThinking`**：收到 `<thought>` token 时创建 `Blocks[0]`（可折叠 `details` / `thinking` 块），并实时更新输入进度。
   - **`PhaseBody`**：检测到 `</thought>` 或首个正文 token 时，**锁定 thinking 块**；此后 Block 数组进入 **Append-Only 模式**。
   - **`PhaseFooter`**：流结束后追加尾部 `footer` 块（模型名、耗时、Token 用量、预估费用）。
   - **`PhaseCommitted`**：原子持久化到磁盘。
2. **Append-Only Block 数组管理**：
   - Block 索引在内存中**永久固定**（`[ThinkingBlock?, ...BodyBlocks, FooterBlock?]`）。
   - 禁止重建、重排或整体替换数组，杜绝「thinking 覆盖正文」「正文消失」「块顺序错乱」等经典 bug。
3. **Draft ↔ 原子 Commit 协作**：
   - **流式阶段（`sendRichDraftBlocks`）**：使用 Telegram Bot API 10.2 的 `sendRichMessageDraft` 端点把当前完整 Block 数组作为预览推送。单一全局绑定的 `draft_id` 防止出现多个草稿气泡。
   - **完成阶段（`editRichBlocks`）**：用 `sendRichMessage` + 同一 `draft_id` 一步把草稿「晋升」为持久化聊天消息，无多余第二条消息。

---

## ⚙️ 全局配置

配置文件位于 `~/.gemini-cli-telegram/config.json`：

```json
{
  "telegramBotToken": "YOUR_BOT_TOKEN",
  "allowedUsers": [
    123456789
  ],
  "model": "Gemini 3.7 Flash (High)",
  "proxy": "http://127.0.0.1:7890"
}
```

| 参数 | 必填 | 描述 |
| :--- | :--- | :--- |
| `telegramBotToken` | 是 | 来自 @BotFather 的官方 Token。 |
| `allowedUsers` | 是 | 允许私聊/调用 bot 的 Telegram 用户 ID 数字白名单（数组）。 |
| `model` | 否 | 默认模型；可随时通过 `/model` 动态切换（`auto` = 🤖 智能分流）。 |
| `proxy` | 否 | 网络代理（如本地 Clash `http://127.0.0.1:7890`），用于稳定连接 Telegram API。 |

> 消息的 **解析/渲染模式**（parseMode）**不是**全局配置项，而是通过 `/settings`
> 命令控制的**会话级设置**（默认 `RichText`）。

---

## 🔑 账户授权与无头兼容

无头（Headless）环境下守护进程无法启动浏览器进行交互式 Google 登录。

若凭据过期，请在可弹出浏览器的本地或交互式终端中执行：
```bash
# 确认你在项目根目录
node dist/cli.js setup auth
```
该命令会自动生成并存储登录状态，供后台服务直接读取。

---

## ❤️ 致谢

本项目是在原作者 [ibidathoillah](https://github.com/ibidathoillah) 的开源作品 —— [gemini-cli-telegram](https://github.com/ibidathoillah/gemini-cli-telegram) 基础上深度重构与功能升级而成。

特别感谢：
- 👤 **[ibidathoillah](https://github.com/ibidathoillah)**：原始网关灵感与出色的开源贡献。
- 🔗 **[gemini-web2api](https://github.com/Sophomoresty/gemini-web2api)**：感谢作者 [Sophomoresty](https://github.com/Sophomoresty) 出色的 Web 反向代理 API 设计，为本项目的高级多模型兼容提供了关键参考与灵感。
- 🧠 **Google Gemini & [Gemini CLI](https://github.com/google-gemini/gemini-cli)**：感谢 Google 团队出色的 AI 模型与底层 CLI 工具，铸就了本项目流畅而强大的内核。
- 🤖 **由 Google Gemini（AI）独立产出**：特别感谢 Gemini 大模型作为本项目**唯一的全职开发者**。值得注意的是，**所有代码重构、新功能实现、问题排查与文档润色均由 Gemini 独立生成与实现（用户未手写任何代码，仅提供核心想法与方向）** —— 人机协作开发的又一成果。

---

## 📄 许可证

本项目遵循 [Apache 2.0](LICENSE) 开源许可证；我们完整保留原作者及所有相关底层库的版权声明。
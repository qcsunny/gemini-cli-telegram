<div align="center">

# 🤖 Telegram for Gemini CLI

### **您的 AI 随身编程搭档，随时随地开启高效编码新纪元。**

<p>
  <a href="https://www.npmjs.com/package/gemini-cli-telegram"><img src="https://img.shields.io/npm/v/gemini-cli-telegram?style=flat-square&logo=npm&color=007acc" alt="npm version"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D20-339933?style=flat-square&logo=node.js" alt="Node.js"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-red?style=flat-square" alt="License"></a>
  <a href="https://t.me/BotFather"><img src="https://img.shields.io/badge/telegram-API%2010.1-0088cc?style=flat-square&logo=telegram" alt="Telegram"></a>
</p>

<p>
  <a href="#-核心特性">核心特性</a> •
  <a href="#-极速安装">安装部署</a> •
  <a href="#-交互指令">Telegram 指令</a> •
  <a href="#-消息渲染引擎与-api-101-升级">富文本引擎</a> •
  <a href="#-全局配置说明">配置指南</a>
</p>

</div>

---

> [!IMPORTANT]
> **`gemini-cli-telegram`** 是本地 **Google Antigravity CLI (`agy`)** 的 Telegram 适配网关。作为常驻后台的守护进程，它完美连接了 Telegram 交互前端与 Google Gemini 底层核心编码引擎，让您在手机或任意 Telegram 客户端上也能直接修改文件、执行系统命令、查询网络。

---

## ✨ 核心特性

| 模块 | 功能 | 深度描述 |
| :---: | :--- | :--- |
| 🤖 | **AI 全功能对话** | 完整的 Gemini CLI 丝滑体验，支持流式渲染和多轮语境。 |
| 📁 | **多项目智能切换** | 自动侦测家目录下所有项目（通过 `.git`、`package.json`、`Cargo.toml` 等识别），支持在聊天中一键无缝切换当前工作目录。 |
| 🕐 | **高阶定时任务** | 支持单次或周期性 cron/定时任务调度（例如每日巡检、定时监控）。 |
| 🚀 | **Autopilot 自动驾驶** | 设定目标后，AI 自主分解任务、自动纠错并运行，直至达成目标。 |
| 🖼️ | **全模态输入支持** | 支持文本、高清照片、音频语音（自动转译）、视频、文档等多模态输入。 |
| 🔧 | **工具链沙盒执行** | AI 可在 Telegram 聊天界面内自动执行系统指令、编辑代码文件、浏览网页。 |
| 🎯 | **模型一键切换** | 提供包含 Gemini 3.5/3.1/2.5 系列在内的 11 种预置模型以及网页端逆向模型一键切换。 |
| 🔒 | **双重白名单机制** | 严格限制仅配置的用户 ID 可以连接和操作，保障服务器本地安全。 |

---

## 🚀 安装与部署指南

根据您的需求，您可以选择**本地源码编译部署（推荐本地运行 / 适用于本仓库）**或**NPM 全局一键部署**：

### 🛠️ 方法一：本地源码编译部署（黄金推荐 / 适用于本项目）

如果您已经克隆了本仓库（或正处于当前本地目录 `~/.gemini-cli-telegram` 下），请按以下步骤安装、编译并启动：

```bash
# 1. 确保已进入项目根目录
cd ~/.gemini-cli-telegram

# 2. 安装本地项目所有依赖
npm install

# 3. 执行项目编译（通过 TypeScript 编译器生成最新的 JavaScript 运行包）
npm run build

# 4. 执行初始化配置向导（配置 Google Auth 登录凭证与 Telegram Bot Token）
node dist/cli.js setup

# 5. 后台常驻启动 Telegram 机器人
./start.sh
# 或者使用 node dist/cli.js start
```

---

### 📦 方法二：NPM 全局一键安装（适用于快速运行）

如果您不直接参与源码二次开发，仅希望直接在宿主机常驻启动打包好的服务：

```bash
# 1. 全局一键安装包
npm install -g gemini-cli-telegram

# 2. 交互式初始化配置
gemini-cli-telegram setup

# 3. 启动后台守护进程
gemini-cli-telegram start
```



## ⚙️ 运维与服务管理

通过 systemd 脚本，您可以轻松将 Bot 注册为系统级 service，实现开机自启和异常自动恢复（守护进程会自动崩溃重启）：

```bash
# 注册为 systemd 服务
sudo ./scripts/install-service.sh
```

### 常用管理指令

| 目标 | 对应指令 |
| :--- | :--- |
| **启动服务** | `sudo systemctl start gemini-telegram` |
| **停止服务** | `sudo systemctl stop gemini-telegram` |
| **重启服务** | `sudo systemctl restart gemini-telegram` |
| **状态查询** | `sudo systemctl status gemini-telegram` |
| **守护进程日志** | `tail -f ~/.gemini-cli-telegram/daemon.log` |
| **系统日志监控** | `sudo journalctl -u gemini-telegram -f` |

---

## 🎮 交互指令

向 Telegram Bot 发送以下常用交互指令，实现对 AI 的精确掌控：

| 指令 | 描述说明 |
| :--- | :--- |
| `/start` | 唤起精美的主功能键盘与新手引导菜单。 |
| `/new` | 即刻重置当前聊天，开启全新的原子会话上下文。 |
| `/projects` | 浏览并直接切换当前活跃的工作目录和项目上下文。 |
| `/model <name>` | 一键切换当前底层推理模型。 |
| `/schedule` | 查看和管理当前的定时调度与周期任务。 |
| `/autopilot <目标>` | 开启 AI 自动驾驶任务。 |
| `/undo` | 撤销上一次用户和助理的对话交互。 |
| `/delete_session` | 安全物理删除指定的历史 session。 |
| `/status` | 实时输出当前的会话统计指标和资源消耗。 |
| `/help` | 唤起详细的指令指引。 |

---

## 🎨 消息渲染引擎与 API 10.1 升级

> [!TIP]
> 本项目已重构并深度适配 **Telegram Bot API 10.1 原生富文本架构（Rich Messages）**，在 `RichText` 模式下展现无与伦比的交互质感。

### ⚡ 3 级高弹性自动回退渲染链路 (Highly Resilient Pipeline)
为了确保任何复杂代码与排版 100% 成功发送，系统在 `RichText` 模式下提供以下三重兜底机制：
1. **Option A (原生云端解析 HTML - 黄金首选)**：调用 `sendRichMessage` 发送由 HTML 转换的富文本块，交由 Telegram 云端自动渲染，完美支持**圆角斑马纹表格**、**折叠 details 容器**以及 **LaTeX 数学公式**，完全消除脆弱的本地 AST 解析崩溃隐患。
2. **Option B (高兼容性 MarkdownV2 自动重试)**：若 HTML 解析遇到边缘字符异常，系统立刻捕获并自动降级为精准转义的 `MarkdownV2` 格式重新发送。
3. **Option C (最坏情况传统 HTML 兜底)**：若 API 10.1 传输或 Telegram 官方服务端突发网络灾难，则使用传统 `ctx.reply` (HTML 解析模式) 强制发送，确保消息绝不漏发。

### ✍️ 草稿路由与 `<tg-thinking>` 原生思考打字动效
- **流式草稿渲染**：所有流式文字的中间打字状态均被自动路由至临时草稿箱写信接口 `sendRichDraft`（底层调用 Telegram 的 `sendRichMessageDraft`），打字输出极度丝滑且绝不触发消息重发。
- **原生思考动画**：AI 在思考和生成阶段，流式输出尾部会自动附带 **`<tg-thinking>Thinking...</tg-thinking>`** 原生标签。这将在 Telegram 手机与桌面端激活官方最高等级的“动态呼吸气泡思考动效”，打造极致灵动的交互体验。

---

## ⚙️ 全局配置说明

配置文件存放于 `~/.gemini-cli-telegram/config.json`：

```json
{
  "telegramBotToken": "YOUR_BOT_TOKEN",
  "allowedUsers": [
    8431249190
  ],
  "model": "Gemini 3.1 Pro (High)",
  "proxy": "http://127.0.0.1:7890",
  "telegram": {
    "parseMode": "RichText"
  }
}
```

| 参数项 | 是否必填 | 职责描述 |
| :--- | :--- | :--- |
| `telegramBotToken` | 是 | 从 @BotFather 申请的官方令牌。 |
| `allowedUsers` | 是 | 允许私聊调用 Bot 的 Telegram 用户 ID 数字白名单（数组形式）。 |
| `model` | 否 | 默认使用的 Gemini 模型，支持随时动态切换。 |
| `proxy` | 否 | 网络代理配置（如本地 Clash 代理 `http://127.0.0.1:7890`），保障 Telegram API 交互稳定性。 |
| `telegram.parseMode` | 否 | 消息解析渲染模式。推荐使用 `RichText` 开启高阶富文本支持。 |

---

## 🔑 账号授权与 Headless 兼容

守护进程在 Headless 环境中运行时无法调起浏览器进行 Google 交互登录。

若凭据过期，用户必须在本地或能够弹出浏览器的交互式终端中执行如下指令：
```bash
gemini-cli-telegram setup auth
```
该命令会自动生成并存储登录态，供后台服务直接读取。

---

## Acknowledgments

Built on [Gemini CLI](https://github.com/google-gemini/gemini-cli) by Google. Open-sourced under Apache 2.0.

---

## License

[Apache 2.0](LICENSE)

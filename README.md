<div align="center">

# 🤖 Telegram for Gemini CLI

### **您的 AI 随身编程搭档，随时随地开启高效编码新纪元。**

<p>
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

请按照以下本地编译部署方案进行安装和启动：

### 🛠️ 源码编译部署步骤

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

> [!WARNING]
> 服务已配置 `Restart=always`，进程异常退出后会被 systemd **自动拉起**。因此**不要直接用 `kill`/`pkill` 杀进程**——这会与 systemd 的自动重启机制冲突，导致服务在短时间内被反复拉起、日志与进程状态混乱。需要重启时请统一使用 `sudo systemctl restart gemini-telegram`；需要彻底停用时使用 `sudo systemctl stop gemini-telegram`。修改源码后也必须重新编译（`npm run build`）再重启服务，否则运行的仍是旧的 `dist`。

### 🔍 多维度错误诊断与隔离
- **详尽诊断输出**：当本地 `agy` CLI 遭遇认证过期、代理进程异常终止、执行超时或网络异常时，系统会向 Telegram 前端反馈具体失败原因（如：认证失败、进程终止、超时取消等），并在后台日志输出包含 `ExitCode`、`Stderr` 预览的完整 Diagnostic 追踪。
- **多路由数据隔离**：针对 Gemini 直接调用（Google Direct SDK）与网页端逆向调用（Web2API Proxy），其上下文对话历史数据独立维护在各自的映射容器中，杜绝多渠道并发请求时的上下文数据混淆。

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
- **草稿定稿固化（关键）**：根据 Telegram Bot API 10.1 的官方语义，通过 `sendRichMessageDraft` 发送的草稿本质是**临时预览（ephemeral preview）**，并不会持久化到聊天记录中。因此当完整回复生成完毕时，系统会**用真正的 `sendRichMessage` 把第一条消息固化为一条正式的持久消息**（而非再次刷新草稿），随后将剩余正文分块依次追加发送。这样无论回复多长，聊天窗口里从第一条消息的开头标题、第一段正文，直到最后一条消息，都 100% 连贯保留，绝不会出现第一条消息（或开头段落）被擦除、吞掉或截断的情况。统计脚注（模型、耗时、Token 消耗）始终收尾于最后一条消息。

### 🧩 结构化消息渲染与状态机解析 (Structured Message & Segment Parsing)
- **结构化流式解析**：全链路重构为以 `StructuredMessage` 为核心的数据流。不再使用脆弱的全局正则切割原始字符串，而是通过状态机（State Machine）精确提取 `<thought>` 思考块、内容块、耗时和 Token 消耗。
- **智能 `<details>` 折叠排版**：
  - 动态计算内容长度并自适应渲染闭合/展开的思考框。
  - 精确处理 `<details>` 折叠容器前后的空白换行（避免空行撑开）。
  - 支持流式输出中“未闭合思考块”的实时渐进式渲染。
- **实体安全截断**：优化了 HTML 实体（如 `&amp;`、`&lt;` 等）的字节计长与安全切片，解决超长消息截断时可能出现的格式失效或崩溃问题。

---


## ⚙️ 全局配置说明

配置文件存放于 `~/.gemini-cli-telegram/config.json`：

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
# 确保已进入项目根目录
node dist/cli.js setup auth
```
该命令会自动生成并存储登录态，供后台服务直接读取。

---

## ❤️ 鸣谢与致敬 (Acknowledgments)

本项目基于原作者 [ibidathoillah](https://github.com/ibidathoillah) 的开源杰作 [gemini-cli-telegram](https://github.com/ibidathoillah/gemini-cli-telegram) 基础进行深度重构与功能升级。

在此，特别鸣谢：
- 👤 **[ibidathoillah](https://github.com/ibidathoillah)**：感谢其对核心网关最初的灵感碰撞与优秀的开源贡献。
- 🔗 **[gemini-web2api](https://github.com/Sophomoresty/gemini-web2api)**：特别鸣谢作者 [Sophomoresty](https://github.com/Sophomoresty) 优秀的网页端逆向 API 逻辑设计，为本项目的高级多模型兼容性对接提供了至关重要的参考与设计启发。
- 🧠 **Google Gemini & [Gemini CLI](https://github.com/google-gemini/gemini-cli)**：感谢 Google 团队提供的卓越 AI 模型以及出色的底层命令行工具支持，赋予了本项目流畅而强大的核心底座。
- 🤖 **Google Gemini (AI) 独立承制**：特别鸣谢 Gemini 智能大模型作为本项目的**唯一全职开发者**。值得一提的是，**本项目的所有代码重构、新功能实现、故障排查、以及精美文档的编写均由 Gemini 独立生成与实现（用户未手写任何一行代码，仅提供核心创意与方向指引）**，是人机协同开发模式的又一力作。

---

## 📄 开源协议 (License)

本项目遵循 [Apache 2.0](LICENSE) 开源协议，我们完整保留了原作者及各关联底层库的版权声明。

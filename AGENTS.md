# AI Agent instructions

## Workflow rules
- All 385 tests must pass before any commit/push.
- After every successful full test run → `git add -A && git commit -m "..." && git push` (backup to remote).
- Major refactoring or version upgrades → do a version release (`npm version <major|minor|patch> && git push --tags && git push`).
- **版本号规范**：本项目版本号严格遵循 [SemVer 2.0.0](https://semver.org/lang/zh-CN/) 语义化版本规范 (`MAJOR.MINOR.PATCH`)。
- Remote: SSH (`git@github.com:qcsunny/gemini-cli-telegram.git`) — HTTPS token expires.
- Commit messages: bilingual (Chinese + English).
- **Code search tools**: 优先使用 `rg` (ripgrep) 或 `ast-bro` 工具，而不是传统的 `grep`。

## ⛔ 启动方式（重要！）
- **禁止**使用 `node dist/cli.js start --live` 直接启动 bot。
- **必须**通过 systemd 服务启动：`systemctl --user start gemini-cli-telegram.service`
- 直接启动会导致多个实例同时运行，Telegram API 返回 409 Conflict 死循环。
- 服务文件：`~/.config/systemd/user/gemini-cli-telegram.service`

## ⚠️ 配置原则（重要！）
- **禁止**在代码中硬编码个人/环境相关配置（如默认模型名、代理地址、API 密钥、用户 ID、允许用户白名单、端口号等）。
- 所有这类值必须从外部配置读取：`config.json`、环境变量、`src/config/` 下的配置文件。
- 若需改默认值（如默认模型），只改 `config.json` 等配置文件，**不改源码**。
- 新增功能如需默认参数，须提供可覆盖的配置项，而非写死。

## Usage
- TypeScript (node:20+ ESM)
- grammy (Telegram Bot framework)
- vitest (testing)
- zod (config validation)
- better-sqlite3 + drizzle-orm (DB)
- undici (HTTP)
- No Express/Koa — health server via node:http

## Reference docs
Bug fix log → `.agents/BUGFIXES.md`
Version numbering → `.agents/AGENTS.md`
Architecture → `.agents/ARCHITECTURE.md`

## 🔍 如何找到 agy 的原始模型输出（调试用）
- **agy 会话数据库目录**：`~/.gemini/antigravity-cli/conversations/`（可被 `config.json → paths.agyDataDir` 或环境变量 `ANTIGRAVITY_USER_DIR` 覆盖，见 `getAgyDataDir()` src/config/userConfig.ts:327）。
- 每个会话一个 SQLite 文件：`<uuid>.db`（如 `aeb171a3-693b-4754-8245-96628ae9af0a.db`）。该 uuid 与项目 `db.sqlite` 的 `conversations` 表的 `conversation_id` 一一对应。
- **chatId → uuid 映射**：`src/agy/conversationStore.ts` 的 `getConversationId(chatId)`（Drizzle，读 `db.sqlite`）。
- **数据库读取函数**（`src/agy/protobuf.ts`，导出）：
  - `readConversationHistory(dbPath)` — 遍历 `steps` 表，把每条 step 的 `step_payload` protobuf 解码为可读文本，返回 `ConversationTurn[]`（含 role/idx/status/usage）。
  - `readUsageFromDatabase(dbPath)` — 从 `steps.metadata` 提取 usage（input/output/cached/thinking）。
  - `extractUsageFromProto(m)` — 单个 usage protobuf blob → usage 对象。
  - `getConversationsDir()` — 会话数据库目录路径。
- **protobuf.ts 内部辅助函数**（⚠️ **不再导出**，仅在 `readConversationHistory` 内部使用，若需外部调试调用须临时恢复 export）：`extractTextFromProto(bytes)`（单个 protobuf blob → 最长可读字符串）、`extractMetadataFromProto(m)`、`stepTypeToRole(stepType)`（step_type → role 映射）。
- **steps 表关键列**：`idx`（序号）、`step_type`（14=thinking、15=assistant/ai、23=assistant、98=title、101=? 等）、`status`、`step_payload`（protobuf BLOB）、`metadata`（usage protobuf BLOB）。
- **usage protobuf 字段语义**（`extractUsageFromProto`，社区 tokscale 交叉验证 + 自校验等式 `field3 == field9 + field10`）：`field2`=input（新处理输入）、`field3`=总 output（含 thinking）、`field5`=cache_read、`field9`=纯正文 output（不含 thinking）、`field10`=thinking。⚠️ `field3`（总 output）**含** thinking，计费按 `field3`，不要另加 thinking 费；纯正文 token = `field3 − field10` = `field9`。
- **找最新回复**：取 `steps` 中 `idx` 最大的 `step_type=15/23` 记录，对其 `step_payload` 调 `extractTextFromProto`。
- ⚠️ `extractTextFromProto` 返回的字符串开头可能带 protobuf 解码残留的二进制垃圾字符（如 `�~`），需用 `text.indexOf('# 标题')` 或找正文起始锚点截断后再用。
- ⚠️ `step_payload` 的 protobuf 里**一个字段内可能嵌套多个子字段**（正文 + thought 等），`extractTextFromProto` 会把它们粘连成一个长字符串，**看起来像"正文重复了多遍"**——实际模型只输出一份。判断真实输出：以 `content.len`（finalize 日志）为准，或找正文结束的自然断点（完整句子/段落），而不是按 `# 标题` 出现的次数。
- **项目 `db.sqlite` 只持久化 deepseek/web2api backend 的消息，opencode backend 的消息不在其中**（conversation 记录在、messages 不在）——查原始输出必须去 agy 的 conversation DB。
- **`protobuf.ts` 数据库读取使用示例**：
  ```typescript
  import path from 'node:path';
  import os from 'node:os';
  import { readConversationHistory } from './src/agy/protobuf.js';

  // 传入 agy 会话 SQLite 数据库绝对路径
  const dbPath = path.join(os.homedir(), '.gemini/antigravity-cli/conversations/aeb171a3-693b-4754-8245-96628ae9af0a.db');
  const history = readConversationHistory(dbPath);
  if (history) {
    for (const turn of history) {
      console.log(`[Role: ${turn.role}] (Step: ${turn.idx}, Status: ${turn.status})`);
      console.log(turn.content); // 模型的原始 markdown 文本或思维链文本
      if (turn.usage) {
        console.log(`Usage: ${JSON.stringify(turn.usage)}`);
      }
    }
  }
  ```


## 📝 调试日志在哪
- **主日志**：项目根目录 `daemon.log`（pino，info + warn）；**错误日志**：`error.log`（error only）。`tail -f daemon.log` 查看实时输出。
- **`journalctl --user -u gemini-cli-telegram.service` 无效**（No journal files / No entries）——服务由 pino 直接写文件，stdout/stderr 未进 journal。
- **TRACE 标记**（调试关键）：`[TRACE flushBlocks]`（draft 内容/thought 缓冲）、`[TRACE thought event]`、`[TRACE finalize]`（content.len/hasSendRich）、`[TRACE-EVIDENCE]`（sendRichDraft/editRichDraft 各 Option 的 API 调用证据，含 first100 快照）、`[STDOUT]`/`[STDOUT-CLOSE]`（agy CLI 原始 stdout）、`[EVENT]`（messageLoop 事件）。
- agy CLI stderr 捕获在内存（`errBuf`），不进文件。
- **agy CLI 子进程自己的日志**：`~/.gemini/antigravity-cli/log/cli-YYYYMMDD_HHMMSS.log`（每次启动一个文件），最新软链 `~/.gemini/antigravity-cli/cli.log`。内容是 agy 内部日志：会话切换、消息转发、API 请求 URL（`streamGenerateContent`）、Trace/ResponseID、quota 刷新等。⚠️ 它把内部信息打成 `ERROR: logging before google.Init:` 前缀（Go 初始化前日志怪癖），不一定是真错误。排查 agy 侧 API 请求看这里。

## Grammy types
When working with Telegram API types (Message, CallbackQuery, InlineKeyboard, etc.), consult `node_modules/@grammy/types/index.d.ts` for the full type definitions. Do not guess type shapes—always check the actual type file.

## ⚠️ Systemd, Deployment & Linger Rules
- **TypeScript 编译编译（Build First）**：修改完 `src/` 中的 TypeScript 源码后，**必须先执行 `npm run build`**，然后再重启 `systemctl --user` 服务。由于服务直接运行 `dist/cli.js`，只修改 TS 而不重新编译会导致重启后仍运行旧版。
- **用户空间服务管理（`--user`）**：本项目强制通过普通用户空间进行服务生命周期管理，禁止使用 `sudo` 启动。这样可以确保生成的日志与数据库（`db.sqlite`）对开发账号保持读写权限兼容，并防止高权限执行带来的安全漏洞。
- **开机与登出常驻（Linger Mode）**：要确保 SSH 退出后 bot 进程不被系统回收，必须且已对当前开发账号启用了 linger 模式。配置命令：`loginctl enable-linger`；验证属性：`loginctl show-user $(whoami) --property=Linger` 应输出 `Linger=yes`。

## 🧪 Testing Best Practices & Speedup
- **增量测试提速**：在日常迭代中，强烈推荐使用 **`npm run test:changed`** 仅对本次修改的模块及其受影响的下游依赖进行增量测试。由于低功耗 CPU (如 J1900) 运行冷启动全量转译和扫描时间较长（约 50 秒），增量测试能将其优化到 2-3 秒内。
- **Mock 状态隔离与保护**：`vitest.config.ts` 已经全局配置 `LOG_LEVEL: 'silent'`。请配置 **`clearMocks: true`** 代替 `restoreMocks`，从而保留文件顶部 `vi.mock()` 默认声明的模拟实现，仅在测试用例间隔离调用历史。
- **特定测试的环境重载**：若特定测试用例（如 logger）确实需要日志输出断言，应在 `beforeEach` 中使用 `vi.stubEnv('LOG_LEVEL', 'info')` 进行局部覆盖，以保护全局静默不失败。

## 🏷️ 版本号管理规范 (SemVer 2.0.0)
- 本项目版本号严格遵循 [SemVer 2.0.0](https://semver.org/lang/zh-CN/) 语义化版本规范 (`MAJOR.MINOR.PATCH`)：
  - **MAJOR（主版本号）**：当发生不兼容的架构重构或破坏性 API 变更时递增（如 `1.0.0`）。
  - **MINOR（次版本号）**：当新增向下兼容的功能特性（如 RichText 格式支持、新命令行、新模型渠道等）时递增（如 `1.1.0`）。
  - **PATCH（修订号）**：进行向下兼容的 Bug 修复、拼写纠错或小幅性能优化时递增（如 `1.1.1`）。
- **发布流程**：在做版本升级时，使用 `npm version <major|minor|patch>`、`git push --tags && git push` 进行版本发布。



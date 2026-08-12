# Version Numbering Rules

本项目版本号严格遵循 [SemVer 2.0.0](https://semver.org/lang/zh-CN/) 语义化版本规范 (`MAJOR.MINOR.PATCH`)。

## Semver policy
- **patch**: bug fixes, minor internal refactoring, dependency updates, documentation (e.g., `1.1.6 → 1.1.7`)
- **minor**: new features, significant changes in behavior, breaking changes to internal APIs (e.g., `1.1.10 → 1.2.0`)
- **major**: complete rewrites, platform changes, backward-incompatible public API changes

## Digit range (0-9 each)
All three segments **never exceed 9**:
- Patch (z): `x.y.9` → next is `minor`, not `x.y.10`
- Minor (y): `x.9.z` → next is `major`, not `x.10.0`
- Major (x): `9.y.z` → next is `10.0.0` (major CAN go to 10+)

Examples:
- `1.1.9 → 1.2.0` (not `1.1.10`)
- `1.9.9 → 2.0.0` (not `1.10.0`)
- `9.9.9 → 10.0.0`

## When to use minor vs patch
- **minor**: new Telegram RichText entity support, new formatter path (Option A/B/C/D), new footnote/citation feature, new model provider, new command; also when patch would exceed 9 (rolls minor)
- **major**: when minor would exceed 9 (rolls major)
- **patch**: fixing bugs in existing features (even if the fix is non-trivial), typos, test improvements, docs, config tweaks

## Tooling & Code Exploration
- **代码搜索工具**：优先使用 `rg` (ripgrep) 或 `ast-bro` 工具进行代码检索与 AST 级别查验，**禁止/避免**使用传统的 `grep` 命令。

## Procedure
1. `npm version <major|minor|patch>`
2. `git push --tags && git push`
3. `gh release create v<VERSION> --title "v<VERSION>" --notes "summary"`
4. `systemctl --user restart gemini-cli-telegram.service`

## ⚠️ Systemd, Deployment & Linger Rules
- **TypeScript 编译编译（Build First）**：修改完 `src/` 中的 TypeScript 源码后，**必须先执行 `npm run build`**，然后再重启 `systemctl --user` 服务。由于服务直接运行 `dist/cli.js`，只修改 TS 而不重新编译会导致重启后仍运行旧版。
- **用户空间服务管理（`--user`）**：本项目强制通过普通用户空间进行服务生命周期管理，禁止使用 `sudo` 启动。这样可以确保生成的日志与数据库（`db.sqlite`）对开发账号保持读写权限兼容，并防止高权限执行带来的安全漏洞。
- **开机与登出常驻（Linger Mode）**：要确保 SSH 退出后 bot 进程不被系统回收，必须且已对当前开发账号启用了 linger 模式。配置命令：`loginctl enable-linger`；验证属性：`loginctl show-user $(whoami) --property=Linger` 应输出 `Linger=yes`。

## 🧪 Testing Best Practices & Speedup
- **增量测试提速**：在日常迭代中，强烈推荐使用 **`npm run test:changed`** 仅对本次修改的模块及其受影响的下游依赖进行增量测试。由于低功耗 CPU (如 J1900) 运行冷启动全量转译和扫描时间较长（约 50 秒），增量测试能将其优化到 2-3 秒内。
- **Mock 状态隔离与保护**：`vitest.config.ts` 已经全局配置 `LOG_LEVEL: 'silent'`。请配置 **`clearMocks: true`** 代替 `restoreMocks`，从而保留文件顶部 `vi.mock()` 默认声明的模拟实现，仅在测试用例间隔离调用历史。
- **特定测试的环境重载**：若特定测试用例（如 logger）确实需要日志输出断言，应在 `beforeEach` 中使用 `vi.stubEnv('LOG_LEVEL', 'info')` 进行局部覆盖，以保护全局静默不失败。

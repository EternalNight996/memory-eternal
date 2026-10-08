# Security Policy

## 支持范围 / Supported versions

只对**最新的 0.10.x**（以及后续的 minor 线）提供安全修复；更早的版本请先升级到 npm 上的最新版。

Security fixes are provided for the **latest 0.10.x release line** (and later minor lines).
Older versions should be upgraded to the latest release on npm first.

## 报告漏洞 / Reporting a vulnerability

**请走 GitHub 私有安全公告**（公开 issue 里不要贴任何令牌、路径或可利用细节）：

Please use **GitHub private security advisories**:

1. 打开 <https://github.com/EternalNight996/memory-eternal/security/advisories/new>
2. 写清：影响的版本、复现步骤、影响面、你建议的修复方向
3. 需要的话附一段最小 PoC（**脱敏后**）

We aim to acknowledge a report within **7 days** and to ship a fix or a mitigation
plan within **30 days** for confirmed issues. Please allow that window before
public disclosure.

公开的 bug（崩溃、界面问题、功能建议）照旧走 <https://github.com/EternalNight996/memory-eternal/issues>；
插件内置的「反馈异常」会自动生成一段**已脱敏**的诊断信息，可以直接贴进 issue。

## 这个插件能碰到什么 / What this plugin can touch

- **文件**：只读写 `~/.dsh/memory-vault`（Markdown 记忆库）与 `~/.dsh` 下的插件自有文件
  （共享配置、watchdog 锁、capture 日志、SQLite 索引）。不遍历用户其它目录。
- **子进程**：用本机 `node` 拉起两个自有脚本——`lib/web.js`（本地 Web UI，默认只监听
  `127.0.0.1:7999`）与 `lib/watchdog.js`（保活）。终端命令请走 `dsh-memory` CLI。
- **网络**：运行期**不外发**任何记忆内容。唯一的出站请求是「检查更新」时读 npm registry
  （`registry.npmjs.org/memory-eternal`，4 秒超时，10 分钟缓存），以及在你显式配置
  provider/model 后调用你自己选择的 LLM 接口做知识卡蒸馏。
- **凭证**：不存任何密钥。蒸馏用的 provider/model 取自宿主（DSH / Codex / Claude Code）的设置，
  插件只读引用，不落盘、不上报。

## 仓库自身的约定 / Repository practices

- 所有第三方 GitHub Actions 一律钉到 commit SHA（可变 tag 会被供应链扫描判为风险）。
- 持续跑官方 [HOL Guard 扫描](https://github.com/hashgraph-online/hol-guard)
  （`.github/workflows/plugin-scanner.yml`：`contents: read`、无 secret、无在线探测）与 `npm test`。
- 示例/测试里的「密钥」都是**运行时拼接的假值**，源码中不存在完整密钥字面量。
- 依赖只有 `@deepseek-ai/schemastery`；没有 postinstall 脚本，没有原生编译，没有远程下载。

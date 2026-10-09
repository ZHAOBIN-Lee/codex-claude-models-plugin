# 把 Claude 做成原生 Codex 模型

[English](README.md)

在 Codex 平常的模型菜单里直接选 Claude，和 GPT 放在一起。由 Claude 做决策，Codex 执行工具，真实的工具调用显示在主聊天里。本地 router 把 GPT 请求用你现有的 Codex 登录发给 OpenAI，把 Claude 请求用你自己的 Claude 订阅登录交给 Claude Agent SDK。

**状态：0.3.0，公开预览。** 维护者在 macOS 上日常使用。目前只在这一台机器上测试过，见[已核对的内容](#已核对的内容)。

## 基于上游

这是 Andrii Shafar 的 [Reidond/codex-claude-models-plugin](https://github.com/Reidond/codex-claude-models-plugin) 的修改版，起点是提交 `dd91e36f30bf5682eb78316f3ed3b0de29d12015`（MIT 许可）。本地 router、请求适配、GPT 转发、合并的模型菜单和安装流程来自上游。两方的版权声明都在 [LICENSE](LICENSE) 里。它不是上游发布的版本，上游 `main` 里没有这些改动。[VERIFICATION.md](VERIFICATION.md) 是上游 2026 年 9 月在 Codex 0.154 上的记录，作为历史保留。

## 这个版本新增了什么

- **上下文与压缩。** 交给 Codex 的是最近一次完整主模型请求的用量，不再是 SDK 的累计总量；以前的累计值会让短聊天每一步都压缩。每个 Claude 模型使用实测窗口（100 万或 20 万），没核实过的模型或带 `[1m]` 后缀的 ID 按 20 万处理。连接器和 MCP 工具改为通过 `tool_search` 按需加载，一般每步的输入从约 48 万 Token 降到 4～7 万。
- **切换到 GPT。** 切到窗口更小的模型时，Codex 会先让上一个模型压缩，所以由 Claude 写摘要、GPT 接收摘要，Claude 可以继续用 75 万的压缩门槛。压缩请求会被识别出来，单独放宽时间上限，失败时重试一次。
- **长步骤。** 只有连续 180 秒没有模型活动（压缩为 300 秒），或单步超过 15 分钟，才判为超时。心跳是真实的 SSE 事件，Codex 的空闲计时不会把慢但仍在进行的步骤断掉。
- **稳健性。** 格式错误的决策、或拿不到可核实用量的流会重试一次。当前回合的图片会交给 Claude。回复语言按用户自己写的文字判断，不受 Codex 包在外面的英文内容影响。
- **Claude 派 GPT 子代理。** 桌面 App 用的是 Codex 的 v2 子代理协议，任务内容放在 `encrypted_content` 字段里。Claude 当主模型时这里是明文，OpenAI 会拒绝 GPT 子代理的第一个请求，报 “Encrypted function output content could not be decrypted or decoded”。现在 router 转发前会把这类明文字段改成普通文本；真正的 OpenAI 密文（`gAAAAA…`）和其他 GPT 请求都原样转发。
- **并发。** 只有 Claude 步骤计入 6 个的上限，因为每一步都要启动一个 Claude Code 进程。GPT 请求只做转发，router 不限制它们；以前把它们也算进去，所有聊天都走 router 后就出现了本地的 `429 Too Many Requests`。超出上限的 Claude 步骤会排队（流式请求排队时持续收到心跳），等满 2 分钟仍没有空位才报 `busy`。
- **直接调用工具。** Claude SDK 会话里没有原生工具，Codex 工具要写进回复的 `calls`。Claude 偶尔仍会直接调用 `exec_command`、`apply_patch`，收到 “No such tool available”。多数时候它在同一步里自己改正，把调用写进 `calls`，这样的回复直接保留。如果它交回的回复没有任何 `calls`（比如说“工具坏了”），router 会带一句提示把这一步重试一次，提示写明工具名，并说明对话里已有的工具结果都是真实执行过的。
- **安全边界。** Claude 只通过固定的官方 CLI 运行（路径、版本和 SHA-256 都核对），要求订阅登录，没有 API 回退。每次调用都写一份私有凭证，记录实际模型和会话。
- **并行子代理。** 本步提供 `spawn_agent` 时，系统提示会要求 Claude 把互不依赖的子代理一起派出：在同一次回复里放多个 `spawn_agent`，数量不超过空闲的并发名额，再一起等待。会改文件的子代理只有在改动文件不重叠时才并行。改之前，维护者聊天里的 Claude 每一步都只派一个子代理。
- **安装。** 安装和回退是事务式的；`PATH` 里没有 npm 时可用 `NPM_BIN` 指定；另有脚本可以把一个或全部已有聊天迁移到 router，带备份和回退（见 [MIGRATION.zh-CN.md](MIGRATION.zh-CN.md)）。

细节、配置差异和回退见 [ADAPTATION.zh-CN.md](ADAPTATION.zh-CN.md)。

## 已核对的内容

2026-10-06 至 07，macOS arm64，Codex 0.160.1，官方 Claude Code 2.1.285，Agent SDK 0.3.270，Node 24。

- 204 项单元和集成测试（`npm test`）。在 Codex 0.162.0-alpha.2 上，单聊天迁移的真机测试会被版本检查拒绝，因为它只接受测过的 0.160.0 和 0.160.1。
- 通过无界面的 `codex exec` 使用真实 Claude 订阅：
  - 强制压缩一次：Sonnet 压缩 423,417 Token 用了 7.7 秒，之后聊天能正确回忆前面的输出。
  - 同一个聊天从 Claude 切到 GPT，临时 catalog 把 GPT 窗口调到 4 万：先由 Sonnet 压缩，GPT 再根据前面的历史作答。
  - 混合子代理，各执行一条命令：Claude 聊天派出 GPT 子代理，GPT 聊天派出 `claude_sonnet`。
- 在桌面 App 里日常使用。这是维护者自己的使用，不是正式验收。
- 在桌面 App 里，Claude（Opus）聊天派出 `gpt-6.1-sol` 子代理，执行一条命令后正常回报。修复之前，同一路径连续三次在子代理的第一个请求就失败。
- 在维护者真实的 Codex 目录上做了批量迁移：一次迁移 4,025 个 `openai` 聊天（含已归档聊天和子代理会话），用真实 Codex 冷启动抽查了 4 个聊天，之前报错的一个旧聊天随后在桌面 App 里用 Claude 正常回复。前两次尝试在抽样时失败并自动改回，两个原因都已修复并补了测试。

没有核对：

- Linux 和 Windows。
- 接近 75 万门槛时的压缩；耗时是按上面的结果推算的。
- 重试和长时间心跳在真实使用中的表现（只有单元测试）。
- 更大的混合子代理流程，以及只读沙箱下的真实 Claude。

## 需要什么

- Node.js 22+（我们用的是 24.19.0）和 npm。
- 你实际使用的 Codex CLI，用绝对路径。
- 官方 Claude CLI，以及你自己的 claude.ai Pro 或 Max 登录。不支持 API 密钥和 Console 路线。
- macOS。目前只在 macOS 上验收过；Linux 和 Windows 没验过，哪怕配置文字看起来是通用的。

## 构建并在隔离目录里试用

在本检出目录里运行，不要指向 `~/.codex`。

```sh
npm ci --ignore-scripts
npm run build
```

锁文件里的 Codex 开发依赖仍是 0.154。真实运行时请让 `CODEX_BIN` 指向你实际使用的 Codex CLI（我们用的是桌面应用自带的 0.160）。

登录请在你自己的终端里照常做：`codex login` 和 `claude auth login`。这里不会读取或复制任何凭证。

**1. 先写政策文件。** 没有它，Claude 路线什么都不会运行。

```sh
ISOLATED_HOME="$HOME/codex-claude-native-test"
CLAUDE_CLI="/官方/claude/的绝对路径"      # 必须是真实文件，不能是符号链接
REAL_CODEX="/你的/codex/的绝对路径"

mkdir -p "$ISOLATED_HOME/claude-models" && chmod 700 "$ISOLATED_HOME" "$ISOLATED_HOME/claude-models"
cp runtime-policy.example.json "$ISOLATED_HOME/claude-models/runtime-policy.json"
chmod 600 "$ISOLATED_HOME/claude-models/runtime-policy.json"
"$CLAUDE_CLI" --version
shasum -a 256 "$CLAUDE_CLI"
```

编辑这份副本：`claude_path`、`claude_version`、`claude_sha256` 用上面命令的结果，然后写 `"subscription_usage_credits_disabled": true` 和 `"usage_credits_confirmation": {"source": "user", "date": "YYYY-MM-DD"}`。只有你在自己的账户里确认过额外用量已关闭才可以这样写。这是你自己的书面声明，不是实时账单核查，也没有任何默认值会替你填 true。示例文件是 `false`/`unconfirmed`，不改就加载不了。

**2. 安装到隔离目录**，端口用一个和你现有安装不冲突的：

```sh
CODEX_BIN="$REAL_CODEX" node plugins/codex-claude-models/bin/setup.mjs install --codex-home "$ISOLATED_HOME" --port 47900
CODEX_BIN="$REAL_CODEX" node plugins/codex-claude-models/bin/setup.mjs doctor --codex-home "$ISOLATED_HOME"
```

**3. 可选：跑一个真实用例。** 不带参数时验收脚本只打印用法。`--live` 会在你的 Claude 订阅上发真实请求，每次只跑一个用例，用它自己的临时 Codex 目录，结束后删除：

```sh
CODEX_BIN="$REAL_CODEX" ./node_modules/.bin/tsx scripts/native-acceptance.ts
CODEX_BIN="$REAL_CODEX" ./node_modules/.bin/tsx scripts/native-acceptance.ts --live --codex-home "$ISOLATED_HOME" --report "$HOME/native-report.json" --case readwrite
```

用例：`readwrite`、`cancel`、`readonly`、`compact`、`history`。报告权限是 600，只有元数据，并且始终标注 GUI 未验证。

## 全局启用（安装步骤）

只有读完 [ADAPTATION.zh-CN.md](ADAPTATION.zh-CN.md) 里的具体配置差异和回退步骤之后再做：

1. 对你真实的 Codex 目录执行 `install`，再 `activate-router`。它只按精确哈希信任自己那一条启动钩子。
2. 重启一次 Codex，开新聊天。旧聊天保留原来的 provider，在里面选 Claude 会报 “not supported when using Codex with a ChatGPT account”。迁移方法见 [MIGRATION.zh-CN.md](MIGRATION.zh-CN.md)。
3. 你原来的 GPT 默认模型保持不变。`deactivate` 和 `uninstall` 会撤销它自己加的改动。

## 使用时要知道

- Claude 的决策要等完整返回才显示。Codex 执行工具时会显示 Codex 自己的事件，看不到 Claude 的隐藏思考，也看不到它内部的每一步。
- 支持文字和当前回合的图片，更早的图片会变成占位说明。音频、Codex 输出 schema 模式和服务端保存的响应 ID 会明确报错。
- 每一步都是新的 SDK 查询，连续性来自 Codex 的聊天历史。某一步的 SDK 会话 ID 不是 Codex 的线程 ID。
- 某一步 SDK 最终用量里可能同时出现所选模型和 Haiku。我们没查清 CLI 为什么会用 Haiku，也不承诺没有额外用量。
- 只在上面列出的情况下重试，没有 API 回退。取消和拒绝会分开记录。
- 如果发现 API 密钥或路线覆盖项，守卫会拒绝运行并说明是哪个变量或文件：`ANTHROPIC_*`、OpenAI 的密钥或地址变量、Claude 设置文件里的辅助程序设置，或 Anthropic 配置档。
- 每次推理尝试都会在 `<home>/claude-models/receipts` 写一份私有凭证（权限 600）。模型名和会话 ID 只取自最终结果，不取别名，也不取模型自己的说法。

## 账户条款

截至 2026-10-06，[Agent SDK 套餐说明](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)开头写着 6 月 15 日的通知，称计费调整已暂停，我们不把其中较早的表格当作现行政策。[SDK 概览](https://code.claude.com/docs/en/agent-sdk/overview)说，第三方产品未经批准不得提供 claude.ai 登录或其额度。MIT 许可管的是代码，不是你的账户条款；技术上能跑不等于获得批准，这也不是法律意见。

## 开发

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run build
```

`PATH` 里没有 npm 时，在 `install` 前把 `NPM_BIN` 设为 npm 可执行文件或 `npm-cli.js`。

`npm run test:codex` 用的是确定性模拟提供方，检查的是原生工具执行和切换，不是真实模型行为，也不是桌面界面。

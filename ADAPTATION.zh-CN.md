# 适配指南

[English](ADAPTATION.md)

写给想自己试用这个修改版的开发者。[README](README.zh-CN.md) 已有简版，这里不重复。它基于 [Reidond/codex-claude-models-plugin](https://github.com/Reidond/codex-claude-models-plugin) 的提交 `dd91e36f30bf5682eb78316f3ed3b0de29d12015`（MIT 许可，两方的版权声明都在 [LICENSE](LICENSE) 里），不是上游发布的版本。[VERIFICATION.md](VERIFICATION.md) 是上游 2026 年 9 月在 Codex 0.154 上的记录，作为历史保留，不是我们的验收。账户条款见 README。技术上跑通不等于 Anthropic 批准第三方产品这么用。

## 思路

这个版本新增了什么，见 [README](README.zh-CN.md#这个版本新增了什么)。下面的验证记录都标了日期；2026-10-06 的基线早于维护者本机的全局启用。

```text
Codex → 本地回环提供方 → Claude Agent SDK → 一份结构化决策（文字 + Codex 工具调用）
Codex 在自己的沙箱和审批下执行这些工具调用，显示出来，再把结果送回去。
```

Claude 的决策直接交给 Codex，由 Codex 执行并显示真实的工具调用。它不是逐 token 流：每个决策要等完整返回才显示，Claude 的隐藏思考和内部步骤看不到。

不开放任何 SDK 执行工具（只有结构化输出那一个）。每一步都是新的 SDK 查询，连续性来自 Codex 的聊天历史，不是 SDK 续接。某一步的 SDK 会话 ID 不是 Codex 的线程 ID。

## 修了什么

**安装、选模型、停用都有事务日志。** 动手之前先写一份待定日志，保存的状态在 `config.toml` 真正包含新值之前，一直描述 `config.toml` 实际的样子。

- 重命名可能已经生效却仍然报错。所以恢复时看磁盘上的实际情况（配置内容、自有文件、目录身份），不看异常。
- 新配置已提交，或者结果无法证明时，保留新文件和日志，不把运行目录换回旧的去配新配置。只有证明提交之前就失败，才恢复旧运行目录。
- 每次安装带一个尝试 ID，失败后能分清“这次尝试已提交”和“旧的已提交状态还在”。第一次日志保存被拒绝时，旧运行目录、配置和文件原样保留，可以直接重试。
- 运行目录交换失败但其实已生效时，用保存的副本恢复原安装。只有确认是这次安装放进去的目录才会删。
- 你之后的编辑会保留。如果你把工具自有的某项设置改成了第三个值，所有操作都会报冲突并拒绝覆盖，直到你把它改回来。

**每一步 Claude 调用前都跑运行守卫，回执完整。**

- 顺序：原始环境（路线和凭证变量，只报名字）→ 私有政策文件（权限 600、不是符号链接、严格字段）→ 扫描本地设置 → 固定的 CLI（先算 SHA-256，再核版本，再用 `auth status` 确认是 `claude.ai` 的 Pro 或 Max）→ SDK 账户检查（第一方、Pro 或 Max）。先扫描设置再跑 CLI，是因为设置文件里的辅助程序可能在 CLI 启动时就执行，连 `--version` 也一样。
- 扫描范围：你的主目录里的 Claude 设置、目录树上层的项目文件、托管设置文件和 drop-in、本地 macOS 托管偏好文件、Anthropic 配置档。符号链接和无法核实的文件一律拒绝。覆盖范围只记录为 `local_file_scan`，不检查远程、MDM 或 Windows 策略。另外 `settingSources: []` 并不能关掉托管设置，它们在 SDK 会话里照样会加载。
- 子进程环境设置 `DISABLE_AUTOUPDATER=1` 和 `DISABLE_UPDATES=1`，并去掉 `FORCE_AUTOUPDATE_PLUGINS`。你自己的环境和更新配置不会被改。
- 每次尝试写一份私有回执（权限 600）。里面有从被接受的那一步开始（在守卫之前）的总耗时、预检和查询耗时、走到的阶段，以及最终结果里的模型、会话 ID、用量和 SDK 计时。`usage_scope: "query_pipeline_total"` 标明 SDK 累计用量；`context_usage` 单独记录已结束的主模型响应计数，供 Codex 判断当前上下文。缺失完整计数时，`context_usage` 保持 null，响应状态为 incomplete。状态有 `complete`、`failed`、`incomplete`、`aborted`、`blocked`。没有最终结果就被取消时，模型和会话保持未知（null），不猜。SDK 查询在每条路径上只关闭一次，包括守卫期间取消。
- 模型检查有真正的 30 秒上限，覆盖守卫、账户和模型列表，并且先核对账户，再去取模型。

**Skill 路由。** `plugins/codex-claude-models/skills/claude-models` 只回应明确的安装设置、使用说明和移除请求。可信上下文表明当前模型就是原生 Claude 时，“用 Claude”就是直接用 Codex 原生工具；需要第二意见时派 Claude 子代理角色，不调用外部 CLI。

**Claude 父聊天派 GPT 子代理。** 合并目录把所有模型设成 `multi_agent_version: "v1"`，但桌面 App（0.160.1）实际仍跑 v2 子代理，派发内容放在 `encrypted_content` 字段里。Claude 当父模型时这个字段是明文，OpenAI 会以 “Encrypted function output content could not be decrypted or decoded” 拒绝 GPT 子代理的请求。`src/openai.ts` 里的 `portableAgentMessages` 只把 `agent_message` 中不是 OpenAI 密文的 `encrypted_content` 改成 `input_text`；没有需要改的内容时，原始请求字节原样转发。桌面 App 为什么没用上 v1 设置，目前还没查清。

**并发与排队。** router 同时最多跑 6 个 Claude 步骤（`concurrency`）。GPT 请求不再占名额：批量迁移后所有 GPT 聊天和子代理都经过 router，长时间的 GPT 流式输出占满了 6 个名额，router 自己对 GPT 和 Claude 都返回了 `429 busy`（Codex 不重试，`request_max_retries = 0`）。现在超出上限的 Claude 步骤按先来后到排队，最多等 `queueMs`（默认 120 秒）；流式请求已经收到 200 响应头和心跳，所以超时会以 `response.failed`、代码 `busy` 的事件返回。

**直接调用原生工具。** SDK 会话以 `tools: []` 运行，使用 Codex 工具的唯一方式是结构化回复里的 `calls`。Opus 和 Sonnet 都偶尔会直接调用 `exec_command`、`apply_patch` 或 `tool_search`。SDK 返回 “No such tool available”，权限拒绝列表仍为空，模型随后交回一份格式合法、却声称 Codex 工具不可用的回复。`src/sdk.ts` 里的 `nativeToolCall` 会检查主模型的消息流（忽略子代理内部的调用和 `StructuredOutput`）。第一版一发现直接调用就中断这次尝试；实际使用中，这类步骤大多已经在同一次查询里把调用写进 `calls` 自行改正，中断反而让耗时翻倍，提示里的 “nothing was executed” 还让 Sonnet 把同一条命令重跑了八次，连续两次被拦截时整轮直接失败。现在回复里有 `calls` 就直接保留；只有首次尝试在直接调用之后交回没有 `calls` 的回复，才以代码 `native_tool_call` 重试一次，提示说明已有的工具结果都是真实的；重试那一次不会再因此被拒。凭证里记录为 `rejected: {code: "native_tool_call", tool}`。

## 已验证与未验证

### 2026-10-07（0.3.0）

macOS arm64，Codex 0.160.1，官方 Claude Code 2.1.285，Agent SDK 0.3.270。

- 203 项测试通过，类型检查和构建通过。设置 `NPM_BIN` 后，安装运行时的测试也能跑。
- 桌面 App：修复明文 `encrypted_content` 之后，Claude 父聊天派出 GPT 子代理（`gpt-6.1-sol`），执行 `pwd && date` 并正常回报。下面那次混合子代理测试用的是无界面的 `codex exec`，没覆盖这条路径。
- 目录里每个 Claude 模型的窗口都取自 SDK 最终结果（100 万或 20 万）。没核实过或带后缀的 ID 按 20 万处理。
- 真实 Sonnet 强制压缩：423,417 输入 Token 用 7.7 秒完成摘要，凭证记为 `request_kind: compaction`，之后回忆正确。
- 同一聊天从 Claude 切到 GPT，临时 catalog 把 GPT 窗口调到 4 万：Codex 的 `ModelDownshift` 压缩在 Sonnet 上执行（70,379 Token，5.9 秒），GPT 再根据摘要作答。
- 混合子代理，各执行一条命令：Claude 父聊天派 GPT 子代理（`gpt-6.1-sol`），GPT 父聊天派 `claude_sonnet`（凭证为 `claude-sonnet-5-5`）。
- 未验证：接近 75 万时的压缩、重试和长时间心跳在真实使用中的表现、Linux 和 Windows。

### 2026-10-06 基线

日期 2026-10-06，macOS arm64。Node 24.19.0，npm 10.9.2，Codex 0.160.0，官方 Claude Code 2.1.285，Agent SDK 0.3.270。

| 层 | 结果 |
| --- | --- |
| 自动化测试 | 136 个测试全部通过，无跳过、无取消。类型检查和构建通过。 |
| 真实 Codex 0.160 消费者 + 确定性模拟提供方 | 执行工具、切换模型、只精确信任一条钩子。一次只读模拟运行看到真实沙箱拒绝了写入。 |
| 真实 Pro 订阅、无界面、一次性目录 | 同一线程两轮读取、修改、读回，第二轮答对第一轮的暗号。取消。一次 18,711 字符的历史提示（是有限文本，不是 token 实测）。小范围手动压缩走到明确终态，之后回忆出早期事实。全部通过。 |
| 真实只读用例 | 模型没调用工具就拒绝了：对沙箱而言是 inconclusive。 |
| 经隔离路由的真实 GPT | 一次小请求通过（5.426 秒），不是性能数据。 |
| 隔离目录里的完整生命周期 | `install` → 激活并精确信任 → 在新建的真实 Codex 聊天里，第一轮运行了启动辅助程序（回答来自确定性模拟，SDK 推理为 0）→ `stop` → `deactivate` 和 `uninstall` 只移除自有字段，保留期间新加的无关设置。端口关闭，运行目录、私有政策、备份和回执保留。 |

耗时：两个小回合里，发送到首个工具是 3104 ms 和 2844 ms，完成是 6547 ms 和 10352 ms。没有和旧 Bridge 做同任务对照，所以不宣称提速。

模型：最终 SDK 用量里同时有 `claude-sonnet-5-5` 和 `claude-haiku-4-5-20251001`。后者起什么作用没有查清。请求里写的 Sonnet 或 `medium` 强度不能证明实际模型或实际强度，只认回执里的最终结果。

过程中出现过两个验收脚本问题：只创建了聊天却没发第一轮，以及主机没关闭 stdin。两个都是脚本问题，已修正。它们留在失败历史里，核心启动并没有出过事故。

基线未验证：桌面 GUI 主聊天、Linux 和 Windows、自动上下文溢出、更大规模的 GPT/Claude 混合子代理流程、远程/MDM/Windows 托管策略、实时账单。

## 全局启用之前

要你自己读完差异之后再做，目前全局什么都没改。

1. **先准备政策文件**：`<CODEX_HOME>/claude-models/runtime-policy.json`（权限 600）。CLI 路径、版本、SHA-256 从真实文件里取。你已经确认过的信息，比如额外用量已关闭及日期，可以直接填，不会为同一件事再问你。这个文件只记录你的声明，不是实时账单核查。
2. 依次执行 `install`、`activate-router`、`doctor`，`CODEX_BIN` 指向你实际使用的 Codex。先在一个单独的目录里试。
3. 重启一次 Codex，开新聊天。旧聊天保留原来的 provider。要迁移一个或全部旧聊天，按 [MIGRATION.zh-CN.md](MIGRATION.zh-CN.md) 操作；两个脚本都会保留备份清单，方便回退。

`config.toml` 里应出现的键（只有占位符，你的值会不同）。设置工具会重新序列化这个文件，格式和注释可能变；解析后的无关字段保留，但字节哈希不会相同。

```toml
model = "<你当前的 GPT 模型，保持不变>"
model_provider = "codex_model_router"          # 原来：<你之前的值，或没有>
model_catalog_json = "<CODEX_HOME>/claude-models/combined-catalog.json"

[features]
hooks = true

[model_providers.claude_agent_sdk]
name = "Claude Agent SDK"
base_url = "http://127.0.0.1:47832/v1"        # 端口来自 --port，默认 47832，只在本机回环
wire_api = "responses"
requires_openai_auth = false
request_max_retries = 0
stream_max_retries = 0
[model_providers.claude_agent_sdk.auth]
command = "<node>"
args = ["<CODEX_HOME>/claude-models/setup.mjs", "token", "--codex-home", "<CODEX_HOME>"]

[model_providers.codex_model_router]
name = "Codex + Claude Router"
base_url = "http://127.0.0.1:47832/v1"
wire_api = "responses"
requires_openai_auth = true
request_max_retries = 0
stream_max_retries = 0
[model_providers.codex_model_router.http_headers]
X-Codex-Router-Token = "<本地随机令牌，不会发往上游>"

[[hooks.SessionStart]]                         # 恰好一条
matcher = "startup|resume|clear"
[[hooks.SessionStart.hooks]]
type = "command"
command = "'<node>' '<CODEX_HOME>/claude-models/setup.mjs' 'ensure-hook' '--codex-home' '<CODEX_HOME>'"

[hooks.state."<你的 hooks/list 返回的键>"]
enabled = true
trusted_hash = "<你的 hooks/list 返回的哈希>"
```

- 钩子的键和哈希来自你自己那份 Codex 的 `hooks/list`，不要拿隔离目录里的去猜。
- 如果你原来没设置 `model`，激活会写入目录里第一个 GPT 模型，所以差异里要看这一行。
- 合并目录里所有模型（GPT 和 Claude）都用原生 v1 子 Agent。只有单独的仅 Claude 配置档仍是 v2。
- `<CODEX_HOME>/claude-models/` 下会生成：`state.json`、`token`、`setup.mjs`、`runtime/`、各目录文件、`backups/`，以及之后的 `receipts/`。Agent 文件在 `<CODEX_HOME>/agents/`，`claude.config.toml` 在 `<CODEX_HOME>`。

## 回退

用你当初安装的同一个目录，和它真实的设置工具路径：

```sh
TARGET_HOME="/你/安装到的/codex/目录"
SETUP_MJS="$TARGET_HOME/claude-models/setup.mjs"
node "$SETUP_MJS" stop --codex-home "$TARGET_HOME"
node "$SETUP_MJS" deactivate --codex-home "$TARGET_HOME"
node "$SETUP_MJS" uninstall --codex-home "$TARGET_HOME"
```

- `deactivate` 恢复原来的提供方、目录和默认设置，并移除自有钩子及其信任。`uninstall` 还会移除未被改动的生成提供方、目录和 Agent 文件。
- 如果你改过工具自有的字段，它会拒绝，文件和备份原样保留，并告诉你是哪一项。把值改回去（或者确认它归你）再运行。不要强行把整份旧配置盖回你之后的编辑上，不要删 `~/.codex`，也不要去杀别的服务；`stop` 只停这个工具自己的桥接服务。
- 备份请保留。运行目录、私有政策和回执在 `uninstall` 之后有意保留，等你不再需要它们作证据时自己再删。
- 整个过程没有任何自动 API 回退。

## 出问题时

| 看到什么 | 意思 | 怎么办 |
| --- | --- | --- |
| 政策缺失或无效 | 没有 `runtime-policy.json`，或权限不是 600、是符号链接、字段有误 | 复制示例，`chmod 600`，填真实的值。 |
| CLI 版本或哈希不匹配 | Claude 程序被更新或替换了 | 自己核实新程序，然后更新路径、版本和 SHA-256。 |
| 报告路线覆盖项 | 守卫点名了会改变路线的环境变量、设置项或配置档 | 这次使用时把它移除，守卫不会被绕过。 |
| 订阅不可用 | CLI 不是以 claude.ai Pro 或 Max 登录（API 或 Console 登录不算） | 在你自己的终端里 `claude auth login`。 |
| 精确钩子信任没有匹配 | Codex 没有恰好返回一条匹配的启动钩子 | 不要用全局信任绕过。重启，运行 `doctor`，再重试 `activate-router`。 |
| 音频等不支持的输入 | Claude 路线支持文字和当前回合的图片 | 发文字或图片，或这一步换 GPT 模型。 |
| 历史很长 | 请求超出限制（64 MiB 请求体；连续 180 秒没有模型活动或单步超过 15 分钟会失败）或 Claude 上下文 | 缩短，或开新聊天。不支持远程压缩；Codex 的本地压缩可用，已在 42.3 万 Token 上测试过。 |
| 生成文件或提供方冲突 | 工具自有的文件或提供方被改过，或已存在 | 你的改动会保留。恢复它或挪开，再重试。 |

## 试跑一个真实用例

只有明确写 `--live` 才会发真实请求。不带参数时脚本只打印用法，不做推理。用本地的 `tsx`，不用 `npx`，免得悄悄下载东西：

```sh
CODEX_BIN="$REAL_CODEX" ./node_modules/.bin/tsx scripts/native-acceptance.ts
CODEX_BIN="$REAL_CODEX" ./node_modules/.bin/tsx scripts/native-acceptance.ts --live --codex-home "$ISOLATED_HOME" --report "$HOME/native-report.json" --case readwrite
```

# 把 Claude 做成原生 Codex 模型（本地适配）

[English](README.md)

目标：由 Claude 做决策，Codex 执行工具，真实的工具调用显示在主聊天里。中间有本地的 router 和 SDK 进程，但工作仍留在主聊天：由 Codex 执行工具并显示真实调用，没有侧边面板。

**状态：本地、未发布。** 已在本机启用，用户确认能够调用。2026-10-06 第一次修复调整了 Sonnet 的上下文预算，随后用量修复也已安装：161 项测试通过，真实 Codex app-server 连续运行三轮 Claude 对话、六次原生文件读取，自动压缩零次；实际返回的上下文及缓存计数与新凭证一致。本次后续验收通过无界面的原生客户端完成。下方早期验收记录来自全局启用之前。

这是对 [Reidond/codex-claude-models-plugin](https://github.com/Reidond/codex-claude-models-plugin)（提交 `dd91e36f30bf5682eb78316f3ed3b0de29d12015`）的本地适配，MIT 许可，版权 Copyright (c) 2026 Andrii Shafar，见 [LICENSE](LICENSE)。它不是上游发布的新版本，直接克隆上游 `main` 拿不到这些改动。

更多细节见 [ADAPTATION.zh-CN.md](ADAPTATION.zh-CN.md)（改了什么、配置差异、回退）。旧的 [VERIFICATION.md](VERIFICATION.md) 是上游 2026 年 9 月在 Codex 0.154 上的记录，作为历史保留，不是我们的验收。

## 2026-10-06：连续调用反复压缩

这里有两个问题。下面的窗口修复通过了三轮短消息测试，但后来的工具任务仍压缩了三次。`result.modelUsage` 累加 SDK 整次查询里的所有请求，包括重复的主模型请求和辅助模型调用。把它作为当前上下文返回，会出现单次输入 46.9 万、报告输入 93.8 万的情况。

现在启用 SDK 的部分流事件，取最近一次已经完整结束的主模型响应用量。`message_delta` 中的累计计数直接替换，不相加；等到 `message_stop` 后才采用，缓存 Token 仍计入输入。缺失或未结束的单次用量会以 `missing_context_usage` 拒绝返回，不用整次累计数或人为缩小的值代替。凭证保留累计 `usage`，以 `usage_scope: "query_pipeline_total"` 标明范围，并单独保存 `context_usage`。正常的超限压缩继续启用。占位消息用量与最终流计数的区别见官方 [SDK 用量说明](https://code.claude.com/docs/en/agent-sdk/cost-tracking)。

当前固定版本的 SDK 在单次采样用量中不提供独立模型名，因此采用已校验的外层主模型信息；如果它明确提供了不同模型，则拒绝接受。回归数据已覆盖实际观察到的事件形状，并保留缓存输入计数。

以下是早先窗口修复的验收记录，不能作为后一次修复的验收：

新聊天也可能带着很大的工具说明。本机完整工具列表的一次真实输入约 39 万 token，后续短回合约 48 万；原目录却在 9.6 万就触发压缩。聊天历史缩短后，工具说明又会加回来，所以一直循环。

保留 SDK 返回的实际型号解析结果。`sonnet` 解析为 `claude-sonnet-5-5` 时，使用这次真实 SDK 最终结果报告的 100 万窗口，75 万触发压缩，90 万作为有效窗口。其他型号的相同容量尚未验证，仍保留原预算；不能把这次结果视为所有 Claude 型号都已通过。

完整工具列表下，真实 Sonnet 连续三轮通过，压缩次数为零，跨轮暗号保留。139 项单元/集成测试通过；真实 Codex 消费者配模拟用量时，旧配置三轮压缩两次，新配置零次，76 万用量仍压缩一次。这些是后端验收，不是桌面重载后的显示验收。

更新已安装的目录后，需要重载 Codex 才能读取新预算。无需删除聊天记录。原有的长历史、请求大小和单步超时限制仍适用。

## 实际核对过什么（早期记录）

2026-10-06，macOS arm64，Codex 0.160.0，官方 Claude Code 2.1.285，Agent SDK 0.3.270。

真实 Claude 订阅、无界面 Codex app-server、一次性临时目录、小范围用例：

- 读一个固定文件，再修改并读回，两轮在同一个 Codex 线程里。工具事件和输出都是真的，文件在磁盘上核对过，第一轮的暗号在第二轮也答对了。
- 请求进行中取消：回合被中断，请求被中止，没有残留子进程。
- 一次 18,711 字符的历史提示，要求回答开头的事实。它是有限文本，不是 token 实测，也不是上限测试。
- 小对话手动压缩后再回忆早期事实。走的是 `/responses`，不是远程 `/responses/compact`，也不是溢出或自动压缩测试。

GPT：原来的登录代理路径对真实默认 GPT 跑通了（一次小请求）。模拟的 GPT → Claude → GPT 切换在 0.160 上也通过（确定性模拟提供方，没有真实模型调用）。

没验过的：

- 桌面 GUI 主聊天。
- 这个版本上真实的 GPT/Claude 混合子 Agent。上游的记录不算我们的。
- 真实 Claude 下的只读沙箱。那次模型没尝试工具就拒绝了，对沙箱说明不了什么。模拟提供方的一次运行确实看到真实沙箱拒绝了写入。
- 上下文溢出、Linux、任何速度对比。

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
2. 重启一次 Codex，开新聊天。旧聊天不会自动迁移，在旧聊天里选 Claude 也不会改变它的路线。
3. 你原来的 GPT 默认模型保持不变。`deactivate` 和 `uninstall` 会撤销它自己加的改动。

## 使用时要知道

- Claude 的决策要等完整返回才显示。Codex 真正执行工具时会显示 Codex 自己的事件，但看不到 Claude 的隐藏思考，也看不到它内部的每一步。
- 只支持文字。图片、音频、Codex 输出 schema 模式、服务端保存的响应 ID 和不认识的历史项类型都会明确报错。
- 每一步都是新的 SDK 查询，连续性来自 Codex 的聊天历史。某一步的 SDK 会话 ID 不是 Codex 的线程 ID。
- 某一步 SDK 最终用量里可能同时有 Sonnet 和 Haiku。我们没查清 CLI 为什么会用 Haiku，所以别把一次运行当成纯 Sonnet。它还会产生什么别的开销我们也说不清，不承诺没有额外用量。
- 适配层不自动重试，也没有 API 回退。取消和拒绝会分开记录。
- 如果发现 API 密钥或路线覆盖项，守卫会拒绝运行并说明是哪个变量或文件：`ANTHROPIC_*`、OpenAI 的密钥或地址变量、Claude 设置文件里的辅助程序设置，或 Anthropic 配置档。
- 每次推理尝试都会在 `<home>/claude-models/receipts` 写一份私有回执（权限 600）。模型名和会话 ID 只取自最终结果，不取别名，也不取模型自己的说法。被取消和被拦下的尝试也有回执，什么都不会替它填。

## 账户条款

截至 2026-10-06，[Agent SDK 套餐说明](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)开头写着 6 月 15 日的通知，称计费调整已暂停，我们不把其中较早的表格当作现行政策。[SDK 概览](https://code.claude.com/docs/en/agent-sdk/overview)说，第三方产品未经批准不得提供 claude.ai 登录或其额度。MIT 许可管的是代码，不是你的账户条款；技术上能跑不等于获得批准，这也不是法律意见。

## 开发

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run build
```

`npm run test:codex` 用的是确定性模拟提供方，检查的是原生工具执行和切换，不是真实模型行为，也不是桌面界面。

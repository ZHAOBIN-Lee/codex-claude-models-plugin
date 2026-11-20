# 可选 Claude API 回退

[English](API-FALLBACK.md)

付费回退默认关闭。安装、启动、健康检查、`doctor` 或保存密钥都不会启用它。订阅路径仍要求固定的 CLI、可核验的账户身份及现有的“额外用量已关闭”政策。记录在本地的额外用量确认不等于实时账单检查。

## 在本机隐藏输入凭据

在仓库目录下，用你自己的交互式终端运行。目标 Codex home 必须与已安装 router 一致：

```sh
TARGET_HOME="/path/to/your/codex-home"
python3 scripts/enter-api-key.py --codex-home "$TARGET_HOME"
```

密钥通过 `getpass` 隐藏输入，不放进命令行参数或环境变量。脚本写入 `<TARGET_HOME>/claude-models/api/credentials.json`，文件权限为 600，API 目录权限为 700。它不改变 Claude 全局环境、不连接 Anthropic，也不启用回退。可选参数 `--workspace-id wrkspc_YOUR_WORKSPACE_ID` 可同时保存 workspace ID。不安全的目标权限、符号链接和祖先符号链接会被拒绝，请使用真实目录路径。

仅支持 Anthropic 官方 HTTPS 端点，不支持任意域名、代理 base URL、携带凭据的重定向，也不支持把 API 凭据注入订阅环境。

## 明确设置自己的预算

使用已安装的 setup 脚本。每日与单次上限必须明确填写，软件没有预置美元预算。下面金额是占位符，需要替换为你自己的决定：

```sh
SETUP_MJS="$TARGET_HOME/claude-models/setup.mjs"
node "$SETUP_MJS" api-status --codex-home "$TARGET_HOME"
node "$SETUP_MJS" api-enable --codex-home "$TARGET_HOME" \
  --daily-usd DAILY_LIMIT --per-request-usd REQUEST_LIMIT \
  --total-usd CUMULATIVE_LIMIT --max-output-tokens 8192 --cache 5m
```

`--total-usd` 是可选的累计估算费用上限，包含未结算风险。`--max-output-tokens` 默认 8192，可设 256 到 128000，实际 API 模型也必须支持该值。`--cache` 接受 `5m`（默认）或 `off`。单次上限不能高于每日上限或已配置的累计上限。

启用会在本地检查私有凭据，并进行只读取账户的实时订阅握手，不发送模型提示词。配置绑定该账户的不透明指纹；切换订阅账户后，需要重新明确启用。命令成功显示 `configured_unverified`，只表示文件配置完成，不代表 API 密钥可用、账单已核验、模型权限可用或付费推理已通过。状态包含每日／累计估算风险、未结算预留、剩余本地预算，以及 Unix 毫秒表示的额度重置／冷却时间；不会输出密钥或账户身份、领取恢复探针或发起推理。关闭状态不读取凭据和账本。`doctor` 也包含这种 API 配置状态，不做付费推理。

```sh
node "$SETUP_MJS" api-disable --codex-home "$TARGET_HOME"
```

即使可选配置或状态 JSON 损坏，也可以关闭回退。关闭会保留凭据和账本，不重置费用。API 配置不可用时仍可使用订阅路径。新步骤读取当前 API 配置；已经发往 Anthropic 的调用仍可能产生已预留的费用。

## 切换条件与恢复

优先尝试订阅。只有订阅尝试以失败终态结束，并且有明确的结构化额度证据，才具备付费回退条件。警告、带额度警告的成功结果、登录失败、运行守卫失败、排队错误、网络错误、取消和错误格式的决策都不触发付费回退。

已确认的额度窗口按账户持久保存，包含全账户及 Opus/Sonnet 专属限制。适用窗口尚未恢复时，符合条件的请求可使用已配置的 API 路径。全部适用窗口到期后，由下一次真实请求取得唯一的订阅恢复探针。缺失重置时间时采用五至三十分钟的有界冷却。没有后台付费探测；旧探针的成功不会清除更新的额度拒绝。

API 请求保留所选模型和完整的已准备上下文。推理前检查模型能力、输入 token、输出预留和 UTF-8 请求大小，不会自动降级模型、截断历史、缩小全局上下文窗口或递归重试付费压缩。工具仍由 Codex 执行；API 只返回经过本地校验的决策，不自行执行工具。

API 请求用原生 JSON 结构化输出（`output_config.format` 的 `type: "json_schema"`）返回一个决策对象，不提供原生工具或工具选择。Fable 5.1 不支持强制调用工具，自动选择时模型可能在结束时直接回答文字而不调用包装工具，导致此前工具步骤成功后的最终回答失败。JSON 输出让最终回答也保持在同一决策格式中。推理前仍须确认模型声明支持结构化输出，并保留所选思考强度与自适应思考。计数请求包含相同输出 schema，只省略推理缓存策略。

一个决策内仍可包含多个 Codex 工具调用，因此不会降低 Codex 工具或子代理的并发能力。API 路径把函数参数对象编码为 JSON 字符串，再由本地解析回完整对象；自定义工具的代码或文本保持原文。订阅路径的参数格式不变。schema 用闭合的 `anyOf` 对象分支，将 function/custom 各自限定到同类型的可用工具名，包括 `tool_search` 发现的工具；无工具时保留 calls 为空的要求，不生成空 enum。函数 input 必须是编码为字符串的 JSON 对象，无参数时用 `"{}"`；custom input 保留原文。[Anthropic 的 schema 限制说明](https://platform.claude.com/docs/en/build-with-claude/structured-outputs#json-schema-limitations)支持 `anyOf` 和字符串 enum（包括单值 enum），不支持 `maxItems`，因此调用数量仍由本地校验。未知工具、错误类型配对或无效参数都会被拒绝；只有完整且以 `end_turn` 结束的流可以成功。

每个逻辑步骤最多进行一次付费尝试。重复的付费步骤会被拒绝，包括断线重连；这不是已存结果重放。交付状态不确定时不会悄悄再生成一个付费答案。API 失败不自动重试。父步骤、子步骤和压缩都计入同一账本。

Codex 客户端仍可能在失败流之后重连。在 Codex 0.163.0-alpha.10.2 的本地假服务验收中，普通请求和压缩都出现首次请求加三次重连；防重复机制只允许一次模拟生成，随后客户端停止。这验证了不会重复生成收费，并不代表断线后能重放已生成答案。

## API 响应中断后怎么排查

私有 API 凭证位于 `<TARGET_HOME>/claude-models/api/receipts/`。先找 `api_duplicate_step` 之前的第一笔失败记录：重复调用提示说明重试为何被拦截，不代表首次失败的原因。

失败记录会保留已经获得且通过格式校验的请求编号、消息编号和模型标识，以及白名单内的失败原因、流事件元数据、`stream_stop_reason`（仅限已知 Anthropic 值）与 `decision_text_blocks`（0 至 1024 的整数，以文字保存）。本地契约校验失败时，`decision_rule` 进一步记录 `unknown_tool`、`invalid_arguments`、`invalid_decision`、`tool_choice`、`parallel_calls` 或 `empty_decision`；有 calls 数组时，`decision_calls` 保存其非负整数数量。若能获得，`decision_tool_kind` 只允许 function/custom；`decision_tool` 仅保存本次实际提供且符合格式限制的工具 key（1 至 256 个 ASCII 字母、数字、下划线、点或连字符），未提供的名字一律省略。数量均以文字保存。这些字段不包含提示词、回答正文、工具参数、思考内容或密钥。编号缺失表示当时未获得或未通过校验，不能据此判断 Anthropic 是否处理或收费。诊断信息不会结算未知费用，也不会解除付费步骤的防重试标记。

仅凭 `api_invalid_stream` 不能断定是网络故障。具体诊断原因会区分错误事件 JSON、事件顺序异常、不可用的原生工具调用（`unexpected_tool_use`）、无效 UTF-8 和读取响应流失败。决策错误进一步区分缺少或空白正文（`missing_decision_text`）、非预期结束原因（`unexpected_stop_reason`）、错误 JSON（`invalid_decision_json`）及未通过本地工具契约校验（`invalid_decision`）。更新前生成的旧记录无法补回这些字段。排查时不要删除防重试标记，也不要重放结果未知的请求。

## 预算怎样计算

发送前，router 按已配置并核验的模型费率，预留完整输入的估算费用加上最大输出额度。开启五分钟缓存时，保守预留还包括冷启动写缓存费率。同一 Codex home 下的并发请求、不同密钥和账户共同使用这份私有账本。

可信的返回用量可以结算估算费用并释放差额；实际估算额超过预留时，也会记录超额。发送后结果不明，包括取消或断流，会无限期保留全部预留。未知费用跨午夜和重启仍计入当日风险；已确认结算的费用留在原预留日。每日按 Australia/Melbourne 时区计算。换密钥、关闭、重装和跨天都不清除累计费用；不要通过删除账本来解除预算阻断。

所有金额都是根据 token 用量及配置费率得出的本地估算，不是 Anthropic 账单或实时余额。预算预留限制估算风险，不能保证供应商最终收费精确等于本地数字。

## 五分钟提示词缓存

`--cache 5m` 允许复用满足条件、内容完全相同的提示词前缀。Anthropic 报告缓存命中时，重复调用可以降低输入费用。冷启动写入的缓存部分按**普通输入费率的 1.25 倍**计费；命中读取按该模型配置的缓存读取费率计费。命中不作保证：前缀过短、工具或较早内容变化、超过五分钟复用窗口，都可能造成失效并重新写入。

缓存不会减少发送的上下文、模型计算的上下文用量或上下文窗口要求，完整请求仍必须放得下。`--cache off` 关闭这些显式缓存写入及对应的冷写预算加成。

## 验证边界

首次本地真实 API 检查使用**累计 US$1** 的测试预算。这是当时的本地验证授权，不是软件预置预算或自动启用设置。2026-10-18 已通过本地真实 API 文本与工具决策检查、注入额度事件后调用真实 API runner，以及真实五分钟缓存检查，当时的额度触发是模拟的。2026-10-22 的本机生产记录出现了真实订阅额度拒绝后转 API：一笔 Fable 请求流校验失败，其后三次重连均在推理前被拦截，随后另一笔 Opus 压缩经 API 完成。这证明路由切换发生过，不代表失败的 Fable 回合已成功交付。实际额度重置后的订阅恢复仍未验收。

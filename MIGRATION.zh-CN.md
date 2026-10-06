# 把已有聊天迁移到 router

[English](MIGRATION.md)

执行 `activate-router` 之后，新聊天会走 GPT + Claude router。在那之前建的聊天仍保留原来的 provider，一般是 `openai`。在这些聊天里选 Claude 模型，Codex 会报：

```
... not supported when using Codex with a ChatGPT account
```

从旧聊天里派出的子代理会继承它的 provider，所以 Claude 子代理也会报同样的错。

解决办法是把这些聊天记录的 provider 改成 `codex_model_router`。有两个脚本可以做：

| 脚本 | 迁移范围 | 适合 |
| --- | --- | --- |
| `scripts/thread_migration.py` | 一个聊天 | 只在意一两个聊天 |
| `scripts/batch_migration.py` | 所有 `openai` 聊天，可选包括已归档聊天和子代理会话 | 想让所有旧聊天都能用 Claude |

两个脚本都不调用模型，只改 Codex 状态库（`<CODEX_HOME>/state_<n>.sqlite`）里的 `model_provider` 这一列。聊天历史文件、标题和 `config.toml` 都不动，脚本跑完会核对这一点。

## 开始之前

- **完全退出 Codex。** macOS 上在 ChatGPT/Codex App 里按 Cmd+Q，只关窗口不够。桌面 App 或 Codex `app-server` 还在运行时，脚本会拒绝执行，因为 Codex 会把改动写回去。
- **在普通终端里运行。** 不要在 Codex 聊天里跑，那个聊天本身就属于正在运行的 App。
- **router 要在运行且健康。** 启动命令：

  ```sh
  node ~/.codex/claude-models/setup.mjs start --codex-home ~/.codex
  ```

- **Codex 版本。** `migrate` 和 `rollback` 只接受实际跑通过迁移、冷启动、回退测试的版本（目前是 0.160.0 和 0.160.1）。其他版本会在写入任何东西之前被拒绝，输出里会写明检测到的版本。
- **Codex 路径。** `--codex-bin` 默认是 macOS 桌面 App 自带的 CLI。其他系统请自己传 `--codex-bin`。目前只在 macOS 上测过。

## 迁移全部聊天

先设两个变量。`PLUGIN` 是你克隆这个仓库的位置，`BACKUPS` 是一个你会保留的文件夹。

```sh
PLUGIN="$HOME/codex-claude-models-plugin"
BACKUPS="$HOME/codex-provider-backups"
```

**1. 先看会改什么。** `plan` 只读不写：

```sh
python3 "$PLUGIN/scripts/batch_migration.py" plan --home ~/.codex --include-subagents --include-archived
```

输出包括会迁移多少个聊天、当前各 provider 的数量，以及 `backend_quiet`（false 表示 Codex 还在运行）。不加这两个参数时，只统计你自己开的、未归档的聊天。

**2. 迁移。**

```sh
python3 "$PLUGIN/scripts/batch_migration.py" migrate --home ~/.codex \
  --include-subagents --include-archived \
  --backup-dir "$BACKUPS" --sample 3
```

脚本按顺序做这几件事：

1. 把状态库做一份快照、`config.toml` 复制一份，放进 `$BACKUPS/batch-<id>/`，同时写一份 `manifest.json`，列出每个聊天和它原来的 provider。文件夹权限 700，文件 600。
2. 在一个事务里改掉所有列出聊天的 provider。
3. 核对每个聊天现在都是 `codex_model_router`，所有聊天的其他列都没变，`config.toml` 也没变。
4. 用真实的 Codex 打开（`thread/resume`）几个迁移后的聊天，确认 Codex 报告的是 router。它挑你自己开的、未归档的、最小的几个聊天；已归档聊天和子代理会话会跳过，因为 Codex 不直接恢复它们。想确保某个聊天被检查，加 `--check <聊天 ID>`。

任何一步失败，所有聊天都会改回原来的 provider，输出会写明原因。成功时输出类似：

```json
{
  "status": "migrated",
  "count": 4025,
  "sampled_cold_resume": ["..."],
  "other_columns_preserved": true,
  "configuration_preserved": true,
  "model_calls": 0,
  "manifest": ".../batch-<id>/manifest.json"
}
```

**3. 重新打开 Codex**，在旧聊天里选 Claude 试一下。

记下输出里的 `manifest` 路径，回退时要用。

## 迁移单个聊天

聊天 ID 是 `codex://threads/<id>` 链接的最后一段。

```sh
python3 "$PLUGIN/scripts/thread_migration.py" migrate --home ~/.codex --thread-id <聊天 ID> --backup-dir "$BACKUPS"
```

单聊天脚本还会备份这个聊天的历史文件，并逐字节核对。`plan`、`verify`、`rollback` 的用法见 `--help`。

## 回退

再次完全退出 Codex，然后：

```sh
python3 "$PLUGIN/scripts/batch_migration.py" rollback --manifest "$BACKUPS/batch-<id>/manifest.json"
```

它会先用 manifest 里的哈希核对备份文件，被改动过就拒绝。然后只把 manifest 里列出的聊天改回原来的 provider。迁移之后你做的改动，比如改过的聊天标题、新开的聊天、配置修改，都会保留。

## 迁移之后

- 迁移过的聊天，包括用 GPT 的，都会经过本地 router。如果 GPT 和 Claude 同时没反应，多半是 router 没在运行，用上面的命令启动它。
- 想彻底撤掉 router，先回退迁移，再按 [ADAPTATION.zh-CN.md 的回退一节](ADAPTATION.zh-CN.md#回退)操作。
- 每次运行都会在 manifest 旁边写 `operation-result.json`。失败的运行也会留下备份，确认不需要后可以删掉那些文件夹。

## 被拒绝或失败时

| 输出的 `reason` | 意思 | 怎么办 |
| --- | --- | --- |
| `desktop_or_codex_backend_still_running` | Codex 或桌面 App 还在运行 | Cmd+Q，等几秒再跑。 |
| `router_health_not_verified` | router 在它的端口上没有响应 | 按上面的命令启动，再跑。 |
| `router_not_configured` | `config.toml` 里没有 `codex_model_router` | 先执行 `install` 和 `activate-router`。 |
| `codex_version_not_verified` | 这个 Codex 版本还没通过迁移测试 | 等这个仓库更新，或者先在隔离目录里自己测。 |
| `migration_lock_or_home_permission_failed` | 另一次迁移正在跑，或上次崩溃留下了锁文件 | 确认没有别的迁移在跑，再删掉 `<CODEX_HOME>/thread-provider-migration.lock`。 |
| `sample_resume_failed:<聊天 ID>:...` | 迁移后 Codex 打不开这个聊天，已全部改回 | 查看这个聊天。`native_rpc_error:-32600` 表示 Codex 拒绝了对它的请求。 |
| `state_changed_before_backup` | 规划和备份之间有程序写了状态库 | 确认 Codex 完全退出后再跑。 |
| `other_columns_changed` / `configuration_changed` | 运行期间 provider 以外的内容变了，已改回 | 同上。 |
| `manifest_invalid`（回退时） | manifest 读不出来，或备份文件和哈希对不上 | 用没被动过的备份文件夹，不要改里面的文件。 |

所有失败都会报告 `"model_calls": 0`。

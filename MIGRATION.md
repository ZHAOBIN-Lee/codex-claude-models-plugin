# Moving existing chats to the router

[中文](MIGRATION.zh-CN.md)

After `activate-router`, new chats use the GPT + Claude router. Chats created before that keep their old provider, usually `openai`. If you pick a Claude model in one of them, Codex answers:

```
... not supported when using Codex with a ChatGPT account
```

Sub-agents started from an old chat inherit its provider, so a Claude sub-agent fails the same way.

The fix is to change the stored provider of those chats to `codex_model_router`. Two scripts do it:

| Script | Moves | Use it when |
| --- | --- | --- |
| `scripts/thread_migration.py` | one chat | you only care about one or two chats |
| `scripts/batch_migration.py` | every `openai` chat, optionally including archived chats and sub-agent sessions | you want all old chats to work with Claude |

Neither script calls a model. Both change only the `model_provider` column in Codex's state database (`<CODEX_HOME>/state_<n>.sqlite`). Chat history files, titles and `config.toml` are not touched, and both scripts check that afterwards.

## Before you start

- **Quit Codex completely.** On macOS press Cmd+Q in the ChatGPT/Codex app; closing the window is not enough. The scripts refuse to run while the desktop app or a Codex `app-server` is running, because Codex would overwrite the change.
- **Run from a normal terminal.** Not from inside a Codex chat: that chat is part of the running app.
- **The router must be running and healthy.** Start it with:

  ```sh
  node ~/.codex/claude-models/setup.mjs start --codex-home ~/.codex
  ```

- **Codex version.** `migrate` and `rollback` accept only Codex versions that have passed a real migrate/resume/rollback test (currently 0.160.0 and 0.160.1). Other versions are refused before anything is written, and the output names the version found.
- **Codex path.** The default `--codex-bin` is the macOS desktop app's bundled CLI. On other systems pass `--codex-bin` yourself. Only macOS has been tested.

## Move all chats

Set two variables first. `PLUGIN` is where you cloned this repository; `BACKUPS` is any folder you will keep.

```sh
PLUGIN="$HOME/codex-claude-models-plugin"
BACKUPS="$HOME/codex-provider-backups"
```

**1. See what would change.** `plan` only reads:

```sh
python3 "$PLUGIN/scripts/batch_migration.py" plan --home ~/.codex --include-subagents --include-archived
```

It prints how many chats would move, the provider counts now, and `backend_quiet` (false means Codex is still running). Without the two flags, only open chats you started yourself are counted.

**2. Migrate.**

```sh
python3 "$PLUGIN/scripts/batch_migration.py" migrate --home ~/.codex \
  --include-subagents --include-archived \
  --backup-dir "$BACKUPS" --sample 3
```

What happens, in order:

1. One snapshot of the state database and one copy of `config.toml` go into `$BACKUPS/batch-<id>/`, with a `manifest.json` listing every chat and its old provider. The folder is mode 700, the files 600.
2. All listed chats change provider in a single transaction.
3. The script checks that every chat now reads `codex_model_router`, that no other column of any chat changed, and that `config.toml` is unchanged.
4. It opens a few migrated chats with the real Codex (`thread/resume`) and checks Codex reports the router. It picks the smallest open chats you started yourself; archived chats and sub-agent sessions are skipped because Codex does not resume them directly. Add `--check <chat id>` to always include a chat you care about.

If any step fails, every chat is changed back to its old provider, and the output says why. Success looks like:

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

**3. Reopen Codex** and pick Claude in an old chat.

Keep the `manifest` path from the output. You need it to roll back.

## Move one chat

The chat ID is the last part of a `codex://threads/<id>` link.

```sh
python3 "$PLUGIN/scripts/thread_migration.py" migrate --home ~/.codex --thread-id <chat id> --backup-dir "$BACKUPS"
```

This one also backs up the chat's history file and verifies it byte for byte. See `--help` for `plan`, `verify` and `rollback`.

## Rolling back

Quit Codex again, then:

```sh
python3 "$PLUGIN/scripts/batch_migration.py" rollback --manifest "$BACKUPS/batch-<id>/manifest.json"
```

It first checks the backup files against the hashes in the manifest and refuses if they were changed. Then it sets only the chats listed in the manifest back to their old provider. Edits you made after the migration, such as renamed chats, new chats or config changes, are kept.

## After migrating

- Every migrated chat, GPT included, now goes through the local router. If GPT and Claude both stop answering, the router is probably not running: start it with the command above.
- To undo the router entirely, roll back the migration first, then follow [Rolling back in ADAPTATION.md](ADAPTATION.md#rolling-back).
- Each run writes `operation-result.json` next to its manifest. Failed runs keep their backups too; delete those folders once you no longer need them.

## When it refuses or fails

| Output `reason` | Meaning | What to do |
| --- | --- | --- |
| `desktop_or_codex_backend_still_running` | Codex or the desktop app is still running | Cmd+Q, wait a few seconds, run again. |
| `router_health_not_verified` | The router is not answering on its port | Start it (see above), then run again. |
| `router_not_configured` | `config.toml` has no `codex_model_router` provider | Run `install` and `activate-router` first. |
| `codex_version_not_verified` | This Codex version has not passed the migration test | Wait for an update of this repository, or test it in an isolated home first. |
| `migration_lock_or_home_permission_failed` | Another migration is running, or a lock from a crashed run is left | Make sure nothing else is running, then remove `<CODEX_HOME>/thread-provider-migration.lock`. |
| `sample_resume_failed:<chat id>:...` | Codex could not open that chat after migration; everything was reverted | Look at that chat. `native_rpc_error:-32600` means Codex rejected the request for it. |
| `state_changed_before_backup` | Something wrote to the database between planning and backup | Make sure Codex is fully quit and run again. |
| `other_columns_changed` / `configuration_changed` | Something besides the provider changed during the run; reverted | Same as above. |
| `manifest_invalid` (rollback) | The manifest is unreadable or a backup file no longer matches its hash | Use the untouched backup folder; do not edit files in it. |

All failures report `"model_calls": 0`.

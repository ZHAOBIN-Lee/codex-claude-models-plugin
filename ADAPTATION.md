# Adaptation guide

[中文](ADAPTATION.zh-CN.md)

For developers who want to try this local adaptation themselves. The [README](README.md) has the short version, so this skips it. It is based on [Reidond/codex-claude-models-plugin](https://github.com/Reidond/codex-claude-models-plugin) at commit `dd91e36f30bf5682eb78316f3ed3b0de29d12015` (MIT, Copyright (c) 2026 Andrii Shafar, see [LICENSE](LICENSE)). It is not an upstream release. The upstream record in [VERIFICATION.md](VERIFICATION.md) is September 2026 evidence on Codex 0.154 and is kept as history, not as our acceptance. Account terms are in the README. A technical success is not Anthropic's approval for a third-party product.

## The idea

See the [README](README.md#2026-10-06-repeated-compaction-on-short-chats) for the 2026-10-06 short-chat compaction repair. This check verified the 1M window of `claude-sonnet-5-5` and now retains SDK alias resolution; the same capacity for other models remains unverified. The pre-activation record below is historical. Global activation on this machine was authorized and completed later.

```text
Codex → loopback provider → Claude Agent SDK → one structured decision (text + Codex tool calls)
Codex runs the tool calls under its own sandbox and approvals, shows them, and sends the results back.
```

The old Claude Bridge works differently: a GPT host hands a task to the Claude CLI and relays what comes back, one step at a time. Here the host no longer transcribes each step; Claude's decision goes straight to Codex, which executes and displays the real tool calls. That means less relaying by the host. It does not mean a token stream: each decision is buffered until it is complete, and Claude's hidden thinking and internal steps are not shown.

No SDK execution tools are exposed (only the structured-output tool). Every step is a fresh SDK query, so continuity comes from Codex's chat history, not from an SDK resume. The SDK session ID of a step is not the Codex thread ID.

## What was fixed

**Install, model selection and deactivation use a journal.** A pending journal is written before anything changes, and the saved state keeps describing what `config.toml` really holds until it actually contains the new values.

- A rename can take effect and still report an error. Recovery therefore judges by what is on disk (config content, owned files, directory identities), not by the exception.
- If the new config is committed, or the outcome can't be proven, the new files and the journal are kept and the runtime is not swapped back under it. Only a proved pre-commit failure restores the old runtime.
- Each install carries an attempt ID, so a later failure can tell "this attempt committed" from "an older committed state is still there". If the first journal save is refused, the old runtime, config and files stay and a retry works.
- If a runtime directory swap fails but did apply, the original install is restored from the saved copy. A directory is only removed if this install put it there.
- Edits you make later are preserved. If a setting this tool owns was changed by you to some third value, every operation reports the conflict and refuses to overwrite it until you restore the value.

**The runtime guard runs before every Claude step, and receipts are complete.**

- Order: raw environment (route and credential variables, names only) → private policy file (mode 600, no symlink, strict schema) → scan of local settings → pinned CLI (SHA-256 first, then version, then `auth status` as `claude.ai` Pro or Max) → SDK account check (first-party, Pro or Max). Settings are scanned before the CLI because a helper in a settings file can run when the CLI starts, even for `--version`.
- The scan covers Claude settings in your home, project files up the directory tree, managed settings files and drop-ins, a local macOS managed-preference file, and an Anthropic profile. It refuses symlinks and unverifiable files. Its coverage is recorded as `local_file_scan`. It does not check remote, MDM or Windows policy. Also, `settingSources: []` does not turn off managed settings: those still load in SDK sessions.
- The child environment sets `DISABLE_AUTOUPDATER=1` and `DISABLE_UPDATES=1` and removes `FORCE_AUTOUPDATE_PLUGINS`. Your own environment and updater config are untouched.
- Each attempt writes a private receipt (mode 600). It has the wall clock from the accepted step (before the guard), preflight and query time, the stage reached, and the final result's models, session ID, usage and SDK timing counters. `usage_scope: "query_pipeline_total"` labels cumulative SDK accounting; `context_usage` separately records the completed primary response counters returned to Codex. Missing completed counters leave `context_usage` null and the response incomplete. Statuses are `complete`, `failed`, `incomplete`, `aborted` and `blocked`. A cancel before a final result leaves models and session unknown (null), never a guess. The SDK query is closed once on every path, including a cancel during the guard.
- Model inspection has a real 30 s limit across the guard, account and model list, and checks the account before it asks for models.

**Skill recursion drafts.** `plugins/codex-claude-models/skills/claude-models` now answers only explicit setup, usage-help and removal requests; with trusted native-Claude context, "use Claude" means using Codex's native tools directly. The two files in `staged-skills/` (`claude-bridge`, `dev-orchestrator`) got minimal conditional routing for the same case and keep the old flows. They are drafts and are **not installed**; nothing global was changed.

## What has and hasn't been verified

Date 2026-10-06, macOS arm64. Node 24.19.0, npm 10.9.2, Codex 0.160.0, official Claude Code 2.1.285, Agent SDK 0.3.270.

| Layer | Result |
| --- | --- |
| Automated suite | 136 tests pass, none skipped or cancelled. Typecheck and build pass. |
| Real Codex 0.160 consumer with deterministic providers | Executes a tool, switches models, trusts exactly one hook. A mock read-only run showed the real sandbox denying a write. |
| Real Pro subscription, headless, throwaway home | Read, edit and read back over two turns in one thread, with the first turn's nonce recalled in the second. Cancel. An 18,711-character history prompt (a finite text, not a token measurement). Manual small compaction reaching an explicit terminal state, then recalling the early fact. All passed. |
| Real read-only case | The model refused without calling a tool: inconclusive for the sandbox. |
| Real GPT through the isolated router | One small request passed (5.426 s). Not a performance figure. |
| Isolated lifecycle | `install` → activate and exact trust → a new real Codex chat whose first turn ran the startup helper (answer from a deterministic mock, no SDK inference) → `stop` → `deactivate` and `uninstall` removed only owned fields and kept an unrelated setting added in between. The port closed. Runtime, private policy, backups and receipts stayed. |

Timing: send to first tool was 3104 ms and 2844 ms, and completion 6547 ms and 10352 ms, over two small turns. There was no same-task comparison with the old Bridge, so there is no speedup claim.

Models: the final SDK usage listed both `claude-sonnet-5-5` and `claude-haiku-4-5-20251001`. What the second was used for was not established. A requested Sonnet or `medium` effort is not proof of the actual model or effective effort; only the final result in the receipt counts.

Two acceptance-script problems happened along the way: a chat created without ever sending its first turn, and a host that didn't close stdin. Both were script bugs and are fixed. They stay in the failure history, and there was no core startup incident.

Not verified: the desktop GUI main chat, Linux and Windows, automatic context overflow, real mixed GPT/Claude subagents on this build, remote/MDM/Windows managed policy, and live Billing.

## Before enabling it globally

You do this yourself, after reading the diff. Nothing global has been changed.

1. **Prepare the policy first** at `<CODEX_HOME>/claude-models/runtime-policy.json` (mode 600). Fill the CLI path, version and SHA-256 from the real files. Facts you have already confirmed, such as extra usage being off with a date, can go straight in; nobody needs to ask you again for the same fact. The file records your statement and is not a live Billing check.
2. Run `install`, then `activate-router`, then `doctor`, with `CODEX_BIN` pointing at the Codex you actually use. Try it in a separate home first.
3. Restart Codex once and start a new chat. Old chats are not migrated.

Expected keys in `config.toml` (placeholders only; your values will differ). Setup re-serializes the file, so formatting and comments can change. Parsed unrelated fields are preserved, but a byte hash will not match.

```toml
model = "<your current GPT model, unchanged>"
model_provider = "codex_model_router"          # was: <your previous value or absent>
model_catalog_json = "<CODEX_HOME>/claude-models/combined-catalog.json"

[features]
hooks = true

[model_providers.claude_agent_sdk]
name = "Claude Agent SDK"
base_url = "http://127.0.0.1:47832/v1"        # port from --port, default 47832, loopback only
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
X-Codex-Router-Token = "<random local token, never sent upstream>"

[[hooks.SessionStart]]                         # exactly one entry
matcher = "startup|resume|clear"
[[hooks.SessionStart.hooks]]
type = "command"
command = "'<node>' '<CODEX_HOME>/claude-models/setup.mjs' 'ensure-hook' '--codex-home' '<CODEX_HOME>'"

[hooks.state."<key from your hooks/list>"]
enabled = true
trusted_hash = "<hash from your hooks/list>"
```

- The hook key and hash come from your own Codex's `hooks/list`. Don't guess them from an isolated run.
- If you had no `model` set, activation writes the first GPT model in the catalog, so check that line in the diff.
- All models in the combined catalog (GPT and Claude) use native v1 subagents. Only the separate Claude-only profile keeps v2.
- Files created under `<CODEX_HOME>/claude-models/`: `state.json`, `token`, `setup.mjs`, `runtime/`, the catalogs, `backups/`, and later `receipts/`. Agent files go in `<CODEX_HOME>/agents/`, and `claude.config.toml` in `<CODEX_HOME>`.

## Rolling back

Use the same home you installed into, and its real setup path:

```sh
TARGET_HOME="/path/to/the/codex/home/you/installed/into"
SETUP_MJS="$TARGET_HOME/claude-models/setup.mjs"
node "$SETUP_MJS" stop --codex-home "$TARGET_HOME"
node "$SETUP_MJS" deactivate --codex-home "$TARGET_HOME"
node "$SETUP_MJS" uninstall --codex-home "$TARGET_HOME"
```

- `deactivate` restores the previous provider, catalog and default, and removes the owned hook and its trust. `uninstall` also removes the unchanged generated providers, catalogs and agent files.
- If you edited a field the tool owns, it refuses, leaves the files and backups as they are, and says which one. Put the value back (or decide it is yours) and run it again. Don't force the whole old config back over your later edits, and don't delete `~/.codex` or kill other services; `stop` only stops this tool's own bridge.
- Keep the backups. The runtime, the private policy and the receipts stay after `uninstall` on purpose; remove them yourself, if you want, once you no longer need them as evidence.
- There is no automatic API fallback anywhere in this.

## When something stops

| What you see | Meaning | What to do |
| --- | --- | --- |
| Policy missing or invalid | `runtime-policy.json` not there, not mode 600, a symlink, or fields wrong | Copy the example, `chmod 600`, fill in real values. |
| CLI version or hash doesn't match | The Claude binary was updated or replaced | Check the new binary yourself, then update path, version and SHA-256. |
| Route override reported | The guard names an environment variable, settings key or profile that changes the route | Remove it for this use. The guard won't be bypassed. |
| Subscription unavailable | The CLI isn't logged in with claude.ai Pro or Max (API or Console logins don't count) | `claude auth login` in your own terminal. |
| Exact hook trust has no match | Codex didn't return exactly one matching startup hook | Don't use a global trust bypass. Restart, run `doctor`, retry `activate-router`. |
| Image or other non-text input | Claude route is text only | Send text, or use a GPT model for that step. |
| Very long history | The request exceeds a limit (8 MiB body, 180 s step) or Claude's context | Shorten or start a new chat. Only a finite 18,711-character history was verified. Remote compaction is unsupported. |
| Generated file or provider conflict | A file or provider the tool owns was edited or already exists | Your edit is kept. Restore it or move it aside, then retry. |

## Trying a real case

Only an explicit `--live` makes a real request. With no arguments the script prints usage and does no inference. Use the local `tsx` rather than `npx`, so nothing gets downloaded implicitly:

```sh
CODEX_BIN="$REAL_CODEX" ./node_modules/.bin/tsx scripts/native-acceptance.ts
CODEX_BIN="$REAL_CODEX" ./node_modules/.bin/tsx scripts/native-acceptance.ts --live --codex-home "$ISOLATED_HOME" --report "$HOME/native-report.json" --case readwrite
```

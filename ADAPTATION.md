# Adaptation guide

[中文](ADAPTATION.zh-CN.md)

For developers who want to try this modified version themselves. The [README](README.md) has the short version, so this skips it. It is based on [Reidond/codex-claude-models-plugin](https://github.com/Reidond/codex-claude-models-plugin) at commit `dd91e36f30bf5682eb78316f3ed3b0de29d12015` (MIT; both copyright notices are in [LICENSE](LICENSE)). It is not an upstream release. The upstream record in [VERIFICATION.md](VERIFICATION.md) is September 2026 evidence on Codex 0.154 and is kept as history, not as our acceptance. Account terms are in the README. A technical success is not Anthropic's approval for a third-party product.

## The idea

The [README](README.md#what-this-version-adds) lists what this version adds. Verification records below are dated; the 2026-10-06 baseline predates global activation on the maintainer's machine.

```text
Codex → loopback provider → Claude Agent SDK → one structured decision (text + Codex tool calls)
Codex runs the tool calls under its own sandbox and approvals, shows them, and sends the results back.
```

Claude's decision goes straight to Codex, which executes and displays the real tool calls. It is not a token stream: each decision is buffered until it is complete, and Claude's hidden thinking and internal steps are not shown.

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

**Skill routing.** `plugins/codex-claude-models/skills/claude-models` answers only explicit setup, usage-help and removal requests. When trusted context says the current model is native Claude, "use Claude" means using Codex's native tools directly; a second opinion is a Claude sub-agent role, not an external CLI.

**Claude parents with GPT sub-agents.** The combined catalog sets every model to `multi_agent_version: "v1"`, but the desktop app (0.160.1) still ran v2 sub-agents, which carry the spawn message in an `encrypted_content` part. From a Claude parent that part is plain text, and OpenAI failed the GPT child's request with "Encrypted function output content could not be decrypted or decoded". `portableAgentMessages` in `src/openai.ts` rewrites only `agent_message` parts whose `encrypted_content` is not OpenAI ciphertext into `input_text`. If nothing needs changing, the original request bytes are forwarded. Why the v1 setting is not applied in the desktop app is still open.

**Concurrency and queueing.** The router allows 6 Claude steps at once (`concurrency`). GPT requests no longer take a slot: after the batch migration every GPT chat and sub-agent went through the router, long GPT streams filled all 6 slots, and the router itself answered `429 busy` to GPT and Claude alike (Codex does not retry, `request_max_retries = 0`). A Claude step over the limit now waits in FIFO order for up to `queueMs` (default 120 s); a streamed request has already received its 200 header and heartbeats, so a timeout arrives as a `response.failed` event with code `busy`.

**Direct native tool calls.** The SDK session runs with `tools: []`, so the only way to use a Codex tool is the structured decision's `calls`. Opus and Sonnet both occasionally called `exec_command`, `apply_patch` or `tool_search` directly. The SDK answered "No such tool available", the permission-denial list stayed empty, and the model then returned a valid decision claiming Codex tools were unavailable. `nativeToolCall` in `src/sdk.ts` watches the main model's stream (sub-agent frames and `StructuredOutput` are ignored). The first version aborted the attempt at any direct call; in real use most such steps had already recovered by returning the call in `calls`, so aborting doubled latency, its "nothing was executed" note made Sonnet re-run a command eight times, and a step rejected twice failed the turn. Now the answer is kept when it contains calls. Only a first-attempt answer with no calls after a direct call is retried once (code `native_tool_call`), with a note that earlier tool results are real; the retry is never rejected for this reason. The receipt records `rejected: {code: "native_tool_call", tool}`.

## What has and hasn't been verified

### 2026-10-07 (0.3.0)

macOS arm64, Codex 0.160.1, official Claude Code 2.1.285, Agent SDK 0.3.270.

- 210 tests; typecheck and build pass. Desktop app: after the image-route fix, an image was generated in a Claude chat through the router (before: 404). The native single-chat migration test fails on Codex 0.162.0-alpha.2 only because its version gate refuses untested versions.
- Desktop app: one Claude (Opus) step spawned three `gpt-6.1-sol` sub-agents together; their commands ran at 12:36:19, 12:36:20 and 12:36:20 and all three reported back. With `NPM_BIN` set, the install-runtime tests run too.
- Desktop app: a Claude parent spawned a GPT sub-agent (`gpt-6.1-sol`) that ran `pwd && date` and reported back, after the plain-text `encrypted_content` fix. The earlier mixed sub-agent check below used headless `codex exec` and did not cover this path.
- Every Claude model in the catalog had its window read from the final SDK result (1M or 200k). Unverified or suffixed IDs fall back to 200k.
- Forced compaction on real Sonnet: 423,417 input tokens summarised in 7.7 s, receipt `request_kind: compaction`, correct recall afterwards.
- Claude to GPT in one chat, GPT window lowered to 40k in a temporary catalog: Codex's `ModelDownshift` compaction ran on Sonnet (70,379 tokens, 5.9 s), then GPT answered from the summary.
- Mixed sub-agents, one shell command each: Claude parent with a GPT sub-agent (`gpt-6.1-sol`), GPT parent with `claude_sonnet` (receipt `claude-sonnet-5-5`).
- Not verified: compaction near 750k, retries and long heartbeats in real use, Linux and Windows.

### 2026-10-06 baseline

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

Not verified in the baseline: the desktop GUI main chat, Linux and Windows, automatic context overflow, larger mixed GPT/Claude subagent workflows, remote/MDM/Windows managed policy, and live Billing.

## Before enabling it globally

You do this yourself, after reading the diff. Nothing global has been changed.

1. **Prepare the policy first** at `<CODEX_HOME>/claude-models/runtime-policy.json` (mode 600). Fill the CLI path, version and SHA-256 from the real files. Facts you have already confirmed, such as extra usage being off with a date, can go straight in; nobody needs to ask you again for the same fact. The file records your statement and is not a live Billing check.
2. Run `install`, then `activate-router`, then `doctor`, with `CODEX_BIN` pointing at the Codex you actually use. Try it in a separate home first.
3. Restart Codex once and start a new chat. Old chats keep their original provider. To move one or all of them, follow [MIGRATION.md](MIGRATION.md); both scripts keep a backup manifest for rollback.

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
| Audio or other unsupported input | The Claude route takes text and current-turn images | Send text or an image, or use a GPT model for that step. |
| Very long history | The request exceeds a limit (64 MiB body; a step fails after 180 s without model activity or at 15 min) or Claude's context | Shorten or start a new chat. Remote compaction is unsupported; Codex's local compaction works and was tested at 423k tokens. |
| Generated file or provider conflict | A file or provider the tool owns was edited or already exists | Your edit is kept. Restore it or move it aside, then retry. |

## Trying a real case

Only an explicit `--live` makes a real request. With no arguments the script prints usage and does no inference. Use the local `tsx` rather than `npx`, so nothing gets downloaded implicitly:

```sh
CODEX_BIN="$REAL_CODEX" ./node_modules/.bin/tsx scripts/native-acceptance.ts
CODEX_BIN="$REAL_CODEX" ./node_modules/.bin/tsx scripts/native-acceptance.ts --live --codex-home "$ISOLATED_HOME" --report "$HOME/native-report.json" --case readwrite
```

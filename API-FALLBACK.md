# Optional Claude API fallback

[中文](API-FALLBACK.zh-CN.md)

Paid fallback is disabled by default. Installing, starting, checking health, running `doctor`, or saving credentials does not enable it. The subscription route still requires its pinned CLI, verified account identity and existing extra-usage-off policy. Its recorded extra-usage confirmation is not a live billing check.

## Enter a credential locally

From the repository, run this in your own interactive terminal. Choose the same Codex home as the installed router:

```sh
TARGET_HOME="/path/to/your/codex-home"
python3 scripts/enter-api-key.py --codex-home "$TARGET_HOME"
```

The key is entered through a hidden `getpass` prompt. It is never a command-line argument or environment variable. The script writes `<TARGET_HOME>/claude-models/api/credentials.json` with mode 600 inside a mode-700 API directory. It does not change the global Claude environment, contact Anthropic, or enable fallback. An optional `--workspace-id wrkspc_YOUR_WORKSPACE_ID` stores the workspace ID with the credential. Unsafe destination permissions, symlinks and symlink ancestors are rejected; use the real directory path.

Only official Anthropic HTTPS endpoints are supported. Arbitrary domains, proxy base URLs, credential-bearing redirects and API credentials injected into the subscription environment are not supported.

## Set your own budgets explicitly

Use the installed setup script. Daily and per-request limits are required; there is no shipped dollar budget. The values below are placeholders to replace with your own decision:

```sh
SETUP_MJS="$TARGET_HOME/claude-models/setup.mjs"
node "$SETUP_MJS" api-status --codex-home "$TARGET_HOME"
node "$SETUP_MJS" api-enable --codex-home "$TARGET_HOME" \
  --daily-usd DAILY_LIMIT --per-request-usd REQUEST_LIMIT \
  --total-usd CUMULATIVE_LIMIT --max-output-tokens 8192 --cache 5m
```

`--total-usd` is optional and caps cumulative estimated spend, including unresolved liabilities. `--max-output-tokens` defaults to 8192 and must be between 256 and 128000; the chosen API model must also support it. `--cache` accepts `5m` (default) or `off`. The per-request limit must fit both the daily and any cumulative limit.

Enabling validates private credentials locally and performs an account-only subscription handshake; it sends no model prompt. The configuration binds to that account's opaque fingerprint. Changing subscription accounts requires a fresh explicit enable step. A successful command reports `configured_unverified`: this means the files are configured, not that the API credential, billing, model access or paid inference has been verified. Status includes estimated daily/cumulative exposure, unresolved reservations, remaining local budget and quota reset/cooldown times in Unix milliseconds. It never prints the key or account identity, acquires a recovery probe or sends inference. Disabled status reads neither credentials nor the ledger. `doctor` includes the same API configuration status and performs no paid inference.

```sh
node "$SETUP_MJS" api-disable --codex-home "$TARGET_HOME"
```

Disable remains available when optional configuration or state JSON is damaged. It retains the credential and ledger so costs are not reset. Subscription-only use remains available when API configuration is unavailable. API settings are read for new steps; a call already sent to Anthropic can still incur its reserved cost.

## Routing and recovery

The subscription is tried first. A paid attempt is eligible only after a failed subscription attempt has definitive structured quota evidence. Warnings, successful responses with quota warnings, login failures, runtime guard failures, queue errors, network errors, cancellations and malformed decisions do not qualify.

Confirmed quota windows persist per account, including global and Opus/Sonnet-specific limits. While applicable windows are blocked, eligible requests may use the configured API route. Once every applicable window expires, the next real request leases one subscription recovery probe. Missing reset times use a bounded five-to-thirty-minute cooldown. There are no background paid probes. A successful old probe cannot clear a newer quota rejection.

Each API request keeps the selected model and complete prepared context. Model capability, input tokens, reserved output and UTF-8 body size are checked before inference. There is no automatic downgrade, history truncation, context-window reduction or recursive paid compaction retry. Codex still executes tools; the API returns a validated decision and does not execute tools itself.

The API request uses native JSON structured output (`output_config.format` with `type: "json_schema"`) for one decision object, with no native tools or tool choice. Fable 5.1 does not support forced tool choice, and automatic choice can end with plain text instead of a wrapper tool call; that broke final answers after successful tool steps. JSON output keeps final answers inside the same decision format. Preflight still requires advertised structured output support, and the selected reasoning effort and adaptive thinking are preserved. Token counting includes the same output schema; only the inference cache policy is omitted.

That decision can still contain multiple Codex tool calls, so this does not reduce Codex tool or subagent concurrency. On the API route, function argument objects are encoded as JSON strings and parsed locally back into complete objects; custom tool code or text stays unchanged. The subscription route keeps its existing argument format. Closed `anyOf` object branches pair each tool kind with only the offered names of that kind, including tools discovered through `tool_search`. Empty tool lists retain the empty-calls instruction without an empty enum. Function input must be a JSON object encoded as a string (`"{}"` when no arguments are needed); custom input stays raw text. [Anthropic’s schema limitations](https://platform.claude.com/docs/en/build-with-claude/structured-outputs#json-schema-limitations) support `anyOf` and string enums, including single-value enums; `maxItems` is unsupported, so count limits remain local. Local validation still checks exact offered tool names and kinds, function arguments, the 16-call limit, tool choice and parallel-call restrictions. Unexpected native tool blocks, malformed JSON and invalid decisions are rejected. Only a complete stream ending with `end_turn` can succeed; `stop_sequence` is rejected because no stop sequences are requested. Truncation and refusal never produce a partial decision.

Each logical step gets at most one paid attempt. A repeated paid step is refused, including after a reconnect; the guard does not replay a saved result. Ambiguous delivery cannot silently regenerate a billable answer. API failures are not automatically retried. Parent steps, child steps and compaction each count toward the same ledger.

Codex itself may reconnect after a failed stream. A local fake-server check on Codex 0.163.0-alpha.10.2 observed the initial request plus three reconnects for both ordinary requests and compaction. The paid-step guard allowed only one simulated generation, and the client then stopped. This verifies duplicate protection, not saved-answer delivery after a disconnect.

## Diagnosing an interrupted API response

Private API receipts live in `<TARGET_HOME>/claude-models/api/receipts/`. Look for the first failure before any `api_duplicate_step` receipts: the duplicate message explains why a retry was blocked, not why the first attempt failed.

Failed requests retain validated request/message identifiers and model identity when available, plus allowlisted diagnostic reasons, stream event metadata, `stream_stop_reason` (known Anthropic values only) and `decision_text_blocks` (an integer from 0 to 1024, serialized as text). For local contract failures, `decision_rule` is one of `unknown_tool`, `invalid_arguments`, `invalid_decision`, `tool_choice`, `parallel_calls` or `empty_decision`; `decision_calls` records a nonnegative integer count when a calls array is available. `decision_tool_kind` is `function` or `custom`, when available, and `decision_tool` is included only for a key actually offered in this request and matching the bounded key charset (1–256 ASCII letters, digits, `_`, `.` or `-`). Counts are serialized as text. These fields contain no prompt, response text, tool arguments, thinking content or credentials. A missing identifier means it was unavailable or invalid; it does not establish whether Anthropic processed or billed the request. Diagnostics do not settle unknown costs or release a claimed paid step.

An `api_invalid_stream` code alone is not enough to diagnose a network problem. The diagnostic reason distinguishes invalid event JSON, an unexpected event sequence, unavailable native tool use (`unexpected_tool_use`), invalid UTF-8 and a body-read failure. Decision failures distinguish absent or empty text (`missing_decision_text`), an unexpected completion reason (`unexpected_stop_reason`), malformed JSON (`invalid_decision_json`) and a failed local tool contract (`invalid_decision`). Receipts created before this diagnostic update do not gain these fields retroactively. Do not delete a paid-step claim or replay an uncertain request to investigate it.

## Budget accounting

Before sending, the router reserves estimated prepared-input cost plus the maximum output allowance at its configured verified model rates. With five-minute caching enabled, the conservative reservation includes the cold cache-write rate. Concurrent requests and different keys/accounts share the same private ledger under this Codex home.

Trusted returned usage can settle the estimate and release the difference. An overrun is recorded even if it exceeds the reservation. An unknown outcome after sending, including cancellation or a broken stream, keeps the full reservation indefinitely. Unknown liabilities remain in the daily exposure after midnight and restart; confirmed settled costs remain on their reservation day. Daily accounting uses Australia/Melbourne. Key rotation, disabling, installation and midnight do not reset cumulative spend. Do not delete the ledger to clear a blocked budget.

All displayed costs are local estimates based on token usage and configured rates, not Anthropic invoices or live remaining-credit balances. Budget reservation controls estimated exposure; it cannot guarantee an exact provider charge.

## Five-minute prompt caching

`--cache 5m` permits reuse of an eligible identical prompt prefix. Repeated calls can reduce input cost when Anthropic reports a cache hit. A cold cache write costs **1.25× the ordinary input rate** for the cached portion; cache reads use the configured model's cache-read rate. A hit is not guaranteed: minimum prefix lengths, changes to tools or earlier content, and expiry after the five-minute reuse window can cause misses and new writes.

Caching does not reduce the context sent, the model's context accounting or its context-window requirement. The complete request still has to fit. `--cache off` disables these explicit cache writes and their cold-write reservation premium.

## Verification boundary

The initial local live API checks used a **US$1 cumulative** test budget. That was a local test authorization, not a shipped budget or an automatic enable setting. On 2026-10-18, local real API text and tool-decision checks passed, as did a forced quota event into the real API runner and a real five-minute cache check. The quota trigger in those checks was synthetic. On 2026-10-22, local production receipts recorded an actual subscription quota rejection followed by API fallback: one Fable request failed stream validation, its three reconnects were blocked before inference, and a subsequent Opus compaction completed through the API. This establishes that routing occurred, not successful delivery of the failed Fable turn. Actual quota-reset recovery remains unverified.

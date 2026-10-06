# Claude as a native Codex model (local adaptation)

[中文](README.zh-CN.md)

The goal: Claude makes the decisions, Codex runs the tools, and the real tool calls show up in the main chat. A local router and SDK process sit in between, but the work stays in the main chat: Codex executes the tools and shows the real calls, with no side panel.

**Status: local and unreleased.** Enabled on this machine, with the user confirming calls work. The first 2026-10-06 repair corrected Sonnet's context budget. The follow-up usage-accounting fix is now installed: 161 tests passed, and a real Codex app-server ran three continuous Claude turns with six native file reads and zero automatic compactions. Its reported context and cache counters matched the new receipts. This follow-up check was headless; the earlier acceptance notes below predate global activation.

This is a local adaptation of [Reidond/codex-claude-models-plugin](https://github.com/Reidond/codex-claude-models-plugin) at commit `dd91e36f30bf5682eb78316f3ed3b0de29d12015` (MIT, Copyright (c) 2026 Andrii Shafar, see [LICENSE](LICENSE)). It is not an upstream release, and cloning upstream `main` will not give you these changes.

More detail: [ADAPTATION.md](ADAPTATION.md) (changes, config diff, rollback). The old [VERIFICATION.md](VERIFICATION.md) is upstream's September 2026 record on Codex 0.154. It stays as history and is not our acceptance.

## 2026-10-06: repeated compaction on short chats

There were two separate problems. The budget repair below passed three short-message turns, but a later tool-using chat still compacted three times. `result.modelUsage` adds up all requests inside the SDK query, including repeated main-model requests and auxiliary calls. Returning it as one context estimate can turn a 469k input into a 938k reported input.

The runner now enables partial SDK events and returns usage from the latest completed primary-model response. It replaces cumulative `message_delta` counters instead of adding them, waits for `message_stop`, and includes cache tokens. Missing or unfinished per-request usage rejects the response as `missing_context_usage`; it never substitutes query totals or a made-up small count. The receipt keeps aggregate `usage` with `usage_scope: "query_pipeline_total"` and separately records `context_usage`. Normal threshold-based compaction remains enabled. See the official [SDK usage guide](https://code.claude.com/docs/en/agent-sdk/cost-tracking) for the distinction between placeholder assistant counters and final stream counters.

The pinned SDK's per-iteration counters carry no separate model name. They inherit the model already verified on the enclosing primary stream; an explicit conflicting model is rejected. The regression fixtures cover this observed event shape, including cached input.

The following results are the earlier budget repair's evidence, not acceptance of the follow-up fix:

A fresh chat can already carry a large tool description. With this machine's full tool catalog, one real input measured about 391k tokens and later short turns about 480k. The old catalog triggered compaction at 96k. Shortening chat history left the tool prefix in the next request, so the cycle repeated.

Discovery retains the SDK's canonical model resolution. When `sonnet` resolves to `claude-sonnet-5-5`, the catalog uses the 1M window reported by the actual final SDK result, a 750k compaction trigger and a 900k effective window. The same capacity has not been verified for other models; they keep the original budget. This result does not cover every Claude model.

Three real Sonnet turns with the full tool catalog passed without compaction and preserved an earlier marker. All 139 unit/integration tests passed. With deterministic usage and the real Codex consumer, the old catalog compacted twice over three turns; the corrected catalog compacted zero times, and 760k usage still triggered one compaction. These are backend checks, not desktop acceptance after reloading.

Reload Codex after updating an installed catalog so it reads the new budget. Chat history can stay. Existing history, request-size and step-timeout limits still apply.

## What has actually been checked (earlier record)

2026-10-06, macOS arm64, Codex 0.160.0, official Claude Code 2.1.285, Agent SDK 0.3.270.

Real Claude subscription, headless Codex app-server, throwaway home, small cases:

- Read a fixture, then change it and read it back, over two turns in one Codex thread. Real tool events, real output, the file checked on disk, and the first turn's nonce came back in the second.
- Interrupt mid-request: turn interrupted, request aborted, no stray child processes.
- One 18,711-character history prompt that asks for an early fact. It's a finite text, not a token measurement or a limit test.
- Manual compaction on a small chat, then recalling the early fact. It goes through `/responses`, not remote `/responses/compact`. It is not an overflow or auto-compaction test.

GPT: the original login-proxy path worked against real default GPT (one small request). A mock GPT → Claude → GPT switch also passes on 0.160 (deterministic providers, no model calls).

Not checked:

- The desktop GUI main chat.
- Real mixed GPT/Claude subagents on this build. The upstream record is not ours.
- The read-only sandbox with live Claude. In that run the model refused without trying a tool, so it proves nothing about the sandbox. A mock run did show the real sandbox denying a write.
- Context overflow, Linux, and any speed comparison.

## What you need

- Node.js 22+ (we used 24.19.0) and npm.
- The Codex CLI you actually use, by absolute path.
- The official Claude CLI, and your own claude.ai Pro or Max login. API-key and Console routes aren't supported.
- macOS. Only macOS has been accepted so far; Linux and Windows are untested, even though the config text looks generic.

## Build and try it in an isolated home

Run from this checkout. Don't point it at `~/.codex`.

```sh
npm ci --ignore-scripts
npm run build
```

The lockfile still carries a 0.154 Codex dev dependency. For real runs point `CODEX_BIN` at the Codex CLI you actually use (we used the desktop app's 0.160).

Log in the normal way, in your own terminal: `codex login` and `claude auth login`. Nothing here reads or copies credentials.

**1. Write the policy file first.** Nothing runs on the Claude route without it.

```sh
ISOLATED_HOME="$HOME/codex-claude-native-test"
CLAUDE_CLI="/absolute/path/to/official/claude"      # a real file, not a symlink
REAL_CODEX="/absolute/path/to/your/codex"

mkdir -p "$ISOLATED_HOME/claude-models" && chmod 700 "$ISOLATED_HOME" "$ISOLATED_HOME/claude-models"
cp runtime-policy.example.json "$ISOLATED_HOME/claude-models/runtime-policy.json"
chmod 600 "$ISOLATED_HOME/claude-models/runtime-policy.json"
"$CLAUDE_CLI" --version
shasum -a 256 "$CLAUDE_CLI"
```

Edit the copy: `claude_path`, `claude_version` and `claude_sha256` from the commands above, then `"subscription_usage_credits_disabled": true` and `"usage_credits_confirmation": {"source": "user", "date": "YYYY-MM-DD"}`. Set those only after you checked in your own account that extra usage is off. That is your recorded statement, not a live billing check, and nothing defaults it to true. The example ships as `false`/`unconfirmed` and will not load until you change it.

**2. Install into the isolated home**, on a port that isn't your existing install's:

```sh
CODEX_BIN="$REAL_CODEX" node plugins/codex-claude-models/bin/setup.mjs install --codex-home "$ISOLATED_HOME" --port 47900
CODEX_BIN="$REAL_CODEX" node plugins/codex-claude-models/bin/setup.mjs doctor --codex-home "$ISOLATED_HOME"
```

**3. Optional: run one real case.** With no arguments the harness only prints usage. `--live` makes real requests on your Claude subscription, one case per run, in its own temporary Codex home that it deletes afterwards:

```sh
CODEX_BIN="$REAL_CODEX" ./node_modules/.bin/tsx scripts/native-acceptance.ts
CODEX_BIN="$REAL_CODEX" ./node_modules/.bin/tsx scripts/native-acceptance.ts --live --codex-home "$ISOLATED_HOME" --report "$HOME/native-report.json" --case readwrite
```

Cases: `readwrite`, `cancel`, `readonly`, `compact`, `history`. The report is mode 600 and holds metadata only. It always says the GUI is unverified.

## Turning it on globally (installation steps)

Do this only after you've read the concrete config diff and rollback steps in [ADAPTATION.md](ADAPTATION.md):

1. `install`, then `activate-router`, against your real Codex home. It trusts only its own startup hook, by exact hash.
2. Restart Codex once and start a new chat. Old chats are not migrated; selecting Claude in one doesn't reroute it.
3. Your GPT default stays as it was. `deactivate` and `uninstall` undo the owned changes.

## What to expect

- Claude's decision is buffered until it's complete. You see Codex's own events when Codex runs a tool. You don't see Claude's hidden thinking or every internal step.
- Text only. Images, audio, Codex output-schema mode, server-stored response IDs and unknown history item types fail with a clear error.
- Each step is a fresh SDK query. Continuity comes from Codex's chat history. The SDK session ID of a step is not the Codex thread ID.
- The final SDK usage for a step can list both Sonnet and Haiku. We haven't established why the CLI uses Haiku, so don't read a run as pure Sonnet. We also can't say what else it costs, and make no promise of no extra usage.
- No adapter-level retries and no API fallback. A cancel and a refusal are recorded as different things.
- The guard refuses to run, naming the variable or file, if it finds API-key or route overrides: `ANTHROPIC_*`, OpenAI key or URL variables, helper settings in Claude's settings files, or an Anthropic profile.
- Each inference attempt writes a private receipt in `<home>/claude-models/receipts` (mode 600). Model names and the session ID come only from the final result, never from the alias or the model's own claim. Cancelled and blocked attempts get receipts too, with nothing filled in.

## Account terms

As checked on 2026-10-06, the [Agent SDK plan article](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) opens with a June 15 notice that the billing change is paused, and we don't treat its older tables as current policy. The [SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) says third-party products may not offer claude.ai login or its limits without approval. The MIT license covers the code, not your account terms; working technically is not approval, and this is not legal advice.

## Development

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run build
```

`npm run test:codex` uses deterministic providers. It checks native tool execution and switching, not live model behaviour or the desktop UI.

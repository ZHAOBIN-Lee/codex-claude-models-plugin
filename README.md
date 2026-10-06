# Claude as a native Codex model

[中文](README.zh-CN.md)

Pick Claude in the normal Codex model picker, next to GPT. Claude makes the decisions, Codex runs the tools, and the real tool calls show up in the main chat. A local router sends GPT requests to OpenAI with your existing Codex login and Claude requests to the Claude Agent SDK with your own Claude subscription login.

**Status: 0.3.0, public preview.** The maintainer uses it daily on macOS. It has only been tested on that machine; see [What has been checked](#what-has-been-checked).

## Based on upstream

This is a modified version of [Reidond/codex-claude-models-plugin](https://github.com/Reidond/codex-claude-models-plugin) by Andrii Shafar, starting from commit `dd91e36f30bf5682eb78316f3ed3b0de29d12015` (MIT). The local router, the request adapter, GPT forwarding, the combined model picker and the setup flow come from upstream. Both copyright notices are in [LICENSE](LICENSE). It is not an upstream release, and upstream `main` does not contain these changes. [VERIFICATION.md](VERIFICATION.md) is upstream's September 2026 record on Codex 0.154, kept as history.

## What this version adds

- **Context and compaction.** Codex receives the usage of the latest completed main-model request, not the SDK's accumulated total, which had made short chats compact after every step. Each Claude model gets its measured window (1M or 200k); an unverified model or a `[1m]` suffix falls back to 200k. Connector and MCP tools are deferred behind `tool_search`, which cut a typical step from about 480k to 40-70k input tokens.
- **Switching to GPT.** When you switch to a model with a smaller window, Codex first asks the previous model to compact, so Claude writes the summary and GPT receives it. Claude keeps its 750k trigger. Compaction requests are recognised and get a longer limit and one retry.
- **Long steps.** A step fails only after 180 s without model activity (300 s for compaction) or at a 15 minute cap. Heartbeats are real SSE events, so Codex's idle timer does not cut off a slow step.
- **Robustness.** A malformed decision or a stream without verifiable usage is retried once. Images in the current turn are passed to Claude. Replies follow the language of the user's own words, not the English context Codex wraps around them.
- **Guard rails.** Claude runs only through a pinned official CLI (path, version and SHA-256), with a subscription login and no API fallback. Every attempt writes a private receipt with the actual model and session.
- **Install.** Transactional install and rollback, `NPM_BIN` for machines without npm on `PATH`, and scripts that move one or all existing chats to the router, with backup and rollback ([MIGRATION.md](MIGRATION.md)).

Details, config diff and rollback: [ADAPTATION.md](ADAPTATION.md).

## What has been checked

2026-10-06 and 07, macOS arm64, Codex 0.160.1, official Claude Code 2.1.285, Agent SDK 0.3.270, Node 24.

- 195 unit and integration tests (`npm test`).
- Real Claude subscription through headless `codex exec`:
  - A forced compaction: Sonnet summarised 423,417 tokens in 7.7 s and the chat recalled earlier output afterwards.
  - Claude to GPT in one chat, with GPT's window lowered to 40k in a temporary catalog: Sonnet compacted first, then GPT answered from the earlier history.
  - Mixed sub-agents, one shell command each: a Claude chat spawned a GPT sub-agent, and a GPT chat spawned `claude_sonnet`.
- Daily use in the desktop app. This is the maintainer's own use, not a formal acceptance.
- Batch migration on the maintainer's real Codex home: 4,025 `openai` chats (including archived chats and sub-agent sessions) moved in one run, 4 sampled chats cold-resumed through the real Codex, and a previously failing old chat then answered with Claude in the desktop app. Two earlier attempts failed on sampling and reverted themselves; both causes are fixed and covered by tests.

Not checked:

- Linux and Windows.
- Compaction near the 750k trigger; its time is extrapolated from the runs above.
- The retry and long-heartbeat paths in real use (unit tests only).
- Larger mixed sub-agent workflows, and the read-only sandbox with live Claude.

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
2. Restart Codex once and start a new chat. Old chats keep their original provider, and picking Claude in them fails with "not supported when using Codex with a ChatGPT account". To move them, see [MIGRATION.md](MIGRATION.md).
3. Your GPT default stays as it was. `deactivate` and `uninstall` undo the owned changes.

## What to expect

- Claude's decision is buffered until it is complete. You see Codex's own events when Codex runs a tool, not Claude's hidden thinking or every internal step.
- Text, and images in the current turn. Older images become placeholders. Audio, Codex output-schema mode and server-stored response IDs fail with a clear error.
- Each step is a fresh SDK query. Continuity comes from Codex's chat history; the SDK session ID of a step is not the Codex thread ID.
- The final SDK usage for a step can list both the chosen model and Haiku. We haven't established why the CLI uses Haiku, and make no promise about extra usage.
- Retries are limited to the cases above. There is no API fallback, and a cancel and a refusal are recorded as different things.
- The guard refuses to run, naming the variable or file, if it finds API-key or route overrides: `ANTHROPIC_*`, OpenAI key or URL variables, helper settings in Claude's settings files, or an Anthropic profile.
- Each inference attempt writes a private receipt in `<home>/claude-models/receipts` (mode 600). Model names and the session ID come only from the final result, never from the alias or the model's own claim.

## Account terms

As checked on 2026-10-06, the [Agent SDK plan article](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) opens with a June 15 notice that the billing change is paused, and we don't treat its older tables as current policy. The [SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) says third-party products may not offer claude.ai login or its limits without approval. The MIT license covers the code, not your account terms; working technically is not approval, and this is not legal advice.

## Development

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run build
```

If npm is not on your `PATH`, set `NPM_BIN` to an npm executable or `npm-cli.js` before `install`.

`npm run test:codex` uses deterministic providers. It checks native tool execution and switching, not live model behaviour or the desktop UI.

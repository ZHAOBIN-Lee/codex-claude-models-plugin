# Claude models for Codex

A **Codex plugin** that runs Claude through the official [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview), using your existing local Claude subscription login. Claude can drive a Codex task or run as a native Codex subagent. Codex executes the tools and retains its permissions and approvals.

**Experimental, v0.1.0.** Model availability is discovered from your SDK account during setup, rather than hard-coded to a particular Claude generation.

## What appears in Codex

| Use | How |
| --- | --- |
| Claude in the CLI model picker | `codex --profile claude`, then `/model` |
| Claude in the desktop model picker | Run `activate`, restart Codex, then choose a Claude model for a new task |
| Claude subagents within a Claude main task | Ask for a registered role such as `claude_sonnet`, `claude_opus` or `claude_haiku` |
| Return to your previous main-task provider | Run `deactivate`, then restart Codex |

**Codex currently selects one provider for a task.** Its catalog entries do not carry a per-model provider. This plugin supplies a Claude provider mode and catalog; it does **not** add Claude beside OpenAI models in one automatically routed dropdown. Switching back restores your previous catalog.

**Native subagents inherit the parent's provider.** Codex 0.154.0 and the tested desktop build ignore `model_provider` in custom-agent files. Claude → Claude subagents are supported; OpenAI → Claude native subagents are not. Fixing mixed-provider native delegation requires a Codex change, beyond a plugin. The [Codex role implementation](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/core/src/agent/role.rs) defines the actual override subset; putting an unsupported field in TOML does not enable it.

The plugin does not modify Codex application binaries or intercept OpenAI authentication.

## Install

Requirements: macOS or Linux, Node.js 22+, npm, Codex CLI 0.154.0 or compatible desktop Codex, and an authenticated Claude subscription account. The CLI profile syntax below targets Codex 0.154.0.

Authenticate through Claude's own CLI:

```sh
claude auth login
```

Add the repository as a Codex marketplace and install its plugin:

```sh
codex plugin marketplace add https://github.com/Reidond/codex-claude-models-plugin.git
codex plugin add codex-claude-models@personal
```

This repository uses the scaffold's `personal` marketplace name. If you already have a different marketplace with that name, use the clone-based setup below instead of replacing your marketplace.

In a fresh Codex task, ask:

```text
Use $claude-models to set up Claude models and subagents.
```

The skill runs the setup bundle from the installed plugin. You can also run it yourself using the plugin path shown by `codex plugin list`:

```sh
node /path/to/codex-claude-models/bin/setup.mjs install
node /path/to/codex-claude-models/bin/setup.mjs doctor
```

Or set up from a clone without adding a marketplace:

```sh
git clone https://github.com/Reidond/codex-claude-models-plugin.git
cd codex-claude-models-plugin
node plugins/codex-claude-models/bin/setup.mjs install
```

The committed adapter bundles do not need a source build. Setup installs the pinned Agent SDK dependency in private local runtime storage using `npm ci`, discovers available models, and adds provider configuration, a CLI profile, and native custom-agent files. It leaves your main-task provider unchanged until you activate Claude.

## Main tasks and subagents

CLI:

```sh
codex --profile claude
# An explicit discovered model can also be selected:
codex --profile claude --model claude-sdk-sonnet
```

Desktop:

```sh
node /path/to/codex-claude-models/bin/setup.mjs activate --model sonnet
```

Restart Codex and start a new task. Its picker uses the Claude catalog. Existing tasks may retain their previous provider; restart/new-task is the reliable reload boundary. The adapter uses a conservative 128K input budget, even when the SDK's model label advertises a larger context window.

For native delegation, start a main task with the Claude profile or activated Claude provider, then ask:

```text
Use claude_sonnet to review the authentication changes. Give it a bounded task and compare its findings with yours.
```

The available roles depend on the discovered models; `doctor` lists model IDs, and installed role files are under `$CODEX_HOME/agents/`. No background Claude filesystem agent is hidden behind a text answer: Claude returns tool requests that Codex executes and displays.

## Authentication and subscription limits

The Agent SDK reads your own existing Claude login. Every model step checks for a first-party subscription account **before releasing the prompt for inference**. The bridge removes API-key, bearer-token and cloud-provider overrides from its child environment. It never extracts OAuth credentials, offers a replacement login flow, or falls back to paid API keys.

Anthropic's [June 15 update](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) says its proposed billing change is paused and Agent SDK, `claude -p`, and third-party usage still draw from subscription limits. However, the [SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) separately says third-party developers need approval to offer claude.ai login/rate limits for their products. These are distinct, partly conflicting notices, checked September 14, 2026. Technical compatibility is not Anthropic approval; this project claims none. Check the current terms before distributing a product or relying on a particular billing arrangement.

Ordinary subscription limits and any extra-usage settings on your Claude account still apply. The plugin does not alter them. Do not expose the local bridge as a shared subscription service.

## Architecture and limits

```text
Codex model picker / native custom agent
  -> authenticated loopback Responses adapter
  -> Claude Agent SDK, using the local Claude login
  -> structured text + Codex tool-call decision
  -> Codex executes tools under its own permissions
  -> next model step receives the tool results
```

The adapter asks the SDK for a JSON structured decision rather than emulating Anthropic's private API. SDK execution tools are disabled (`tools: []`), local settings and MCP configuration are isolated, and a hook denies tools other than the SDK's internal structured-output tool. Conversation instructions, roles and tool results are retained. The SDK cannot independently run shell/file/MCP/subagent tools around Codex's approvals.

Current limits:

- Text input, function calls and custom/freeform tool calls are supported. Images, audio, remote compaction, Codex output-schema mode and server-stored response IDs are rejected.
- A model step is buffered until its structured decision is complete, then emitted as Responses SSE. It is not token-by-token Claude streaming and has more latency than a direct model API.
- Codex's built-in server-side web search is disabled in the Claude profile and activated mode. Subagents inherit that setting. Compatible function-based tools remain available.
- The service binds only to `127.0.0.1`, requires a random local bearer token, rejects browser Origin headers, caps requests at 8 MiB and 6 concurrent steps, and aborts each step after 180 seconds or client disconnection. It performs no adapter-level retries.
- Unsupported protocol features fail explicitly. New Codex or SDK releases may require compatibility changes.

## Configuration, upgrades and removal

Private state is stored in `$CODEX_HOME/claude-models` (normally `~/.codex/claude-models`). The local bearer token only authenticates the loopback bridge; it is not a Claude credential. The provider's token command starts the bridge on demand, so no login-item or session hook is required.

All setup commands accept `--codex-home PATH`. `install` accepts `--port PORT` (default `47832`). Run upgrades from the latest plugin's `bin/setup.mjs`, not the copied internal helper.

```sh
node /path/to/codex-claude-models/bin/setup.mjs install    # refresh dependencies and models
node /path/to/codex-claude-models/bin/setup.mjs doctor
node /path/to/codex-claude-models/bin/setup.mjs stop
node /path/to/codex-claude-models/bin/setup.mjs start
node /path/to/codex-claude-models/bin/setup.mjs deactivate
node /path/to/codex-claude-models/bin/setup.mjs uninstall
codex plugin remove codex-claude-models@personal
```

Config changes preserve parsed TOML values and create exact byte backups; formatting and comments can change in the active file. Activation journals the previous model, provider, catalog, web-search and default-subagent-model settings. Deactivation restores those values while preserving unrelated changes. Edited generated files or provider conflicts are rejected. Uninstall stops the bridge and removes only its unchanged generated configuration and agent files. It retains private runtime files and backups for recovery.

## Development and verification

```sh
npm ci
npm run check
npm run test:codex
```

Tests exercise HTTP authentication, cancellation/timeouts, invalid structured output, configuration lifecycle and real Codex protocol consumption. `test:codex` starts a real pinned Codex app-server, checks `model/list`, and runs a Codex file-read tool round trip against a deterministic provider fixture. It does not require either subscription or make model API requests. Live Claude checks are separate and are recorded in [VERIFICATION.md](VERIFICATION.md).

CI runs on macOS and Linux and verifies that committed plugin bundles reproduce from source. This repository's adapter code is MIT licensed. The Agent SDK is downloaded separately and remains subject to Anthropic's own license and terms.

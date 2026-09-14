---
name: claude-models
description: Set up, select, diagnose, or remove Claude models and Claude subagents in Codex through the Claude Agent SDK. Use when the user asks to use Claude inside Codex or configure this plugin.
---

# Claude models in Codex

This is a Codex plugin. Run its setup bundle at `../../bin/setup.mjs` relative to this skill directory, resolving the absolute path before invoking Node.

For first-time setup, run `node /absolute/plugin/bin/setup.mjs install`, then `doctor`. The installer uses the official Agent SDK with the user's existing local Claude subscription login. If authentication is missing, have the user run `claude auth login` interactively; never read, copy or print Claude tokens.

Installation adds a `claude` CLI profile and discovered named agents including `claude_opus`, `claude_sonnet` and `claude_haiku` where available. Read `doctor` output for current model IDs. Use `codex --profile claude` for CLI main tasks. For requested Claude delegation, use a native custom agent by its registered role only when the parent already uses the Claude provider. Codex 0.154.0 ignores provider overrides in agent files, so OpenAI-to-Claude native delegation is unavailable. Scope the delegated task and preserve the parent's execution permissions. If the role is not visible yet, start a fresh task.

For a Claude model picker in the desktop app, run `activate` (optionally `--model sonnet`), then restart Codex. Explain that Codex currently chooses one provider per task: this selects the Claude catalog for main tasks, and does not create a mixed OpenAI/Claude dropdown. `deactivate` restores the previous provider and catalog. Do not silently activate when the user requested only subagents.

Commands: `install`, `doctor`, `activate`, `deactivate`, `start`, `stop`, `uninstall`. All accept `--codex-home PATH` when the user uses a custom Codex home. Run upgrades from the plugin bundle, not the internal copied setup file.

Codex executes all tools; the SDK returns structured decisions with its own execution tools disabled. This release supports text and Codex function/custom tools. Built-in web search is disabled in Claude mode; images, audio and true token-by-token streaming are unsupported. Never present a synthetic test as live Claude evidence.

Uninstall the generated provider/agents with `uninstall` before removing the plugin. Configuration backups and the private dependency cache are retained. Report edited-file conflicts without overwriting them.

Anthropic's subscription availability and third-party integration rules can change. See the repository README's authentication section; this plugin does not assert Anthropic approval or bypass login or usage limits.

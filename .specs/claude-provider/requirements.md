# Claude in Codex

The user requested a public Codex plugin that uses their Claude subscription through the Claude Agent SDK for main tasks and subagents. This is a new capability, not a measured production incident.

Actors: a local Codex CLI or desktop user; Codex's model provider client; the local adapter; the user's authenticated Claude Agent SDK.

## Acceptance

- AC-1: Given an authenticated SDK, installing discovers its models and creates a Codex catalog and named subagents. Reinstall preserves unrelated Codex settings; conflicting owned files are rejected.
- AC-2: Given an active Claude provider, Codex's model/list includes the discovered Claude models. A selected Claude model answers a real turn. Unsupported models fail explicitly.
- AC-3: Given Codex tool definitions, Claude may return a call to an advertised function or custom tool. Codex executes it and returns the result on the next request. The SDK cannot independently execute filesystem, shell, MCP or subagent tools. Unknown tool calls fail.
- AC-4: Given a Claude main task, a named Claude subagent uses the inherited provider and returns a result to Codex. OpenAI-to-Claude native delegation is unavailable in Codex 0.154.0: its role override implementation ignores model_provider. This was verified against source and both installed binaries; a plugin cannot supply that missing native capability.
- AC-5: Given unauthenticated, oversized, malformed, disconnected, timed-out or concurrent requests, reject or terminate them without executing tools or exposing credentials. Failed SDK runs must not become successful assistant answers.
- AC-6: Given an activated configuration, deactivation restores the prior model/provider/catalog values while preserving subsequent unrelated changes. Uninstall removes only unchanged files owned by the installer, and creates configuration backups.
- AC-7: The repository is public on the user's GitHub and includes installation instructions, license, reproducible dependencies, tests and a portable plugin package.

## Verified constraints

Codex 0.154.0 has model_catalog_json and custom Responses providers. Its model/list schema contains no per-model provider selector. Therefore main-task selection is a Claude provider mode, not a mixed OpenAI/Claude dropdown. A plugin cannot add that missing routing field to Codex's UI.

The Agent SDK 0.3.270 supports query(), supportedModels(), accountInfo(), tools: [], settingSources: [], strictMcpConfig, persistSession: false, abortController and JSON structured output. Subscription authentication uses the SDK's own cached login. No OAuth token extraction, API emulation against Anthropic, or automatic API-key fallback is in scope.

Text input and Codex function/custom tool output are in scope. Images, audio, encrypted reasoning, server-side previous_response_id storage, token streaming before a structured decision finishes, and remote hosting are not supported in this release. Unknown input kinds fail rather than silently losing content.

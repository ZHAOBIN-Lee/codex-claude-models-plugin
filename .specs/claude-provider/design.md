# Design

TypeScript, Node 22+, official Claude Agent SDK, Zod validation and TOML parsing. The plugin bundles first-party adapter code; setup installs the pinned SDK in private local runtime storage rather than redistributing Anthropic binaries.

The HTTP service listens on 127.0.0.1, requires a random local bearer token, rejects browser Origin headers, limits body size and concurrency, sends SSE keepalives and aborts the SDK on timeout/disconnection. It logs no request bodies. Stateless full-history requests prevent concurrent workspace/session contamination.

For each Responses request, preserve instructions and role-labelled history, describe the offered Codex tools, and request a structured decision with text and zero or more function/custom tool calls. tools: [] and isolated SDK settings disable the SDK's own execution facilities. StructuredOutput is the only internal SDK tool permitted. Codex remains responsible for execution and approvals. This approach costs a new SDK query per model step; low latency is not claimed.

Return normal Responses SSE message/tool items, completion and real token usage. Validate every output tool against the advertised definitions. Reject unsupported request features, invalid structured output, failures, unsupported models, or incomplete SDK runs. No adapter retries; Codex transport retries are disabled for this provider.

Installation creates a private state directory, token, SDK runtime, catalog, Claude CLI profile and global custom agent TOMLs. Provider auth uses a local command which ensures the bridge is running and prints only the local bridge token. It never prints a Claude credential. No session hook is needed because workspace operations execute in Codex.

Activation edits model, model_provider, model_catalog_json, web_search and agents.default_subagent_model in Codex config. Parsing/stringification preserves semantic values, with an exact byte backup before each change. Keep a journal of previous values and generated file contents. Reject edits to owned values/files rather than clobbering them. Serialize installs with an exclusive lock. Deactivate restores owned values; uninstall compares file contents before deletion. All metadata and runtime paths stay outside the public source.

Runtime verification narrowed native subagents to Claude-parent tasks. The role override code filters out model_provider, catalog and web_search, so generated roles contain only supported model/instruction overrides. The CLI profile and activated root config select the provider and disable unsupported built-in server-side web search. Inter-agent records use Codex's agent_message type and retain author/recipient/content.

High risks: protocol drift and execution-boundary regression. Mitigations: real Codex client integration tests plus no SDK tools. Medium risks: latency, subscription availability, provider-mode UI limitations and config edits. Mitigations: live smoke, current documentation, explicit UI limitation and backups/journal.

Source files: contracts.ts, adapter.ts, sdk.ts, server.ts, catalog.ts, setup.ts, setup-main.ts and bridge-main.ts. Build and integration scripts, test files, plugin skill/manifest, README and CI accompany them.

Review resolved: a provider definition alone does not add picker entries; catalog generation and app-server model/list test required. SDK allowedTools is not a tool allowlist; use tools: [] plus a deny hook. A loopback bind alone is not authentication; use a private token and reject browser origins. No shared cwd or last-session fallback. No claim that subscription use is generally approved for public products; document Anthropic's conflicting notices.

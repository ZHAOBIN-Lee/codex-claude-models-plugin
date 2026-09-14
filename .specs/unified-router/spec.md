# Unified picker and model router

The user wants Claude to remain in the normal Codex picker alongside GPT models. Version 0.1.0 instead required a separate Claude profile. The approved extension is a permanent local provider that routes by the selected model. Existing provider-mode functionality remains available.

## Acceptance and work

- R1: Merge the user's OpenAI model catalog with discovered Claude models, preserving metadata and the selected default except for the shared v1 agent-runtime compatibility setting. Codex CLI and desktop backend model/list must contain both families. Owner: catalog/setup, tested with real Codex.
- R2: Route GPT Responses requests, streams, errors and remote compaction to the fixed official OpenAI endpoint using credentials supplied by Codex's documented requires_openai_auth proxy mode. Never read OpenAI credential files. Owner: upstream/server, tested with an HTTP fixture and live ChatGPT login.
- R3: Route Claude requests through the existing SDK adapter. Never send OpenAI authentication to Anthropic or to any other destination. Claude tools remain executed by Codex. Owner: server/sdk, tested with route isolation and live Claude calls.
- R4: Native GPT-to-Claude and Claude-to-GPT subagents inherit the same router provider and select their model by name. Verify with live file-read delegation, including the actual child's model and tool result. Owner: integration verification.
- R5: Activation preserves the current default GPT model, removes the need for profile switching, starts the bridge at SessionStart, and remains reversible. Upgrade v0.1 state without overwriting unrelated config or files. Owner: setup/hook, covered by filesystem lifecycle and restart tests.
- R6: Publish and reinstall the update, with macOS/Linux CI and current documentation replacing the old blanket limitation. Owner: release.

## Architecture

Keep the legacy Claude-only provider/profile. Add codex_model_router with requires_openai_auth=true and a separate random X-Codex-Router-Token header. The same loopback server accepts legacy local bearer authentication for Claude-only traffic; GPT requires the separate local header plus Codex's OpenAI bearer credentials. This prevents treating the local token as an OpenAI credential.

GPT traffic bypasses the Claude request schema and structured decision logic. Forward request bytes and response streams without rebuilding model/tool data. Allow only documented Responses and compaction paths and fixed HTTPS OpenAI origins; never follow redirects, accept client-provided upstream destinations, log auth, forward local bridge secrets, or forward browser cookies. Preserve status and relevant rate-limit/auth headers so Codex owns refresh/retry behavior. Non-2xx responses remain failures.

The combined catalog uses a configured existing catalog or the user's cached account catalog, with the bundled Codex catalog as a fallback. Include hidden OpenAI rows to preserve internal model dependencies but do not invent access entitlements. Do not change provider-is-OpenAI identity by naming the custom provider OpenAI. Preserve native web search for GPT; omit its server-executed definition from Claude's available tools and explain that limitation in the Claude system prompt. Other unsupported Claude inputs still fail explicitly.

Full-history cross-model conversations may contain opaque OpenAI reasoning. Preserve visible content, never claim to decrypt opaque state. Live testing found v2 inter-agent encryption incompatible with mixed delegation, so the combined catalog pins native v1 for both model families. GPT-to-Sonnet and Sonnet-to-GPT file delegation passed. Haiku's repeated tool-unavailable responses remain an explicit reliability limitation.

Update installer state to own both providers and catalogs. Combined activation journals only changed keys, leaves the selected model intact when recognized, and registers a user-level SessionStart hook. It uses native hooks/list metadata and a version-checked config write to trust only the exact owned source/command. Unsigned plugin hooks are not used, and global trust bypass is never enabled. Exact config backups, edited-file conflicts and token permissions remain in force. Keep previous activation values across upgrades.

## Review and verification

Local proof: Codex 0.154.0 completed a real GPT response through a custom proxy using its existing ChatGPT login, and sent the expected Authorization and ChatGPT-Account-ID headers. No OpenAI secret was printed or stored by the proxy.

Risks: fixed upstream protocol drift; expired auth; SSE cancellation; stale catalogs; runtime startup races; conflicting installation state; opaque cross-model history. HTTP integration tests own forwarding/auth/error/cancellation assertions. Filesystem tests own upgrade/rollback assertions. Real Codex consumer tests own mixed catalog and selection assertions. Live tests own subscription and native cross-model agent claims. Desktop GUI rendering remains a separate visual verification item.

No API key fallback, custom Codex build, app binary patch, remote shared subscription service, or unrelated provider changes. The public feature remains experimental until its live checks pass.

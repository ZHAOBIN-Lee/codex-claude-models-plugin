# Verification record

Local verification date: September 14, 2026. Platform: macOS arm64. Claude Agent SDK: 0.3.270. Codex CLI: 0.154.0. Desktop bundled backend: 0.154.0-alpha.6.2.

## Automated checks

- TypeScript strict typecheck.
- 17 behavioral tests covering message/tool conversion, SDK execution isolation, subscription gating before prompt delivery, invalid/failed results, token accounting, HTTP authentication, browser origins, timeout/disconnect cancellation, request size, concurrency, install/reinstall/deactivate/uninstall and conflicts.
- Real Codex app-server `model/list`: generated catalog is accepted and models are visible.
- Real Codex `exec` with a deterministic provider: a returned function call causes Codex to read a generated fixture; the adapter receives the actual command output and completes the turn. Two model steps are asserted.
- The consumer checks pass with both the standalone CLI and the desktop app's bundled backend.
- Codex plugin-manifest and skill-frontmatter validation.
- Production dependency audit: no known vulnerabilities reported at verification time.

The deterministic tests do not use a Claude account and do not establish model quality or live availability. CI repeats them on Linux and macOS.

## Live subscription checks

The SDK reported a first-party Claude Max login. No token or account identifier is included in this repository.

1. An SDK structured-output request returned the exact requested probe string.
2. A Codex main task using Claude Haiku returned the requested `CODEX_CLAUDE_OK` string.
3. Claude Haiku requested a Codex shell read of a fixture, received its actual contents and answered with them.
4. Claude Sonnet requested Codex's freeform `apply_patch` tool to create a test file, then requested a shell read to verify the exact line. Codex emitted both native file-change and command-execution events.
5. A Claude Sonnet main task spawned one native `claude_haiku` child, waited, and reported the fixture contents returned by the child. The child's own recorded shell result contained the fixture value. The final run completed without a follow-up retry.

These checks verify bounded local tasks, not broad coding accuracy or production readiness. Earlier test attempts revealed SDK schema-version compatibility, Codex inter-agent payload format, and SDK-runtime-directory confusion; the final code and regression coverage address those findings.

## Confirmed host limitations

- Both tested binaries ignore `model_provider` in custom-agent files. An OpenAI parent attempting a native Claude child sends the Claude model name to OpenAI and fails. This feature is not claimed as supported.
- Model catalog entries have no per-model provider route. The plugin supplies a separate Claude mode, not a mixed OpenAI/Claude picker.
- The desktop backend's catalog and tool behavior were verified. The GUI picker itself was not visually verified after an app restart; restarting the user's active desktop app would interrupt the task doing the installation.
- Only Haiku and Sonnet inference were exercised live. Other models were discovered from the SDK and included in the catalog, not live-tested.
- Long conversations, compaction, large-scale parallel use and Windows are outside this release's verification.

## Review and rollback

Reviewed callers: `contracts` feeds `sdk` and `server`; `adapter` feeds `server`; `catalog` feeds SDK discovery and setup; `setup` feeds both entrypoints; committed plugin bundles and the skill call those entrypoints. Consumer tests check configuration-driven calls through real Codex, which a source-reference scan alone cannot prove.

Review corrections include provider-limit documentation, disabling built-in web search in Claude mode, draft-7 structured output, constraining tool names, preserving v2 inter-agent payloads, account gating before prompt delivery, cancellation and owned-file conflict checks. The runtime was restarted after changes before live verification.

`deactivate` restores the journalled settings. `uninstall` preflights generated files before removing them. Exact config backups are retained. Review covered source, tests, plugin packaging and instructions; it did not audit the internals of Codex, Anthropic's binary or every SDK dependency.

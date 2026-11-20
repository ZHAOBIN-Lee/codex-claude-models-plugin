# Claude API Fallback Implementation Plan

> **For agentic workers:** implement assigned modules with focused tests; root integrates and reviews the complete change. The user delegated execution and does not require another approval round.

**Goal:** Add an opt-in, budgeted official Claude API fallback to the subscription router.

**Architecture:** Independent subscription and API runners share Codex preparation/validation. A coordinator owns routing and a durable ledger owns quota windows and paid reservations. API configuration is private and optional.

**Tech Stack:** TypeScript, Node fetch/SSE, node:test, existing Claude Agent SDK, private JSON files with exclusive locks.

**Spec:** ../specs/2026-10-18-api-fallback.md

## Global Constraints
- US$1 cumulative initial test budget; recurring fallback disabled by default.
- No plaintext key in tools/logs/Git; never modify global Claude authentication.
- No paid calls in installation, startup, diagnostics or background timers.
- No change to GPT retry policy or subscription context windows.
- Existing baseline has an unrelated migration compatibility failure on Codex 0.162; report it separately.

## Review Focus
- Completed upstream generation followed by client disconnect: no blind second paid generation.
- Compaction errors: never multiply fallback attempts across existing retry layers.
- Multi-window/global quota combined with account changes: no false recovery.
- Cancelled/unknown paid results: retain budget exposure across restart/day changes.
- Optional API configuration corrupted: subscription-only path remains usable.

## Tasks
- [x] 1. Secure local credential input and non-generating API model/auth check (root).
- [x] 2. `src/subscription-limits.ts`, SDK extraction and tests: structured terminal quota, reset/account identity (worker).
- [x] 3. `src/api-runner.ts` and tests: official transport, capability/token preflight, single streamed decision, complete usage and safe errors (worker).
- [x] 4. `src/fallback-store.ts` and tests: atomic budget reservations, durable quota/probe leases, recovery and strict validation (worker).
- [x] 5. `src/api-settings.ts`, `src/fallback.ts`, bridge/server/setup integration and tests (root). Enforce disabled mode before reading optional secrets or ledger; exclude paid errors from generic retries.
- [x] 6. Independent review, relevant regression and full suite, typecheck and build. Fix new findings. Full suite snapshot: 373/374 passed; the unchanged migration suite fails its current Codex version gate. Isolated rerun: 20/21 migration cases pass. Final coordinator/settings changes: 21/21 pass.
- [x] 7. Real API text/tool/forced-quota smoke within US$1, bilingual documentation, private install after drain and runtime verification.

## Progress / rulings
- Installed on 2026-10-18 with a drained listener, verified bridge/setup hashes and health. Recurring paid fallback remains disabled pending a daily budget. Six real Sonnet 5.5 calls total an estimated US$0.055052; cache read is verified. Quota trigger was synthetic, actual subscription exhaustion/reset recovery and native switch notification remain unverified.
- Independent review fixes: preserve non-null cumulative usage; global inference geography and Haiku tier accounting; serialized disable/send permission; account-bound success evidence; release probes on ordinary failure or cancellation; robust lock handoff and symlink-ancestor refusal.
- User supplied the official prompt-caching guide. Include default 5-minute automatic caching, conservative cold-write reservations and distinct cache counters; no background warming or 1-hour cache in this version.
- User explicitly delegated remaining implementation and tests; use existing checkout with clean baseline and distinct file ownership. No GitHub publish in this turn.
- Credential was entered through macOS hidden input and saved at `~/.codex/claude-models/api/credentials.json` with mode 600. GET models authenticated successfully without inference; the latest Sonnet/Opus/Haiku models report 1M input capability.

# Verification

| ID | Requirement | Technique | Owner | Level | Observable result |
|---|---|---|---|---|---|
| TC-1 | AC-3 | Equivalence classes | T1 | Unit | Function/custom calls preserve names and payloads; unknown tools rejected |
| TC-2 | AC-5 | Boundary values | T1 | HTTP integration | Authentication, body limit, concurrency limit and cancellation enforce the contract |
| TC-3 | AC-3, AC-5 | Failure injection | T1 | Unit | SDK options disable execution, failed/incomplete results fail and usage maps correctly |
| TC-4 | AC-1, AC-6 | State transitions | T2 | Filesystem integration | Install/reinstall/activate/deactivate/uninstall preserve unrelated settings and refuse ownership conflicts |
| TC-5 | AC-1, AC-2 | Consumer contract | T2 | Codex integration | Real app-server accepts generated config and lists nonempty Claude catalog |
| TC-6 | AC-2, AC-3, AC-4 | Live smoke | T3 | End to end | SDK answer, Codex file/tool round trip and named Claude subagent complete |
| TC-7 | AC-7 | Release verification | T3 | Manual | Public GitHub URL, tracked files, plugin install and CI status verified |

No automated latency SLA or cross-platform claim. Windows is outside this initial macOS/Linux release. Main desktop picker is checked on the installed app if its UI is available; SDK inference and CLI proof do not alone establish desktop UI behavior. No destructive or external-write tool calls are used in smoke tests.

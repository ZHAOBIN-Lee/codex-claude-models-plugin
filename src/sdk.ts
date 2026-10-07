import { query, type ModelUsage, type Options, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { BridgeError, isCompactionRequest, outputSchemaFor, preparePrompt, validateDecision, type ImageBlock, type ResponsesRequest, type RunStep, type StepResult, type Usage } from './contracts.js';
import { discoverCatalog, type ClaudeModel } from './catalog.js';
import { VERSION } from './version.js';
import { cancelled, GUARD_COVERAGE, normalizeSubscription, pinnedEnvironment, verifyRuntime, type VerifiedRuntime } from './runtime-policy.js';
import { newRunId, safeCode, summarizeFinal, writeReceipt, type InferenceStage, type Receipt, type ReceiptStatus } from './receipts.js';
import {ContextUsageTracker, type ContextUsage} from './context-usage.js';

export function subscriptionEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result = {...source};
  for (const key of Object.keys(result)) {
    if (/^(ANTHROPIC_|OPENAI_|CODEX_API_KEY$|CHATGPT_ACCESS_TOKEN$|CHATGPT_AUTH_TOKEN$|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH_TOKEN$|CLAUDECODE$|CLAUDE_CODE_SESSION_ID$)/.test(key)) delete result[key];
  }
  result.CLAUDE_AGENT_SDK_CLIENT_APP = `codex-claude-models/${VERSION}`;
  // The pinned executable must stay the one the policy verified; only this child's environment changes.
  return pinnedEnvironment(result);
}

export function isolatedOptions(cwd: string): Options {
  return {
    cwd, env: subscriptionEnvironment(), tools: [], settingSources: [], strictMcpConfig: true,
    mcpServers: {}, plugins: [], persistSession: false, permissionMode: 'dontAsk', permissionPrompts: 'none',
    hooks: {PreToolUse: [{hooks: [async input => {
      if (input.hook_event_name === 'PreToolUse' && input.tool_name === 'StructuredOutput') return {};
      return {hookSpecificOutput: {hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Codex executes all tools.'}};
    }]}]},
  };
}

// Trusted instruction placed ahead of everything Codex supplies. It changes nothing about Codex sandboxing or approvals.
export const NATIVE_PROVIDER_INSTRUCTION = [
  'Native provider mode: you are the model behind a Codex session. You emit Codex tool decisions; Codex alone executes tools under its own sandbox and approvals.',
  'For an ordinary request to use Claude, do the work yourself in this session. Do not invoke the legacy Claude Bridge, a Claude CLI, or another Claude session recursively.',
  'Consult an independent side Claude session only when the user explicitly asks for one.',
].join('\n');

export function usageFromModels(models: Record<string, ModelUsage>): Usage {
  // Aggregate accounting helper. sdkRunner must never return this as current context usage.
  const rows = Object.values(models);
  const input = rows.reduce((sum, m) => sum + m.inputTokens + m.cacheReadInputTokens + m.cacheCreationInputTokens, 0);
  const output = rows.reduce((sum, m) => sum + m.outputTokens, 0);
  return {input_tokens: input, input_tokens_details: {cached_tokens: rows.reduce((sum, m) => sum + m.cacheReadInputTokens, 0)},
    output_tokens: output, output_tokens_details: {reasoning_tokens: rows.reduce((sum, m) => sum + (m.thinkingTokens ?? 0), 0)}, total_tokens: input + output};
}

export interface RuntimeOptions {
  runtimePolicyPath?: string;
  receiptsDir?: string;
  // Module-test injection only. bridge-main never sets it, so production always runs the policy check.
  guard?: (context: {cwd: string; signal: AbortSignal}) => Promise<VerifiedRuntime>;
}

function guardRuntime(cwd: string, runtime: RuntimeOptions, signal: AbortSignal): Promise<VerifiedRuntime> {
  if (runtime.guard) return runtime.guard({cwd, signal});
  if (!runtime.runtimePolicyPath) {
    return Promise.reject(new BridgeError(503, 'runtime_policy_required', 'A private runtime policy is required before any Claude request. Create runtime-policy.json from runtime-policy.example.json.'));
  }
  return verifyRuntime({policyPath: runtime.runtimePolicyPath, cwd, signal, childEnv: subscriptionEnvironment});
}

// The loser of the race must never become an unhandled rejection.
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  promise.catch(() => {});
  if (signal.aborted) return Promise.reject(cancelled());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(cancelled());
    signal.addEventListener('abort', onAbort, {once: true});
    promise.then(value => {signal.removeEventListener('abort', onAbort); resolve(value);},
      error => {signal.removeEventListener('abort', onAbort); reject(error);});
  });
}

const subscriptionPlan = (account: {apiProvider?: string; subscriptionType?: string}) =>
  account.apiProvider === 'firstParty' ? normalizeSubscription(account.subscriptionType) : null;
function requireSubscription(account: {apiProvider?: string; subscriptionType?: string}) {
  const plan = subscriptionPlan(account);
  if (!plan) throw new BridgeError(401, 'subscription_required', 'A Claude subscription login is required. Run claude auth login. API-key fallback is disabled.');
  return plan;
}

// The 30 s deadline bounds every step, including a guard, account or model request that never settles.
export async function inspectSdk(cwd: string, runtime: RuntimeOptions = {}, queryImpl: typeof query = query) {
  let release!: () => void;
  const idle = new Promise<void>(resolve => {release = resolve;});
  const abortController = new AbortController();
  const {signal} = abortController;
  const timer = setTimeout(() => abortController.abort(), 30000);
  let session: ReturnType<typeof query> | undefined;
  let closed = false;
  try {
    const verified = await raceAbort(guardRuntime(cwd, runtime, signal), signal);
    session = queryImpl({prompt: (async function* () {await idle;})(), options: {...isolatedOptions(cwd), abortController,
      ...(verified.claudePath ? {pathToClaudeCodeExecutable: verified.claudePath} : {})}});
    const account = await raceAbort(session.accountInfo(), signal);
    const plan = subscriptionPlan(account);
    const guardCoverage = verified.coverage ?? GUARD_COVERAGE;
    // An account that is not a supported first-party subscription is reported before any model request is made.
    if (!plan) return {authenticated: false, subscriptionType: null, models: [] as ClaudeModel[], guardCoverage};
    const models = discoverCatalog(await raceAbort(session.supportedModels(), signal));
    return {authenticated: true, subscriptionType: plan, models, guardCoverage};
  } finally {
    clearTimeout(timer); release();
    if (session && !closed) {
      closed = true;
      try {session.close();} catch {/* closing is best effort */}
    }
  }
}

const RETRYABLE_DECISIONS = new Set(['invalid_decision', 'invalid_arguments', 'unknown_tool', 'tool_choice', 'parallel_calls', 'empty_decision', 'native_tool_call']);

// The SDK session has no native tools (tools: []); every Codex tool belongs in the structured decision's calls.
// A model that calls exec_command, apply_patch or tool_search directly gets "No such tool available", then tends to
// report that Codex tools are broken. Returns the tool name of such a call by the main model, if any.
export function nativeToolCall(message: Record<string, unknown>): string | undefined {
  if (message.parent_tool_use_id != null) return undefined;
  const named = (block: unknown) => {
    const b = block as {type?: unknown; name?: unknown} | null | undefined;
    return b && b.type === 'tool_use' && typeof b.name === 'string' && b.name !== 'StructuredOutput' ? b.name.slice(0, 80) : undefined;
  };
  if (message.type === 'stream_event') {
    const event = message.event as {type?: unknown; content_block?: unknown} | undefined;
    return event?.type === 'content_block_start' ? named(event.content_block) : undefined;
  }
  if (message.type === 'assistant') {
    const content = (message.message as {content?: unknown} | undefined)?.content;
    if (Array.isArray(content)) for (const block of content) {const name = named(block); if (name) return name;}
  }
  return undefined;
}
// A stream without verifiable per-request usage is retried once with the unchanged prompt instead of withholding the turn.
const RETRY_WITHOUT_NOTE = new Set(['missing_context_usage']);
// Names the rejected call and the rule only; the rejected arguments are not echoed or stored.
const retryNote = (rejected: Record<string, unknown>) => `Your previous decision for this exact step was rejected by the adapter (${String(rejected.code)}${
  rejected.tool ? ` on ${String(rejected.tool)}` : ''}): ${String(rejected.reason ?? '')} Return a corrected decision. For function tools put the arguments object in "arguments"; for custom tools put the raw text in "input".`;

// One text block per conversation record, each attached image labelled right after its record. Claude caches at block
// boundaries, so a step that only appends records reuses the previous step's cached prompt instead of paying for it again.
export function promptContent(prepared: {header: string; records: string[]; recordImages: ImageBlock[][]; images: ImageBlock[]}) {
  const label = (image: ImageBlock) => `Attached image ${prepared.images.indexOf(image) + 1}:`;
  return [{type: 'text' as const, text: prepared.header}, ...prepared.records.flatMap((text, index) => [{type: 'text' as const, text},
    ...(prepared.recordImages[index] ?? []).flatMap(image => [{type: 'text' as const, text: label(image)}, image])])];
}

// Explicit and visible: an unsupported effort is an error, never silently dropped. "none" means no override.
function resolveEffort(model: ClaudeModel, request: ResponsesRequest) {
  const requested = request.reasoning?.effort;
  if (!requested || requested === 'none') return undefined;
  if (!model.efforts.includes(requested)) {
    throw new BridgeError(400, 'unsupported_effort', `Model ${model.id} does not support reasoning effort "${requested.slice(0, 32)}". Supported: ${model.efforts.join(', ') || 'none'}.`);
  }
  return requested as Options['effort'];
}

export function sdkRunner(cwd: string, models: ClaudeModel[], queryImpl: typeof query = query, runtime: RuntimeOptions = {}): RunStep {
  return async (request: ResponsesRequest, signal: AbortSignal, progress: () => void = () => {}) => {
    // Client errors end here: an unknown model, unsupported input or effort is not an inference attempt and leaves no receipt.
    const model = models.find(m => m.id === request.model);
    if (!model) throw new BridgeError(400, 'unknown_model', 'Unknown Claude model. Run setup install to refresh the catalog.');
    const prepared = preparePrompt(request);
    const effort = resolveEffort(model, request);

    // The accepted model step starts here, before the guard and the account handshake, and is never reset.
    const startedAt = new Date(), startedClock = performance.now();
    const abortController = new AbortController();
    const abort = () => abortController.abort();
    signal.addEventListener('abort', abort, {once: true});
    if (signal.aborted) abort();
    let session: ReturnType<typeof query> | undefined;
    let closed = false;
    let release: () => void = () => {};
    let verified: VerifiedRuntime | undefined;
    let stage: InferenceStage = 'not_started', releasedClock: number | undefined;
    let final: Record<string, unknown> | undefined;
    let context: ContextUsage | undefined;
    let result: StepResult | undefined, failure: unknown;
    let attempts = 0, rejected: Record<string, unknown> | undefined;
    const closeSession = () => {
      release();
      if (session && !closed) {
        closed = true;
        try {session.close();} catch {/* closing is best effort */}
      }
    };
    // One SDK query. A retry gets a fresh session; only the decision note is added to the prompt.
    const attempt = async (options: Options, note: string) => {
      closeSession(); closed = false; final = undefined;
      let permitted = false;
      // First direct native tool call by the main model in this query, if any.
      let direct: string | undefined;
      const authenticated = new Promise<void>(resolve => {release = resolve;});
      const contextTracker = new ContextUsageTracker(model);
      const content = promptContent(prepared);
      session = queryImpl({prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
        await authenticated;
        if (permitted && !abortController.signal.aborted) yield {type: 'user', session_id: '', parent_tool_use_id: null,
          message: {role: 'user', content: note ? [...content, {type: 'text', text: note}] : content}};
      })(), options});
      requireSubscription(await raceAbort(session.accountInfo(), abortController.signal));
      permitted = true; stage = 'prompt_released'; releasedClock ??= performance.now(); release();
      const iterator = session[Symbol.asyncIterator]();
      for (;;) {
        const next = await raceAbort(iterator.next(), abortController.signal);
        if (next.done) break;
        const message = next.value as unknown as Record<string, unknown>;
        // Thinking and output arrive as frequent stream events (measured gaps under 2 s at high effort).
        progress();
        if (message.type === 'result') {final = message; stage = 'final_received'; break;}
        direct ??= nativeToolCall(message);
        contextTracker.observe(message);
      }
      if (!final) throw new BridgeError(502, 'incomplete_sdk', 'Claude SDK ended without a result.');
      if (final.subtype !== 'success' || final.is_error) {
        throw new BridgeError(502, 'claude_failed', `Claude SDK did not complete successfully (${safeCode(final.subtype)}). Check Claude login, usage limits and model access.`);
      }
      const evidence = summarizeFinal(final);
      if (evidence.permission_denials_status === 'present') {
        throw new BridgeError(502, 'sdk_permission_denied', 'Claude attempted an action the SDK denied. The answer was discarded; Codex alone executes tools.');
      }
      if (!evidence.actual_models.length || !evidence.sdk_session_id || !evidence.usage) {
        throw new BridgeError(502, 'missing_result_metadata', 'Claude SDK returned no verifiable model, session or usage. The answer was discarded.');
      }
      context = contextTracker.finish(final);
      const decision = validateDecision(final.structured_output, request);
      // A direct native call usually fails with "No such tool available" and the model recovers in the same query by
      // returning the call in calls; that answer is kept. Aborting those steps doubled latency and made a long chat fail.
      // Only a first-attempt answer with no calls after a direct call may rest on the failed call, so it is retried once.
      if (direct && !decision.calls.length && attempts === 1) {
        throw new BridgeError(502, 'native_tool_call', `Claude called ${direct} as a native tool and then returned no calls.`, {tool: direct,
          reason: `During this step you called "${direct}" as a native tool. This session has no native tools, so only that one direct call failed with "No such tool available". Codex tools work normally, and every tool result already in the conversation was really executed and is valid. If you still need a tool, put the request in the calls array of the structured decision; otherwise answer from the existing results.`});
      }
      return {decision, usage: context.usage};
    };
    try {
      verified = await raceAbort(guardRuntime(cwd, runtime, abortController.signal), abortController.signal);
      if (!runtime.receiptsDir) throw new BridgeError(503, 'receipts_required', 'A private receipts directory is required before any Claude request.');
      const options: Options = {...isolatedOptions(cwd), model: model.sdkModel, systemPrompt: `${NATIVE_PROVIDER_INSTRUCTION}\n\n${prepared.system}`,
        // Successful receipts report num_turns up to 5 with tools disabled; 8 leaves headroom before error_max_turns.
        abortController, maxTurns: 8, includePartialMessages: true, outputFormat: {type: 'json_schema', schema: outputSchemaFor(request)},
        ...(verified.claudePath ? {pathToClaudeCodeExecutable: verified.claudePath} : {}), ...(effort ? {effort} : {})};
      for (;;) {
        attempts++;
        try {result = await attempt(options, rejected && !RETRY_WITHOUT_NOTE.has(String(rejected.code)) ? retryNote(rejected) : ''); break;}
        catch (error) {
          // A malformed decision or unverifiable usage is retried once; login, limits, cancellation and timeouts are not.
          if (attempts > 1 || !(error instanceof BridgeError) || !(RETRYABLE_DECISIONS.has(error.code) || RETRY_WITHOUT_NOTE.has(error.code))
            || abortController.signal.aborted) throw error;
          rejected = {code: error.code, ...error.details};
        }
      }
    } catch (error) {
      failure = error;
    } finally {
      closeSession(); signal.removeEventListener('abort', abort);
    }

    if (runtime.receiptsDir) {
      const endClock = performance.now();
      const aborted = abortController.signal.aborted || (failure instanceof Error && failure.name === 'AbortError');
      const code = failure === undefined ? 'success' : failure instanceof BridgeError ? failure.code : aborted ? 'aborted' : 'sdk_error';
      // Before the prompt was released nothing was asked of the model, so a refusal is blocked. After it, a final result
      // that is not a verified success is a failure; without a usable final result the outcome stays incomplete.
      const status: ReceiptStatus = failure === undefined ? 'complete' : code === 'aborted' ? 'aborted' : stage === 'not_started' ? 'blocked'
        : final && code !== 'missing_result_metadata' && code !== 'missing_context_usage' ? 'failed' : 'incomplete';
      const receipt: Receipt = {
        schema_version: 1, run_id: newRunId(), started_at: startedAt.toISOString(), ended_at: new Date().toISOString(),
        wall_ms: Math.round(endClock - startedClock),
        preflight_ms: releasedClock === undefined ? null : Math.round(releasedClock - startedClock),
        query_ms: releasedClock === undefined ? null : Math.round(endClock - releasedClock),
        inference_stage: stage, requested_alias: model.sdkModel, requested_effort: effort ?? null,
        effective_effort: 'unknown', ...summarizeFinal(final), status, code: safeCode(code),
        usage_scope: 'query_pipeline_total', context_usage: context ? {model: context.model, source: context.source, usage: {
          input_tokens: context.usage.input_tokens, cached_input_tokens: context.usage.input_tokens_details.cached_tokens,
          output_tokens: context.usage.output_tokens, reasoning_tokens: context.usage.output_tokens_details.reasoning_tokens,
          total_tokens: context.usage.total_tokens,
        }} : null,
        guard_coverage: verified?.coverage ?? GUARD_COVERAGE, cli_version: verified?.claudeVersion ?? null,
        attempts, rejected: rejected ? {code: safeCode(rejected.code), ...(typeof rejected.tool === 'string' ? {tool: rejected.tool.slice(0, 200)} : {}),
          ...(typeof rejected.kind === 'string' ? {kind: rejected.kind.slice(0, 20)} : {})} : null,
        request_kind: isCompactionRequest(request) ? 'compaction' : 'turn',
      };
      try {await writeReceipt(runtime.receiptsDir, receipt);}
      catch (evidence) {
        const reason = evidence instanceof Error ? evidence.message : 'Receipt write failed.';
        if (failure === undefined) throw new BridgeError(500, 'receipt_failed', `Claude completed the request (inference status: complete) but the evidence receipt could not be written, so the answer was withheld. ${reason}`);
        console.error(`Evidence receipt not written (inference status: ${status}, code: ${receipt.code}). ${reason}`);
        if (failure instanceof BridgeError) throw new BridgeError(failure.status, failure.code, `${failure.message} The evidence receipt could not be written either.`);
      }
    }
    if (failure !== undefined) throw failure;
    return result!;
  };
}

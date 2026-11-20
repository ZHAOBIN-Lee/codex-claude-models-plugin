import {BridgeError, availableTools, preparePrompt, validateDecision, type ResponsesRequest, type StepResult} from './contracts.js';
import type {ClaudeModel} from './catalog.js';
import {NATIVE_PROVIDER_INSTRUCTION, promptContent} from './sdk.js';
import {apiInferenceGeography, apiPriceForUsage, type ApiPrice, type ApiTokenRates, type ApiInferenceGeography} from './api-pricing.js';
import {safeApiDiagnostics, type ApiStreamPhase, type ApiStreamReason} from './api-diagnostics.js';

export interface ApiCredentials {api_key: string; workspace_id?: string}
export interface ApiRunnerOptions {
  credentials: () => Promise<ApiCredentials>;
  fetchImpl?: typeof fetch;
  maxOutputTokens?: number;
  prices?: Record<string, ApiPrice>;
  cache?: 'off' | '5m';
}
export interface PreparedApiStep {
  model: string;
  inputTokens: number;
  maxOutputTokens: number;
  reservationUsd: number;
  execute(signal: AbortSignal, progress?: () => void): Promise<ApiStepResult>;
}
export interface ApiStepResult {
  result: StepResult;
  actualModel: string;
  requestId: string | null;
  messageId: string;
  inputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  outputTokens: number;
  costUsd: number;
}

type Json = Record<string, unknown>;
const ORIGIN = 'https://api.anthropic.com';
const REQUEST_BYTES = 32_000_000;
const FRAME_BYTES = 2_000_000;
const STREAM_BYTES = 16_000_000;
const DECISION_BYTES = 8_000_000;
const METADATA_BYTES = 256_000;
const DECISION_INSTRUCTION = 'Your entire response is one JSON object matching the required schema: user-facing Markdown in text, Codex tool requests in calls (empty when you are giving a final answer). Native tools are unavailable; Codex executes calls.';
function apiDecisionSchema(request: ResponsesRequest, tools: ReturnType<typeof availableTools>) {
  // JSON output grammars require closed objects. Pair each kind with only its offered keys; keep arbitrary arguments
  // encoded as strings. Count limits are unsupported in the wire grammar and remain enforced by validateDecision.
  const functionInput = {type: 'string', description: 'A JSON object encoded as a string (e.g. "{}" when no args).'};
  const customInput = {type: 'string', description: 'Raw text, code or patch matching the custom tool format.'};
  const branches = (['function', 'custom'] as const).flatMap(kind => {
    const names = tools.filter(tool => tool.kind === kind).map(tool => tool.key);
    return names.length ? [{type: 'object', additionalProperties: false, required: ['kind', 'name', 'input'], properties: {
      kind: {type: 'string', enum: [kind]}, name: {type: 'string', enum: names},
      input: kind === 'function' ? functionInput : customInput,
    }}] : [];
  });
  const calls = !tools.length || request.tool_choice === 'none' ? 'Leave calls empty.'
    : request.parallel_tool_calls === false ? 'Return at most one Codex tool call.' : 'Return at most 16 Codex tool calls.';
  // With no tools, retain the empty-calls instruction and local guard without an empty enum or unsupported maxItems.
  const items = branches.length ? {anyOf: branches} : {type: 'object', additionalProperties: false,
    required: ['kind', 'name', 'input'], properties: {kind: {type: 'string', enum: ['function', 'custom']},
      name: {type: 'string'}, input: {type: 'string', description: `${functionInput.description} Custom: raw text, code or patch.`}}};
  return {type: 'object', additionalProperties: false, required: ['text', 'calls'], properties: {
    text: {type: 'string'}, calls: {type: 'array', description: calls, items},
  }};
}
class ApiError extends BridgeError {}
const fail = (code: string, message: string, status = 424, details: Record<string, string> = {}) => new ApiError(status, `api_${code}`, message, details);
const record = (value: unknown): Json | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined;
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const positive = (value: unknown): value is number => integer(value) && value > 0;
const supports = (value: unknown) => record(value)?.supported === true;
const money = (value: number) => Math.round(value * 1e12) / 1e12;
const validRates = (price: ApiTokenRates) => [price.input, price.output, price.cacheRead ?? price.input].every(n => Number.isFinite(n) && n >= 0)
  && price.input > 0 && price.output > 0;
const aborted = () => fail('aborted', 'Claude API request was cancelled.', 409);
function checkAbort(signal: AbortSignal) {if (signal.aborted) throw aborted();}
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  promise.catch(() => {});
  if (signal.aborted) return Promise.reject(aborted());
  return new Promise((resolve, reject) => {
    const abort = () => reject(aborted());
    signal.addEventListener('abort', abort, {once: true});
    promise.then(value => {signal.removeEventListener('abort', abort); resolve(value);},
      error => {signal.removeEventListener('abort', abort); reject(error);});
  });
}
function serialize(body: unknown) {
  const json = JSON.stringify(body);
  if (Buffer.byteLength(json, 'utf8') >= REQUEST_BYTES) throw fail('request_too_large', 'Prepared Claude API request reaches the 32 MB body limit.', 422);
  return json;
}
function safeFailure(error: unknown, signal: AbortSignal, code = 'transport_error', diagnostics: Record<string, unknown> = {}): BridgeError {
  const known = error instanceof ApiError ? error : undefined;
  const safe = signal.aborted ? aborted() : known ?? fail(code, 'Claude API request could not be completed. Its outcome has not been verified.');
  return new ApiError(safe.status, safe.code, safe.message, {...safeApiDiagnostics(diagnostics), ...safeApiDiagnostics(known?.details),
    ...(signal.aborted && (diagnostics.stream_phase || known?.details.stream_phase) ? {stream_reason: 'cancelled'} : {})});
}
async function readMetadata(response: Response, signal: AbortSignal): Promise<Json> {
  if (!response.body) throw fail('invalid_metadata', 'Claude API returned no metadata.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', {fatal: true});
  let text = '', bytes = 0;
  try {
    for (;;) {
      const next = await raceAbort(reader.read(), signal);
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > METADATA_BYTES) throw fail('invalid_metadata', 'Claude API metadata exceeded its limit.');
      text += decoder.decode(next.value, {stream: true});
    }
    text += decoder.decode();
    const value = record(JSON.parse(text));
    if (!value) throw fail('invalid_metadata', 'Claude API metadata was invalid.');
    return value;
  } catch (error) {throw safeFailure(error, signal, 'invalid_metadata', {request_id: response.headers.get('request-id')});}
  finally {void reader.cancel().catch(() => {}); reader.releaseLock();}
}

function checkedUsage(value: Json, outputLimit: number, geography: ApiInferenceGeography) {
  const input = value.input_tokens;
  const read = value.cache_read_input_tokens ?? 0;
  const created = value.cache_creation_input_tokens ?? 0;
  const output = value.output_tokens;
  const thinking = record(value.output_tokens_details)?.thinking_tokens ?? 0;
  if (![input, read, created, output, thinking].every(integer) || !integer(input) || !integer(read) || !integer(created) || !integer(output)
      || !integer(thinking) || thinking > output || output > outputLimit || !Number.isSafeInteger(input + read + created + output)) {
    throw fail('missing_usage', 'Claude API returned incomplete or invalid usage.', 424, {stream_reason: 'invalid_usage'});
  }
  const serverTools = value.server_tool_use;
  const cache = record(value.cache_creation);
  if ((serverTools != null && (!record(serverTools) || Object.values(record(serverTools)!).some(v => v !== 0)))
      || (value.service_tier != null && value.service_tier !== 'standard')
      || (geography === 'global' ? value.inference_geo !== 'global' : value.inference_geo != null && value.inference_geo !== 'global')
      || (cache && (cache.ephemeral_1h_input_tokens !== 0 || !integer(cache.ephemeral_5m_input_tokens)
        || cache.ephemeral_5m_input_tokens !== created))) {
    throw fail('unexpected_billing', 'Claude API reported billing terms outside this request reservation.', 424, {stream_reason: 'unexpected_billing'});
  }
  return {input, read, created, output, thinking};
}

async function readDecision(response: Response, request: ResponsesRequest, model: string, price: ApiPrice, geography: ApiInferenceGeography,
  outputLimit: number, signal: AbortSignal, progress: () => void): Promise<ApiStepResult> {
  const requestId = safeApiDiagnostics({request_id: response.headers.get('request-id')}).request_id;
  let phase: ApiStreamPhase = 'response', eventDiagnostics: Record<string, string> = {}, decisionDiagnostics: Record<string, string> = {};
  let pending = '', bytes = 0, messageId: string | undefined, actualModel: string | undefined;
  let stopReason: unknown, decisionText = '', decisionTextBlocks = 0;
  const diagnostics = () => ({request_id: requestId, message_id: messageId, actual_model: actualModel, stream_phase: phase,
    stream_stop_reason: stopReason, decision_text_blocks: decisionTextBlocks, ...eventDiagnostics, ...decisionDiagnostics});
  const streamFailure = (code: string, message: string, reason: ApiStreamReason, status = 424) =>
    fail(code, message, status, safeApiDiagnostics({...diagnostics(), stream_reason: reason}));
  const invalid = (reason: ApiStreamReason) => streamFailure('invalid_stream', 'Claude API returned an invalid or incomplete event sequence.', reason);
  if (!response.body || !response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')) {
    void response.body?.cancel().catch(() => {});
    throw streamFailure('invalid_stream', 'Claude API did not return an event stream.', response.body ? 'invalid_content_type' : 'missing_stream_body');
  }
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', {fatal: true});
  let stopped = false, finalUsage = false, usage: Json = {};
  const blocks = new Map<number, {type: string; closed: boolean}>();
  const appendText = (text: string) => {
    decisionText += text;
    if (Buffer.byteLength(decisionText, 'utf8') > DECISION_BYTES) {
      throw streamFailure('stream_too_large', 'Claude API decision exceeded its buffer limit.', 'decision_size_limit');
    }
  };
  const observe = (event: Json) => {
    phase = 'event';
    eventDiagnostics = safeApiDiagnostics({stream_event: event.type,
      stream_block_index: integer(event.index) ? String(event.index) : undefined,
      stream_block_type: record(event.content_block)?.type ?? (integer(event.index) ? blocks.get(event.index)?.type : undefined),
      stream_delta_type: record(event.delta)?.type});
    if (event.type === 'error') throw streamFailure('stream_error', 'Claude API reported a stream error.', 'stream_error');
    if (event.type === 'ping') return;
    if (stopped) throw invalid('event_after_stop');
    if (event.type === 'message_start') {
      const message = record(event.message);
      if (messageId) throw invalid('duplicate_message_start');
      if (!message || typeof message.id !== 'string' || !/^msg_[A-Za-z0-9_-]{1,200}$/.test(message.id)
          || message.type !== 'message' || message.role !== 'assistant' || !Array.isArray(message.content) || message.content.length) throw invalid('invalid_message_start');
      messageId = message.id;
      if (message.model !== model) throw streamFailure('model_mismatch', 'Claude API returned a different model than the reserved model.', 'model_mismatch');
      actualModel = model;
      usage = record(message.usage) ?? {};
      progress(); return;
    }
    if (!messageId) throw invalid('message_not_started');
    if (event.type === 'content_block_start') {
      const block = record(event.content_block);
      if (!integer(event.index)) throw invalid('invalid_block_index');
      if (event.index !== blocks.size) throw invalid('nonsequential_block_index');
      if (!block || typeof block.type !== 'string') throw invalid('invalid_block_start');
      if ([...blocks.values()].some(b => !b.closed)) throw invalid('overlapping_blocks');
      if (finalUsage) throw invalid('block_after_final_usage');
      if (block.type === 'refusal') throw streamFailure('refusal', 'Claude API refused this request.', 'refusal_block', 422);
      if (block.type === 'tool_use' || block.type === 'server_tool_use') throw invalid('unexpected_tool_use');
      if (!['text', 'thinking', 'redacted_thinking'].includes(block.type)) throw streamFailure('unexpected_tool', 'Claude API attempted an unsupported native operation.', 'unsupported_block_type');
      if (block.type === 'text') {
        if (typeof block.text !== 'string') throw invalid('invalid_block_start');
        decisionTextBlocks++;
        appendText(block.text);
      }
      blocks.set(event.index, {type: block.type, closed: false});
      progress(); return;
    }
    if (event.type === 'content_block_delta') {
      const block = integer(event.index) ? blocks.get(event.index) : undefined;
      const delta = record(event.delta);
      if (!block) throw invalid('unknown_block_index');
      if (block.closed) throw invalid('delta_after_block_stop');
      if (!delta) throw invalid('invalid_delta');
      if (finalUsage) throw invalid('delta_after_final_usage');
      if (delta.type === 'refusal_delta') throw streamFailure('refusal', 'Claude API refused this request.', 'refusal_delta', 422);
      if (delta.type === 'text_delta' && block.type === 'text' && typeof delta.text === 'string') {
        appendText(delta.text);
      } else if (!((delta.type === 'thinking_delta' && block.type === 'thinking' && typeof delta.thinking === 'string')
        || (delta.type === 'signature_delta' && block.type === 'thinking' && typeof delta.signature === 'string'))) throw invalid('invalid_delta_type');
      progress(); return;
    }
    if (event.type === 'content_block_stop') {
      const block = integer(event.index) ? blocks.get(event.index) : undefined;
      if (!block) throw invalid('unknown_block_index');
      if (block.closed) throw invalid('duplicate_block_stop');
      if (finalUsage) throw invalid('block_stop_after_final_usage');
      block.closed = true;
      progress(); return;
    }
    if (event.type === 'message_delta') {
      if ([...blocks.values()].some(b => !b.closed)) throw invalid('open_block_at_message_delta');
      const delta = record(event.delta), update = record(event.usage);
      if (!delta || !update || !integer(update.output_tokens)) throw streamFailure('missing_usage', 'Claude API returned incomplete or invalid final usage.', 'invalid_final_usage');
      // Anthropic stream usage fields are cumulative totals. Missing/null means unchanged, including cache fields;
      // an explicit zero is authoritative and must replace the prior value rather than being added or ignored.
      for (const [key, value] of Object.entries(update)) if (value != null) usage[key] = value;
      if (delta.stop_reason != null) stopReason = delta.stop_reason;
      finalUsage = true; progress(); return;
    }
    if (event.type === 'message_stop') {
      if (!finalUsage) throw streamFailure('missing_usage', 'Claude API returned no final usage.', 'missing_final_usage');
      if ([...blocks.values()].some(b => !b.closed)) throw invalid('open_block_at_message_stop');
      stopped = true; progress(); return;
    }
    // Future event types cannot provide completion, decision or heartbeat evidence.
  };
  const frame = (text: string) => {
    phase = 'frame'; eventDiagnostics = {};
    if (Buffer.byteLength(text, 'utf8') > FRAME_BYTES) throw streamFailure('stream_too_large', 'Claude API event exceeded its buffer limit.', 'frame_size_limit');
    const data = text.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
    if (!data) return;
    let event: Json | undefined;
    try {event = record(JSON.parse(data));} catch {throw invalid('invalid_event_json');}
    if (!event || typeof event.type !== 'string') throw invalid('invalid_event_shape');
    observe(event);
  };
  try {
    while (!stopped) {
      phase = 'read';
      const next = await raceAbort(reader.read(), signal);
      phase = 'decode';
      if (next.done) {
        pending += decoder.decode();
        // SSE dispatch requires a blank line, including for message_stop.
        break;
      }
      bytes += next.value.byteLength;
      if (bytes > STREAM_BYTES) throw streamFailure('stream_too_large', 'Claude API stream exceeded its buffer limit.', 'stream_size_limit');
      pending += decoder.decode(next.value, {stream: true});
      for (;;) {
        const separator = /\r?\n\r?\n/.exec(pending);
        if (!separator) break;
        const item = pending.slice(0, separator.index);
        pending = pending.slice(separator.index + separator[0].length);
        frame(item);
      }
      if (Buffer.byteLength(pending, 'utf8') > FRAME_BYTES) throw streamFailure('stream_too_large', 'Claude API event exceeded its buffer limit.', 'frame_size_limit');
    }
    phase = 'validation';
    checkAbort(signal);
    if (!stopped) throw streamFailure('incomplete_stream', 'Claude API stream ended before a complete result.', 'incomplete_stream');
    if (stopReason === 'max_tokens') throw streamFailure('output_truncated', 'Claude API reached the output limit; no partial decision was accepted.', 'output_truncated', 422);
    if (stopReason === 'refusal') throw streamFailure('refusal', 'Claude API refused this request.', 'refusal', 422);
    // No stop sequences are requested. Only end_turn proves the complete JSON response finished normally.
    if (stopReason !== 'end_turn') throw streamFailure('invalid_decision', 'Claude API returned an unexpected stop reason.', 'unexpected_stop_reason', 422);
    if (!decisionText.trim()) throw streamFailure('invalid_decision', 'Claude API returned no decision text.', 'missing_decision_text', 422);
    const tokens = checkedUsage(usage, outputLimit, geography);
    let decision: unknown, validated: StepResult['decision'];
    try {decision = JSON.parse(decisionText);}
    catch {throw streamFailure('invalid_decision', 'Claude API decision was not valid JSON.', 'invalid_decision_json', 422);}
    try {validated = validateDecision(decision, request);}
    catch (error) {
      if (error instanceof BridgeError) {
        const calls = record(decision)?.calls;
        decisionDiagnostics = safeApiDiagnostics({decision_rule: error.code, decision_tool_kind: error.details.kind,
          decision_tool: availableTools(request).some(tool => tool.key === error.details.tool) ? error.details.tool : undefined,
          decision_calls: Array.isArray(calls) ? calls.length : undefined});
      }
      throw streamFailure('invalid_decision', 'Claude API decision did not satisfy the Codex tool contract.', 'invalid_decision', 422);
    }
    const inputTotal = tokens.input + tokens.read + tokens.created;
    const actualPrice = apiPriceForUsage(price, inputTotal);
    return {
      result: {decision: validated, usage: {input_tokens: inputTotal, input_tokens_details: {cached_tokens: tokens.read},
        output_tokens: tokens.output, output_tokens_details: {reasoning_tokens: tokens.thinking}, total_tokens: inputTotal + tokens.output}},
      actualModel: actualModel!, messageId: messageId!, requestId: requestId ?? null,
      inputTokens: tokens.input, cacheReadInputTokens: tokens.read, cacheCreationInputTokens: tokens.created, outputTokens: tokens.output,
      costUsd: money((tokens.input * actualPrice.input + tokens.read * (actualPrice.cacheRead ?? actualPrice.input)
        + tokens.created * actualPrice.input * 1.25 + tokens.output * actualPrice.output) / 1_000_000),
    };
  } catch (error) {
    throw safeFailure(error, signal, 'invalid_stream', {...diagnostics(),
      stream_reason: phase === 'read' ? 'body_read_error' : phase === 'decode' ? 'invalid_utf8' : 'processing_error'});
  }
  finally {void reader.cancel().catch(() => {}); reader.releaseLock();}
}

export function createApiRunner(options: ApiRunnerOptions): {prepare(request: ResponsesRequest, model: ClaudeModel, signal: AbortSignal): Promise<PreparedApiStep>} {
  const fetchImpl = options.fetchImpl ?? fetch;
  return {async prepare(original, model, signal) {
    let responseDiagnostics: Record<string, string> = {};
    try {
      checkAbort(signal);
      const canonical = model.resolvedModel ?? model.sdkModel;
      if (model.id !== original.model || !/^claude-[a-z0-9]+(?:-[a-z0-9]+)+$/.test(canonical)) {
        throw fail('model_unresolved', 'Claude API requires an exact canonical model from the current catalog.', 400);
      }
      const foundPrice = options.prices?.[canonical];
      if (!foundPrice || !validRates(foundPrice)) throw fail('price_unknown', 'No verified Claude API price is configured for this model.', 422);
      const tier = foundPrice.shortContext;
      if (tier && (!positive(tier.maxInputTokens) || !validRates(tier) || tier.input > foundPrice.input || tier.output > foundPrice.output
          || (tier.cacheRead ?? tier.input) > (foundPrice.cacheRead ?? foundPrice.input))) {
        throw fail('price_unknown', 'Claude API tier prices exceed the configured reservation rates.', 422);
      }
      const price = structuredClone(foundPrice);
      const geography = apiInferenceGeography(canonical);
      if (!geography) throw fail('geography_unknown', 'Claude API model geography pricing is not verified.', 422);
      const maxOutputTokens = options.maxOutputTokens ?? 8192;
      if (!positive(maxOutputTokens)) throw fail('output_limit', 'Claude API output reservation must be a positive integer.', 400);
      const request = structuredClone(original);
      let prepared: ReturnType<typeof preparePrompt>, schema: ReturnType<typeof apiDecisionSchema>;
      try {
        prepared = preparePrompt(request, {functionArgumentFormat: 'json-string'});
        schema = apiDecisionSchema(request, prepared.tools);
      } catch {
        throw fail('unsupported_request', 'This request cannot be represented by the Claude API adapter.', 400);
      }
      const effort = request.reasoning?.effort;
      if (effort && effort !== 'none' && !model.efforts.includes(effort)) throw fail('unsupported_effort', 'Requested effort is not supported by this model.', 400);
      let credentials: ApiCredentials;
      try {credentials = await raceAbort(options.credentials(), signal);} catch (error) {throw safeFailure(error, signal, 'credentials_unavailable');}
      if (!credentials || typeof credentials.api_key !== 'string' || !credentials.api_key || /[\r\n]/.test(credentials.api_key)
          || (credentials.workspace_id !== undefined && !/^wrkspc_[A-Za-z0-9_-]{1,200}$/.test(credentials.workspace_id))) {
        throw fail('credentials_unavailable', 'Claude API credentials are unavailable or invalid.');
      }
      const headers: Record<string, string> = {'x-api-key': credentials.api_key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json',
        ...(credentials.workspace_id ? {'anthropic-workspace-id': credentials.workspace_id} : {})};
      const send = async (path: string, body: string | undefined, requestSignal: AbortSignal) => {
        responseDiagnostics = {};
        checkAbort(requestSignal);
        try {
          const response = await raceAbort(fetchImpl(`${ORIGIN}${path}`, {method: body === undefined ? 'GET' : 'POST', headers,
            ...(body !== undefined ? {body} : {}), redirect: 'error', signal: requestSignal}), requestSignal);
          responseDiagnostics = safeApiDiagnostics({request_id: response.headers.get('request-id')});
          if (!response.ok) {
            void response.body?.cancel().catch(() => {});
            const code = response.status === 401 || response.status === 403 ? 'auth' : response.status === 429 ? 'rate_limit' : 'http_error';
            // Retain only trusted status and a bounded request ID, never arbitrary headers or response bodies.
            throw fail(code, 'Claude API rejected this request.', 424, {http_status: String(response.status), ...responseDiagnostics});
          }
          return response;
        } catch (error) {throw safeFailure(error, requestSignal, 'transport_error', responseDiagnostics);}
      };
      const info = await readMetadata(await send(`/v1/models/${encodeURIComponent(canonical)}`, undefined, signal), signal);
      if (info.id !== canonical) throw fail('model_mismatch', 'Claude API model resolution did not match the current catalog.', 422);
      if (!positive(info.max_input_tokens) || !positive(info.max_tokens) || !record(info.capabilities)) {
        throw fail('capabilities_unknown', 'Claude API model capacity is not verified.', 422);
      }
      if (maxOutputTokens > info.max_tokens) throw fail('output_limit', 'Requested output reservation exceeds the Claude API model limit.', 422);
      const capabilities = record(info.capabilities)!;
      if (!supports(capabilities.structured_outputs)) {
        throw fail('structured_output_unsupported', 'Claude API model does not advertise JSON structured output support.', 422);
      }
      if (prepared.images.length && !supports(capabilities.image_input)) throw fail('image_unsupported', 'Claude API model does not support the prepared images.', 422);
      const reasoning = effort && effort !== 'none';
      if (reasoning && (!supports(capabilities.effort) || !supports(record(capabilities.effort)?.[effort])
          || !supports(capabilities.thinking) || !supports(record(record(capabilities.thinking)?.types)?.adaptive))) {
        throw fail('unsupported_effort', 'Claude API does not support the requested reasoning configuration.', 422);
      }
      const body = {model: canonical, system: `${NATIVE_PROVIDER_INSTRUCTION}\n\n${prepared.system}\n\n${DECISION_INSTRUCTION}`,
        messages: [{role: 'user', content: promptContent(prepared)}],
        output_config: {format: {type: 'json_schema', schema}, ...(reasoning ? {effort} : {})},
        ...(reasoning ? {thinking: {type: 'adaptive'}} : {}),
        ...(options.cache !== 'off' ? {cache_control: {type: 'ephemeral'}} : {})};
      // Freeze serialized bytes before counting and reservation; never modify or truncate history after this point.
      const inference = serialize({...body, max_tokens: maxOutputTokens, stream: true, service_tier: 'standard_only',
        ...(geography === 'global' ? {inference_geo: 'global'} : {})});
      // The count endpoint supports output_config; keep the JSON grammar in the counted prompt.
      // Cache policy does not change the prompt being counted. Omit it for count endpoint compatibility;
      // inference still uses the exact frozen 5m policy and its cold-write reservation.
      const {cache_control: _cacheControl, ...countBody} = body;
      const count = await readMetadata(await send('/v1/messages/count_tokens', serialize(countBody), signal), signal);
      if (!integer(count.input_tokens)) throw fail('invalid_token_count', 'Claude API did not return a valid input token estimate.');
      const inputTokens = count.input_tokens;
      // Token counting is an estimate: reserve uncertainty, preserving the requested output and history.
      const reservedInput = inputTokens + Math.max(1024, Math.ceil(inputTokens * 0.02));
      if (!Number.isSafeInteger(reservedInput + maxOutputTokens) || reservedInput + maxOutputTokens > info.max_input_tokens) {
        throw fail('context_limit', 'Prepared input plus output reservation exceeds the Claude API context limit.', 422);
      }
      const reservationUsd = money((reservedInput * price.input * (options.cache === 'off' ? 1 : 1.25) + maxOutputTokens * price.output) / 1_000_000);
      if (!Number.isFinite(reservationUsd) || reservationUsd <= 0) throw fail('price_unknown', 'Claude API reservation could not be computed.', 422);
      let executed = false;
      return {model: canonical, inputTokens, maxOutputTokens, reservationUsd, async execute(executeSignal, progress = () => {}) {
        if (executed) throw fail('step_already_executed', 'This prepared Claude API step already used its single inference attempt.', 409);
        checkAbort(signal); checkAbort(executeSignal);
        executed = true;
        const combinedSignal = AbortSignal.any([signal, executeSignal]);
        return readDecision(await send('/v1/messages', inference, combinedSignal), request, canonical, price, geography, maxOutputTokens, combinedSignal, progress);
      }};
    } catch (error) {throw safeFailure(error, signal, 'transport_error', responseDiagnostics);}
  }};
}

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createApiRunner, type ApiRunnerOptions} from '../src/api-runner.js';
import {BridgeError, requestSchema} from '../src/contracts.js';
import type {ClaudeModel} from '../src/catalog.js';
import {API_PRICES} from '../src/api-pricing.js';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fallbackRunner} from '../src/fallback.js';
import {saveApiConfig} from '../src/api-settings.js';
import {attachStepIdentity} from '../src/paid-step-guard.js';
import {SubscriptionQuotaError} from '../src/subscription-limits.js';

const MODEL = 'claude-sonnet-5-5';
const model: ClaudeModel = {id: 'claude-sdk-sonnet', sdkModel: 'sonnet', resolvedModel: MODEL,
  displayName: 'Sonnet', description: '', efforts: ['low', 'medium', 'high', 'max']};
const request = (over: Record<string, unknown> = {}) => requestSchema.parse({model: model.id, input: 'Answer briefly.', ...over});
const signal = () => new AbortController().signal;
const supported = {supported: true};
const capability = (over: Record<string, unknown> = {}) => ({id: MODEL, type: 'model', created_at: '2026-01-01T00:00:00Z', display_name: 'Sonnet',
  max_input_tokens: 1000000, max_tokens: 64000, capabilities: {image_input: supported, structured_outputs: supported,
    effort: {supported: true, low: supported, medium: supported, high: supported, max: supported, xhigh: null},
    thinking: {supported: true, types: {adaptive: supported, enabled: supported}}}, ...over});
type Event = Record<string, any>;
function events(decision: unknown = {text: '你好 👋', calls: []}, over: {stop?: string; usage?: Event; model?: string} = {}): Event[] {
  const json = JSON.stringify(decision);
  return [
    {type: 'message_start', message: {id: 'msg_fixture', type: 'message', role: 'assistant', model: over.model ?? MODEL,
      content: [], stop_reason: null, stop_sequence: null, usage: {input_tokens: 80, cache_read_input_tokens: 20, cache_creation_input_tokens: 0, output_tokens: 0, inference_geo: 'global'}}},
    {type: 'ping'},
    {type: 'content_block_start', index: 0, content_block: {type: 'thinking', thinking: ''}},
    {type: 'content_block_delta', index: 0, delta: {type: 'thinking_delta', thinking: 'Working'}},
    {type: 'content_block_stop', index: 0},
    {type: 'content_block_start', index: 1, content_block: {type: 'text', text: ''}},
    {type: 'content_block_delta', index: 1, delta: {type: 'text_delta', text: json.slice(0, 15)}},
    {type: 'content_block_delta', index: 1, delta: {type: 'text_delta', text: json.slice(15)}},
    {type: 'content_block_stop', index: 1},
    {type: 'message_delta', delta: {stop_reason: over.stop ?? 'end_turn', stop_sequence: null}, usage: {output_tokens: 12, ...over.usage}},
    {type: 'message_stop'},
  ];
}
function stream(data: Event[] | string, chunkSize = 31): Response {
  const bytes = new TextEncoder().encode(typeof data === 'string' ? data : data.map(e => `event: ${e.type}\r\ndata: ${JSON.stringify(e)}\r\n\r\n`).join(''));
  let offset = 0;
  return new Response(new ReadableStream({pull(controller) {
    if (offset >= bytes.length) return controller.close();
    controller.enqueue(bytes.slice(offset, offset += chunkSize));
  }}), {headers: {'content-type': 'text/event-stream', 'request-id': 'req_fixture'}});
}
function fixture(over: {capability?: unknown; tokens?: unknown; response?: () => Response; fetch?: typeof fetch; options?: Partial<ApiRunnerOptions>} = {}) {
  const calls: {url: string; init: RequestInit}[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    calls.push({url: String(url), init: init!});
    if (over.fetch) return over.fetch(url, init);
    if (String(url).includes('/models/')) return Response.json(over.capability ?? capability());
    if (String(url).endsWith('/count_tokens')) return Response.json(over.tokens ?? {input_tokens: 100});
    return (over.response ?? (() => stream(events())))();
  };
  const runner = createApiRunner({credentials: async () => ({api_key: 'fake-secret', workspace_id: 'wrkspc_fixture'}), fetchImpl,
    maxOutputTokens: 2000, prices: {[MODEL]: {input: 3, output: 15, cacheRead: 0.3}}, ...over.options});
  return {runner, calls};
}
const rejects = (code: string) => (error: unknown) => {
  assert.ok(error instanceof BridgeError);
  assert.equal(error.code, code);
  assert.ok([400, 409, 422, 424].includes(error.status));
  assert.doesNotMatch(error.message, /fake-secret|sensitive-upstream/);
  return true;
};

test('preflight preserves image and open tool arguments, pins origin and canonical model, and does not infer', async () => {
  const {runner, calls} = fixture();
  const step = await runner.prepare(request({reasoning: {effort: 'high'}, input: [{role: 'user', content: [
    {type: 'input_text', text: 'See this image'}, {type: 'input_image', image_url: 'data:image/png;base64,aGVsbG8='}]}],
    tools: [{type: 'function', name: 'exec', parameters: {type: 'object'}}]}), model, signal());
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.url, `https://api.anthropic.com/v1/models/${MODEL}`);
  const counted = JSON.parse(String(calls[1]!.init.body));
  assert.equal(counted.model, MODEL);
  assert.equal(counted.messages[0].content.find((b: Event) => b.type === 'image').source.data, 'aGVsbG8=');
  assert.equal(counted.tools, undefined);
  assert.equal(counted.tool_choice, undefined);
  assert.equal(counted.output_config.format.type, 'json_schema');
  assert.equal(counted.output_config.format.schema.additionalProperties, false);
  assert.equal(counted.output_config.format.schema.properties.calls.items.anyOf[0].properties.input.type, 'string');
  assert.equal(counted.output_config.effort, 'high');
  assert.deepEqual(counted.thinking, {type: 'adaptive'});
  assert.doesNotMatch(counted.system, /except StructuredOutput/);
  assert.equal(step.model, MODEL);
  assert.equal(step.inputTokens, 100);
  assert.equal(step.maxOutputTokens, 2000);
  assert.equal(step.reservationUsd, 0.034215);
  assert.equal(counted.cache_control, undefined);
  for (const call of calls) {
    assert.equal(call.init.redirect, 'error');
    const headers = new Headers(call.init.headers);
    assert.equal(headers.get('x-api-key'), 'fake-secret');
    assert.equal(headers.get('anthropic-workspace-id'), 'wrkspc_fixture');
  }
});

test('incremental stream returns only validated synthetic decision with actual usage and no session fabrication', async () => {
  const {runner, calls} = fixture();
  const step = await runner.prepare(request(), model, signal());
  let progress = 0;
  const result = await step.execute(signal(), () => progress++);
  assert.deepEqual(result.result.decision, {text: '你好 👋', calls: []});
  assert.deepEqual(result.result.usage, {input_tokens: 100, input_tokens_details: {cached_tokens: 20}, output_tokens: 12,
    output_tokens_details: {reasoning_tokens: 0}, total_tokens: 112});
  assert.equal(result.costUsd, 0.000426);
  assert.equal(result.actualModel, MODEL);
  assert.equal(result.messageId, 'msg_fixture');
  assert.equal(result.requestId, 'req_fixture');
  assert.equal(result.cacheReadInputTokens, 20);
  assert.equal(result.inputTokens, 80);
  assert.equal('sessionId' in result, false);
  assert.ok(progress >= 4);
  assert.equal(calls.filter(c => c.url.endsWith('/messages')).length, 1);
  const sent = JSON.parse(String(calls.at(-1)!.init.body));
  assert.equal(sent.max_tokens, 2000);
  assert.equal(sent.stream, true);
  assert.equal(sent.service_tier, 'standard_only');
  assert.equal(sent.inference_geo, 'global');
  assert.equal(sent.tools, undefined);
  assert.equal(sent.tool_choice, undefined);
  assert.equal(sent.output_config.format.type, 'json_schema');
  assert.equal(sent.output_config.effort, undefined);
  assert.deepEqual(sent.cache_control, {type: 'ephemeral'});
  await assert.rejects(step.execute(signal()), rejects('api_step_already_executed'));
  assert.equal(calls.length, 3);
});

test('freeform and discovered tool decisions remain native Codex decisions', async () => {
  const {runner} = fixture({response: () => stream(events({text: '', calls: [
    {kind: 'custom', name: 'apply_patch', input: '*** Begin Patch\n*** End Patch'},
    {kind: 'function', name: 'lookup', input: '{"nested":{"x":1}}'}]}))});
  const step = await runner.prepare(request({tools: [{type: 'custom', name: 'apply_patch'}], input: [
    {type: 'tool_search_output', call_id: 'search_1', tools: [{type: 'function', name: 'lookup', parameters: {type: 'object'}}]},
    {role: 'user', content: 'Do it'}]}), model, signal());
  assert.deepEqual((await step.execute(signal())).result.decision.calls, [
    {kind: 'custom', name: 'apply_patch', input: '*** Begin Patch\n*** End Patch'},
    {kind: 'function', name: 'lookup', input: '{"nested":{"x":1}}'}]);
});

test('additional-tools grammar reaches official API count and inference without losing native custom calls', async () => {
  const raw = 'text("追加工具");';
  const format = {type: 'grammar', syntax: 'lark', definition: 'start: /[\\s\\S]+/'};
  const {runner, calls} = fixture({response: () => stream(events({text: '', calls: [
    {kind: 'custom', name: 'functions.exec', input: raw}]}))});
  const declared = [{type: 'namespace', name: 'functions', tools: [{type: 'custom', name: 'exec', description: 'Run JavaScript.', format}]}];
  const step = await runner.prepare(request({tools: declared, input: [
    {type: 'additional_tools', id: 'at_native', role: 'developer', tools: [{type: 'namespace', name: 'functions', tools: [
      {type: 'custom', name: 'exec', description: 'Run JavaScript.', format}]}]},
    {role: 'user', content: 'Use the additional tool.'}]}), model, signal());
  assert.deepEqual((await step.execute(signal())).result.decision.calls, [{kind: 'custom', name: 'functions.exec', input: raw}]);
  for (const call of calls.filter(c => c.url.includes('/messages'))) {
    const body = JSON.parse(String(call.init.body));
    const record = body.messages[0].content.filter((part: Event) => part.type === 'text')
      .map((part: Event) => {try {return JSON.parse(part.text);} catch {return null;}})
      .find((record: Event | null) => record?.type === 'additional_tools');
    assert.deepEqual(record.tools[0].format, format);
    assert.deepEqual(body.output_config.format.schema.properties.calls.items.anyOf[0].properties.name.enum, ['functions.exec']);
  }
});

for (const [name, over, req, mapped, code] of [
  ['unknown price', {options: {prices: {}}}, {}, model, 'api_price_unknown'],
  ['unresolved alias', {}, {}, {...model, resolvedModel: undefined}, 'api_model_unresolved'],
  ['changed model', {capability: capability({id: 'claude-other'})}, {}, model, 'api_model_mismatch'],
  ['missing capacity', {capability: capability({max_input_tokens: null})}, {}, model, 'api_capabilities_unknown'],
  ['excess output', {capability: capability({max_tokens: 1000})}, {}, model, 'api_output_limit'],
  ['input plus output overflow', {capability: capability({max_input_tokens: 2099})}, {}, model, 'api_context_limit'],
  ['unsupported effort', {}, {reasoning: {effort: 'ultra'}}, model, 'api_unsupported_effort'],
  ['unknown token count', {tokens: {input_tokens: -1}}, {}, model, 'api_invalid_token_count'],
] as const) test(`preflight rejects ${name} without paid inference`, async () => {
  const {runner, calls} = fixture(over);
  await assert.rejects(runner.prepare(request(req), mapped, signal()), rejects(code));
  assert.equal(calls.filter(c => c.url.endsWith('/messages')).length, 0);
});

test('oversized UTF-8 request fails before count or inference and without truncation', async () => {
  const {runner, calls} = fixture();
  await assert.rejects(runner.prepare(request({input: '字'.repeat(11_000_000)}), model, signal()), rejects('api_request_too_large'));
  assert.equal(calls.filter(c => c.url.includes('/messages')).length, 0);
});

for (const [name, source, code] of [
  ['premature EOF', () => events().slice(0, -1), 'api_incomplete_stream'],
  ['max tokens', () => events(undefined, {stop: 'max_tokens'}), 'api_output_truncated'],
  ['refusal', () => events(undefined, {stop: 'refusal'}), 'api_refusal'],
  ['upstream error', () => [{type: 'error', error: {type: 'overloaded_error', message: 'sensitive-upstream'}}], 'api_stream_error'],
  ['missing final usage', () => events().filter(e => e.type !== 'message_delta'), 'api_missing_usage'],
  ['invalid tool arguments', () => events({text: '', calls: [{kind: 'function', name: 'unknown', arguments: {}}]}), 'api_invalid_decision'],
  ['wrong model', () => events(undefined, {model: 'claude-other'}), 'api_model_mismatch'],
  ['unclosed block', () => events().filter(e => e.type !== 'content_block_stop'), 'api_invalid_stream'],
  ['malformed JSON', () => 'event: message_start\ndata: not-json\n\n', 'api_invalid_stream'],
  ['invalid usage', () => events(undefined, {usage: {output_tokens: -1}}), 'api_missing_usage'],
] as const) test(`paid ${name} fails safely without retry`, async () => {
  const {runner, calls} = fixture({response: () => stream(source())});
  const step = await runner.prepare(request(), model, signal());
  await assert.rejects(step.execute(signal()), rejects(code));
  assert.equal(calls.filter(c => c.url.endsWith('/messages')).length, 1);
});

for (const [status, code] of [[401, 'api_auth'], [403, 'api_auth'], [429, 'api_rate_limit'], [400, 'api_http_error'],
  [402, 'api_http_error'], [500, 'api_http_error']] as const) test(`HTTP ${status} is safely classified without retry`, async () => {
  const {runner, calls} = fixture({response: () => new Response('sensitive-upstream fake-secret', {status,
    headers: {'request-id': 'req_http_fixture', 'x-secret': 'fake-secret'}})});
  const step = await runner.prepare(request(), model, signal());
  await assert.rejects(step.execute(signal()), error => {
    rejects(code)(error);
    assert.ok(error instanceof BridgeError);
    assert.deepEqual(error.details, {http_status: String(status), request_id: 'req_http_fixture'});
    return true;
  });
  assert.equal(calls.length, 3);
});

test('count token payload preserves every prompt field while excluding inference-only cache policy', async () => {
  const {runner, calls} = fixture();
  const step = await runner.prepare(request({reasoning: {effort: 'high'}}), model, signal());
  await step.execute(signal());
  const counted = JSON.parse(String(calls[1]!.init.body));
  const sent = JSON.parse(String(calls[2]!.init.body));
  const {cache_control, max_tokens, stream, service_tier, inference_geo, ...samePrompt} = sent;
  assert.deepEqual(counted, samePrompt);
  assert.deepEqual(cache_control, {type: 'ephemeral'});
});

test('network and credential failures never expose their original errors', async () => {
  for (const options of [{credentials: async () => {throw Error('sensitive-upstream fake-secret');}},
    {fetchImpl: async () => {throw Error('sensitive-upstream fake-secret');}}]) {
    const {runner} = fixture({options});
    await assert.rejects(runner.prepare(request(), model, signal()), error => {
      assert.ok(error instanceof BridgeError);
      assert.equal(error.status, 424);
      assert.doesNotMatch(error.message, /fake-secret|sensitive-upstream/);
      return true;
    });
  }
});

test('cancellation interrupts an idle stream and cancels its reader', async () => {
  let cancelled = false;
  const {runner} = fixture({response: () => new Response(new ReadableStream({cancel() {cancelled = true;}}),
    {headers: {'content-type': 'text/event-stream'}})});
  const step = await runner.prepare(request(), model, signal());
  const controller = new AbortController();
  const result = step.execute(controller.signal);
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(result, rejects('api_aborted'));
  assert.equal(cancelled, true);
});

test('oversized stream frame is bounded and withheld', async () => {
  const {runner} = fixture({response: () => stream('data: ' + 'x'.repeat(2_200_000), 65536)});
  const step = await runner.prepare(request(), model, signal());
  await assert.rejects(step.execute(signal()), rejects('api_stream_too_large'));
});

for (const [name, usage, cost] of [
  ['cold write', {input_tokens: 10, cache_creation_input_tokens: 90, cache_read_input_tokens: 0}, 0.0005475],
  ['warm hit', {input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 90}, 0.000237],
  ['below threshold or miss', {input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0}, 0.00048],
  ['expired rewritten cache', {input_tokens: 10, cache_creation_input_tokens: 90, cache_read_input_tokens: 0,
    cache_creation: {ephemeral_5m_input_tokens: 90, ephemeral_1h_input_tokens: 0}}, 0.0005475],
] as const) test(`cache ${name} keeps full current context and accounts actual usage`, async () => {
  const {runner} = fixture({response: () => stream(events(undefined, {usage}))});
  const step = await runner.prepare(request(), model, signal());
  assert.equal(step.reservationUsd, 0.034215);
  const result = await step.execute(signal());
  assert.equal(result.result.usage.input_tokens, 100);
  assert.equal(result.costUsd, cost);
  assert.equal(result.cacheCreationInputTokens, usage.cache_creation_input_tokens);
});

test('cache off preserves ordinary input reservation and omits cache control', async () => {
  const {runner, calls} = fixture({options: {cache: 'off'}});
  const step = await runner.prepare(request(), model, signal());
  assert.equal(step.reservationUsd, 0.033372);
  await step.execute(signal());
  assert.equal(JSON.parse(String(calls.at(-1)!.init.body)).cache_control, undefined);
});

test('unknown billed server tools fail closed', async () => {
  const {runner} = fixture({response: () => stream(events(undefined, {usage: {server_tool_use: {web_search_requests: 1}}}))});
  const step = await runner.prepare(request(), model, signal());
  await assert.rejects(step.execute(signal()), rejects('api_unexpected_billing'));
});

test('an upstream BridgeError cannot bypass error redaction', async () => {
  const {runner} = fixture({options: {fetchImpl: async () => {throw new BridgeError(424, 'api_external', 'sensitive-upstream fake-secret');}}});
  await assert.rejects(runner.prepare(request(), model, signal()), rejects('api_transport_error'));
});

test('a truncated partial JSON decision reports the output limit', async () => {
  const partial = events(undefined, {stop: 'max_tokens'});
  partial[7]!.delta.text = '{broken';
  const {runner} = fixture({response: () => stream(partial)});
  const step = await runner.prepare(request(), model, signal());
  await assert.rejects(step.execute(signal()), error => {
    rejects('api_output_truncated')(error);
    assert.ok(error instanceof BridgeError);
    assert.equal(error.details.stream_stop_reason, 'max_tokens');
    assert.equal(error.details.stream_reason, 'output_truncated');
    return true;
  });
});

test('missing optional cache usage fields normalize to zero and pings do not count as model activity', async () => {
  const source = events();
  delete source[0]!.message.usage.cache_read_input_tokens;
  delete source[0]!.message.usage.cache_creation_input_tokens;
  source.splice(1, 0, {type: 'ping'}, {type: 'ping'});
  const {runner} = fixture({response: () => stream(source)});
  const step = await runner.prepare(request(), model, signal());
  let activity = 0;
  const result = await step.execute(signal(), () => activity++);
  assert.equal(activity, 10);
  assert.equal(result.result.usage.input_tokens, 80);
  assert.equal(result.cacheReadInputTokens, 0);
  assert.equal(result.cacheCreationInputTokens, 0);
});

test('preflight aborts credential loading promptly before any network call', async () => {
  const {runner, calls} = fixture({options: {credentials: () => new Promise(() => {})}});
  const controller = new AbortController();
  const result = runner.prepare(request(), model, controller.signal);
  controller.abort();
  await assert.rejects(result, rejects('api_aborted'));
  assert.equal(calls.length, 0);
});

test('prepare signal cancellation remains effective during execute', async () => {
  const {runner, calls} = fixture();
  const controller = new AbortController();
  const step = await runner.prepare(request(), model, controller.signal);
  controller.abort();
  await assert.rejects(step.execute(signal()), rejects('api_aborted'));
  assert.equal(calls.length, 2);
});

test('server-reported unsupported effort cannot be silently dropped', async () => {
  const info = capability();
  info.capabilities.effort.high = {supported: false};
  const {runner, calls} = fixture({capability: info});
  await assert.rejects(runner.prepare(request({reasoning: {effort: 'high'}}), model, signal()), rejects('api_unsupported_effort'));
  assert.equal(calls.length, 1);
});

test('one JSON decision can return eight parallel Codex subagent calls', async () => {
  const calls = Array.from({length: 8}, (_, index) => ({kind: 'function', name: 'spawn_agent', input: JSON.stringify({task: `Task ${index + 1}`})}));
  const {runner} = fixture({response: () => stream(events({text: '', calls}))});
  const step = await runner.prepare(request({parallel_tool_calls: true,
    tools: [{type: 'function', name: 'spawn_agent', parameters: {type: 'object'}}]}), model, signal());
  assert.deepEqual((await step.execute(signal())).result.decision.calls, calls);
});

test('JSON API envelope preserves arbitrary nested function arguments and raw custom text', async () => {
  const args = {nested: {'arbitrary key': [{text: '你好 👋 "quoted"\nnext line\\path', enabled: true, absent: null}]},
    numeric: 4.25, list: ['another\tvalue', 0, false], extra: {notDeclaredByTheEnvelope: 'preserved'}};
  const raw = '*** Begin Patch\n+ 中文 "quote" \\path 👋\n*** End Patch';
  const decision = {text: '', calls: [{kind: 'function', name: 'lookup', input: JSON.stringify(args)},
    {kind: 'custom', name: 'apply_patch', input: raw}]};
  const {runner, calls} = fixture({response: () => stream(events(decision), 3)});
  const history = 'Keep my history: 中文 "quotes"\nnext line\\path 👋';
  const step = await runner.prepare(request({reasoning: {effort: 'max'}, input: history,
    tools: [{type: 'function', name: 'lookup', parameters: {type: 'object', additionalProperties: true}},
      {type: 'custom', name: 'apply_patch'}]}), model, signal());
  const result = await step.execute(signal());
  assert.equal(result.result.decision.calls[0]!.input, JSON.stringify(args));
  assert.deepEqual(JSON.parse(result.result.decision.calls[0]!.input), args);
  assert.equal(result.result.decision.calls[1]!.input, raw);
  for (const call of calls.filter(call => call.url.includes('/messages'))) {
    const body = JSON.parse(String(call.init.body)), schema = body.output_config.format.schema;
    assert.equal(body.tools, undefined);
    assert.equal(body.output_config.format.type, 'json_schema');
    assert.equal(schema.type, 'object');
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.required, ['text', 'calls']);
    assert.deepEqual(Object.keys(schema.properties).sort(), ['calls', 'text']);
    const items = schema.properties.calls.items;
    assert.equal(items.anyOf.length, 2);
    for (const branch of items.anyOf) {
      assert.equal(branch.additionalProperties, false);
      assert.deepEqual(branch.required, ['kind', 'name', 'input']);
      assert.deepEqual(Object.keys(branch.properties).sort(), ['input', 'kind', 'name']);
      assert.equal(branch.properties.input.type, 'string');
    }
    assert.deepEqual(items.anyOf[0].properties.kind.enum, ['function']);
    assert.deepEqual(items.anyOf[0].properties.name.enum, ['lookup']);
    assert.deepEqual(items.anyOf[1].properties.kind.enum, ['custom']);
    assert.deepEqual(items.anyOf[1].properties.name.enum, ['apply_patch']);
    assert.equal(schema.properties.calls.maxItems, undefined);
    assert.equal(body.tool_choice, undefined);
    assert.deepEqual(body.thinking, {type: 'adaptive'});
    assert.equal(body.output_config.effort, 'max');
    const record = body.messages[0].content.filter((part: Event) => part.type === 'text')
      .map((part: Event) => {try {return JSON.parse(part.text);} catch {return null;}})
      .find((record: Event | null) => record?.role === 'user');
    assert.ok(JSON.stringify(record).includes(JSON.stringify(history).slice(1, -1)));
  }
});

test('API transport rules replace only the adapter sentence and follow all supplied system instructions', async () => {
  const sharedRule = 'For each call, name must be an exact available tool key. kind is function or custom. For a function tool put its parameters as a JSON object in "arguments" (not a string). For a custom tool put the raw text/code/patch matching its full format in "input". Never use your own tools except StructuredOutput.';
  const instructions = `${sharedRule}\n\nPreserve this user-supplied instruction exactly.`;
  const {runner, calls} = fixture();
  await runner.prepare(request({instructions, tools: [{type: 'function', name: 'lookup', parameters: {type: 'object'}}]}), model, signal());
  const system = JSON.parse(String(calls[1]!.init.body)).system as string;
  assert.ok(system.includes(instructions));
  assert.equal(system.split(sharedRule).length - 1, 1);
  assert.match(system, /JSON-encoded.*"input"/);
  assert.match(system, /custom tool.*raw text\/code\/patch.*"input"/);
  assert.ok(system.lastIndexOf('Your entire response is one JSON object') > system.lastIndexOf('Available Codex tools:'));
});

for (const support of [{supported: false}, null, undefined, {supported: 'true'}]) {
  test(`unverified JSON structured output capability ${JSON.stringify(support)} prevents counting and paid inference`, async () => {
    const info = capability();
    (info.capabilities as Event).structured_outputs = support;
    const {runner, calls} = fixture({capability: info});
    await assert.rejects(runner.prepare(request(), model, signal()), rejects('api_structured_output_unsupported'));
    assert.equal(calls.length, 1);
  });
}

for (const blockType of ['tool_use', 'server_tool_use']) test(`unavailable native ${blockType} is rejected without retry`, async () => {
  const source = events();
  source[5]!.content_block = {type: blockType, id: 'toolu_fixture', name: 'codex_decision', input: {}};
  const {runner, calls} = fixture({response: () => stream(source)});
  const step = await runner.prepare(request(), model, signal());
  await assert.rejects(step.execute(signal()), error => {
    rejects('api_invalid_stream')(error);
    assert.ok(error instanceof BridgeError);
    assert.equal(error.details.stream_reason, 'unexpected_tool_use');
    assert.doesNotMatch(JSON.stringify(error.details), /codex_decision/);
    return true;
  });
  assert.equal(calls.filter(call => call.url.endsWith('/messages')).length, 1);
});

for (const [count, extra] of [[17, {}], [2, {parallel_tool_calls: false}], [1, {tool_choice: 'none'}]] as const) {
  test(`local decision guards still reject ${count} calls with ${JSON.stringify(extra)} with JSON wire schema`, async () => {
    const calls = Array.from({length: count}, () => ({kind: 'function', name: 'lookup', input: '{"x":1}'}));
    const {runner} = fixture({response: () => stream(events({text: '', calls}))});
    const step = await runner.prepare(request({...extra, tools: [{type: 'function', name: 'lookup', parameters: {type: 'object'}}]}), model, signal());
    await assert.rejects(step.execute(signal()), error => {
      rejects('api_invalid_decision')(error);
      assert.ok(error instanceof BridgeError);
      assert.equal(error.details.stream_reason, 'invalid_decision');
      assert.equal(error.details.stream_stop_reason, 'end_turn');
      return true;
    });
  });
}

const messageStartBytes = () => new TextEncoder().encode(`data: ${JSON.stringify(events()[0])}\n\n`);
function brokenStream(chunks: Uint8Array[], failRead = false) {
  return new Response(new ReadableStream<Uint8Array>({pull(controller) {
    const chunk = chunks.shift();
    if (chunk) controller.enqueue(chunk);
    else if (failRead) controller.error(new Error('sensitive-upstream fake-secret'));
    else controller.close();
  }}), {headers: {'content-type': 'text/event-stream', 'request-id': 'req_diagnostic'}});
}

for (const [name, response, reason, phase] of [
  ['body read failure', () => brokenStream([messageStartBytes()], true), 'body_read_error', 'read'],
  ['invalid UTF-8', () => brokenStream([messageStartBytes(), new Uint8Array([0xff])]), 'invalid_utf8', 'decode'],
  ['invalid event JSON', () => brokenStream([messageStartBytes(), new TextEncoder().encode('data: sensitive-upstream fake-secret\n\n')]), 'invalid_event_json', 'frame'],
] as const) test(`${name} retains only verified stream identity and a specific diagnostic`, async () => {
  const {runner} = fixture({response});
  const step = await runner.prepare(request(), model, signal());
  await assert.rejects(step.execute(signal()), error => {
    rejects('api_invalid_stream')(error);
    assert.ok(error instanceof BridgeError);
    assert.equal(error.details.request_id, 'req_diagnostic');
    assert.equal(error.details.message_id, 'msg_fixture');
    assert.equal(error.details.actual_model, MODEL);
    assert.equal(error.details.stream_reason, reason);
    assert.equal(error.details.stream_phase, phase);
    assert.doesNotMatch(JSON.stringify(error.details), /sensitive-upstream|fake-secret|usage|cost|tokens/);
    assert.ok(Object.values(error.details).every(value => typeof value === 'string'));
    return true;
  });
});

test('cancellation after message start preserves verified identity without claiming usage', async () => {
  const response = new Response(new ReadableStream({start(controller) {controller.enqueue(messageStartBytes());}}),
    {headers: {'content-type': 'text/event-stream', 'request-id': 'req_cancelled'}});
  const {runner} = fixture({response: () => response});
  const step = await runner.prepare(request(), model, signal());
  const controller = new AbortController();
  await assert.rejects(step.execute(controller.signal, () => controller.abort()), error => {
    rejects('api_aborted')(error);
    assert.ok(error instanceof BridgeError);
    assert.equal(error.details.request_id, 'req_cancelled');
    assert.equal(error.details.message_id, 'msg_fixture');
    assert.equal(error.details.actual_model, MODEL);
    assert.equal(error.details.stream_reason, 'cancelled');
    assert.equal(error.details.cost_usd, undefined);
    return true;
  });
});

test('wrong response model and invalid request IDs cannot introduce arbitrary diagnostic text', async () => {
  const response = stream(events(undefined, {model: 'sensitive-upstream fake-secret'}));
  response.headers.set('request-id', 'sensitive-upstream fake-secret');
  const {runner} = fixture({response: () => response});
  const step = await runner.prepare(request(), model, signal());
  await assert.rejects(step.execute(signal()), error => {
    rejects('api_model_mismatch')(error);
    assert.ok(error instanceof BridgeError);
    assert.equal(error.details.message_id, 'msg_fixture');
    assert.equal(error.details.request_id, undefined);
    assert.equal(error.details.actual_model, undefined);
    assert.equal(error.details.stream_reason, 'model_mismatch');
    assert.doesNotMatch(JSON.stringify(error.details), /sensitive-upstream|fake-secret/);
    return true;
  });
});

for (const [source, code] of [
  [() => new Response('sensitive-upstream fake-secret', {headers: {'request-id': 'req_metadata'}}), 'api_invalid_metadata'],
  [() => Response.json(capability({id: 'claude-other'}), {headers: {'request-id': 'req_metadata'}}), 'api_model_mismatch'],
  [() => new Response('sensitive-upstream fake-secret', {status: 403, headers: {'request-id': 'req_metadata'}}), 'api_auth'],
] as const) test(`preflight ${code} retains its own request ID without response content`, async () => {
  const {runner, calls} = fixture({fetch: async () => source()});
  await assert.rejects(runner.prepare(request(), model, signal()), error => {
    rejects(code)(error);
    assert.ok(error instanceof BridgeError);
    assert.equal(error.details.request_id, 'req_metadata');
    assert.doesNotMatch(JSON.stringify(error.details), /sensitive-upstream|fake-secret/);
    return true;
  });
  assert.equal(calls.length, 1);
});

for (const [event, reason, expected] of [
  [{type: 'message_start', message: events()[0]!.message}, 'duplicate_message_start', {}],
  [{type: 'content_block_start', index: -1, content_block: {type: 'text'}}, 'invalid_block_index', {stream_block_type: 'text'}],
  [{type: 'content_block_start', index: 1, content_block: {type: 'text'}}, 'nonsequential_block_index', {stream_block_index: '1'}],
  [{type: 'content_block_start', index: 0}, 'invalid_block_start', {stream_block_index: '0'}],
  [{type: 'content_block_start', index: 0, content_block: {type: 'tool_use', name: 'sensitive-upstream fake-secret', input: {}}}, 'unexpected_tool_use', {stream_block_type: 'tool_use'}],
  [{type: 'content_block_start', index: 0, content_block: {type: 'tool_use', name: 'codex_decision', input: null}}, 'unexpected_tool_use', {stream_block_type: 'tool_use'}],
  [{type: 'content_block_delta', index: 0, delta: {type: 'sensitive-upstream fake-secret'}}, 'unknown_block_index', {stream_delta_type: undefined}],
] as const) test(`invalid stream ${reason} identifies the failing protocol branch without copying upstream text`, async () => {
  const {runner} = fixture({response: () => stream([events()[0]!, event])});
  const step = await runner.prepare(request(), model, signal());
  await assert.rejects(step.execute(signal()), error => {
    rejects('api_invalid_stream')(error);
    assert.ok(error instanceof BridgeError);
    assert.equal(error.details.stream_reason, reason);
    assert.equal(error.details.stream_phase, 'event');
    assert.equal(error.details.stream_event, event.type);
    for (const [key, value] of Object.entries(expected)) assert.equal(error.details[key], value);
    assert.doesNotMatch(JSON.stringify(error.details), /sensitive-upstream|fake-secret/);
    return true;
  });
});

test('an upstream error event keeps verified identity without copying its error object', async () => {
  const {runner} = fixture({response: () => stream([events()[0]!,
    {type: 'error', error: {type: 'sensitive-upstream', message: 'fake-secret', cost_usd: 50}}])});
  const step = await runner.prepare(request(), model, signal());
  await assert.rejects(step.execute(signal()), error => {
    rejects('api_stream_error')(error);
    assert.ok(error instanceof BridgeError);
    assert.deepEqual(error.details, {request_id: 'req_fixture', message_id: 'msg_fixture', actual_model: MODEL,
      stream_phase: 'event', stream_event: 'error', stream_reason: 'stream_error', decision_text_blocks: '0'});
    return true;
  });
});

test('an invalid inference content type preserves the inference ID before parsing begins', async () => {
  const {runner} = fixture({response: () => new Response('sensitive-upstream fake-secret', {headers: {'request-id': 'req_wrong_type'}})});
  const step = await runner.prepare(request(), model, signal());
  await assert.rejects(step.execute(signal()), error => {
    rejects('api_invalid_stream')(error);
    assert.ok(error instanceof BridgeError);
    assert.deepEqual(error.details, {request_id: 'req_wrong_type', stream_phase: 'response', stream_reason: 'invalid_content_type', decision_text_blocks: '0'});
    return true;
  });
});

for (const geo of ['us', 'unexpected', null, undefined]) test(`supported model with unverified response geo ${geo} cannot settle at global rates`, async () => {
  const source = events();
  source[0]!.message.usage.inference_geo = geo;
  const {runner} = fixture({response: () => stream(source)});
  const step = await runner.prepare(request(), model, signal());
  await assert.rejects(step.execute(signal()), rejects('api_unexpected_billing'));
});

for (const id of ['claude-opus-4-5-20251101', 'claude-haiku-4-5-20251001']) test(`legacy ${id} omits unsupported geo parameter and accepts legacy usage`, async () => {
  const legacyModel = {...model, resolvedModel: id};
  const source = events(undefined, {model: id});
  source[0]!.message.usage.inference_geo = null;
  const {runner, calls} = fixture({capability: capability({id}), options: {prices: API_PRICES}, response: () => stream(source)});
  const step = await runner.prepare(request(), legacyModel, signal());
  const result = await step.execute(signal());
  assert.equal(result.actualModel, id);
  assert.equal(JSON.parse(String(calls.at(-1)!.init.body)).inference_geo, undefined);
});

for (const [name, deltaUsage, expectedInput, expectedRead, expectedCreated, expectedCost] of [
  ['missing fields', {}, 80, 20, 10, 0.0004635],
  ['null fields', {input_tokens: null, cache_read_input_tokens: null, cache_creation_input_tokens: null, inference_geo: null}, 80, 20, 10, 0.0004635],
  ['explicit zeros', {input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0}, 0, 0, 0, 0.00018],
  ['replacement totals', {input_tokens: 5, cache_read_input_tokens: 40, cache_creation_input_tokens: 20}, 5, 40, 20, 0.000282],
] as const) test(`message delta ${name} preserve cumulative usage semantics`, async () => {
  const source = events(undefined, {usage: deltaUsage});
  source[0]!.message.usage.cache_creation_input_tokens = 10;
  const {runner} = fixture({response: () => stream(source)});
  const step = await runner.prepare(request(), model, signal());
  const result = await step.execute(signal());
  assert.equal(result.inputTokens, expectedInput);
  assert.equal(result.cacheReadInputTokens, expectedRead);
  assert.equal(result.cacheCreationInputTokens, expectedCreated);
  assert.equal(result.result.usage.input_tokens, expectedInput + expectedRead + expectedCreated);
  assert.equal(result.costUsd, expectedCost);
});

test('null delta metadata cannot erase prior billed tool or geography evidence', async () => {
  for (const prior of [{server_tool_use: {web_search_requests: 1}}, {inference_geo: 'us'}]) {
    const source = events(undefined, {usage: {server_tool_use: null, inference_geo: null}});
    Object.assign(source[0]!.message.usage, prior);
    const {runner} = fixture({response: () => stream(source)});
    const step = await runner.prepare(request(), model, signal());
    await assert.rejects(step.execute(signal()), rejects('api_unexpected_billing'));
  }
});

test('null delta metadata preserves cache duration and reasoning breakdown', async () => {
  const source = events(undefined, {usage: {cache_creation: null, output_tokens_details: null}});
  Object.assign(source[0]!.message.usage, {cache_creation: {ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0},
    output_tokens_details: {thinking_tokens: 5}});
  const {runner} = fixture({response: () => stream(source)});
  const step = await runner.prepare(request(), model, signal());
  assert.equal((await step.execute(signal())).result.usage.output_tokens_details.reasoning_tokens, 5);
});

for (const [name, input, read, created, expectedCost] of [
  ['100000 uncached', 100000, 0, 0, 0.010006],
  ['100001 uncached', 100001, 0, 0, 0.0500305],
  ['100000 including cache reads and writes', 1, 99998, 1, 0.001006205],
  ['100001 including cache reads and writes', 1, 99999, 1, 0.005031075],
  ['100000 including cache writes', 50000, 0, 50000, 0.011256],
  ['100001 including cache writes', 50000, 0, 50001, 0.056280625],
] as const) test(`official Haiku 5.5 rates settle ${name} using the whole prompt`, async () => {
  const id = 'claude-haiku-5-5';
  const haiku = {...model, resolvedModel: id};
  const source = events(undefined, {model: id, usage: {input_tokens: input, cache_read_input_tokens: read,
    cache_creation_input_tokens: created}});
  const {runner} = fixture({capability: capability({id}), tokens: {input_tokens: 100000}, options: {prices: API_PRICES}, response: () => stream(source)});
  const step = await runner.prepare(request(), haiku, signal());
  assert.equal(step.reservationUsd, 0.06875);
  const result = await step.execute(signal());
  assert.equal(result.result.usage.input_tokens, input + read + created);
  assert.equal(result.costUsd, expectedCost);
  assert.ok(result.costUsd < step.reservationUsd);
});


test('a final JSON answer survives split text deltas and UTF-8 byte boundaries after thinking', async () => {
  const decision = {text: '已完成 👋 "quoted"\n第二行\\path', calls: []};
  const source = events(decision);
  const json = JSON.stringify(decision);
  source.splice(6, 2, ...[json.slice(0, 19), json.slice(19, 25), json.slice(25)].map(text =>
    ({type: 'content_block_delta', index: 1, delta: {type: 'text_delta', text}})));
  const {runner} = fixture({response: () => stream(source, 1)});
  const step = await runner.prepare(request(), model, signal());
  assert.deepEqual((await step.execute(signal())).result.decision, decision);
});

for (const [name, source, reason, stop, count] of [
  ['no text blocks', () => events().filter(e => e.index !== 1), 'missing_decision_text', 'end_turn', '0'],
  ['empty text', () => events().filter(e => e.type !== 'content_block_delta' || e.index !== 1), 'missing_decision_text', 'end_turn', '1'],
  ['stop sequence', () => events(undefined, {stop: 'stop_sequence'}), 'unexpected_stop_reason', 'stop_sequence', '1'],
  ['tool stop', () => events(undefined, {stop: 'tool_use'}), 'unexpected_stop_reason', 'tool_use', '1'],
  ['pause turn', () => events(undefined, {stop: 'pause_turn'}), 'unexpected_stop_reason', 'pause_turn', '1'],
  ['unknown stop', () => events(undefined, {stop: 'sensitive-upstream fake-secret'}), 'unexpected_stop_reason', undefined, '1'],
  ['malformed decision JSON', () => {const data = events(); data[6]!.delta.text = '{broken'; return data;}, 'invalid_decision_json', 'end_turn', '1'],
  ['unknown Codex tool', () => events({text: '', calls: [{kind: 'function', name: 'unknown', input: '{}'}]}), 'invalid_decision', 'end_turn', '1'],
] as const) test(`${name} yields a specific private-safe JSON decision diagnostic`, async () => {
  const {runner, calls} = fixture({response: () => stream(source())});
  const step = await runner.prepare(request(), model, signal());
  await assert.rejects(step.execute(signal()), error => {
    rejects('api_invalid_decision')(error);
    assert.ok(error instanceof BridgeError);
    assert.equal(error.details.stream_reason, reason);
    assert.equal(error.details.stream_stop_reason, stop);
    assert.equal(error.details.decision_text_blocks, count);
    assert.equal(error.details.decision_tool, undefined);
    assert.doesNotMatch(JSON.stringify(error.details), /你好|broken|sensitive-upstream|fake-secret|"unknown"/);
    return true;
  });
  assert.equal(calls.filter(call => call.url.endsWith('/messages')).length, 1);
});

test('decision text is bounded across multiple text blocks', async () => {
  const source = events();
  const chunks: Event[] = [];
  for (let index = 1; index <= 9; index++) chunks.push(
    {type: 'content_block_start', index, content_block: {type: 'text', text: ''}},
    {type: 'content_block_delta', index, delta: {type: 'text_delta', text: 'x'.repeat(1_000_000)}},
    {type: 'content_block_stop', index});
  source.splice(5, 4, ...chunks);
  const {runner} = fixture({response: () => stream(source, 65536)});
  const step = await runner.prepare(request(), model, signal());
  await assert.rejects(step.execute(signal()), error => {
    rejects('api_stream_too_large')(error);
    assert.ok(error instanceof BridgeError);
    assert.equal(error.details.stream_reason, 'decision_size_limit');
    return true;
  });
});


test('a redacted thinking block and sequential text blocks produce one complete decision', async () => {
  const source = events();
  source[2]!.content_block = {type: 'redacted_thinking', data: 'private thinking'};
  source.splice(3, 1);
  source.splice(8, 0,
    {type: 'content_block_start', index: 2, content_block: {type: 'text', text: ''}},
    {type: 'content_block_delta', index: 2, delta: {type: 'text_delta', text: ' \n'}},
    {type: 'content_block_stop', index: 2});
  const {runner, calls} = fixture({response: () => stream(source)});
  const step = await runner.prepare(request(), model, signal());
  assert.deepEqual((await step.execute(signal())).result.decision, {text: '你好 👋', calls: []});
  const schema = JSON.parse(String(calls[1]!.init.body)).output_config.format.schema;
  assert.equal(schema.properties.calls.items.properties.name.enum, undefined);
});

for (const [name, delta, reason] of [
  ['refusal block', false, 'refusal_block'], ['refusal delta', true, 'refusal_delta'],
] as const) test(`${name} withholds decision text and never retries`, async () => {
  const source = events();
  if (delta) source[6]!.delta = {type: 'refusal_delta', refusal: 'private answer'};
  else source[5]!.content_block = {type: 'refusal', refusal: 'private answer'};
  const {runner, calls} = fixture({response: () => stream(source)});
  const step = await runner.prepare(request(), model, signal());
  await assert.rejects(step.execute(signal()), error => {
    rejects('api_refusal')(error);
    assert.ok(error instanceof BridgeError);
    assert.equal(error.details.stream_reason, reason);
    assert.doesNotMatch(JSON.stringify(error.details), /private answer/);
    return true;
  });
  assert.equal(calls.filter(call => call.url.endsWith('/messages')).length, 1);
});


for (const [label, over, expected] of [
  ['mixed including searched tools', {tools: [{type: 'custom', name: 'apply_patch'}], input: [
    {type: 'tool_search_output', call_id: 'search_1', tools: [{type: 'function', name: 'lookup', parameters: {type: 'object'}}]},
    {role: 'user', content: 'Do it'}]}, [['function', ['lookup']], ['custom', ['apply_patch']]]],
  ['function only', {tools: [{type: 'function', name: 'lookup', parameters: {type: 'object'}}]}, [['function', ['lookup']]]],
  ['custom only', {tools: [{type: 'custom', name: 'apply_patch'}]}, [['custom', ['apply_patch']]]],
  ['no tools', {}, []],
  ['tool choice none', {tool_choice: 'none', tools: [{type: 'function', name: 'lookup', parameters: {type: 'object'}}]}, [['function', ['lookup']]]],
] as const) test(`wire schema pairs tool kinds and keys for ${label} without unsupported limits or empty enums`, async () => {
  const {runner, calls} = fixture();
  await runner.prepare(request(over), model, signal());
  const schema = JSON.parse(String(calls[1]!.init.body)).output_config.format.schema;
  const callSchema = schema.properties.calls;
  const branches = callSchema.items.anyOf;
  if (expected.length) {
    assert.deepEqual(branches.map((branch: Event) => [branch.properties.kind.enum[0], branch.properties.name.enum]), expected);
    for (const branch of branches) {
      assert.equal(branch.type, 'object');
      assert.equal(branch.additionalProperties, false);
      assert.deepEqual(branch.required, ['kind', 'name', 'input']);
      assert.equal(branch.properties.input.type, 'string');
      assert.equal(branch.properties.kind.enum.length, 1);
      if (branch.properties.kind.enum[0] === 'function') assert.match(branch.properties.input.description, /JSON object.*string.*\{\}/);
      else assert.match(branch.properties.input.description, /raw text/i);
    }
  } else {
    assert.equal(branches, undefined);
    assert.equal(callSchema.items.type, 'object');
  }
  if (!expected.length || over.tool_choice === 'none') assert.equal(callSchema.description, 'Leave calls empty.');
  const check = (value: any) => {
    if (!value || typeof value !== 'object') return;
    assert.equal(value.maxItems, undefined);
    if (Array.isArray(value.enum)) assert.ok(value.enum.length > 0);
    for (const nested of Object.values(value)) check(nested);
  };
  check(schema);
});

const diagnosticTools = [{type: 'function', name: 'lookup', parameters: {type: 'object'}}, {type: 'custom', name: 'apply_patch'}];
for (const [label, decision, extra, expected] of [
  ['mismatched custom key', {text: 'private-answer', calls: [{kind: 'function', name: 'apply_patch', input: '{}'}]}, {},
    {decision_rule: 'unknown_tool', decision_tool_kind: 'function', decision_tool: 'apply_patch', decision_calls: '1'}],
  ['unoffered tool', {text: 'private-answer', calls: [{kind: 'custom', name: 'private_unoffered_tool', input: 'private-arguments'}]}, {},
    {decision_rule: 'unknown_tool', decision_tool_kind: 'custom', decision_calls: '1'}],
  ['invalid function JSON', {text: 'private-answer', calls: [{kind: 'function', name: 'lookup', input: 'private-arguments'}]}, {},
    {decision_rule: 'invalid_arguments', decision_tool_kind: 'function', decision_tool: 'lookup', decision_calls: '1'}],
  ['non-object function JSON', {text: 'private-answer', calls: [{kind: 'function', name: 'lookup', input: '[]'}]}, {},
    {decision_rule: 'invalid_arguments', decision_tool_kind: 'function', decision_tool: 'lookup', decision_calls: '1'}],
  ['custom arguments', {text: 'private-answer', calls: [{kind: 'custom', name: 'apply_patch', input: 'private-arguments', arguments: {secret: 'private-arguments'}}]}, {},
    {decision_rule: 'invalid_arguments', decision_tool_kind: 'custom', decision_tool: 'apply_patch', decision_calls: '1'}],
  ['empty decision', {text: '', calls: []}, {}, {decision_rule: 'empty_decision', decision_calls: '0'}],
  ['required call', {text: 'private-answer', calls: []}, {tool_choice: 'required'}, {decision_rule: 'tool_choice', decision_calls: '0'}],
  ['parallel calls', {text: 'private-answer', calls: [{kind: 'function', name: 'lookup', input: '{}'}, {kind: 'function', name: 'lookup', input: '{}'}]},
    {parallel_tool_calls: false}, {decision_rule: 'parallel_calls', decision_calls: '2'}],
  ['invalid shape', {text: 'private-answer', calls: [{kind: 'private-kind', name: 'lookup', input: 'private-arguments'}]}, {},
    {decision_rule: 'invalid_decision', decision_calls: '1'}],
] as const) test(`contract failure diagnostics identify ${label} without retaining model content`, async () => {
  const {runner, calls} = fixture({response: () => stream(events(decision))});
  const step = await runner.prepare(request({tools: diagnosticTools, ...extra}), model, signal());
  await assert.rejects(step.execute(signal()), error => {
    rejects('api_invalid_decision')(error);
    assert.ok(error instanceof BridgeError);
    assert.equal(error.details.stream_reason, 'invalid_decision');
    assert.equal(error.details.stream_stop_reason, 'end_turn');
    assert.equal(error.details.stream_phase, 'validation');
    assert.deepEqual(Object.fromEntries(Object.entries(error.details).filter(([key]) => key.startsWith('decision_') && key !== 'decision_text_blocks')), expected);
    assert.doesNotMatch(JSON.stringify(error.details), /private-|secret/);
    return true;
  });
  assert.equal(calls.filter(call => call.url.endsWith('/messages')).length, 1);
});

test('real API validation diagnostics survive fallback receipt sanitization without prompts, text or arguments', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'api-decision-receipt-')));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const account = 'a'.repeat(64);
  await saveApiConfig(root, {schema_version: 1, enabled: true, dailyLimitUsd: 1, totalLimitUsd: 1, perRequestLimitUsd: .5,
    maxOutputTokens: 2000, confirmedSubscriptionAccount: account, cache: '5m'});
  const {runner, calls} = fixture({response: () => stream(events({text: 'private-answer', calls: [
    {kind: 'function', name: 'apply_patch', input: '{"private-arguments":true}'}]}))});
  const run = fallbackRunner({root, models: [model], account: async () => account,
    subscription: async () => {throw new SubscriptionQuotaError(account, [{type: 'five_hour', resetsAt: Date.now() + 100000}]);},
    api: () => runner});
  const req = request({input: 'private-prompt', tools: diagnosticTools});
  attachStepIdentity(req, {'thread-id': 'api-diagnostic-fixture'});
  await assert.rejects(run(req, signal()), {code: 'api_invalid_decision'});
  const files = await fs.readdir(path.join(root, 'receipts'));
  assert.equal(files.length, 1);
  const raw = await fs.readFile(path.join(root, 'receipts', files[0]!), 'utf8');
  const receipt = JSON.parse(raw);
  assert.equal(receipt.diagnostics.decision_rule, 'unknown_tool');
  assert.equal(receipt.diagnostics.decision_tool_kind, 'function');
  assert.equal(receipt.diagnostics.decision_tool, 'apply_patch');
  assert.equal(receipt.diagnostics.decision_calls, '1');
  assert.equal(receipt.inference_stage, 'sent_outcome_unknown');
  assert.equal(receipt.usage, null);
  assert.doesNotMatch(raw, /private-|fake-secret|Working/);
  await assert.rejects(run(req, signal()), {code: 'api_duplicate_step'});
  assert.equal(calls.filter(call => call.url.endsWith('/messages')).length, 1);
});

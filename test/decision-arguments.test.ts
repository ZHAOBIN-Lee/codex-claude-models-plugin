import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { completedResponse, responseEnvelope } from '../src/adapter.js';
import { BridgeError, outputSchemaFor, preparePrompt, requestSchema, validateDecision } from '../src/contracts.js';
import { sdkRunner, usageFromModels } from '../src/sdk.js';
import { usageEvent, usageStream, USAGE_MODEL, USAGE_SESSION, type Frame } from './sdk-usage-fixtures.js';

const exec = {type: 'function', name: 'exec_command', parameters: {type: 'object', properties: {cmd: {type: 'string'}}}};
const patch = {type: 'custom', name: 'apply_patch', format: {type: 'text'}};
const request = requestSchema.parse({model: 'claude-sdk-sonnet', input: 'fixture', tools: [exec, patch]});
// Nested quotes, backslashes, newlines and non-ASCII: the shape that broke double-encoded arguments.
const nasty = `python3 -c "import json; print(json.dumps({'a': \\"b\\\\n\\"}))"\necho '中文 "x"' | grep -E "\\\\d+"`;

test('function arguments arrive as an object and reach Codex byte for byte', () => {
  const decision = validateDecision({text: '', calls: [{kind: 'function', name: 'exec_command', arguments: {cmd: nasty}}]}, request);
  assert.deepEqual(decision.calls, [{kind: 'function', name: 'exec_command', input: JSON.stringify({cmd: nasty})}]);
  const item = completedResponse(responseEnvelope(request.model), request, {decision, usage: usageFromModels({})}).output[0]!;
  assert.equal(JSON.parse(String(item.arguments)).cmd, nasty);
});

test('the older JSON-string form is still accepted', () => {
  const decision = validateDecision({text: '', calls: [{kind: 'function', name: 'exec_command', input: JSON.stringify({cmd: 'ls'})}]}, request);
  assert.equal(decision.calls[0]?.input, '{"cmd":"ls"}');
});

test('custom tools keep raw input; misplaced or missing arguments are named in the rejection', () => {
  const ok = validateDecision({text: '', calls: [{kind: 'custom', name: 'apply_patch', input: '*** Begin Patch\n*** End Patch'}]}, request);
  assert.equal(ok.calls[0]?.input, '*** Begin Patch\n*** End Patch');
  const rejection = (calls: unknown[]) => {
    try {validateDecision({text: '', calls}, request);} catch (error) {return error as BridgeError;}
    assert.fail('expected a rejection');
  };
  const custom = rejection([{kind: 'custom', name: 'apply_patch', arguments: {patch: 'x'}}]);
  assert.equal(custom.code, 'invalid_arguments');
  assert.deepEqual({tool: custom.details.tool, kind: custom.details.kind}, {tool: 'apply_patch', kind: 'custom'});
  for (const call of [{kind: 'function', name: 'exec_command'}, {kind: 'function', name: 'exec_command', input: '{"cmd": "unterminated'},
    {kind: 'function', name: 'exec_command', input: '[1]'}]) {
    const error = rejection([call]);
    assert.equal(error.code, 'invalid_arguments');
    assert.equal(error.details.tool, 'exec_command');
    assert.ok(!JSON.stringify(error.details).includes('unterminated'), 'arguments are never echoed');
  }
  assert.equal(rejection([{kind: 'function', name: 'Bash', arguments: {}}]).details.tool, 'Bash');
});

test('the output schema asks for an arguments object and the prompt explains both forms and the reply language', () => {
  const item = outputSchemaFor(request).properties.calls.items;
  assert.deepEqual(item.required, ['kind', 'name']);
  assert.equal(item.properties.arguments.type, 'object');
  assert.equal(item.properties.input.type, 'string');
  const {system} = preparePrompt(request);
  assert.match(system, /JSON object in "arguments" \(not a string\)/);
  assert.match(system, /language of their latest message/);
});

const models = [{id: 'claude-sdk-sonnet', sdkModel: 'sonnet', resolvedModel: USAGE_MODEL, displayName: 'Fixture', description: '', efforts: ['medium']}];
const finalResult = (structured: unknown): Frame => ({type: 'result', subtype: 'success', is_error: false, duration_ms: 100, duration_api_ms: 90,
  num_turns: 2, result: '', stop_reason: 'end_turn', total_cost_usd: 0, permission_denials: [],
  usage: {input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 5},
  modelUsage: {[USAGE_MODEL]: {inputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 5, thinkingTokens: 0,
    webSearchRequests: 0, costUSD: 0, contextWindow: 1000000, maxOutputTokens: 128000}},
  structured_output: structured, session_id: USAGE_SESSION, uuid: '6a0f3c52-8d14-4b7e-a3c9-2e5f7b1d9c84'});
const bad = {text: '', calls: [{kind: 'function', name: 'exec_command', input: '{"cmd": "echo \\"oops'}]};
const good = {text: 'done', calls: [{kind: 'function', name: 'exec_command', arguments: {cmd: nasty}}]};

async function scripted(t: TestContext, outputs: unknown[]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'decision-retry-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const prompts: unknown[] = [];
  const fake = ((args: any) => Object.assign((async function* () {
    for await (const message of args.prompt) prompts.push(message.message.content);
    for (const frame of usageStream(`msg_${prompts.length}`, {input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 5})) yield frame;
    yield finalResult(outputs[prompts.length - 1]);
  })(), {accountInfo: async () => ({apiProvider: 'firstParty', subscriptionType: 'pro'}), close() {}})) as unknown as Parameters<typeof sdkRunner>[2];
  const run = sdkRunner(root, models, fake, {receiptsDir: root, guard: async () => ({coverage: 'test_injected'})});
  const receipt = async () => JSON.parse(await fs.readFile(path.join(root, (await fs.readdir(root)).find(n => n.endsWith('.json'))!), 'utf8'));
  return {run: () => run(request, new AbortController().signal), prompts, receipt};
}

test('a malformed decision is retried once with the reason, and the receipt records it without arguments', async t => {
  const f = await scripted(t, [bad, good]);
  const result = await f.run();
  assert.equal(JSON.parse(result.decision.calls[0]!.input).cmd, nasty);
  assert.equal(f.prompts.length, 2);
  const retry = f.prompts[1] as {type: string; text?: string}[];
  assert.match(String(retry.at(-1)?.text), /rejected by the adapter \(invalid_arguments on exec_command\)/);
  assert.deepEqual(retry.slice(0, -1), f.prompts[0], 'the retry only appends the note, keeping the cached prefix');
  assert.ok(!JSON.stringify(retry).includes('oops'));
  const receipt = await f.receipt();
  assert.equal(receipt.status, 'complete');
  assert.equal(receipt.attempts, 2);
  assert.deepEqual(receipt.rejected, {code: 'invalid_arguments', tool: 'exec_command', kind: 'function'});
  assert.ok(!JSON.stringify(receipt).includes('oops'));
});

test('a second malformed decision fails the step after exactly two queries', async t => {
  const f = await scripted(t, [bad, bad, good]);
  await assert.rejects(f.run(), /invalid function arguments/);
  assert.equal(f.prompts.length, 2);
  const receipt = await f.receipt();
  assert.equal(receipt.status, 'failed');
  assert.equal(receipt.attempts, 2);
});

test('a valid first decision makes one query and records no rejection', async t => {
  const f = await scripted(t, [good]);
  await f.run();
  assert.equal(f.prompts.length, 1);
  assert.ok(!JSON.stringify(f.prompts[0]).includes('rejected by the adapter'));
  const receipt = await f.receipt();
  assert.equal(receipt.attempts, 1);
  assert.equal(receipt.rejected, null);
});

const toolStart = (name: string, parent: string | null = null) => usageEvent({type: 'content_block_start', index: 0,
  content_block: {type: 'tool_use', id: `toolu_${name}`, name, input: {}}}, parent);

// Each attempt: optional direct native call, normal usage frames, the StructuredOutput call, then the final result.
async function nativeScript(t: TestContext, attempts: {native?: string; subagent?: boolean; output: unknown}[]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-call-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const prompts: unknown[] = [];
  const fake = ((args: any) => Object.assign((async function* () {
    for await (const message of args.prompt) prompts.push(message.message.content);
    const step = attempts[prompts.length - 1]!;
    if (step.subagent) yield toolStart('Bash', 'toolu_parent');
    if (step.native) yield toolStart(step.native);
    for (const frame of usageStream(`msg_${prompts.length}`, {input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 5})) yield frame;
    yield toolStart('StructuredOutput');
    yield finalResult(step.output);
  })(), {accountInfo: async () => ({apiProvider: 'firstParty', subscriptionType: 'pro'}), close() {}})) as unknown as Parameters<typeof sdkRunner>[2];
  const run = sdkRunner(root, models, fake, {receiptsDir: root, guard: async () => ({coverage: 'test_injected'})});
  const receipt = async () => JSON.parse(await fs.readFile(path.join(root, (await fs.readdir(root)).find(n => n.endsWith('.json'))!), 'utf8'));
  return {run: () => run(request, new AbortController().signal), prompts, receipt};
}
const broken = {text: 'Codex tools are unavailable', calls: []};

test('a direct native call the model recovers from in the same query is accepted without a retry', async t => {
  const f = await nativeScript(t, [{native: 'exec_command', subagent: true, output: good}]);
  const result = await f.run();
  assert.equal(result.decision.calls[0]?.name, 'exec_command');
  assert.equal(f.prompts.length, 1);
  const receipt = await f.receipt();
  assert.equal(receipt.attempts, 1);
  assert.equal(receipt.rejected, null);
});

test('an answer with no calls after a direct native call is retried once; the note says earlier results are real', async t => {
  const f = await nativeScript(t, [{native: 'exec_command', output: broken}, {output: good}]);
  const result = await f.run();
  assert.equal(result.decision.calls[0]?.name, 'exec_command');
  assert.equal(f.prompts.length, 2);
  const note = String((f.prompts[1] as {text?: string}[]).at(-1)?.text);
  assert.match(note, /rejected by the adapter \(native_tool_call on exec_command\)/);
  assert.match(note, /every tool result already in the conversation was really executed/);
  assert.doesNotMatch(note, /nothing was executed/);
  const receipt = await f.receipt();
  assert.equal(receipt.status, 'complete');
  assert.equal(receipt.attempts, 2);
  assert.deepEqual(receipt.rejected, {code: 'native_tool_call', tool: 'exec_command'});
});

test('the retry is never rejected for a native call, so the turn does not fail', async t => {
  const f = await nativeScript(t, [{native: 'exec_command', output: broken}, {native: 'exec_command', output: {text: 'final answer', calls: []}}]);
  const result = await f.run();
  assert.equal(result.decision.text, 'final answer');
  assert.equal(f.prompts.length, 2);
  assert.equal((await f.receipt()).status, 'complete');
});

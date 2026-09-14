import { test } from 'node:test';
import assert from 'node:assert/strict';
import { completedResponse, completionEvents, responseEnvelope } from '../src/adapter.js';
import { preparePrompt, requestSchema, validateDecision } from '../src/contracts.js';
import { isolatedOptions, sdkRunner, subscriptionEnvironment, usageFromModels } from '../src/sdk.js';
import type { query, SDKMessage, ModelUsage } from '@anthropic-ai/claude-agent-sdk';

const request = requestSchema.parse({model: 'claude-sdk-haiku', instructions: 'System instruction', input: [
  {role: 'developer', content: 'Developer instruction'}, {role: 'user', content: 'User question'},
  {type: 'function_call_output', call_id: 'previous', output: 'An untrusted tool result'},
], tools: [{type: 'namespace', name: 'functions', tools: [
  {type: 'function', name: 'read_file', parameters: {type: 'object', properties: {path: {type: 'string'}}}},
  {type: 'custom', name: 'apply_patch', format: {type: 'text'}},
]}]});

test('preserves role boundaries and function/custom tool payloads', () => {
  const prompt = preparePrompt(request);
  assert.ok(prompt.system.includes('Developer instruction'));
  assert.ok(!prompt.system.includes('An untrusted tool result'));
  assert.ok(prompt.prompt.includes('An untrusted tool result'));
  const decision = validateDecision({text: 'Reading.', calls: [
    {kind: 'function', name: 'functions.read_file', input: '{"path":"a.txt"}'},
    {kind: 'custom', name: 'functions.apply_patch', input: '*** Begin Patch\n*** End Patch'},
  ]}, request);
  const response = completedResponse(responseEnvelope(request.model), request, {decision, usage: usageFromModels({})});
  assert.equal(response.output[1]?.name, 'read_file');
  assert.equal(response.output[1]?.namespace, 'functions');
  assert.equal(response.output[1]?.arguments, '{"path":"a.txt"}');
  assert.equal(response.output[2]?.type, 'custom_tool_call');
  assert.equal(response.output[2]?.input, '*** Begin Patch\n*** End Patch');
  const events = [...completionEvents(response)];
  assert.equal(events.at(-1)?.type, 'response.completed');
  assert.deepEqual(events.filter(e => e.type === 'response.output_item.done').map(e => e.item), response.output);
});

test('rejects unknown tools, malformed calls, unsupported content and missing history', () => {
  assert.throws(() => validateDecision({text: '', calls: [{kind: 'function', name: 'Bash', input: '{}'}]}, request), /not offered/);
  assert.throws(() => validateDecision({text: '', calls: [{kind: 'function', name: 'functions.read_file', input: '[]'}]}, request), /arguments/);
  assert.throws(() => preparePrompt({...request, previous_response_id: 'old'}), /full conversation/);
  assert.throws(() => preparePrompt({...request, input: [{role: 'user', content: [{type: 'input_image', image_url: 'https://example.com/a.png'}]}]}), /text only/);
  assert.throws(() => preparePrompt({...request, tools: [{type: 'computer_use'}]}), /Unsupported Codex tool/);
  assert.throws(() => validateDecision({text: '', calls: []}, request), /no answer/);
});

test('Claude does not advertise OpenAI server-side search as an executable tool', () => {
  const prepared = preparePrompt({...request, tools: [...request.tools, {type: 'web_search'}]});
  assert.equal(prepared.tools.length, 2);
  assert.ok(prepared.system.includes('server-side web search is unavailable'));
});

test('preserves native v2 parent and child messages as labelled conversation records', () => {
  const request = requestSchema.parse({model: 'claude-sdk-haiku', input: [{type: 'agent_message', author: '/root',
    recipient: '/root/child', content: [{type: 'input_text', text: 'Delegation:'},
      {type: 'encrypted_content', encrypted_content: 'Read the fixture and report back.'}]}]});
  const prompt = preparePrompt(request);
  assert.ok(prompt.prompt.includes('Read the fixture and report back.'));
  assert.ok(prompt.prompt.includes('"author": "/root"'));
  assert.ok(!prompt.system.includes('Read the fixture and report back.'));
});

test('only exposes StructuredOutput in the SDK execution boundary', async () => {
  const options = isolatedOptions('/private/runtime');
  assert.deepEqual(options.tools, []);
  assert.deepEqual(options.settingSources, []);
  assert.equal(options.strictMcpConfig, true);
  assert.deepEqual(options.mcpServers, {});
  assert.equal(options.permissionMode, 'dontAsk');
  assert.equal(options.persistSession, false);
  const hook = options.hooks!.PreToolUse![0]!.hooks[0]!;
  const result = await hook({hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {command: 'touch x'},
    session_id: 'test', transcript_path: '', cwd: '/', tool_use_id: 'test'}, undefined, {signal: new AbortController().signal});
  assert.equal('hookSpecificOutput' in result && result.hookSpecificOutput?.hookEventName === 'PreToolUse' && result.hookSpecificOutput.permissionDecision, 'deny');
});

test('subscription environment never forwards API keys or token overrides', () => {
  const env = subscriptionEnvironment({HOME: '/home/test', PATH: '/bin', ANTHROPIC_API_KEY: 'secret',
    ANTHROPIC_AUTH_TOKEN: 'secret', ANTHROPIC_BASE_URL: 'https://example.com', CLAUDE_CODE_OAUTH_TOKEN: 'secret',
    CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CONFIG_DIR: '/custom/login', OPENAI_API_KEY: 'secret', CODEX_API_KEY: 'secret'});
  assert.equal(env.HOME, '/home/test');
  assert.equal(env.CLAUDE_CONFIG_DIR, '/custom/login');
  assert.ok(!Object.values(env).includes('secret'));
  assert.equal(env.CLAUDE_CODE_USE_BEDROCK, undefined);
});

test('uses actual SDK token totals including caches', () => {
  const usage = usageFromModels({a: {inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 30,
    cacheCreationInputTokens: 40, thinkingTokens: 5} as ModelUsage});
  assert.equal(usage.input_tokens, 80);
  assert.equal(usage.total_tokens, 100);
  assert.equal(usage.input_tokens_details.cached_tokens, 30);
});

test('failed and incomplete SDK runs cannot become successful text', async () => {
  let closed = 0;
  const fake = (messages: unknown[]) => (() => Object.assign((async function* () {
    for (const message of messages) yield message as SDKMessage;
  })(), {close() {closed++;}, async accountInfo() {return {apiProvider: 'firstParty', subscriptionType: 'Claude Max'};}})) as unknown as typeof query;
  const model = {id: request.model, sdkModel: 'haiku', displayName: 'Haiku', description: '', efforts: []};
  await assert.rejects(sdkRunner('/tmp', [model], fake([{type: 'result', subtype: 'success', is_error: true,
    result: 'Rate limited'}]))(request, new AbortController().signal), /did not complete/);
  await assert.rejects(sdkRunner('/tmp', [model], fake([]))(request, new AbortController().signal), /without a result/);
  assert.equal(closed, 2);
});

test('no prompt reaches inference when the account is not a subscription', async () => {
  let delivered: Promise<IteratorResult<unknown>> | undefined;
  const fake = ((params: Parameters<typeof query>[0]) => {
    assert.notEqual(typeof params.prompt, 'string');
    delivered = (params.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]().next();
    return Object.assign((async function* () {})(), {close() {}, async accountInfo() {return {apiProvider: 'firstParty'};}});
  }) as unknown as typeof query;
  const model = {id: request.model, sdkModel: 'haiku', displayName: 'Haiku', description: '', efforts: []};
  await assert.rejects(sdkRunner('/tmp', [model], fake)(request, new AbortController().signal), /subscription login/);
  assert.equal((await delivered)!.done, true);
});

test('named tool choice and unsupported structured-answer modes fail explicitly', () => {
  assert.throws(() => validateDecision({text: 'answer', calls: []}, {...request,
    tool_choice: {type: 'function', namespace: 'functions', name: 'read_file'}}), /required named tool/);
  assert.throws(() => preparePrompt({...request, text: {format: {type: 'json_schema', schema: {}}}}), /output-schema mode/);
  assert.throws(() => preparePrompt({...request, background: true}), /Background/);
});

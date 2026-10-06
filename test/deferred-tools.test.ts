import { test } from 'node:test';
import assert from 'node:assert/strict';
import { completedResponse, completionEvents, responseEnvelope } from '../src/adapter.js';
import { availableTools, outputSchemaFor, preparePrompt, requestSchema, validateDecision } from '../src/contracts.js';
import { codexCatalog } from '../src/catalog.js';
import { usageFromModels } from '../src/sdk.js';
import { assertNoRouteOverride, routerEnvironment } from '../src/runtime-policy.js';

// Shapes captured from Codex 0.160.1 with supports_search_tool enabled (no model call).
const toolSearch = {type: 'tool_search', execution: 'client', description: '# Tool discovery\nSearches over deferred tool metadata.',
  parameters: {type: 'object', properties: {query: {type: 'string'}, limit: {type: 'number'}}, required: ['query'], additionalProperties: false}};
const execCommand = {type: 'function', name: 'exec_command', parameters: {type: 'object', properties: {cmd: {type: 'string'}}}};
const searchCall = {type: 'tool_search_call', id: 'tsc_1', call_id: 'call_search_1', status: 'completed', execution: 'client', arguments: {query: 'github pull request', limit: 3}};
const searchOutput = {type: 'tool_search_output', id: 'tso_1', call_id: 'call_search_1', status: 'completed', execution: 'client', tools: [
  {type: 'namespace', name: 'mcp__codex_apps__github', description: 'GitHub', tools: [
    {type: 'function', name: '_get_pull_request', description: 'Read one pull request.', strict: false, defer_loading: true,
      parameters: {type: 'object', properties: {pr_number: {type: 'integer'}}, required: ['pr_number']}},
  ]},
  {type: 'image_generation'},
]};
const ask = {role: 'user', content: 'Check PR 7.'};
const result = (calls: {kind: 'function' | 'custom'; name: string; input: string}[]) => ({decision: {text: '', calls}, usage: usageFromModels({})});

test('tool_search is offered to Claude and guidance explains deferred tools', () => {
  const request = requestSchema.parse({model: 'claude-sdk-opus', input: [ask], tools: [execCommand, toolSearch, {type: 'web_search'}]});
  const prepared = preparePrompt(request);
  assert.deepEqual(prepared.tools.map(t => t.key), ['exec_command', 'tool_search']);
  assert.match(prepared.system, /call tool_search/);
  assert.deepEqual(outputSchemaFor(request).properties.calls.items.properties.name.enum, ['exec_command', 'tool_search']);
});

test('a Claude tool_search decision becomes a client tool_search_call with object arguments', () => {
  const request = requestSchema.parse({model: 'claude-sdk-opus', input: [ask], tools: [execCommand, toolSearch]});
  const decision = validateDecision({text: '', calls: [{kind: 'function', name: 'tool_search', input: '{"query":"github pull request","limit":3}'}]}, request);
  const response = completedResponse(responseEnvelope(request.model), request, {...result([]), decision});
  assert.equal(response.output.length, 1);
  const item = response.output[0]!;
  assert.equal(item.type, 'tool_search_call');
  assert.equal(item.execution, 'client');
  assert.deepEqual(item.arguments, {query: 'github pull request', limit: 3});
  assert.match(String(item.call_id), /^call_/);
  const events = [...completionEvents(response)];
  assert.deepEqual(events.map(e => e.type), ['response.output_item.added', 'response.output_item.done', 'response.completed']);
});

test('tools returned by tool_search become callable on later steps and keep their namespace', () => {
  const request = requestSchema.parse({model: 'claude-sdk-opus', input: [ask, searchCall, searchOutput], tools: [execCommand, toolSearch]});
  assert.ok(availableTools(request).some(t => t.key === 'mcp__codex_apps__github._get_pull_request'));
  const prepared = preparePrompt(request);
  assert.ok(!prepared.system.includes('_get_pull_request'), 'discovered tools stay out of the cached system prompt');
  assert.match(prepared.prompt, /"key": "mcp__codex_apps__github._get_pull_request"/);
  assert.ok(!prepared.prompt.includes('defer_loading'));
  assert.ok(outputSchemaFor(request).properties.calls.items.properties.name.enum!.includes('mcp__codex_apps__github._get_pull_request'));
  const decision = validateDecision({text: '', calls: [{kind: 'function', name: 'mcp__codex_apps__github._get_pull_request', input: '{"pr_number":7}'}]}, request);
  const call = completedResponse(responseEnvelope(request.model), request, {...result([]), decision}).output[0]!;
  assert.deepEqual({type: call.type, namespace: call.namespace, name: call.name, arguments: call.arguments},
    {type: 'function_call', namespace: 'mcp__codex_apps__github', name: '_get_pull_request', arguments: '{"pr_number":7}'});
});

test('tools that were never searched for are still rejected', () => {
  const request = requestSchema.parse({model: 'claude-sdk-opus', input: [ask], tools: [execCommand, toolSearch]});
  assert.throws(() => validateDecision({text: '', calls: [{kind: 'function', name: 'mcp__codex_apps__github._get_pull_request', input: '{}'}]}, request), /not offered/);
});

test('catalog defers tools, accepts images and uses measured context windows', () => {
  const model = (sdkModel: string, resolvedModel?: string) => ({id: `claude-sdk-${sdkModel}`, sdkModel, resolvedModel, displayName: sdkModel, description: '', efforts: ['medium']});
  const catalog = codexCatalog([model('opus', 'claude-opus-5-5'), model('haiku', 'claude-haiku-4-5-20251001'), model('mystery'),
    model('opus[1m]', 'claude-opus-5-5[1m]')]).models;
  assert.ok(catalog.every(m => m.supports_search_tool === true));
  assert.ok(catalog.every(m => m.input_modalities.includes('image')));
  assert.deepEqual(catalog.map(m => [m.context_window, m.auto_compact_token_limit]),
    [[1000000, 750000], [200000, 150000], [200000, 150000], [1000000, 750000]]);
});

test('the router environment drops caller route overrides and agent session markers', () => {
  const env = routerEnvironment({HOME: '/h', PATH: '/bin', ANTHROPIC_BASE_URL: 'http://proxy', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's',
    CLAUDE_CODE_OAUTH_TOKEN: 't', CLAUDE_AGENT_SDK_VERSION: '1', OPENAI_API_KEY: 'k', CODEX_HOME: '/c'});
  assert.deepEqual(Object.keys(env).sort(), ['CODEX_HOME', 'HOME', 'PATH']);
  assert.doesNotThrow(() => assertNoRouteOverride(env));
});

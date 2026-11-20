import {test} from 'node:test';
import assert from 'node:assert/strict';
import {completedResponse, responseEnvelope} from '../src/adapter.js';
import {availableTools, BridgeError, outputSchemaFor, preparePrompt, requestSchema, validateDecision} from '../src/contracts.js';
import {usageFromModels} from '../src/sdk.js';

// Shape observed in Codex 0.163.0-alpha.10.2. GPT code-mode steps leave these records in history; on a Claude step
// Codex does not register the declared code-mode tools, and calling functions.exec fails with "unsupported custom tool call".
const grammar = {type: 'grammar', syntax: 'lark', definition: 'start: /[\\s\\S]+/'};
const declared = [
  {type: 'namespace', name: 'functions', tools: [
    {type: 'custom', name: 'exec', description: 'Execute JavaScript supplied as raw code.', format: grammar},
    {type: 'function', name: 'read_file', description: 'Read a project file.', strict: true,
      parameters: {type: 'object', properties: {path: {type: 'string'}}, required: ['path'], additionalProperties: false}},
  ]},
];
const additions = {type: 'additional_tools', id: 'at_native', role: 'developer', tools: declared};
const ask = {role: 'user', content: 'Read the file.'};
const request = (input: Record<string, unknown>[], tools: Record<string, unknown>[] = []) =>
  requestSchema.parse({model: 'claude-sdk-opus', input, tools});
const badTools = (error: unknown) => error instanceof BridgeError && error.status === 400;

test('historical additional tools are readable context but are not callable on a Claude step', () => {
  const req = request([ask, additions]);
  const prepared = preparePrompt(req);
  const record = JSON.parse(prepared.records[1]!);
  assert.equal(record.type, 'additional_tools');
  assert.equal(record.role, 'developer');
  assert.deepEqual(record.tools[0].format, grammar);
  assert.equal(record.tools[1].strict, true);
  assert.deepEqual(availableTools(req), []);
  assert.deepEqual(prepared.tools, []);
  assert.equal(outputSchemaFor(req).properties.calls.maxItems, 0);
  assert.throws(() => validateDecision({text: '', calls: [{kind: 'custom', name: 'functions.exec', input: 'text(1);'}]}, req), /not offered/);
  assert.throws(() => validateDecision({text: '', calls: [{kind: 'custom', name: 'exec', input: 'text(1);'}]}, req), /not offered/);
});

test('a tool also present in the current request is callable with its namespace and raw input', () => {
  const req = request([ask, additions], declared);
  assert.deepEqual(outputSchemaFor(req).properties.calls.items.properties.name.enum, ['functions.exec', 'functions.read_file']);
  const raw = 'const value = "a\\nb"; text(value);';
  const decision = validateDecision({text: '', calls: [
    {kind: 'custom', name: 'functions.exec', input: raw},
    {kind: 'function', name: 'functions.read_file', arguments: {path: 'README.md'}},
  ]}, req);
  const output = completedResponse(responseEnvelope(req.model), req, {decision, usage: usageFromModels({})}).output;
  assert.deepEqual(output.map(({type, namespace, name, input, arguments: args}) => ({type, namespace, name, input, args})), [
    {type: 'custom_tool_call', namespace: 'functions', name: 'exec', input: raw, args: undefined},
    {type: 'function_call', namespace: 'functions', name: 'read_file', input: undefined, args: '{"path":"README.md"}'},
  ]);
});

test('the prompt tells Claude that additional_tools records are context and lists only callable tools', () => {
  const prepared = preparePrompt(request([ask, additions]));
  assert.match(prepared.system, /additional_tools records/);
  assert.ok(!prepared.system.includes('Execute JavaScript supplied as raw code.'));
  assert.ok(prepared.prompt.includes('Execute JavaScript supplied as raw code.'));
});

test('appending an additional-tools record preserves the cached system and earlier record blocks', () => {
  const before = preparePrompt(request([ask]));
  const after = preparePrompt(request([ask, additions]));
  assert.equal(after.system, before.system);
  assert.deepEqual(after.records.slice(0, before.records.length), before.records);
});

test('tool_search results stay callable and current request definitions take priority', () => {
  const declaration = (description: string) => ({type: 'function', name: 'lookup', description, parameters: {type: 'object'}});
  const searched = {type: 'tool_search_output', tools: [declaration('searched')]};
  const req = request([ask, additions, searched]);
  assert.deepEqual(availableTools(req).map(t => [t.key, t.definition.description]), [['lookup', 'searched']]);
  assert.deepEqual(availableTools({...req, tools: [declaration('current')]}).map(t => [t.key, t.definition.description]), [['lookup', 'current']]);
});

test('duplicate keys in one additional-tools batch and malformed records fail as client errors', () => {
  assert.doesNotThrow(() => preparePrompt(request([ask, additions, additions])));
  const duplicate = {type: 'additional_tools', tools: [{type: 'function', name: 'same'}, {type: 'custom', name: 'same'}]};
  assert.throws(() => preparePrompt(request([ask, duplicate])), badTools);
  for (const item of [
    {type: 'additional_tools'}, {type: 'additional_tools', tools: {}}, {type: 'additional_tools', tools: [null]},
    {type: 'additional_tools', role: 'user', tools: []},
    {type: 'additional_tools', tools: [{type: 'namespace', name: 'broken', tools: {}}]},
    {type: 'additional_tools', tools: [{type: 'namespace', name: 'broken', tools: [null]}]},
    {type: 'additional_tools', tools: [{type: 'computer_use'}]},
  ]) assert.throws(() => preparePrompt(request([ask, item])), badTools);
});

test('unknown history items are still rejected', () => {
  assert.throws(() => preparePrompt(request([ask, {type: 'unknown_history'}])), /Unsupported history item/);
});

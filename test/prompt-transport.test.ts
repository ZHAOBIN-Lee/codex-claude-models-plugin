import {test} from 'node:test';
import assert from 'node:assert/strict';
import {preparePrompt, requestSchema} from '../src/contracts.js';

test('API transport keeps supplied instructions and history intact while selecting its own argument format', () => {
  const supplied = 'Never use your own tools except StructuredOutput.\nKeep this quotation unchanged.';
  const history = '历史工具：StructuredOutput，参数 {"quoted":"中文\\nline"}';
  const request = requestSchema.parse({model: 'fixture', instructions: supplied, input: history});
  const sdk = preparePrompt(request);
  const api = preparePrompt(request, {functionArgumentFormat: 'json-string'});
  assert.ok(api.system.startsWith(supplied + '\n\n'));
  assert.equal(api.system.split('Never use your own tools except StructuredOutput.').length - 1, 1);
  assert.doesNotMatch(api.system, /JSON object in "arguments" \(not a string\)/);
  assert.match(api.system, /JSON-encoded.*"input"/);
  assert.match(api.system, /Native tools are unavailable; Codex executes calls/);
  assert.deepEqual(api.records, sdk.records);
  assert.equal(api.prompt, sdk.prompt);
  assert.match(sdk.system, /JSON object in "arguments" \(not a string\)/);
  assert.equal(sdk.system.split('Never use your own tools except StructuredOutput.').length - 1, 2);
});


test('the API prompt explicitly keeps final answers inside the JSON envelope', () => {
  const request = requestSchema.parse({model: 'fixture', input: 'Answer now.'});
  const api = preparePrompt(request, {functionArgumentFormat: 'json-string'});
  assert.match(api.system, /entire response is one JSON object/);
  assert.match(api.system, /calls \(empty when you are giving a final answer\)/);
  assert.doesNotMatch(api.system, /Only use codex_decision/);
  assert.doesNotMatch(preparePrompt(request).system, /Native tools are unavailable/);
});


test('the API prompt pairs each call kind with its listed tool type and requires object-string function input', () => {
  const request = requestSchema.parse({model: 'fixture', input: 'Use a tool.'});
  const api = preparePrompt(request, {functionArgumentFormat: 'json-string'});
  assert.match(api.system, /kind must match the tool.s listed type \(function vs custom\)/);
  assert.match(api.system, /function input is a JSON object string/);
  assert.doesNotMatch(preparePrompt(request).system, /kind must match the tool.s listed type|function input is a JSON object string/);
});

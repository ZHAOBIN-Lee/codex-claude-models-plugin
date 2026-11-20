import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { bridgeServer, type ServerOptions } from '../src/server.js';
import { ROUTER_TOKEN_HEADER } from '../src/openai.js';
import { usageFromModels } from '../src/sdk.js';

const token = 'additional-tools-test-only';
const headers = {[ROUTER_TOKEN_HEADER]: token, authorization: 'Bearer upstream-test-only',
  'chatgpt-account-id': 'test-account', 'content-type': 'application/json'};
const additionalTools = {type: 'additional_tools', id: 'at_native', role: 'developer', tools: [
  {type: 'namespace', name: 'functions', tools: [
    {type: 'custom', name: 'exec', description: 'Execute JavaScript',
      format: {type: 'grammar', syntax: 'lark', definition: 'start: /[\\s\\S]+/'}},
  ]},
]};
const userMessage = {type: 'message', role: 'user', content: [{type: 'input_text', text: 'Run the JavaScript tool.'}]};
const rawInput = 'const value = "quotes \\" and slash \\\\";\ntext(value);';
const result = {decision: {text: '', calls: [{kind: 'custom' as const, name: 'functions.exec', input: rawInput}]},
  usage: usageFromModels({})};

async function serve(t: TestContext, options: ServerOptions) {
  const server = bridgeServer(options);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => {server.closeAllConnections(); server.close();});
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/responses`;
}

for (const stream of [false, true]) test(`additional_tools reaches the runner and returns a raw namespaced custom call (stream=${stream})`,
  {timeout: 10000}, async t => {
    let runs = 0;
    const url = await serve(t, {token, run: async request => {
      runs++;
      assert.deepEqual(request.input, [additionalTools, userMessage]);
      return result;
    }});
    const response = await fetch(url, {method: 'POST', headers,
      body: JSON.stringify({model: 'claude-sdk-haiku', input: [additionalTools, userMessage], tools: additionalTools.tools, stream})});
    const body = await response.text();
    assert.equal(response.status, 200, body);
    assert.equal(runs, 1);
    const events = stream ? body.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6))) : [];
    const completed = stream ? events.find(event => event.type === 'response.completed')?.response : JSON.parse(body);
    assert.equal(completed?.status, 'completed');
    assert.equal(completed.output.length, 1);
    assert.equal(completed.output[0].type, 'custom_tool_call');
    assert.equal(completed.output[0].namespace, 'functions');
    assert.equal(completed.output[0].name, 'exec');
    assert.equal(completed.output[0].input, rawInput);
    if (stream) assert.equal(events.find(event => event.type === 'response.custom_tool_call_input.delta')?.delta, rawInput);
  });

test('an unsupported record beside additional_tools is still rejected before the runner', {timeout: 10000}, async t => {
  let runs = 0;
  const url = await serve(t, {token, run: async () => {runs++; return result;}});
  const response = await fetch(url, {method: 'POST', headers,
    body: JSON.stringify({model: 'claude-sdk-haiku', input: [additionalTools, {type: 'unknown_history_item'}, userMessage], stream: false})});
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error.code, 'unsupported_input');
  assert.match(body.error.message, /unknown_history_item/);
  assert.equal(runs, 0);
});

test('GPT passthrough preserves additional_tools and surrounding request bytes', {timeout: 10000}, async t => {
  let claudeRuns = 0;
  const forwarded: Buffer[] = [];
  const upstream = '{ "id": "upstream-original", "output": [] }';
  const url = await serve(t, {token, run: async () => {claudeRuns++; return result;},
    openai: {models: new Set(['gpt-test']), forward: async request => {
      forwarded.push(request.body);
      return new Response(upstream, {headers: {'content-type': 'application/json'}});
    }}});
  const body = `{ "model" : "gpt-test", "input" : ${JSON.stringify([additionalTools, {type: 'unknown_history_item'}, userMessage])}, "opaque" : "keep me" }\n`;
  const response = await fetch(url, {method: 'POST', headers, body});
  assert.equal(response.status, 200);
  assert.equal(await response.text(), upstream);
  assert.equal(forwarded.length, 1);
  assert.deepEqual(forwarded[0], Buffer.from(body));
  assert.equal(claudeRuns, 0);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { IMAGE_LIMITS, preparePrompt, requestSchema } from '../src/contracts.js';
import { promptContent, usageFromModels } from '../src/sdk.js';
import { bridgeServer } from '../src/server.js';
import { ROUTER_TOKEN_HEADER } from '../src/openai.js';

const png = (seed: string, bytes = 64) => `data:image/png;base64,${Buffer.from(seed.repeat(bytes)).toString('base64')}`;
const shot = (url: string) => ({type: 'input_image', image_url: url, detail: 'high'});
const ask = (text: string, ...images: string[]) => ({type: 'message', role: 'user', content: [{type: 'input_text', text}, ...images.map(shot)]});
const reply = (text: string) => ({type: 'message', role: 'assistant', content: [{type: 'output_text', text}]});
const parse = (input: unknown[]) => requestSchema.parse({model: 'claude-sdk-haiku', input, tools: []});
const records = (prompt: string) => JSON.parse(prompt.slice(prompt.indexOf('\n') + 1)) as Record<string, unknown>[];

test('encrypted OpenAI compaction items become a readable note instead of failing the step', () => {
  const prepared = preparePrompt(parse([
    {type: 'compaction', id: 'cmp_1', encrypted_content: 'gAAAAopaque-openai-only'}, ask('retained'), reply('ok'), ask('next'),
  ]));
  assert.ok(!prepared.prompt.includes('gAAAAopaque-openai-only'));
  assert.equal(records(prepared.prompt)[0]?.type, 'compaction');
  assert.match(String(records(prepared.prompt)[0]?.note), /encrypted and unavailable/);
});

test('images in the current turn are attached; earlier ones become labelled placeholders', () => {
  const old = png('old'), current = png('now'), tool = `data:image/jpeg;base64,${Buffer.from('jpg').toString('base64')}`;
  const prepared = preparePrompt(parse([
    ask('earlier', old), reply('seen'), ask('look at this', current, current),
    {type: 'function_call', call_id: 'c1', name: 'view_image', arguments: '{}'},
    {type: 'function_call_output', call_id: 'c1', output: [shot(tool)]},
  ]));
  assert.equal(prepared.images.length, 2, 'the duplicate screenshot is attached once');
  assert.deepEqual(prepared.images.map(i => i.source.media_type), ['image/png', 'image/jpeg']);
  assert.equal(prepared.images[0]?.source.data, current.split(',')[1]);
  assert.ok(!prepared.prompt.includes(old.split(',')[1]!) && !prepared.prompt.includes(current.split(',')[1]!), 'no base64 in the text records');
  const history = records(prepared.prompt);
  assert.match(JSON.stringify(history[0]), /earlier image, not resent/);
  assert.deepEqual((history[2]?.content as unknown[]).slice(1), [{type: 'input_image', attached_image: 1}, {type: 'input_image', attached_image: 1}]);
  assert.deepEqual(history[4]?.output, [{type: 'input_image', attached_image: 2}]);
  // header, earlier ask, reply, current ask + its image, call, output + its image
  const content = promptContent(prepared) as {type: string; text?: string}[];
  assert.deepEqual(content.map(c => c.type), ['text', 'text', 'text', 'text', 'text', 'image', 'text', 'text', 'text', 'image']);
  assert.equal(content[4]?.text, 'Attached image 1:');
  assert.equal(content[8]?.text, 'Attached image 2:');
});

test('images Claude cannot accept are described instead of failing the step', () => {
  const big = `data:image/png;base64,${'A'.repeat(IMAGE_LIMITS.perImageBytes + 4)}`;
  const many = Array.from({length: IMAGE_LIMITS.count + 1}, (_, i) => png(`n${i}`));
  const prepared = preparePrompt(parse([ask('check', 'https://example.com/a.png', big, 'data:image/tiff;base64,AAAA', ...many)]));
  const parts = JSON.stringify(records(prepared.prompt));
  assert.match(parts, /remote URL/);
  assert.match(parts, /5 MiB/);
  assert.match(parts, /unsupported image type image\/tiff/);
  assert.match(parts, /too many images/);
  assert.equal(prepared.images.length, IMAGE_LIMITS.count);
});

test('each record is its own block, so appending records leaves every earlier block unchanged', () => {
  const first = [ask('hello'), reply('hi'), ask('run it')];
  const later = [...first, {type: 'function_call', call_id: 'c1', name: 'exec_command', arguments: '{"cmd":"ls"}'},
    {type: 'function_call_output', call_id: 'c1', output: 'a.txt'}];
  const before = promptContent(preparePrompt(parse(first)));
  const after = promptContent(preparePrompt(parse(later)));
  assert.equal(before.length, 4);
  assert.equal(after.length, 6);
  assert.deepEqual(after.slice(0, before.length), before);
});

test('only opening developer messages stay in the system prompt; later ones become records and keep it stable', () => {
  const dev = (text: string) => ({type: 'message', role: 'developer', content: [{type: 'input_text', text}]});
  const turnOne = [dev('OPENING-CONTEXT'), ask('first'), reply('ok')];
  const turnTwo = [...turnOne, dev('SKILLS-ADDED-LATER'), ask('second')];
  const one = preparePrompt(parse(turnOne)), two = preparePrompt(parse(turnTwo));
  assert.match(one.system, /OPENING-CONTEXT/);
  assert.equal(two.system, one.system, 'a new turn does not change the cached system prompt');
  assert.ok(!two.system.includes('SKILLS-ADDED-LATER'));
  assert.deepEqual(JSON.parse(two.records.at(-2)!), {role: 'developer', content: [{type: 'input_text', text: 'SKILLS-ADDED-LATER'}]});
  assert.match(two.system, /role developer is a genuine Codex developer message/);
});

test('a migrated GPT chat shaped like the failing one prepares within limits', () => {
  // Retained history after an OpenAI compaction, then several large screenshots: over the old 8 MiB body cap.
  const screenshot = (i: number) => png(`s${i}`, 1_900_000 / 2);
  const input = [
    {type: 'compaction', id: 'cmp', encrypted_content: 'x'.repeat(28_000)},
    ...Array.from({length: 36}, (_, i) => [ask(`retained ${i}`), reply(`answer ${i}`)]).flat(),
    ...[0, 1, 2, 3].flatMap(i => [ask(`screenshot ${i}`, screenshot(i)), {type: 'reasoning', encrypted_content: 'enc', summary: []}, reply('noted')]),
    ask('why did it fail?', screenshot(9), screenshot(9)),
  ];
  assert.ok(JSON.stringify(input).length > 8 * 1024 * 1024);
  const prepared = preparePrompt(parse(input));
  assert.equal(prepared.images.length, 1);
  assert.ok(prepared.prompt.length < 64 * 1024, 'only text records remain in the prompt');
});

test('the router accepts large migrated GPT requests and forwards them byte for byte', {timeout: 20000}, async t => {
  let forwarded = 0;
  const server = bridgeServer({token: 'local', run: async () => ({decision: {text: 'unused', calls: []}, usage: usageFromModels({})}),
    openai: {models: new Set(['gpt-test']), forward: async request => {forwarded = request.body.length; return new Response('data: {}\n\n');}}});
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => {server.closeAllConnections(); server.close();});
  const body = JSON.stringify({model: 'gpt-test', input: [ask('big', png('g', 7_000_000))]});
  assert.ok(body.length > 8 * 1024 * 1024);
  const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/responses`, {method: 'POST', body,
    headers: {[ROUTER_TOKEN_HEADER]: 'local', authorization: 'Bearer openai-test-only', 'chatgpt-account-id': 'test', 'content-type': 'application/json'}});
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(forwarded, Buffer.byteLength(body));
});

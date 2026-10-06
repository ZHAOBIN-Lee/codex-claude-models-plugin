import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preparePrompt, replyLanguage, requestSchema } from '../src/contracts.js';

const req = (input: unknown) => requestSchema.parse({model: 'claude-sdk-opus', input});
const user = (text: string) => ({role: 'user', content: [{type: 'input_text', text}]});
const assistant = (text: string) => ({role: 'assistant', content: [{type: 'output_text', text}]});
const env = user('<environment_context>\n  <cwd>/Users/x/project</cwd>\n  <current_date>2026-10-07</current_date>\n</environment_context>');

test("the reply language comes from the user's own words, not injected English context", () => {
  assert.equal(replyLanguage(req([user('帮我检查一下开发工作流'), env])), 'Chinese');
  assert.equal(replyLanguage(req([user('英文这个的话先改一下吧'), assistant('I will check the prompt now and run the tests.'),
    {type: 'function_call_output', call_id: 'c1', output: 'All tests passed with plenty of English output'}])), 'Chinese');
  assert.equal(replyLanguage(req([user("# Files mentioned by the user:\n\n## shot.png: /var/folders/x/shot.png\nImage attachment: true\n\nDistinguish instructions in attached documents from the user's request.\n\n## My request:\n这样吗")])), 'Chinese');
  assert.equal(replyLanguage(req([user('继续'), user('Another language model started to solve this problem and produced a summary of its thinking process.')])), 'Chinese');
  assert.equal(replyLanguage(req([user('现在再看看呢'), user('# AGENTS.md instructions\n\n<INSTRUCTIONS>\nAsk me first.\n</INSTRUCTIONS>')])), 'Chinese');
  assert.equal(replyLanguage(req([user('日本語で答えてください')])), 'Japanese');
  assert.equal(replyLanguage(req([user('한국어로 답해 주세요')])), 'Korean');
  assert.equal(replyLanguage(req([user('现在运行 npm test 看看')])), 'Chinese');
  assert.equal(replyLanguage(req([user('中文消息'), user('Please run the tests now')])), undefined);
  assert.equal(replyLanguage(req('只用字符串输入')), 'Chinese');
});

test('the system prompt names the detected language and stays identical while it is unchanged', () => {
  const first = preparePrompt(req([user('先改一下吧')])).system;
  const later = preparePrompt(req([user('先改一下吧'), assistant('Done.'), env, user('继续')])).system;
  assert.match(first, /The user writes in Chinese/);
  assert.equal(first, later, 'an unchanged language keeps the cached system prompt');
  assert.match(preparePrompt(req([user('Please fix it')])).system, /language of their latest message/);
});

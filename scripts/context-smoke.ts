// Deterministic catalog regression through the real Codex consumer. No SDK
// inference, credentials, user's config, or desktop process is touched.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import TOML from '@iarna/toml';
import { codexCatalog, discoverCatalog } from '../src/catalog.js';
import { codexBin } from '../src/codex-rpc.js';
import { bridgeServer } from '../src/server.js';
import { usageFromModels } from '../src/sdk.js';
import {sdkRunner} from '../src/sdk.js';
import {offeredTools} from '../src/contracts.js';
import {usageStream, USAGE_MODEL, USAGE_SESSION} from '../test/sdk-usage-fixtures.js';

const cases: {name: string; resolvedModel?: string; tokens: number; compact: boolean; sdk?: boolean; toolSteps?: boolean}[] = [
  {name: 'legacy-trigger-loop', resolvedModel: undefined, tokens: 465472, compact: true},
  {name: 'verified-capacity-continuity', resolvedModel: 'claude-sonnet-5-5', tokens: 479726, compact: false},
  {name: 'real-compaction-still-enabled', resolvedModel: 'claude-sonnet-5-5', tokens: 760000, compact: true},
  {name: 'sdk-multi-step-tool-continuity', resolvedModel: 'claude-sonnet-5-5', tokens: 469300, compact: false, sdk: true, toolSteps: true},
  {name: 'sdk-genuine-context-compaction', resolvedModel: 'claude-sonnet-5-5', tokens: 760300, compact: true, sdk: true},
];
const reports: Record<string, unknown>[] = [];
for (const fixture of cases) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-context-consumer-'));
  const home = path.join(root, 'home');
  const models = discoverCatalog([{value: 'sonnet', resolvedModel: fixture.resolvedModel,
    displayName: 'Sonnet fixture', description: 'Deterministic capacity regression', supportedEffortLevels: ['medium']}]);
  const catalog = codexCatalog(models);
  const token = 'fixture-context-token';
  let calls = 0, compactions = 0, toolOutputs = 0, toolStarted = 0;
  const returnedTokens: number[] = [];
  await fs.writeFile(path.join(root, 'fixture.txt'), 'SDK_CONTEXT_TOOL_MARKER\n');
  const server = bridgeServer({token, run: async (request, signal) => {
    calls++;
    if (fixture.sdk) {
      const output = Array.isArray(request.input) ? request.input.filter(item => item.type === 'function_call_output') : [];
      if (fixture.toolSteps) {
        assert.ok(request.tools.length, 'the tool continuity case must never turn into a compaction request');
        if (calls % 3 !== 1) assert.ok(JSON.stringify(output).includes('SDK_CONTEXT_TOOL_MARKER'), 'Codex must return the actual read result');
        toolOutputs += output.length;
      }
      const tool = offeredTools(request.tools).find(item => item.name === 'exec_command');
      if (fixture.toolSteps) assert.ok(tool, 'the real Codex consumer must offer exec_command');
      const decision = fixture.toolSteps && calls % 3 !== 0
        ? {text: '', calls: [{kind: 'function', name: tool!.key, input: JSON.stringify({cmd: 'cat fixture.txt', workdir: root, max_output_tokens: 1000})}]}
        : {text: 'CONTEXT_FIXTURE', calls: []};
      const latest = fixture.name === 'sdk-genuine-context-compaction'
        ? {input_tokens: calls === 1 ? 760000 : 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 300}
        : {input_tokens: 1000, cache_read_input_tokens: 465000, cache_creation_input_tokens: 3000, output_tokens: 300};
      const fakeQuery = ((args: any) => Object.assign((async function* () {
        for await (const _ of args.prompt) { /* fake SDK only */ }
        if (args.options.includePartialMessages) {
          yield* usageStream('msg_first', {input_tokens: 468000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 500});
          yield* usageStream('msg_latest', latest);
        }
        yield {type: 'result', subtype: 'success', is_error: false, session_id: USAGE_SESSION, permission_denials: [], num_turns: 3,
          structured_output: decision, modelUsage: {
            [USAGE_MODEL]: {inputTokens: 468000 + latest.input_tokens, cacheReadInputTokens: latest.cache_read_input_tokens,
              cacheCreationInputTokens: latest.cache_creation_input_tokens, outputTokens: 800, thinkingTokens: 0},
            'claude-haiku-4-5-20251001': {inputTokens: 1000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 11, thinkingTokens: 0},
          }};
      })(), {accountInfo: async () => ({apiProvider: 'firstParty', subscriptionType: 'pro'}), close() {}})) as unknown as Parameters<typeof sdkRunner>[2];
      const result = await sdkRunner(root, models, fakeQuery, {receiptsDir: path.join(root, 'receipts'),
        guard: async () => ({coverage: 'test_injected'})})(request, signal);
      returnedTokens.push(result.usage.total_tokens);
      return result;
    }
    // Only the first decision crosses the threshold in this case. Subsequent
    // summary/follow-up responses report a bounded context, so it can recover.
    const tokens = fixture.name === 'real-compaction-still-enabled' && calls > 1 ? 1000 : fixture.tokens;
    const usage = usageFromModels({});
    Object.assign(usage, {input_tokens: tokens - 20, output_tokens: 20, total_tokens: tokens});
    return {decision: {text: 'CONTEXT_FIXTURE', calls: []}, usage};
  }});
  try {server.listen(0, '127.0.0.1'); await once(server, 'listening');}
  catch (error) {server.close(); await fs.rm(root, {recursive: true, force: true}); throw error;}
  let child: ReturnType<typeof spawn> | undefined;
  const pending = new Map<number, {resolve: (value: any) => void; reject: (error: Error) => void}>();
  let sequence = 0, buffer = '', finish: ((turn: any) => void) | undefined, rejectTurn: ((error: Error) => void) | undefined;
  const timer = setTimeout(() => {
    const error = new Error(`Context consumer timed out: ${fixture.name}`);
    for (const waiting of pending.values()) waiting.reject(error);
    rejectTurn?.(error); child?.kill();
  }, 45000);
  try {
    await fs.mkdir(home, {recursive: true});
    const catalogPath = path.join(home, 'catalog.json');
    await fs.writeFile(catalogPath, JSON.stringify(catalog));
    await fs.writeFile(path.join(home, 'config.toml'), TOML.stringify({model: 'claude-sdk-sonnet', model_provider: 'context_fixture',
      model_catalog_json: catalogPath, features: {plugins: false, apps: false, remote_plugin: false},
      model_providers: {context_fixture: {name: 'Context fixture', base_url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
        wire_api: 'responses', requires_openai_auth: false, supports_websockets: false,
        request_max_retries: 0, stream_max_retries: 0, http_headers: {Authorization: `Bearer ${token}`}}}}));
    child = spawn(codexBin(), ['app-server', '--stdio'], {cwd: root, env: {...process.env, CODEX_HOME: home}, stdio: ['pipe', 'pipe', 'pipe']});
    const rpc = (method: string, params: unknown) => new Promise<any>((resolve, reject) => {
      const id = ++sequence; pending.set(id, {resolve, reject}); child!.stdin!.write(JSON.stringify({id, method, params}) + '\n');
    });
    child.stderr!.resume();
    child.stdout!.on('data', chunk => {
      buffer += chunk;
      while (buffer.includes('\n')) {
        const end = buffer.indexOf('\n'); const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        if (message.id !== undefined && !message.method) {
          const waiting = pending.get(message.id); if (!waiting) continue; pending.delete(message.id);
          if (message.error) waiting.reject(new Error('Codex context RPC failed')); else waiting.resolve(message.result);
        } else if (message.id !== undefined && message.method) child!.stdin!.write(JSON.stringify({id: message.id, error: {code: -32601, message: 'declined'}}) + '\n');
        else if (message.method === 'item/started' && message.params?.item?.type === 'contextCompaction') compactions++;
        else if (message.method === 'item/started' && message.params?.item?.type === 'commandExecution') toolStarted++;
        else if (message.method === 'turn/completed') finish?.(message.params.turn);
      }
    });
    await rpc('initialize', {clientInfo: {name: 'context-consumer-regression', version: '1'}, capabilities: {experimentalApi: true}});
    child.stdin!.write(JSON.stringify({method: 'initialized'}) + '\n');
    const thread = await rpc('thread/start', {model: 'claude-sdk-sonnet', cwd: root, sandbox: 'read-only', approvalPolicy: 'never', ephemeral: true});
    for (let turn = 0; turn < 3; turn++) {
      const completed = new Promise<any>((resolve, reject) => {finish = resolve; rejectTurn = reject;});
      await rpc('turn/start', {threadId: thread.thread.id, input: [{type: 'text', text: fixture.toolSteps
        ? 'Read fixture.txt twice using exec_command, then reply CONTEXT_FIXTURE.' : 'Reply only CONTEXT_FIXTURE, without tools.'}]});
      assert.equal((await completed).status, 'completed', fixture.name);
    }
    if (fixture.compact) assert.ok(compactions >= (fixture.name === 'legacy-trigger-loop' ? 2 : 1), `${fixture.name} must trigger native compaction`);
    else {assert.equal(compactions, 0); assert.equal(calls, fixture.toolSteps ? 9 : 3, 'only the intended tool decisions should run');}
    if (fixture.toolSteps) {
      assert.equal(toolStarted, 6, 'Codex must actually execute six reads');
      assert.ok(toolOutputs >= 6);
      assert.deepEqual(returnedTokens, Array(9).fill(469300), 'SDK cumulative usage must never reach Codex');
    }
    if (fixture.name === 'sdk-genuine-context-compaction') {
      assert.equal(returnedTokens[0], 760300);
      assert.equal(compactions, 1, 'a real threshold crossing still compacts exactly once');
    }
    reports.push({case: fixture.name, model_window: catalog.models[0]!.context_window,
      auto_compact_limit: catalog.models[0]!.auto_compact_token_limit, reported_tokens: fixture.tokens, calls, compactions,
      ...(fixture.sdk ? {real_sdk_inference: false, returned_tokens: returnedTokens, native_tool_executions: toolStarted} : {}), status: 'pass'});
  } finally {
    clearTimeout(timer); child?.stdin?.end(); child?.kill();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await fs.rm(root, {recursive: true, force: true});
  }
}
console.log(JSON.stringify({inference: false, cases: reports}, null, 2));

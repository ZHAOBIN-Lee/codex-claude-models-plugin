// Real Codex client, local synthetic model responses only. No SDK/API inference or real credentials.
import assert from 'node:assert/strict';
import {spawn, execFileSync, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {once} from 'node:events';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {AddressInfo} from 'node:net';
import TOML from '@iarna/toml';
import {codexCatalog, discoverCatalog} from '../src/catalog.js';
import {codexBin} from '../src/codex-rpc.js';
import {bridgeServer} from '../src/server.js';
import {BridgeError, isCompactionRequest} from '../src/contracts.js';
import {PaidStepGuard, stepIdentity} from '../src/paid-step-guard.js';
import {usageFromModels} from '../src/sdk.js';

type Notice = {method: string; params: any};
class Client {
  readonly notices: Notice[] = [];
  readonly child: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private pending = new Map<number, {resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>}>();
  private listeners = new Set<() => void>();
  private stopped = false;
  constructor(home: string, cwd: string) {
    const env: NodeJS.ProcessEnv = {...process.env, CODEX_HOME: home};
    for (const key of Object.keys(env)) if (/^(ANTHROPIC_|OPENAI_|CODEX_API_KEY$|CHATGPT_ACCESS_TOKEN$|CHATGPT_AUTH_TOKEN$|CLAUDE_CODE_OAUTH_TOKEN$)/.test(key)) delete env[key];
    this.child = spawn(codexBin(), ['app-server', '--stdio', '--disable', 'remote_plugin', '--disable', 'apps', '--disable', 'plugins'],
      {cwd, env, stdio: ['pipe', 'pipe', 'pipe']});
    this.child.stderr.resume();
    let buffer = '';
    this.child.stdout.on('data', chunk => {
      buffer += chunk;
      while (buffer.includes('\n')) {
        const end = buffer.indexOf('\n'), line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let message: any;
        try {message = JSON.parse(line);} catch {this.stop(); return;}
        if (message.id !== undefined && message.method) {
          this.child.stdin.write(JSON.stringify({id: message.id, error: {code: -32601, message: 'No host actions in local client smoke.'}}) + '\n');
        } else if (message.id !== undefined) {
          const item = this.pending.get(message.id);
          if (!item) continue;
          clearTimeout(item.timer); this.pending.delete(message.id);
          if (message.error) item.reject(new Error(`Codex RPC rejected (${message.error.code}).`)); else item.resolve(message.result);
        } else if (typeof message.method === 'string') {
          this.notices.push({method: message.method, params: message.params});
          for (const listener of this.listeners) listener();
        }
      }
    });
    this.child.on('error', () => this.stop());
    this.child.on('exit', () => this.stop());
  }
  async request(method: string, params: unknown): Promise<any> {
    if (this.stopped) throw new Error('Codex child stopped.');
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {this.pending.delete(id); reject(new Error(`Codex RPC timeout: ${method}`));}, 20000);
      this.pending.set(id, {resolve, reject, timer});
      this.child.stdin.write(JSON.stringify({id, method, params}) + '\n');
    });
  }
  async initialize() {
    await this.request('initialize', {clientInfo: {name: 'api-failure-client-smoke', version: '1'}, capabilities: {experimentalApi: true}});
    this.child.stdin.write(JSON.stringify({method: 'initialized'}) + '\n');
  }
  wait(predicate: (notice: Notice) => boolean, from: number, timeoutMs = 45000): Promise<Notice | undefined> {
    return new Promise(resolve => {
      const finish = (notice?: Notice) => {clearTimeout(timer); this.listeners.delete(check); resolve(notice);};
      const check = () => {const hit = this.notices.slice(from).find(predicate); if (hit) finish(hit); else if (this.stopped) finish();};
      const timer = setTimeout(() => finish(), timeoutMs);
      this.listeners.add(check); check();
    });
  }
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    for (const item of this.pending.values()) {clearTimeout(item.timer); item.reject(new Error('Codex child stopped.'));}
    this.pending.clear();
    for (const listener of this.listeners) listener();
    this.child.stdin.end(); this.child.kill();
  }
}

const version = execFileSync(codexBin(), ['--version'], {encoding: 'utf8'}).trim();
const reports: Record<string, unknown>[] = [];
for (const kind of ['ordinary', 'compaction'] as const) for (const firstError of ['api_fallback_failed', 'api_duplicate_step'] as const) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'codex-api-failure-smoke-')));
  const home = path.join(root, 'home');
  const models = discoverCatalog([{value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Local failure fixture',
    description: 'Synthetic response only', supportedEffortLevels: ['medium']}]);
  const token = 'inert-local-client-smoke-token';
  const guard = new PaidStepGuard(path.join(root, 'claims'));
  const requests: {identity: string | null; compact: boolean; code: string}[] = [];
  const headerContexts: {thread?: string; session?: string; turn?: string}[] = [];
  let phase: 'seed' | 'fail' = kind === 'compaction' ? 'seed' : 'fail';
  let generation = 0, client: Client | undefined;
  const server = bridgeServer({token, run: async request => {
    if (phase === 'seed') return {decision: {text: 'LOCAL_SEED_COMPLETE', calls: []}, usage: usageFromModels({})};
    const identity = stepIdentity(request);
    assert.ok(identity, 'real Codex HTTP context must form a paid-step identity');
    const observed = {identity, compact: isCompactionRequest(request), code: ''}; requests.push(observed);
    try {
      await guard.claim(identity);
      generation++;
      if (firstError === 'api_duplicate_step') await guard.claim(identity); // Simulate an already-claimed unknown prior attempt.
      throw new BridgeError(424, 'api_fallback_failed', 'Synthetic local API fallback failure; no upstream call occurred.');
    } catch (error) {
      observed.code = error instanceof BridgeError ? error.code : 'unexpected';
      throw error;
    }
  }});
  server.prependListener('request', req => {
    if (phase !== 'fail' || req.method !== 'POST') return;
    let metadata: any = {};
    try {metadata = JSON.parse(String(req.headers['x-codex-turn-metadata'] ?? '{}'));} catch { /* retained as absent */ }
    headerContexts.push({thread: typeof req.headers['thread-id'] === 'string' ? req.headers['thread-id'] : undefined,
      session: typeof req.headers['session-id'] === 'string' ? req.headers['session-id'] : undefined,
      turn: typeof metadata.turn_id === 'string' ? metadata.turn_id : undefined});
  });
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    await fs.mkdir(home, {mode: 0o700});
    const catalog = path.join(home, 'catalog.json');
    await fs.writeFile(catalog, JSON.stringify(codexCatalog(models)));
    await fs.writeFile(path.join(home, 'config.toml'), TOML.stringify({model: models[0]!.id, model_provider: 'local_failure_fixture',
      model_catalog_json: catalog, features: {plugins: false, apps: false, remote_plugin: false},
      model_providers: {local_failure_fixture: {name: 'Local failure fixture', base_url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
        wire_api: 'responses', requires_openai_auth: false, supports_websockets: false,
        request_max_retries: 0, stream_max_retries: 3, http_headers: {Authorization: `Bearer ${token}`}}}}));
    client = new Client(home, root); await client.initialize();
    const thread = (await client.request('thread/start', {model: models[0]!.id, cwd: root, sandbox: 'read-only', approvalPolicy: 'never', ephemeral: true})).thread.id;
    const ordinaryTerminal = (notice: Notice) => notice.method === 'turn/completed' && notice.params?.threadId === thread;
    if (kind === 'compaction') {
      const start = client.notices.length;
      await client.request('turn/start', {threadId: thread, input: [{type: 'text', text: 'Reply LOCAL_SEED_COMPLETE without tools.'}]});
      assert.equal((await client.wait(ordinaryTerminal, start))?.params?.turn?.status, 'completed', 'seed turn must complete entirely locally');
      phase = 'fail';
    }
    const start = client.notices.length;
    await client.request(kind === 'ordinary' ? 'turn/start' : 'thread/compact/start', kind === 'ordinary'
      ? {threadId: thread, input: [{type: 'text', text: 'Local failure smoke. Do not run any tools.'}]} : {threadId: thread});
    const terminal = await client.wait(notice => {
      if (ordinaryTerminal(notice)) return true;
      if (kind !== 'compaction' || notice.params?.threadId !== thread) return false;
      return (notice.method === 'error' && notice.params?.willRetry !== true) || notice.method === 'thread/compacted'
        || (notice.method === 'item/completed' && notice.params?.item?.type === 'contextCompaction');
    }, start);
    // Observe after terminal as well so a client loop cannot hide behind an early failure notification.
    await new Promise(resolve => setTimeout(resolve, 2000));
    const notices = client.notices.slice(start);
    const errors = notices.filter(n => n.method === 'error').map(n => ({willRetry: n.params?.willRetry ?? null,
      code: n.params?.error?.codexErrorInfo ?? null}));
    const contexts = headerContexts.map(item => JSON.stringify(item));
    const report = {kind, first_error: firstError, status: terminal ? 'terminal_observed' : 'timeout',
      terminal_method: terminal?.method ?? null, turn_status: terminal?.params?.turn?.status ?? null,
      http_requests: headerContexts.length, runner_calls: requests.length, synthetic_generation: generation,
      paid_step_identities: new Set(requests.map(row => row.identity)).size,
      stable_thread_turn_headers: new Set(contexts).size === 1,
      all_requests_recognized_as_compaction: kind === 'compaction' ? requests.every(row => row.compact) : null,
      emitted_error_codes: requests.map(row => row.code), client_errors: errors,
      stream_max_retries: 3, real_api_inference: false};
    reports.push(report); console.log(JSON.stringify(report));
    assert.ok(terminal, 'real client must reach a terminal outcome, not an automatic retry loop');
    assert.equal(generation, 1, 'durable guard must prevent another synthetic generation of this logical step');
    assert.equal(new Set(requests.map(row => row.identity)).size, 1, 'automatic retries must retain the same paid-step identity');
    assert.equal(new Set(contexts).size, 1, 'automatic retries must retain the same thread/turn headers');
    if (kind === 'compaction') assert.ok(requests.every(row => row.compact), 'exercise actual native compaction requests');
  } finally {
    client?.stop(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await fs.rm(root, {recursive: true, force: true});
  }
}
console.log(JSON.stringify({codex_version: version, real_api_inference: false, all_passed: true, cases: reports}, null, 2));

// Explicitly opted-in LOCAL subscription acceptance harness. It drives the real Codex app-server (the consumer) against an
// in-process loopback bridge whose runner is the production sdkRunner with the real runtime guard, so the scripted model
// decisions come from the actual Claude subscription and every tool call is executed by Codex, never by this harness.
// Headless app-server events are NOT GUI acceptance. Nothing here touches the user's Codex home, login files, credentials
// or an installed Bridge. Reports and receipts are metadata only; no prompt, tool argument, tool output or token is saved.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import TOML from '@iarna/toml';
import type { ClaudeModel } from '../src/catalog.js';
import { codexBin } from '../src/codex-rpc.js';
import { BridgeError, type ResponsesRequest, type RunStep } from '../src/contracts.js';
import { safeModelId, safeSessionId } from '../src/receipts.js';
import { loadRuntimePolicy } from '../src/runtime-policy.js';
import { inspectSdk, sdkRunner } from '../src/sdk.js';
import { bridgeServer } from '../src/server.js';
import { activate, installConfig, locations } from '../src/setup.js';

const exec = promisify(execFile);
const MODEL_ID = 'claude-sdk-sonnet';
const PROVIDER = 'claude_agent_sdk';
const STEP_TIMEOUT_MS = 180_000;
const TURN_TIMEOUT_MS = 240_000;
const CASE_DEADLINE_MS = 480_000;
const COMPACT_TERMINAL_TIMEOUT_MS = 90_000;
export const CASES = ['readwrite', 'cancel', 'readonly', 'compact', 'history'] as const;
export type CaseName = typeof CASES[number];

// ---------------------------------------------------------------- pure helpers (unit-tested offline)

export interface Args {live: boolean; codexHome?: string; report?: string; caseName: CaseName; errors: string[]}

export function usage() {
  return [
    'Native subscription acceptance harness (local, opt-in). The default run shows this text and performs NO inference.',
    '',
    '  tsx scripts/native-acceptance.ts --live --codex-home <ISOLATED_POLICY_HOME> --report <PRIVATE_REPORT_PATH> [--case readwrite|cancel|readonly|compact|history]',
    '',
    '  --live         required to make any real request on the Claude subscription',
    '  --codex-home   isolated home holding claude-models/runtime-policy.json (receipts are written there); never your normal Codex home',
    '  --report       private (mode 600) report path; written even on failure',
    '  --case         one bounded case per invocation (default readwrite)',
    '',
    'Uses CODEX_BIN, else codex on PATH. One fresh temporary consumer home is created and removed per invocation.',
  ].join('\n');
}

export function parseArgs(argv: string[]): Args {
  const args: Args = {live: false, caseName: 'readwrite', errors: []};
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!;
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) {args.errors.push(`missing value for ${flag}`); return undefined;}
      index++; return next;
    };
    if (flag === '--live') args.live = true;
    else if (flag === '--codex-home') args.codexHome = value();
    else if (flag === '--report') args.report = value();
    else if (flag === '--case') {
      const name = value();
      if (name !== undefined) {
        if ((CASES as readonly string[]).includes(name)) args.caseName = name as CaseName; else args.errors.push(`unknown case ${JSON.stringify(name.slice(0, 24))}`);
      }
    } else if (flag === '--help' || flag === '-h') {/* usage is shown whenever --live is absent */} else args.errors.push(`unknown argument ${JSON.stringify(flag.slice(0, 24))}`);
  }
  return args;
}

// The supplied home must never be the normal Codex home, the user's home, an ancestor of either, or inside the normal one.
export function isNormalCodexHome(candidate: string, options: {home: string; envCodexHome?: string}) {
  const resolved = path.resolve(candidate);
  const within = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
  const normals = [path.resolve(options.home, '.codex'), ...(options.envCodexHome ? [path.resolve(options.envCodexHome)] : [])];
  // Equal to, inside, or an ancestor of a normal Codex home; or the user's home itself or an ancestor of it.
  return normals.some(normal => within(normal, resolved) || within(resolved, normal)) || within(path.resolve(options.home), resolved);
}

export const safeToken = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_./-]{1,64}$/.test(value) ? value : undefined;

export interface SafeEvent {method: string; item_type?: string; item_status?: string; exit_code?: number; turn_status?: string; turn_error?: boolean}
// Only structural fields survive: never prompts, arguments, output text, errors or account data.
export function safeEvent(method: unknown, params: any): SafeEvent {
  const event: SafeEvent = {method: safeToken(method) ?? 'unknown'};
  const item = params?.item;
  if (item && typeof item === 'object') {
    const type = safeToken(item.type), status = safeToken(item.status);
    if (type) event.item_type = type;
    if (status) event.item_status = status;
    if (Number.isInteger(item.exitCode)) event.exit_code = item.exitCode;
  }
  const turn = params?.turn;
  if (turn && typeof turn === 'object') {
    const status = safeToken(turn.status);
    if (status) event.turn_status = status;
    if (turn.error) event.turn_error = true;
  }
  return event;
}

export function observeSentinels(text: string, registry: Record<string, string>) {
  return Object.entries(registry).filter(([, value]) => value && text.includes(value)).map(([name]) => name).sort();
}

export interface Notice {method: string; params?: any; at: number}
export interface ToolCompletion {item_type: string; status: string | null; exit_code: number | null; output_sentinels: string[]; change_sentinels: string[]; denial_text: boolean; suspicious_command: boolean}
const TOOL_TYPES = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'collabAgentToolCall']);
const DENIAL = /read-only file system|permission denied|operation not permitted|sandbox/i;
const SUSPICIOUS = /\bclaude\b|bridge\.mjs|setup\.mjs|activate-router/i;
const outputOf = (item: any) => ['aggregatedOutput', 'output', 'stdout', 'stderr'].map(key => item?.[key]).filter((value): value is string => typeof value === 'string').join('\n');
const commandOf = (item: any) => String(Array.isArray(item?.command) ? item.command.join(' ') : item?.command ?? '');

// Reads one turn's item notifications. Text is only inspected in memory for sentinels and booleans, never returned.
export function analyzeItems(notices: Notice[], registry: Record<string, string>) {
  let toolStarted = 0, firstToolAt: number | undefined;
  const completed: ToolCompletion[] = [];
  const itemTypes: Record<string, number> = {};
  let agentText = '';
  for (const notice of notices) {
    const item = notice.params?.item;
    if (!item || typeof item !== 'object') continue;
    const type = safeToken(item.type) ?? 'unknown';
    if (notice.method === 'item/started') {
      itemTypes[type] = (itemTypes[type] ?? 0) + 1;
      if (TOOL_TYPES.has(type)) {toolStarted++; firstToolAt ??= notice.at;}
    } else if (notice.method === 'item/completed') {
      if (type === 'agentMessage' && typeof item.text === 'string') agentText = item.text;
      if (TOOL_TYPES.has(type)) {
        const output = outputOf(item);
        completed.push({item_type: type, status: safeToken(item.status) ?? null, exit_code: Number.isInteger(item.exitCode) ? item.exitCode : null,
          output_sentinels: observeSentinels(output, registry), change_sentinels: type === 'fileChange' ? observeSentinels(JSON.stringify(item.changes ?? ''), registry) : [],
          denial_text: DENIAL.test(output), suspicious_command: SUSPICIOUS.test(commandOf(item))});
      }
    }
  }
  return {toolStarted, firstToolAt, completed, itemTypes, agentText};
}

export type Verdict = 'pass' | 'fail' | 'inconclusive';
export function classifyReadonly(input: {toolStarted: number; completed: Pick<ToolCompletion, 'status' | 'exit_code' | 'denial_text'>[]; fileChanged: boolean}): {result: string; status: Verdict} {
  if (input.fileChanged) return {result: 'write_succeeded_in_read_only_sandbox', status: 'fail'};
  if (input.toolStarted === 0) return {result: 'refused_without_tool', status: 'inconclusive'};
  if (input.completed.some(item => item.status === 'declined')) return {result: 'declined_before_execution', status: 'inconclusive'};
  if (input.completed.some(item => item.denial_text && item.exit_code !== 0)) return {result: 'sandbox_denied', status: 'pass'};
  if (!input.completed.length) return {result: 'tool_not_completed', status: 'inconclusive'};
  if (input.completed.some(item => item.status === 'failed' || (item.exit_code !== null && item.exit_code !== 0))) return {result: 'tool_failed_unclassified', status: 'inconclusive'};
  return {result: 'tool_succeeded_without_change', status: 'inconclusive'};
}

export type CompactionState = 'completed' | 'failed' | 'interrupted';
export interface CompactionTerminal {state: CompactionState; source: 'item_completed' | 'thread_compacted' | 'turn_completed' | 'error'}
// Only an explicit terminal notice for THIS thread ends a compaction. item/started, turn/started and anything that merely has
// "compact" in its name are progress, never completion. An error counts only as a failure, never as success.
export function compactionTerminal(notice: {method: string; params?: any}, threadId: string): CompactionTerminal | undefined {
  const params = notice.params;
  const sameThread = Boolean(threadId) && params?.threadId === threadId;
  switch (notice.method) {
    case 'error':
      // A retried error is not final; one without any thread attribution can only concern this single-thread run.
      if (params?.willRetry === true || (params?.threadId !== undefined && !sameThread)) return undefined;
      return {state: 'failed', source: 'error'};
    case 'item/completed': {
      if (!sameThread || params?.item?.type !== 'contextCompaction') return undefined;
      const status = safeToken(params.item.status);
      if (status === undefined || status === 'completed') return {state: 'completed', source: 'item_completed'};
      return status === 'failed' || status === 'declined' ? {state: 'failed', source: 'item_completed'} : undefined;
    }
    case 'thread/compacted':
      return sameThread ? {state: 'completed', source: 'thread_compacted'} : undefined;
    case 'turn/completed': {
      if (!sameThread) return undefined;
      const status = safeToken(params?.turn?.status);
      return status === 'completed' || status === 'failed' || status === 'interrupted' ? {state: status, source: 'turn_completed'} : undefined;
    }
    default:
      return undefined;
  }
}
export function firstCompactionTerminal(notices: {method: string; params?: any}[], threadId: string) {
  for (const notice of notices) {
    const terminal = compactionTerminal(notice, threadId);
    if (terminal) return terminal;
  }
  return undefined;
}

// Failures are reported by code only; raw messages can carry tokens or paths.
export class RpcError extends Error {
  constructor(readonly kind: string, readonly rpcCode?: number, readonly messageClass?: string) {super(kind); this.name = 'RpcError';}
}
export function failureCode(error: unknown): string {
  if (error instanceof BridgeError) return `bridge:${error.code}`;
  if (error instanceof RpcError) return `rpc:${error.kind}${error.rpcCode !== undefined ? `:${error.rpcCode}` : ''}`;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code)) return `errno:${code}`;
  const name = error instanceof Error ? error.name : typeof error;
  return `error:${safeToken(name) ?? 'unknown'}`;
}
const classifyMessage = (message: unknown) => typeof message !== 'string' ? 'none' : /compact/i.test(message) ? 'mentions_compaction' : /unsupported|not supported/i.test(message) ? 'unsupported' : 'other';

// Models and sessions are re-validated with the same trusted validators the core receipts use, so a value the SDK evidence
// would have discarded can never appear here, and nothing is ever generated or aliased.
export function summarizeReceipt(json: any) {
  const num = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;
  const text = (value: unknown) => safeToken(value) ?? null;
  return {status: text(json?.status), code: text(json?.code), inference_stage: text(json?.inference_stage), requested_alias: text(json?.requested_alias),
    requested_effort: text(json?.requested_effort),
    actual_models: Array.isArray(json?.actual_models) ? json.actual_models.map((m: unknown) => safeModelId(m)).filter((m: string | null): m is string => m !== null).slice(0, 8) : [],
    sdk_session_id: safeSessionId(json?.sdk_session_id),
    wall_ms: num(json?.wall_ms), preflight_ms: num(json?.preflight_ms), query_ms: num(json?.query_ms), sdk_duration_ms: num(json?.sdk_duration_ms),
    sdk_ttft_ms: num(json?.sdk_ttft_ms), sdk_ttft_stream_ms: num(json?.sdk_ttft_stream_ms), sdk_time_to_request_ms: num(json?.sdk_time_to_request_ms),
    total_tokens: num(json?.usage?.total_tokens), permission_denials_status: text(json?.permission_denials_status), permission_denials_count: num(json?.permission_denials_count),
    cli_version: text(json?.cli_version)};
}
export type ReceiptSummary = ReturnType<typeof summarizeReceipt>;

// ---------------------------------------------------------------- runtime pieces

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const hex = (bytes: number) => randomBytes(bytes).toString('hex');

// JSONL JSON-RPC client for `codex app-server --stdio`. Notifications are logged; server requests are declined.
class Rpc {
  readonly log: Notice[] = [];
  readonly counts: Record<string, number> = {};
  readonly events: (SafeEvent & {t_ms: number})[] = [];
  readonly serverRequests: Record<string, number> = {};
  invalidLines = 0; stderrBytes = 0; closed = false; droppedEvents = 0;
  private sequence = 0;
  private buffer = '';
  private readonly pending = new Map<number, {resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout}>();
  private readonly waiters = new Set<() => void>();
  constructor(readonly child: ChildProcess, private readonly clock: () => number) {
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', chunk => this.read(chunk));
    child.stderr!.on('data', chunk => {this.stderrBytes += Buffer.byteLength(chunk);});
    const closed = () => {
      this.closed = true;
      for (const entry of this.pending.values()) {clearTimeout(entry.timer); entry.reject(new RpcError('closed'));}
      this.pending.clear(); this.wake();
    };
    child.on('exit', closed); child.on('error', closed);
  }
  private wake() {for (const waiter of [...this.waiters]) waiter();}
  private read(chunk: string) {
    this.buffer += chunk;
    for (let end = this.buffer.indexOf('\n'); end >= 0; end = this.buffer.indexOf('\n')) {
      const line = this.buffer.slice(0, end).trim(); this.buffer = this.buffer.slice(end + 1);
      if (line) this.handle(line);
    }
  }
  private handle(line: string) {
    let message: any;
    try {message = JSON.parse(line);} catch {this.invalidLines++; return;}
    if (message.id !== undefined && !message.method) {
      const waiting = this.pending.get(message.id);
      if (!waiting) return;
      this.pending.delete(message.id); clearTimeout(waiting.timer);
      if (message.error) waiting.reject(new RpcError('error_response', Number.isInteger(message.error.code) ? message.error.code : undefined, classifyMessage(message.error.message)));
      else waiting.resolve(message.result);
      return;
    }
    if (typeof message.method !== 'string') return;
    if (message.id !== undefined) {
      // approvalPolicy is never, so any server request is unexpected: decline it instead of letting the turn hang.
      const key = safeToken(message.method) ?? 'unknown';
      this.serverRequests[key] = (this.serverRequests[key] ?? 0) + 1;
      this.child.stdin?.write(`${JSON.stringify({id: message.id, error: {code: -32601, message: 'declined by the acceptance harness'}})}\n`);
      return;
    }
    const at = this.clock();
    const method = safeToken(message.method) ?? 'unknown';
    this.counts[method] = (this.counts[method] ?? 0) + 1;
    if (this.events.length < 400) this.events.push({...safeEvent(message.method, message.params), t_ms: Math.round(at)}); else this.droppedEvents++;
    // Streaming deltas are counted but their payloads are never retained.
    const keep = /^(item\/(started|completed)$|turn\/|thread\/|error)/.test(method) || /compact/i.test(method);
    this.log.push({method, params: keep ? message.params : undefined, at});
    this.wake();
  }
  request<T = any>(method: string, params: unknown, timeoutMs = 60_000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.closed) {reject(new RpcError('closed')); return;}
      const id = ++this.sequence;
      const timer = setTimeout(() => {this.pending.delete(id); reject(new RpcError('timeout'));}, timeoutMs);
      this.pending.set(id, {resolve, reject, timer});
      this.child.stdin?.write(`${JSON.stringify({id, method, params})}\n`);
    });
  }
  notify(method: string, params?: unknown) {this.child.stdin?.write(`${JSON.stringify(params === undefined ? {method} : {method, params})}\n`);}
  waitFor(predicate: (notice: Notice) => boolean, timeoutMs: number, from = 0) {
    return new Promise<Notice | undefined>(resolve => {
      const scan = () => this.log.slice(from).find(predicate);
      const finish = (value: Notice | undefined) => {clearTimeout(timer); this.waiters.delete(check); resolve(value);};
      const check = () => {const hit = scan(); if (hit) finish(hit); else if (this.closed) finish(undefined);};
      const timer = setTimeout(() => finish(undefined), timeoutMs);
      this.waiters.add(check); check();
    });
  }
}

interface ProviderEntry {
  n: number; arrival_ms: number; settled_ms?: number; outcome: 'pending' | 'ok' | 'error' | 'aborted'; code?: string; effort: string | null;
  tool_count: number; input_items: number; function_call_outputs: number; sentinels_in_outputs: string[]; sentinels_in_input: string[];
}

// Wraps the production runner: records arrival and outcome (counts and codes only) and tracks every in-flight step.
function trackedRunner(inner: RunStep, registry: Record<string, string>, clock: () => number, harnessAbort: AbortController) {
  const entries: ProviderEntry[] = [];
  const inflight = new Set<Promise<unknown>>();
  const run: RunStep = (request: ResponsesRequest, signal) => {
    const input = Array.isArray(request.input) ? request.input : [];
    const outputs = input.filter(item => item.type === 'function_call_output' || item.type === 'custom_tool_call_output');
    const entry: ProviderEntry = {n: entries.length + 1, arrival_ms: Math.round(clock()), outcome: 'pending', effort: request.reasoning?.effort ?? null,
      tool_count: Array.isArray(request.tools) ? request.tools.length : 0, input_items: input.length, function_call_outputs: outputs.length,
      sentinels_in_outputs: observeSentinels(JSON.stringify(outputs), registry), sentinels_in_input: observeSentinels(JSON.stringify(request.input ?? ''), registry)};
    entries.push(entry);
    const step = (async () => {
      try {
        const result = await inner(request, AbortSignal.any([signal, harnessAbort.signal]));
        entry.outcome = 'ok';
        return result;
      } catch (error) {
        entry.outcome = signal.aborted || harnessAbort.signal.aborted ? 'aborted' : 'error';
        entry.code = failureCode(error);
        throw error;
      } finally {entry.settled_ms = Math.round(clock());}
    })();
    inflight.add(step);
    const forget = () => {inflight.delete(step);};
    step.then(forget, forget);
    return step;
  };
  const settle = async (timeoutMs: number) => {
    const all = Promise.allSettled([...inflight]).then(() => true);
    return Promise.race([all, sleep(timeoutMs).then(() => false)]);
  };
  return {entries, run, settle, inflightCount: () => inflight.size};
}

interface ProcEntry {pid: number; ppid: number; comm: string}
async function processTable(): Promise<ProcEntry[]> {
  const {stdout} = await exec('ps', ['-A', '-o', 'pid=,ppid=,comm='], {maxBuffer: 8 * 1024 * 1024, timeout: 5000});
  const rows: ProcEntry[] = [];
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (match) rows.push({pid: Number(match[1]), ppid: Number(match[2]), comm: path.basename(match[3]!)});
  }
  return rows;
}
function descendantsOf(table: ProcEntry[], root: number) {
  const found: ProcEntry[] = [];
  const queue = [root];
  while (queue.length) {
    const parent = queue.shift()!;
    for (const entry of table) if (entry.ppid === parent && !found.some(known => known.pid === entry.pid)) {found.push(entry); queue.push(entry.pid);}
  }
  return found.filter(entry => entry.comm !== 'ps');
}
const nameCounts = (entries: {comm: string}[]) => entries.reduce<Record<string, number>>((counts, entry) => {counts[entry.comm] = (counts[entry.comm] ?? 0) + 1; return counts;}, {});

// ---------------------------------------------------------------- report

interface TurnRecord {
  label: string; status: string; turn_id_seen: boolean; thread_matches: boolean; send_ms: number; first_provider_request_ms: number | null;
  first_tool_item_started_ms: number | null; completed_ms: number | null; tool_items_started: number; tool_items_completed: ToolCompletion[];
  item_types: Record<string, number>; agent_message_chars: number; agent_sentinels: string[]; provider_requests: number;
}
interface State {
  phase: string; failures: {phase: string; code: string}[]; checks: Record<string, boolean | null>; turns: TurnRecord[]; result: string;
  verdict: Verdict | 'error' | 'recorded'; detail: Record<string, unknown>; deferred: (() => void)[]; receipts: ReceiptSummary[];
}

async function writeReport(file: string, report: unknown) {
  await fs.mkdir(path.dirname(file), {recursive: true, mode: 0o700});
  const existing = await fs.lstat(file).catch(() => undefined);
  if (existing?.isSymbolicLink()) throw Object.assign(new Error('report path is a symlink'), {code: 'ESYMLINK'});
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(report, null, 2)}\n`, {mode: 0o600, flag: 'wx'});
  await fs.chmod(tmp, 0o600);
  await fs.rename(tmp, file);
}

const readJson = async (file: string) => {try {return JSON.parse(await fs.readFile(file, 'utf8')) as any;} catch {return undefined;}};

async function installedSdkVersion() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const manifest = await readJson(path.resolve(here, '..', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'));
  return safeToken(manifest?.version) ?? 'unknown';
}
// Run against the throwaway consumer home so that even a stray write never lands in a real Codex home.
async function codexVersion(consumerHome: string) {
  try {
    const {stdout} = await exec(codexBin(), ['--version'], {timeout: 10000, env: {...process.env, CODEX_HOME: consumerHome}});
    return stdout.trim().slice(0, 64).replace(/[^A-Za-z0-9 ._+-]/g, '?');
  } catch (error) {return `unavailable(${failureCode(error)})`;}
}

// ---------------------------------------------------------------- the run

interface Ctx {
  rpc: Rpc; providers: ReturnType<typeof trackedRunner>; model: ClaudeModel; work: string; S: State; registry: Record<string, string>;
  clock: () => number; threadIds: Set<string>;
}

const check = (C: Ctx, name: string, value: boolean | null) => {C.S.checks[name] = value;};

async function startThread(C: Ctx, sandbox: 'workspace-write' | 'read-only') {
  C.S.phase = 'thread';
  const result = await C.rpc.request<any>('thread/start', {model: MODEL_ID, modelProvider: PROVIDER, cwd: C.work, sandbox, approvalPolicy: 'never', ephemeral: true}, 30_000);
  const id = result?.thread?.id;
  if (typeof id !== 'string' || !id) throw new RpcError('invalid_thread');
  C.threadIds.add(id);
  return id;
}

interface Started {label: string; threadId: string; turnId: string | undefined; sendAt: number; startIndex: number; providerBefore: number}
async function beginTurn(C: Ctx, threadId: string, label: string, text: string): Promise<Started> {
  C.S.phase = label;
  const startIndex = C.rpc.log.length, providerBefore = C.providers.entries.length, sendAt = C.clock();
  const result = await C.rpc.request<any>('turn/start', {threadId, effort: 'medium', input: [{type: 'text', text}]}, 30_000);
  const turnId = typeof result?.turn?.id === 'string' ? result.turn.id : undefined;
  return {label, threadId, turnId, sendAt, startIndex, providerBefore};
}
const isTurnDone = (started: Started) => (notice: Notice) => notice.method === 'turn/completed' && notice.params?.threadId === started.threadId
  && (!started.turnId || !notice.params?.turn?.id || notice.params.turn.id === started.turnId);

function recordTurn(C: Ctx, started: Started, done: Notice | undefined): {record: TurnRecord; agentText: string} {
  const notices = C.rpc.log.slice(started.startIndex);
  const analysis = analyzeItems(notices, C.registry);
  const first = C.providers.entries.slice(started.providerBefore)[0];
  const rel = (value: number | undefined) => value === undefined ? null : Math.max(0, Math.round(value - started.sendAt));
  const record: TurnRecord = {label: started.label, status: safeToken(done?.params?.turn?.status) ?? (done ? 'unknown' : 'missing'), turn_id_seen: Boolean(started.turnId),
    thread_matches: Boolean(done) && done!.params?.threadId === started.threadId, send_ms: Math.round(started.sendAt), first_provider_request_ms: rel(first?.arrival_ms),
    first_tool_item_started_ms: rel(analysis.firstToolAt), completed_ms: rel(done?.at), tool_items_started: analysis.toolStarted, tool_items_completed: analysis.completed,
    item_types: analysis.itemTypes, agent_message_chars: analysis.agentText.length, agent_sentinels: observeSentinels(analysis.agentText, C.registry),
    provider_requests: C.providers.entries.length - started.providerBefore};
  C.S.turns.push(record);
  return {record, agentText: analysis.agentText};
}

async function runTurn(C: Ctx, threadId: string, label: string, text: string) {
  const started = await beginTurn(C, threadId, label, text);
  const done = await C.rpc.waitFor(isTurnDone(started), TURN_TIMEOUT_MS, started.startIndex);
  return {started, ...recordTurn(C, started, done)};
}

const recursionSeen = (C: Ctx) => C.S.turns.some(turn => turn.tool_items_completed.some(item => item.suspicious_command));
const providersOk = (C: Ctx) => C.providers.entries.length > 0 && C.providers.entries.every(entry => entry.outcome === 'ok');

async function caseReadWrite(C: Ctx) {
  const fixture = path.join(C.work, 'fixture.txt');
  const nonce = hex(6);
  Object.assign(C.registry, {fixture: `FIXTURE_${nonce}`, continuity: `CONTINUITY_${nonce}`, changed: `CHANGED_${nonce}`});
  await fs.writeFile(fixture, `${C.registry.fixture}\n`);
  const threadId = await startThread(C, 'workspace-write');
  const first = await runTurn(C, threadId, 'turn1', `Use Claude to read fixture.txt with a Codex tool, report its exact content, and remember ${C.registry.continuity}. Do not invoke another Claude or the legacy bridge.`);
  const second = await runTurn(C, threadId, 'turn2', `Change only fixture.txt so that its entire content is the single line ${C.registry.changed}, using a native Codex tool. Then read the file back with a native Codex tool, and report the changed value and the nonce you were asked to remember. Do not invoke another Claude or the legacy bridge.`);
  const readback = (await fs.readFile(fixture, 'utf8').catch(() => '')).trim();
  const t1 = first.record, t2 = second.record;
  const fromTools = (turn: TurnRecord, name: string) => turn.tool_items_completed.some(item => item.item_type === 'commandExecution' && item.output_sentinels.includes(name));
  check(C, 'turn1_completed', t1.status === 'completed');
  check(C, 'turn2_completed', t2.status === 'completed');
  check(C, 'same_codex_thread', t1.thread_matches && t2.thread_matches && C.threadIds.size === 1);
  check(C, 'turn1_native_tool_item_started', t1.tool_items_started >= 1);
  check(C, 'turn1_fixture_in_tool_output', fromTools(t1, 'fixture'));
  check(C, 'turn1_agent_reported_fixture', t1.agent_sentinels.includes('fixture'));
  check(C, 'tool_result_reached_provider_request', C.providers.entries.some(entry => entry.sentinels_in_outputs.includes('fixture')));
  check(C, 'turn2_two_or_more_native_tool_items', t2.tool_items_completed.length >= 2);
  check(C, 'turn2_changed_in_tool_output', fromTools(t2, 'changed'));
  check(C, 'fs_readback_changed', readback === C.registry.changed);
  check(C, 'turn2_agent_reported_changed', t2.agent_sentinels.includes('changed'));
  check(C, 'turn2_agent_reported_continuity', t2.agent_sentinels.includes('continuity'));
  check(C, 'history_with_continuity_reached_provider', C.providers.entries.slice(t1.provider_requests).some(entry => entry.sentinels_in_input.includes('continuity')));
  check(C, 'no_recursive_bridge_or_cli_command', !recursionSeen(C));
  check(C, 'all_provider_steps_ok', providersOk(C));
  C.S.detail = {write_then_readback_order_not_proven: true, thread_count: C.threadIds.size};
  C.S.deferred.push(() => expectCompleteReceipts(C));
}

async function caseHistory(C: Ctx) {
  const nonce = `HISTORY_${hex(6)}`;
  C.registry.history = nonce;
  const filler = Array.from({length: 190}, (_, index) => `Inert filler paragraph ${index + 1}: the quick grey library cart rolls past the quiet reading room window.`).join('\n');
  const prompt = `Context note: the access phrase for this session is ${nonce}.\n\n${filler}\n\nQuestion: what access phrase does the context note at the very top give? Reply with only that phrase. Do not use any tools.`;
  C.S.detail = {prompt_chars: prompt.length, approx_prompt_tokens_upper_bound: Math.ceil(prompt.length / 3), label: 'finite_history_transport_only'};
  const threadId = await startThread(C, 'read-only');
  const turn = await runTurn(C, threadId, 'history', prompt);
  check(C, 'turn_completed', turn.record.status === 'completed');
  check(C, 'no_tool_items', turn.record.tool_items_started === 0);
  check(C, 'recalled_early_fact', turn.record.agent_sentinels.includes('history'));
  check(C, 'answer_is_short', turn.record.agent_message_chars > 0 && turn.record.agent_message_chars <= 200);
  check(C, 'all_provider_steps_ok', providersOk(C));
  C.S.deferred.push(() => expectCompleteReceipts(C));
}

async function caseReadOnly(C: Ctx) {
  const target = path.join(C.work, 'readonly-target.txt');
  const original = `READONLY_ORIGINAL_${hex(6)}\n`;
  await fs.writeFile(target, original);
  const threadId = await startThread(C, 'read-only');
  const turn = await runTurn(C, threadId, 'readonly', 'Using your native exec_command tool, run exactly one command that tries to overwrite readonly-target.txt with shell redirection, for example: echo MODIFIED > readonly-target.txt . Run it once only, report the exact result, and do not use any other tool, elevation or workaround.');
  const unchanged = (await fs.readFile(target, 'utf8').catch(() => '')) === original;
  const verdict = classifyReadonly({toolStarted: turn.record.tool_items_started, completed: turn.record.tool_items_completed, fileChanged: !unchanged});
  C.S.result = verdict.result; C.S.verdict = verdict.status;
  check(C, 'turn_completed', turn.record.status === 'completed');
  check(C, 'fixture_file_unchanged', unchanged);
  check(C, 'single_write_attempt', turn.record.tool_items_started <= 1);
  check(C, 'no_recursive_bridge_or_cli_command', !recursionSeen(C));
  C.S.detail = {sandbox: 'read-only', approval_policy: 'never', model_refusal_is_not_sandbox_proof: true, tool_items_started: turn.record.tool_items_started};
}

async function caseCompact(C: Ctx) {
  const nonce = `COMPACT_${hex(6)}`;
  C.registry.compact = nonce;
  const threadId = await startThread(C, 'read-only');
  const turn = await runTurn(C, threadId, 'before_compact', `Remember the token ${nonce}. Reply with exactly the word: noted. Do not use any tools.`);
  check(C, 'conversation_turn_completed', turn.record.status === 'completed');
  const startIndex = C.rpc.log.length, providerBefore = C.providers.entries.length, sentAt = C.clock();
  C.S.phase = 'compact';
  // 1. RPC acceptance. A rejection is final: the request is never retried.
  let accepted: boolean | null = null, errorKind: string | undefined, errorClass: string | undefined, rpcCode: number | undefined;
  try {
    await C.rpc.request('thread/compact/start', {threadId}, 30_000);
    accepted = true;
  } catch (error) {
    if (error instanceof RpcError) {errorKind = error.kind; errorClass = error.messageClass; rpcCode = error.rpcCode;}
    // A timed-out request is unknown, not rejected: a terminal notice may still be on its way.
    accepted = errorKind === 'timeout' ? null : false;
  }
  // 2. Terminal state: wait for an explicit terminal notice on this thread. Progress notices and elapsed time prove nothing.
  let terminal: CompactionTerminal | undefined, terminalMs: number | null = null;
  if (accepted !== false) {
    const hit = await C.rpc.waitFor(notice => compactionTerminal(notice, threadId) !== undefined, COMPACT_TERMINAL_TIMEOUT_MS, startIndex);
    terminal = hit ? compactionTerminal(hit, threadId) : undefined;
    terminalMs = hit ? Math.max(0, Math.round(hit.at - sentAt)) : null;
  }
  const providerSettled = await C.providers.settle(30_000);
  const providerRequests = C.providers.entries.length - providerBefore;
  // 3. Recall: only after a confirmed completion, ask the same thread (no tools) for the original nonce.
  const recall: {ran: boolean; ok: boolean | null; agent_message_chars: number | null} = {ran: false, ok: null, agent_message_chars: null};
  if (terminal?.state === 'completed') {
    const after = await runTurn(C, threadId, 'after_compact', 'What token did I ask you to remember earlier in this conversation? Reply with only that token. Do not use any tools.');
    recall.ran = true;
    recall.ok = after.record.status === 'completed' && after.record.tool_items_started === 0 && after.record.agent_sentinels.includes('compact');
    recall.agent_message_chars = after.record.agent_message_chars;
    check(C, 'recalled_early_fact_after_compaction', recall.ok);
    C.S.deferred.push(() => expectCompleteReceipts(C));
  }
  const result = accepted === false ? (errorClass === 'unsupported' ? 'rpc_unsupported' : 'rpc_rejected')
    : !terminal ? (accepted === null ? 'rpc_timeout_no_terminal' : 'no_terminal_before_deadline')
    : terminal.state === 'failed' ? 'terminal_failed' : terminal.state === 'interrupted' ? 'terminal_interrupted'
    : recall.ok ? 'completed_and_recalled' : 'completed_recall_missing';
  C.S.result = result;
  // A refused, failed or interrupted compaction is recorded behaviour; no terminal state at the deadline is inconclusive.
  C.S.verdict = result === 'completed_and_recalled' ? 'pass' : result === 'completed_recall_missing' ? 'fail'
    : !terminal && accepted !== false ? 'inconclusive' : 'recorded';
  C.S.detail = {
    scope: 'manual_compaction_trial_only', not_automatic_long_context_acceptance: true,
    rpc: {accepted, error_kind: errorKind ?? null, error_code: rpcCode ?? null, error_message_class: errorClass ?? null},
    terminal: terminal ? {...terminal, wait_ms: terminalMs} : null, recall,
    provider_requests_during_compaction: providerRequests, provider_settled_after_terminal: providerSettled,
    compact_notifications: [...new Set(C.rpc.log.slice(startIndex).map(notice => notice.method))].slice(0, 20),
    note: 'Claude route has no remote /responses/compact; see provider.by_path for any compact request that reached the bridge.'};
}

async function caseCancel(C: Ctx) {
  const threadId = await startThread(C, 'read-only');
  const before = C.providers.entries.length;
  const started = await beginTurn(C, threadId, 'cancel', 'Write a detailed, numbered 40-step plan for organising a small library of 500 books, with a full paragraph for every step. Do not use any tools.');
  const arrived = await waitUntil(() => C.providers.entries.length > before, 120_000);
  check(C, 'provider_request_observed', arrived);
  if (!arrived) {C.S.result = 'no_provider_request'; C.S.verdict = 'fail'; return;}
  await sleep(3000);
  if (C.rpc.log.slice(started.startIndex).some(isTurnDone(started))) {
    recordTurn(C, started, C.rpc.log.slice(started.startIndex).find(isTurnDone(started)));
    C.S.result = 'cancel_not_exercised'; C.S.verdict = 'inconclusive'; check(C, 'cancel_exercised', false);
    return;
  }
  let returned = false;
  try {
    if (!started.turnId) throw new RpcError('no_turn_id');
    await C.rpc.request('turn/interrupt', {threadId, turnId: started.turnId}, 30_000); returned = true;
  } catch {/* recorded below */}
  check(C, 'interrupt_returned', returned);
  const done = await C.rpc.waitFor(isTurnDone(started), 30_000, started.startIndex);
  const record = recordTurn(C, started, done).record;
  if (record.status === 'completed') {C.S.result = 'cancel_not_exercised'; C.S.verdict = 'inconclusive'; check(C, 'cancel_exercised', false); return;}
  check(C, 'cancel_exercised', true);
  check(C, 'turn_interrupted', record.status === 'interrupted');
  check(C, 'provider_steps_settled', await C.providers.settle(30_000));
  check(C, 'provider_step_aborted', C.providers.entries.slice(before).some(entry => entry.outcome === 'aborted'));
  C.S.deferred.push(() => {
    const aborted = C.S.receipts.filter(receipt => receipt.status === 'aborted');
    check(C, 'receipt_aborted_without_invented_ids', aborted.length >= 1 && aborted.every(receipt => receipt.sdk_session_id === null && receipt.actual_models.length === 0));
  });
}

function expectCompleteReceipts(C: Ctx) {
  const receipts = C.S.receipts;
  check(C, 'receipt_per_provider_request', receipts.length === C.providers.entries.length);
  check(C, 'receipts_complete_with_final_model_and_session', receipts.length > 0 && receipts.every(receipt => receipt.status === 'complete'
    && receipt.inference_stage === 'final_received' && receipt.actual_models.length > 0 && receipt.sdk_session_id !== null));
}

async function waitUntil(predicate: () => boolean, timeoutMs: number) {
  const until = performance.now() + timeoutMs;
  while (performance.now() < until) {if (predicate()) return true; await sleep(100);}
  return predicate();
}

// ---------------------------------------------------------------- orchestration

async function runAcceptance(args: Args & {codexHome: string; report: string}) {
  const t0 = performance.now();
  const clock = () => performance.now() - t0;
  const startedAt = new Date();
  const S: State = {phase: 'args', failures: [], checks: {}, turns: [], result: 'unexecuted', verdict: 'error', detail: {}, deferred: [], receipts: []};
  const fail = (error: unknown) => {S.failures.push({phase: S.phase, code: failureCode(error)});};
  const policyHome = locations(args.codexHome);
  const runtime = {runtimePolicyPath: path.join(policyHome.root, 'runtime-policy.json'), receiptsDir: path.join(policyHome.root, 'receipts')};
  const registry: Record<string, string> = {};
  const harnessAbort = new AbortController();
  const owned = new Map<number, string>();
  let sampling = false;
  const sample = async () => {
    if (sampling) return;
    sampling = true;
    try {for (const entry of descendantsOf(await processTable(), process.pid)) owned.set(entry.pid, entry.comm);} catch {/* best effort */}
    sampling = false;
  };
  const meta: Record<string, unknown> = {requested_model: MODEL_ID, requested_effort: 'medium'};
  let tempRoot: string | undefined, server: Server | undefined, rpc: Rpc | undefined, providers: ReturnType<typeof trackedRunner> | undefined;
  let tracker: NodeJS.Timeout | undefined, deadline: NodeJS.Timeout | undefined;
  const cleanup: Record<string, unknown> = {};
  const receiptsBefore = new Set<string>();
  let providerPaths: Record<string, number> = {};
  try {
    S.phase = 'policy';
    const policy = await loadRuntimePolicy(runtime.runtimePolicyPath);
    Object.assign(meta, {claude_cli_version: policy.claude_version, claude_cli_sha256_prefix: policy.claude_sha256.slice(0, 12), sdk_version: await installedSdkVersion()});

    S.phase = 'inspect';
    await fs.mkdir(path.join(policyHome.root, 'sdk-cwd'), {recursive: true, mode: 0o700});
    const inspected = await inspectSdk(path.join(policyHome.root, 'sdk-cwd'), runtime);
    meta.inspected = {authenticated: inspected.authenticated, plan: inspected.subscriptionType, models: inspected.models.length, guard_coverage: inspected.guardCoverage};
    if (!inspected.authenticated) throw new RpcError('not_authenticated');
    const model = inspected.models.find(entry => entry.id === MODEL_ID);
    if (!model) throw new RpcError('model_unavailable');
    if (!model.efforts.includes('medium')) throw new RpcError('effort_medium_unsupported');
    for (const name of await fs.readdir(runtime.receiptsDir).catch(() => [] as string[])) receiptsBefore.add(name);

    S.phase = 'fixture';
    tempRoot = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'nat-accept-'));
    const work = path.join(tempRoot, 'work');
    const consumerHome = path.join(tempRoot, 'codex-home');
    await fs.mkdir(work, {mode: 0o700}); await fs.mkdir(consumerHome, {mode: 0o700});
    meta.codex_version = await codexVersion(consumerHome);

    S.phase = 'server';
    const token = `local-${hex(24)}`;
    providers = trackedRunner(sdkRunner(path.join(policyHome.root, 'sdk-cwd'), [model], undefined, runtime), registry, clock, harnessAbort);
    server = bridgeServer({token, run: providers.run, timeoutMs: STEP_TIMEOUT_MS});
    server.on('request', request => {
      const route = request.url === '/v1/responses' ? '/v1/responses' : request.url === '/v1/responses/compact' ? '/v1/responses/compact' : 'other';
      providerPaths[route] = (providerPaths[route] ?? 0) + 1;
    });
    server.listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {server!.once('listening', resolve); server!.once('error', reject);});
    const port = (server.address() as AddressInfo).port;

    S.phase = 'consumer_config';
    const consumer = locations(consumerHome);
    await installConfig(consumer, [model], port);
    await activate(consumer, MODEL_ID);
    const config = TOML.parse(await fs.readFile(consumer.config, 'utf8')) as any;
    const provider = config.model_providers[PROVIDER];
    // Test-only override in this throwaway home: a static random loopback header instead of the dynamic auth command.
    delete provider.auth;
    provider.http_headers = {Authorization: `Bearer ${token}`};
    provider.requires_openai_auth = false; provider.request_max_retries = 0; provider.stream_max_retries = 0;
    config.features = {...config.features, remote_plugin: false, plugins: false, apps: false, hooks: false};
    await fs.writeFile(consumer.config, TOML.stringify(config), {mode: 0o600});

    S.phase = 'app_server';
    await sample();
    tracker = setInterval(() => void sample(), 1500); tracker.unref();
    const env: NodeJS.ProcessEnv = {...process.env, CODEX_HOME: consumerHome};
    for (const key of Object.keys(env)) if (/^(ANTHROPIC_|OPENAI_|CODEX_API_KEY$|CHATGPT_|CLAUDE_CODE_|AWS_BEARER_TOKEN_BEDROCK$)/.test(key)) delete env[key];
    const child = spawn(codexBin(), ['app-server', '--stdio', '--disable', 'remote_plugin', '--disable', 'apps', '--disable', 'plugins'], {cwd: work, env, stdio: ['pipe', 'pipe', 'pipe']});
    rpc = new Rpc(child, clock);
    const deadlineHit = new Promise<never>((_, reject) => {
      deadline = setTimeout(() => {harnessAbort.abort(); child.kill('SIGKILL'); reject(new RpcError('case_deadline'));}, CASE_DEADLINE_MS);
    });
    deadline!.unref();

    const body = async () => {
      S.phase = 'initialize';
      await rpc!.request('initialize', {clientInfo: {name: 'native-acceptance', version: '0.1.0'}, capabilities: {experimentalApi: true}}, 30_000);
      rpc!.notify('initialized');
      S.phase = 'model_list';
      const list = await rpc!.request<any>('model/list', {limit: 100}, 30_000);
      const listed = Array.isArray(list?.data) ? list.data : [];
      meta.model_list = {count: listed.length, claude_model_listed: listed.some((entry: any) => entry?.model === MODEL_ID)};
      if (!listed.some((entry: any) => entry?.model === MODEL_ID)) throw new RpcError('model_not_listed');
      const C: Ctx = {rpc: rpc!, providers: providers!, model, work, S, registry, clock, threadIds: new Set()};
      S.phase = `case:${args.caseName}`;
      S.result = 'executed'; S.verdict = 'error';
      const cases = {readwrite: caseReadWrite, cancel: caseCancel, readonly: caseReadOnly, compact: caseCompact, history: caseHistory};
      await cases[args.caseName](C);
      await C.providers.settle(20_000);
      S.phase = 'case_done';
    };
    await Promise.race([body(), deadlineHit]);
  } catch (error) {
    fail(error);
  } finally {
    S.phase = 'cleanup';
    harnessAbort.abort();
    if (tracker) clearInterval(tracker);
    if (deadline) clearTimeout(deadline);
    try {
      await sample();
      if (rpc) {
        rpc.child.stdin?.end();
        const gone = new Promise<void>(resolve => {if (rpc!.child.exitCode !== null || rpc!.child.signalCode) resolve(); else rpc!.child.once('exit', () => resolve());});
        rpc.child.kill('SIGTERM');
        await Promise.race([gone, sleep(5000)]);
        if (rpc.child.exitCode === null && !rpc.child.signalCode) {rpc.child.kill('SIGKILL'); await Promise.race([gone, sleep(2000)]);}
      }
      if (server) {
        server.closeAllConnections();
        await Promise.race([new Promise<void>(resolve => server!.close(() => resolve())), sleep(3000)]);
      }
      cleanup.inflight_settled = providers ? await providers.settle(15_000) : true;
      // Owned descendants only: PIDs this process was seen to own whose command name is unchanged.
      const live = async () => (await processTable()).filter(entry => owned.get(entry.pid) === entry.comm);
      let remaining = await live();
      cleanup.owned_seen = owned.size; cleanup.owned_seen_names = nameCounts([...owned].map(([, comm]) => ({comm})));
      for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
        if (!remaining.length) break;
        for (const entry of remaining) {try {process.kill(entry.pid, signal);} catch {/* already gone */}}
        cleanup[`signalled_${signal}`] = remaining.length;
        await sleep(signal === 'SIGTERM' ? 2500 : 1000);
        remaining = await live();
      }
      const stray = descendantsOf(await processTable(), process.pid);
      cleanup.owned_remaining = remaining.length; cleanup.owned_remaining_names = nameCounts(remaining);
      cleanup.descendants_remaining = stray.length; cleanup.descendants_remaining_names = nameCounts(stray);
    } catch (error) {cleanup.error = failureCode(error);}
    if (tempRoot) {
      const removed = await fs.rm(tempRoot, {recursive: true, force: true}).then(() => true, () => false);
      cleanup.temp_removed = removed;
    }
  }

  // Only receipts created by this invocation count; earlier cases and their session IDs are never reused.
  const receiptFiles: string[] = [];
  try {
    for (const name of (await fs.readdir(runtime.receiptsDir).catch(() => [] as string[])).filter(entry => entry.endsWith('.json') && !receiptsBefore.has(entry)).sort()) {
      receiptFiles.push(name);
      const summary = summarizeReceipt(await readJson(path.join(runtime.receiptsDir, name)));
      S.receipts.push(summary);
    }
  } catch (error) {fail(error);}
  // Deferred checks need receipts and cleanup facts, which exist only after cleanup.
  S.checks.no_owned_child_remains_after_cleanup = cleanup.owned_remaining === 0 && cleanup.descendants_remaining === 0;
  for (const run of S.deferred) {try {run();} catch (error) {S.failures.push({phase: 'verify', code: failureCode(error)});}}

  const failedChecks = Object.entries(S.checks).filter(([, value]) => value === false).map(([name]) => name);
  const unknownChecks = Object.entries(S.checks).filter(([, value]) => value === null).map(([name]) => name);
  let status: string;
  if (S.failures.length) status = 'error';
  else if (S.verdict === 'inconclusive') status = 'inconclusive';
  else if (S.verdict === 'recorded') status = failedChecks.length ? 'fail' : 'recorded';
  else if (S.verdict === 'fail' || failedChecks.length) status = 'fail';
  else if (S.verdict === 'pass') status = unknownChecks.length ? 'inconclusive' : 'pass';
  else status = unknownChecks.length || S.result === 'unexecuted' ? 'inconclusive' : 'pass';
  if (S.result === 'executed' && S.verdict === 'error' && !S.failures.length) S.result = failedChecks.length ? 'checks_failed' : 'checks_passed';

  const report = {
    schema: 'native-acceptance/1', case: args.caseName, status, result: S.result, phase: S.phase, started_at: startedAt.toISOString(), ended_at: new Date().toISOString(),
    wall_ms: Math.round(performance.now() - t0), ...meta,
    gui_acceptance: 'unverified', scope: 'headless Codex app-server events with a loopback bridge and the real Claude subscription; not GUI screenshots, not a sandbox audit beyond the stated case',
    provider: {requests: providers?.entries.length ?? 0, by_path: providerPaths, entries: providers?.entries ?? []},
    codex: {event_counts: rpc?.counts ?? {}, server_requests_declined: rpc?.serverRequests ?? {}, invalid_lines: rpc?.invalidLines ?? 0, stderr_bytes: rpc?.stderrBytes ?? 0,
      events_sample: rpc?.events.slice(0, 120) ?? [], events_dropped: rpc?.droppedEvents ?? 0},
    turns: S.turns, checks: S.checks, failed_checks: failedChecks, unknown_checks: unknownChecks, detail: S.detail,
    receipts: {dir: runtime.receiptsDir, files: receiptFiles, summaries: S.receipts},
    cleanup, failures: S.failures,
    limits: ['actual model identity and session IDs come only from the final-result receipts, never from aliases or stream init', 'effective reasoning effort is unknown',
      'no GPT request was made and no fallback exists', 'process cleanup proof covers PIDs this process observed, by name only'],
  };
  return report;
}

export async function main(argv: string[]) {
  const args = parseArgs(argv);
  if (!args.live) {
    console.log(usage());
    if (args.errors.length) {console.error(`Not run: ${args.errors.join('; ')}`); return 2;}
    return 0;
  }
  const missing = [...(args.codexHome ? [] : ['--codex-home']), ...(args.report ? [] : ['--report'])];
  if (missing.length || args.errors.length) {
    console.log(usage()); console.error(`Not run: ${[...args.errors, ...missing.map(flag => `${flag} is required with --live`)].join('; ')}`);
    return 2;
  }
  const home = await fs.realpath(os.homedir()).catch(() => os.homedir());
  const supplied = path.resolve(args.codexHome!);
  const suppliedReal = await fs.realpath(supplied).catch(() => undefined);
  if (!suppliedReal) {console.error('Not run: --codex-home must be an existing isolated directory.'); return 2;}
  const envHome = process.env.CODEX_HOME ? await fs.realpath(process.env.CODEX_HOME).catch(() => path.resolve(process.env.CODEX_HOME!)) : undefined;
  if (isNormalCodexHome(suppliedReal, {home, envCodexHome: envHome}) || isNormalCodexHome(supplied, {home: os.homedir(), envCodexHome: process.env.CODEX_HOME})) {
    console.error('Not run: --codex-home must be an isolated directory, never the normal Codex home or an ancestor of it.'); return 2;
  }
  const reportPath = path.resolve(args.report!);
  const report = await runAcceptance({...args, codexHome: suppliedReal, report: reportPath});
  let code = report.status === 'pass' || report.status === 'recorded' ? 0 : report.status === 'inconclusive' ? 3 : report.status === 'fail' ? 1 : 2;
  try {await writeReport(reportPath, report);}
  catch (error) {console.error(`Report not written (${failureCode(error)}).`); code = 4;}
  console.log(`native-acceptance case=${report.case} status=${report.status} result=${report.result} report=${reportPath}`);
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(code => process.exit(code), error => {console.error(`native-acceptance failed (${failureCode(error)}).`); process.exit(2);});
}

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { BridgeError } from './contracts.js';

// One private receipt per SDK inference attempt. Identity and aggregate accounting come only from the final result;
// separately labelled context counters come from a completed, verified main-model stream. No
// prompts, history, tools, arguments, results, credentials, or account identity, and no request alias or stream ID
// is ever promoted to evidence of the actual model or session.
//   blocked    - the gate, account check or another step before the prompt was released refused the attempt
//   aborted    - the request was cancelled
//   failed     - a final result arrived but is not a verified success
//   incomplete - no final result, or a final result without verifiable model, session and usage
export type ReceiptStatus = 'complete' | 'failed' | 'incomplete' | 'aborted' | 'blocked';
export type InferenceStage = 'not_started' | 'prompt_released' | 'final_received';
export interface ReceiptUsage {input_tokens: number; cached_input_tokens: number; output_tokens: number; reasoning_tokens: number; total_tokens: number}
export interface Receipt {
  schema_version: 1;
  run_id: string;
  started_at: string;
  ended_at: string;
  // Host wall clock from the accepted model step, before the guard and account handshake, to the end of the attempt.
  wall_ms: number;
  // Until the prompt was released (null if it never was) and from then on (null if it never was).
  preflight_ms: number | null;
  query_ms: number | null;
  inference_stage: InferenceStage;
  requested_alias: string;
  requested_effort: string | null;
  effective_effort: 'unknown';
  actual_models: string[];
  sdk_session_id: string | null;
  status: ReceiptStatus;
  code: string;
  usage: ReceiptUsage | null;
  usage_scope?: 'query_pipeline_total';
  context_usage?: {model: string; source: 'message_stream'; usage: ReceiptUsage} | null;
  // Counters reported by the SDK's final result; distinct from the host wall clock and not GUI or first-tool times.
  sdk_duration_ms: number | null;
  sdk_duration_api_ms: number | null;
  sdk_num_turns: number | null;
  sdk_ttft_ms: number | null;
  sdk_ttft_stream_ms: number | null;
  sdk_time_to_request_ms: number | null;
  permission_denials_status: 'none' | 'present' | 'unknown';
  permission_denials_count: number | null;
  guard_coverage: string;
  cli_version: string | null;
  // SDK queries made for this step; above 1 when a malformed decision was retried. Counters above describe the last one.
  attempts?: number;
  // Why the first decision was rejected: code, tool key and kind only, never the arguments.
  rejected?: {code: string; tool?: string; kind?: string} | null;
  // 'compaction' when Codex asked for a context-checkpoint summary; 'turn' for an ordinary step.
  request_kind?: 'turn' | 'compaction';
}

export class ReceiptError extends BridgeError {
  constructor(message: string) {super(500, 'receipt_failed', message);}
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

// Only a UUID can be a session ID, and only a plausible bounded Claude model identifier (family and version words, optionally
// a context suffix such as [1m]) can be a model name. Anything else in a final result is discarded, never saved.
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODEL_ID = /^claude-[a-z0-9]+(?:[-.][a-z0-9]+){0,7}(?:\[[0-9a-z]{1,8}\])?$/;
export function safeSessionId(value: unknown): string | null {
  return typeof value === 'string' && SESSION_ID.test(value) ? value : null;
}
export function safeModelId(value: unknown): string | null {
  return typeof value === 'string' && value.length <= 64 && MODEL_ID.test(value) ? value : null;
}
export function safeCode(value: unknown): string {
  return typeof value === 'string' && /^[a-z0-9_]{1,48}$/.test(value) ? value : 'unknown';
}

export function aggregateUsage(modelUsage: unknown): ReceiptUsage | null {
  if (!isRecord(modelUsage)) return null;
  const rows = Object.values(modelUsage);
  if (!rows.length) return null;
  const total = {input: 0, cached: 0, output: 0, reasoning: 0};
  for (const row of rows) {
    if (!isRecord(row)) return null;
    const input = finite(row.inputTokens), read = finite(row.cacheReadInputTokens), created = finite(row.cacheCreationInputTokens), output = finite(row.outputTokens);
    if (input === null || read === null || created === null || output === null) return null;
    total.input += input + read + created; total.cached += read; total.output += output; total.reasoning += finite(row.thinkingTokens) ?? 0;
  }
  return {input_tokens: total.input, cached_input_tokens: total.cached, output_tokens: total.output, reasoning_tokens: total.reasoning,
    total_tokens: total.input + total.output};
}

// Everything evidential comes from the final result message, and only from there.
export function summarizeFinal(final: Record<string, unknown> | undefined) {
  const models = final && isRecord(final.modelUsage)
    ? Object.keys(final.modelUsage).map(safeModelId).filter((name): name is string => name !== null).slice(0, 8) : [];
  const denials = final && Array.isArray(final.permission_denials) ? final.permission_denials.length : null;
  return {
    actual_models: models,
    sdk_session_id: safeSessionId(final?.session_id),
    usage: final ? aggregateUsage(final.modelUsage) : null,
    sdk_duration_ms: finite(final?.duration_ms),
    sdk_duration_api_ms: finite(final?.duration_api_ms),
    sdk_num_turns: finite(final?.num_turns),
    sdk_ttft_ms: finite(final?.ttft_ms),
    sdk_ttft_stream_ms: finite(final?.ttft_stream_ms),
    sdk_time_to_request_ms: finite(final?.time_to_request_ms),
    permission_denials_status: (denials === null ? 'unknown' : denials ? 'present' : 'none') as Receipt['permission_denials_status'],
    permission_denials_count: denials,
  };
}

export function newRunId() {return randomUUID();}

async function privateDirectory(dir: string) {
  let stat = await fs.lstat(dir).catch(error => {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error;});
  if (!stat) {await fs.mkdir(dir, {recursive: true, mode: 0o700}); stat = await fs.lstat(dir);}
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw Object.assign(new Error('not a plain directory'), {code: 'EINVAL'});
  if (stat.mode & 0o077) await fs.chmod(dir, 0o700);
}

export async function writeReceipt(dir: string, receipt: Receipt) {
  const file = path.join(dir, `${receipt.started_at.replaceAll(/[-:.]/g, '')}-${receipt.run_id}.json`);
  const tmp = `${file}.tmp`;
  try {
    await privateDirectory(dir);
    await fs.writeFile(tmp, `${JSON.stringify(receipt, null, 2)}\n`, {mode: 0o600, flag: 'wx'});
    await fs.chmod(tmp, 0o600);
    await fs.rename(tmp, file);
  } catch (error) {
    await fs.rm(tmp, {force: true}).catch(() => {});
    const code = (error as NodeJS.ErrnoException).code;
    throw new ReceiptError(`Receipt write failed (${typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : 'EWRITE'}).`);
  }
  return file;
}

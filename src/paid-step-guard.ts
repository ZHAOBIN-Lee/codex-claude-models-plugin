import {createHash, type Hash} from 'node:crypto';
import {constants, promises as fs, type Stats} from 'node:fs';
import path from 'node:path';
import {BridgeError, type ResponsesRequest} from './contracts.js';

const identities = new WeakMap<ResponsesRequest, string>();
const contexts = new WeakMap<ResponsesRequest, {chat: string; turn: string | null}>();
type Headers = Record<string, string | string[] | undefined>;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value);

function context(headers: Headers): {chat: string; turn: string | null} | null {
  const selected: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (!['thread-id', 'session-id', 'x-codex-turn-metadata'].includes(key) || value === undefined) continue;
    if (typeof value !== 'string' || selected[key] !== undefined) return null;
    selected[key] = value;
  }
  let metadata: Record<string, unknown> = {};
  if (selected['x-codex-turn-metadata'] !== undefined) {
    const raw = selected['x-codex-turn-metadata']!;
    if (raw.length > 16384) return null;
    try {const parsed: unknown = JSON.parse(raw); if (!record(parsed)) return null; metadata = parsed;}
    catch {return null;}
  }
  for (const value of [selected['thread-id'], selected['session-id'], metadata.thread_id, metadata.session_id, metadata.turn_id]) {
    if (value !== undefined && !validId(value)) return null;
  }
  if (selected['thread-id'] && metadata.thread_id && selected['thread-id'] !== metadata.thread_id) return null;
  if (selected['session-id'] && metadata.session_id && selected['session-id'] !== metadata.session_id) return null;
  const chat = selected['thread-id'] ?? metadata.thread_id ?? selected['session-id'] ?? metadata.session_id;
  return validId(chat) ? {chat, turn: validId(metadata.turn_id) ? metadata.turn_id : null} : null;
}

// Canonical JSON is hashed incrementally so inline images need no second full-request copy.
function digestValue(hash: Hash, value: unknown): void {
  if (Array.isArray(value)) {
    hash.update('[');
    value.forEach((item, index) => {if (index) hash.update(','); digestValue(hash, item);});
    hash.update(']');
  } else if (record(value)) {
    hash.update('{');
    Object.keys(value).filter(key => value[key] !== undefined).sort().forEach((key, index) => {
      if (index) hash.update(','); hash.update(JSON.stringify(key)); hash.update(':'); digestValue(hash, value[key]);
    });
    hash.update('}');
  } else hash.update(JSON.stringify(value) ?? 'null');
}

// Call only after authenticating the local HTTP request. Identity comes from Codex's HTTP context, never from
// request.router_* or body client_metadata. Codex 0.163 sends thread-id/session-id plus x-codex-turn-metadata;
// its turn_id stays the same across a tool round trip. Older clients without a turn ID use chat + full history.
export function attachStepIdentity(request: ResponsesRequest, headers: Headers): string | null {
  registerStepContext(request, headers);
  return stepIdentity(request);
}

// The normal subscription path only stores small HTTP identifiers. Large image histories are hashed lazily
// if a request actually needs paid fallback, preserving the existing subscription path's preparation cost.
export function registerStepContext(request: ResponsesRequest, headers: Headers): void {
  identities.delete(request);
  contexts.delete(request);
  const scope = context(headers);
  if (scope) contexts.set(request, scope);
}

export function stepIdentity(request: ResponsesRequest): string | null {
  const existing = identities.get(request);
  if (existing) return existing;
  const scope = contexts.get(request);
  if (!scope) return null;
  const hash = createHash('sha256').update('codex-paid-step-v1\0');
  digestValue(hash, {scope, model: request.model, instructions: request.instructions ?? '', input: request.input,
    tools: request.tools, reasoning: request.reasoning?.effort ?? null, tool_choice: request.tool_choice ?? 'auto',
    parallel_tool_calls: request.parallel_tool_calls ?? true});
  const key = hash.digest('hex');
  identities.set(request, key);
  return key;
}

const unavailable = () => new BridgeError(503, 'api_step_guard_unavailable',
  'The private paid-step guard could not be verified or persisted. No paid request is allowed.');
const duplicate = () => new BridgeError(409, 'api_duplicate_step',
  'This paid step was already attempted; its completion may be unknown. Do not retry this step. Saved-response replay is not supported. Check the prior outcome before starting a new user turn.');
const sameFile = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
const privateRoot = (stat: Stats) => stat.isDirectory() && !stat.isSymbolicLink() && !(stat.mode & 0o077)
  && (process.getuid === undefined || stat.uid === process.getuid());

// Never expire or remove a claim automatically: a disconnected or crashed attempt may already have been billed.
// This first release deliberately has no response replay cache. Both completion and uncertainty remain claimed.
export class PaidStepGuard {
  private readonly root: string;
  constructor(root: string) {this.root = path.resolve(root);}

  private async directory() {
    let current = path.parse(this.root).root;
    for (const part of this.root.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      let stat: Stats;
      try {stat = await fs.lstat(current);}
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        try {await fs.mkdir(current, {mode: 0o700});}
        catch (mkdirError) {if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError;}
        stat = await fs.lstat(current);
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw unavailable();
    }
    const stat = await fs.lstat(this.root);
    if (!privateRoot(stat)) throw unavailable();
    const handle = await fs.open(this.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      if (!sameFile(stat, await handle.stat())) throw unavailable();
      return {handle, stat};
    } catch (error) {await handle.close(); throw error;}
  }

  async claim(key: string): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(key)) throw unavailable();
    try {
      const dir = await this.directory();
      try {
        let file;
        try {file = await fs.open(path.join(this.root, `${key}.claim`), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);}
        catch (error) {if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw duplicate(); throw error;}
        // Even a failed fsync leaves the marker in place. Releasing it could cause an uncertain paid attempt to repeat.
        try {await file.sync();} finally {await file.close();}
        const current = await fs.lstat(this.root);
        if (!sameFile(current, dir.stat) || !privateRoot(current)) throw unavailable();
        await dir.handle.sync();
      } finally {await dir.handle.close();}
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      throw unavailable();
    }
  }

  // Completion never unlocks a paid attempt. Keeping the atomic marker unchanged also avoids a post-response write race.
  async complete(_key: string): Promise<void> {}
}

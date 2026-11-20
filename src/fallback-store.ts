import { createHash, randomUUID } from 'node:crypto';
import { constants, promises as fs, type Stats } from 'node:fs';
import path from 'node:path';
import { BridgeError } from './contracts.js';

const SCALE = 1_000_000_000;
const COOLDOWN = 5 * 60_000, MAX_COOLDOWN = 30 * 60_000, PROBE_LEASE = 15 * 60_000;
const HASH = /^[a-f0-9]{64}$/, UUID = /^[a-f0-9-]{36}$/;
const invalid = () => new BridgeError(424, 'api_store_invalid', 'The private API fallback store cannot be verified. Paid fallback is blocked.');
const badInput = () => new BridgeError(400, 'api_store_invalid_input', 'Invalid API fallback accounting input.');
const conflict = (code: string, message: string) => new BridgeError(409, code, message);
const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const keys = (v: Record<string, unknown>, expected: string[]) => Object.keys(v).sort().join(',') === expected.sort().join(',');
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
function identity(v: unknown): asserts v is string {
  if (typeof v !== 'string' || !v.trim() || v.length > 4096) throw badInput();
}
function units(value: number, limit = false, allowZero = false) {
  if (!Number.isFinite(value) || value < 0 || (!allowZero && value === 0)) throw badInput();
  const result = limit ? Math.floor(value * SCALE) : Math.ceil(value * SCALE);
  if (!Number.isSafeInteger(result) || (!allowZero && result === 0)) throw badInput();
  return result;
}
function add(a: number, b: number) {
  if (!Number.isSafeInteger(a + b)) throw invalid();
  return a + b;
}
function validPrivate(stat: Stats, directory = false) {
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())
    || (stat.mode & 0o777) !== (directory ? 0o700 : 0o600)
    || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw invalid();
}
const missing = (e: unknown) => (e as NodeJS.ErrnoException)?.code === 'ENOENT';
function validDay(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

interface Reservation {idHash: string; scopeHash: string; day: string; reserved: number; actual: number | null}
interface Window {type: string; resetsAt: number | null; retryAt: number; cooldown: number}
interface Probe {id: string; generation: number; expiresAt: number; windows: string[]}
interface Account {idHash: string; generation: number; windows: Window[]; probe: Probe | null}
interface State {schemaVersion: 1; timeZone: string; reservations: Reservation[]; accounts: Account[]}
interface Owner {schemaVersion: 1; pid: number; token: string}
export interface FallbackSnapshot {
  schemaVersion: 1;
  day: string;
  timeZone: string;
  /** Today's settled costs plus every unresolved reservation, including prior days. */
  todayUsd: number;
  /** All settled costs plus every unresolved reservation, across all accounts and keys. */
  totalUsd: number;
  reservedUsd: number;
  settledUsd: number;
  reservationCount: number;
  unresolvedCount: number;
  quotaAccountCount: number;
}
export interface FallbackQuotaStatus {
  windows: Array<{type: string; resetsAt: number | null; retryAt: number}>;
  probePending: boolean;
}

function validateState(value: unknown, timeZone: string): State {
  if (!object(value) || !keys(value, ['schemaVersion', 'timeZone', 'reservations', 'accounts'])
    || value.schemaVersion !== 1 || value.timeZone !== timeZone || !Array.isArray(value.reservations) || !Array.isArray(value.accounts)) throw invalid();
  const ids = new Set<string>();
  for (const row of value.reservations) {
    if (!object(row) || !keys(row, ['idHash', 'scopeHash', 'day', 'reserved', 'actual'])
      || typeof row.idHash !== 'string' || !HASH.test(row.idHash) || ids.has(row.idHash)
      || typeof row.scopeHash !== 'string' || !HASH.test(row.scopeHash)
      || !validDay(row.day)
      || !integer(row.reserved) || row.reserved === 0 || !(row.actual === null || integer(row.actual))) throw invalid();
    ids.add(row.idHash);
  }
  ids.clear();
  for (const row of value.accounts) {
    if (!object(row) || !keys(row, ['idHash', 'generation', 'windows', 'probe'])
      || typeof row.idHash !== 'string' || !HASH.test(row.idHash) || ids.has(row.idHash)
      || !integer(row.generation) || !Array.isArray(row.windows)) throw invalid();
    ids.add(row.idHash);
    const types = new Set<string>();
    for (const window of row.windows) {
      if (!object(window) || !keys(window, ['type', 'resetsAt', 'retryAt', 'cooldown']) || !validWindowType(window.type)
        || types.has(window.type) || !(window.resetsAt === null || integer(window.resetsAt)) || !integer(window.retryAt)
        || (window.resetsAt !== null && window.retryAt < window.resetsAt)
        || !integer(window.cooldown) || window.cooldown < COOLDOWN || window.cooldown > MAX_COOLDOWN) throw invalid();
      types.add(window.type);
    }
    const probe = row.probe;
    if (probe !== null && (!object(probe) || !keys(probe, ['id', 'generation', 'expiresAt', 'windows'])
      || typeof probe.id !== 'string' || !UUID.test(probe.id) || !integer(probe.generation) || probe.generation > row.generation
      || !integer(probe.expiresAt) || !Array.isArray(probe.windows) || !probe.windows.length
      || probe.windows.some(type => !validWindowType(type)) || new Set(probe.windows).size !== probe.windows.length)) throw invalid();
  }
  return value as unknown as State;
}

function validWindowType(type: unknown): type is string {
  return typeof type === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(type);
}
function applicable(type: string, modelId: string) {
  if (type.includes('opus')) return modelId.toLowerCase().includes('opus');
  if (type.includes('sonnet')) return modelId.toLowerCase().includes('sonnet');
  return true; // Unrecognized quota scopes conservatively cover the whole account.
}

/** Private, process-safe accounting. Timestamps (including resetsAt) are Unix milliseconds. */
export class FallbackStore {
  private readonly root: string;
  private readonly now: () => number;
  private readonly timeZone: string;
  private readonly formatter: Intl.DateTimeFormat;
  constructor(root: string, options: {now?: () => number; timeZone?: string} = {}) {
    if (!path.isAbsolute(root)) throw badInput();
    this.root = path.resolve(root);
    this.now = options.now ?? Date.now;
    this.timeZone = options.timeZone ?? 'Australia/Melbourne';
    try {this.formatter = new Intl.DateTimeFormat('en-CA', {timeZone: this.timeZone, year: 'numeric', month: '2-digit', day: '2-digit'});}
    catch {throw badInput();}
  }

  async reserve(input: {id: string; amountUsd: number; dailyLimitUsd: number; totalLimitUsd?: number; scope: string}): Promise<void> {
    if (!object(input)) throw badInput();
    identity(input.id); identity(input.scope);
    const amount = units(input.amountUsd), daily = units(input.dailyLimitUsd, true);
    const total = input.totalLimitUsd === undefined ? undefined : units(input.totalLimitUsd, true);
    await this.transaction((state, now) => {
      const idHash = hash(input.id);
      if (state.reservations.some(row => row.idHash === idHash)) throw conflict('api_duplicate_attempt', 'This paid attempt was already reserved. Repeating it is blocked.');
      const snapshot = this.summarize(state, now);
      if (add(snapshot.today, amount) > daily || (total !== undefined && add(snapshot.total, amount) > total))
        throw conflict('api_budget_exceeded', 'The API fallback budget cannot cover this request.');
      state.reservations.push({idHash, scopeHash: hash(input.scope), day: this.day(now), reserved: amount, actual: null});
    });
  }

  async settle(id: string, actualUsd: number | null): Promise<void> {
    identity(id);
    const actual = actualUsd === null ? null : units(actualUsd, false, true);
    await this.transaction(state => {
      const row = state.reservations.find(item => item.idHash === hash(id));
      if (!row) throw conflict('api_unknown_attempt', 'No reservation exists for this paid attempt.');
      if (row.actual !== null && actual !== null && row.actual !== actual) throw conflict('api_already_settled', 'This paid attempt already has a settled cost.');
      if (actual !== null) row.actual = actual;
      // Unknown/cancelled outcomes never release any liability. A later verified cost may settle them.
    });
  }

  async snapshot(): Promise<FallbackSnapshot> {
    return this.transaction((state, now) => {
      const s = this.summarize(state, now);
      return {schemaVersion: 1, day: this.day(now), timeZone: this.timeZone, todayUsd: s.today / SCALE, totalUsd: s.total / SCALE,
        reservedUsd: s.reserved / SCALE, settledUsd: s.settled / SCALE, reservationCount: state.reservations.length,
        unresolvedCount: state.reservations.filter(row => row.actual === null).length, quotaAccountCount: state.accounts.filter(row => row.windows.length).length};
    }, false);
  }

  /** Diagnostic only: does not acquire a recovery probe or initialize a missing ledger. */
  async quotaStatus(accountId: string): Promise<FallbackQuotaStatus> {
    identity(accountId);
    return this.transaction((state, now) => {
      const account = state.accounts.find(row => row.idHash === hash(accountId));
      return {windows: account?.windows.map(({type, resetsAt, retryAt}) => ({type, resetsAt, retryAt})) ?? [],
        probePending: !!account?.probe && account.probe.expiresAt > now};
    }, false, false);
  }

  /** Serializes enable/disable and the final send permit, independently of accounting state.
   * Return {pending: inferencePromise} after starting a send to release this lock before inference completes. */
  async withControlLock<T>(action: () => Promise<T>): Promise<T> {
    let release: () => Promise<void>;
    try {
      await this.directory();
      release = await this.lock(path.join(this.root, 'api-control.lock'), performance.now() + 5000);
    } catch (error) {if (error instanceof BridgeError) throw error; throw invalid();}
    try {return await action();}
    finally {
      try {await release();} catch (error) {if (error instanceof BridgeError) throw error; throw invalid();}
    }
  }

  async recordQuota(accountId: string, windows: Array<{type: string; resetsAt: number | null}>): Promise<void> {
    identity(accountId);
    if (!Array.isArray(windows) || !windows.length || windows.length > 64
      || windows.some(w => !object(w) || !keys(w, ['type', 'resetsAt']) || !validWindowType(w.type) || !(w.resetsAt === null || integer(w.resetsAt)))
      || new Set(windows.map(w => w.type)).size !== windows.length) throw badInput();
    await this.transaction((state, now) => {
      const idHash = hash(accountId);
      let account = state.accounts.find(row => row.idHash === idHash);
      if (!account) {account = {idHash, generation: 0, windows: [], probe: null}; state.accounts.push(account);}
      account.generation = add(account.generation, 1);
      for (const window of windows) {
        const old = account.windows.find(row => row.type === window.type);
        const cooldown = window.resetsAt === null && old ? Math.min(old.cooldown * 2, MAX_COOLDOWN) : COOLDOWN;
        const retryAt = Math.max(old?.retryAt ?? 0, window.resetsAt ?? add(now, cooldown));
        const next: Window = {type: window.type, resetsAt: window.resetsAt, retryAt, cooldown};
        if (old) Object.assign(old, next); else account.windows.push(next);
      }
    });
  }

  async route(accountId: string, modelId: string): Promise<{route: 'subscription' | 'api'; probeId?: string}> {
    identity(accountId); identity(modelId);
    return this.transaction((state, now) => {
      const account = state.accounts.find(row => row.idHash === hash(accountId));
      const windows = account?.windows.filter(row => applicable(row.type, modelId)) ?? [];
      if (!account || !windows.length) return {route: 'subscription'};
      if (windows.some(row => row.retryAt > now) || (account.probe !== null && account.probe.expiresAt > now)) return {route: 'api'};
      const probeId = randomUUID();
      account.probe = {id: probeId, generation: account.generation, expiresAt: add(now, PROBE_LEASE), windows: windows.map(row => row.type)};
      return {route: 'subscription', probeId};
    });
  }

  async finishProbe(accountId: string, probeId: string, success: boolean): Promise<void> {
    identity(accountId);
    if (typeof probeId !== 'string' || !UUID.test(probeId) || typeof success !== 'boolean') throw badInput();
    await this.transaction((state, now) => {
      const account = state.accounts.find(row => row.idHash === hash(accountId));
      const probe = account?.probe;
      if (!account || !probe || probe.id !== probeId) return; // A late completion cannot affect a replacement lease.
      if (success && probe.generation === account.generation) account.windows = account.windows.filter(row => !probe.windows.includes(row.type));
      else if (!success) for (const row of account.windows) {
        if (probe.windows.includes(row.type)) row.retryAt = Math.max(row.retryAt, add(now, row.cooldown));
      }
      account.probe = null;
    });
  }

  /** Cancellation and ordinary failures are not fresh quota evidence; preserve every window and its retry time. */
  async releaseProbe(accountId: string, probeId: string): Promise<void> {
    identity(accountId);
    if (typeof probeId !== 'string' || !UUID.test(probeId)) throw badInput();
    await this.transaction(state => {
      const account = state.accounts.find(row => row.idHash === hash(accountId));
      if (account?.probe?.id === probeId) account.probe = null;
    });
  }

  private day(now: number) {
    const parts = this.formatter.formatToParts(now);
    return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)!.value).join('-');
  }
  private summarize(state: State, now: number) {
    let today = 0, total = 0, reserved = 0, settled = 0;
    const day = this.day(now);
    for (const row of state.reservations) {
      const exposure = row.actual ?? row.reserved;
      total = add(total, exposure);
      if (row.actual === null) {reserved = add(reserved, exposure); today = add(today, exposure);}
      else {settled = add(settled, exposure); if (row.day === day) today = add(today, exposure);}
    }
    return {today, total, reserved, settled};
  }
  private async directory(create = true): Promise<boolean> {
    // Inspect each component before creating anything below it. Recursive mkdir follows ancestor symlinks,
    // which could redirect both the ledger and its initialized marker to an apparently fresh installation.
    let current = path.parse(this.root).root;
    for (const part of this.root.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      let stat: Stats;
      try {stat = await fs.lstat(current);}
      catch (error) {
        if (!missing(error)) throw error;
        if (!create) return false;
        try {await fs.mkdir(current, {mode: 0o700});}
        catch (mkdirError) {if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError;}
        stat = await fs.lstat(current);
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw invalid();
    }
    validPrivate(await fs.lstat(this.root), true);
    return true;
  }
  private async read(file: string, lockHandoff = false): Promise<unknown | undefined> {
    let stat: Stats;
    try {stat = await fs.lstat(file);} catch (error) {if (missing(error)) return undefined; throw error;}
    validPrivate(stat);
    if (stat.size > 16 * 1024 * 1024) throw invalid();
    let handle;
    try {handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);}
    catch (error) {if (lockHandoff && missing(error)) return undefined; throw error;}
    try {
      const opened = await handle.stat(); validPrivate(opened);
      if (opened.ino !== stat.ino || opened.dev !== stat.dev) {
        if (lockHandoff) return undefined;
        throw invalid();
      }
      try {return JSON.parse(await handle.readFile('utf8')) as unknown;} catch {throw invalid();}
    } finally {await handle.close();}
  }
  private async durableWrite(file: string, value: unknown) {
    const temporary = path.join(this.root, `.fallback-${randomUUID()}.tmp`);
    const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync();}
    finally {await handle.close();}
    try {await fs.rename(temporary, file); await this.syncDirectory();}
    finally {await fs.unlink(temporary).catch(error => {if (!missing(error)) throw error;});}
  }
  private async syncDirectory() {
    const handle = await fs.open(this.root, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {await handle.sync();} finally {await handle.close();}
  }
  private owner(value: unknown): Owner {
    if (!object(value) || !keys(value, ['schemaVersion', 'pid', 'token']) || value.schemaVersion !== 1
      || !integer(value.pid) || value.pid === 0 || typeof value.token !== 'string' || !UUID.test(value.token)) throw invalid();
    return value as unknown as Owner;
  }
  private alive(pid: number) {
    try {process.kill(pid, 0); return true;} catch (error) {return (error as NodeJS.ErrnoException).code !== 'ESRCH';}
  }
  private async lock(file: string, deadline: number, depth = 0): Promise<() => Promise<void>> {
    if (depth > 8) throw conflict('api_store_busy', 'The API fallback store needs lock recovery before it can be used.');
    const owner: Owner = {schemaVersion: 1, pid: process.pid, token: randomUUID()};
    // Publish a complete owner atomically; a crash cannot leave a half-written canonical lock.
    const candidate = path.join(this.root, `.fallback-lock-${owner.token}`);
    const handle = await fs.open(candidate, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {await handle.writeFile(JSON.stringify(owner)); await handle.sync();} finally {await handle.close();}
    try {
      while (performance.now() < deadline) {
        try {
          await fs.link(candidate, file);
          return async () => {
            const current = await this.read(file);
            if (current === undefined || this.owner(current).token !== owner.token) throw invalid();
            await fs.unlink(file);
          };
        } catch (error) {if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;}
        // Another owner may release or replace the contended lock between lstat and open. Retry that ordinary
        // handoff; stable ledger/marker reads and our own release still require strict file identity.
        const raw = await this.read(file, true);
        if (raw === undefined) continue;
        const current = this.owner(raw);
        if (!this.alive(current.pid)) {
          // A separate, token-specific lock serializes reapers. Its own dead owner can be
          // recovered recursively, preventing two stale observers from unlinking a new lock.
          const release = await this.lock(path.join(this.root, `.fallback-reap-${current.token}`), deadline, depth + 1);
          try {
            const checked = await this.read(file, true);
            if (checked !== undefined && this.owner(checked).token === current.token && !this.alive(current.pid)) await fs.unlink(file);
          } finally {await release();}
          continue;
        }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw conflict('api_store_busy', 'Another process is using the API fallback store. Retry without starting a paid request.');
    } finally {await fs.unlink(candidate).catch(error => {if (!missing(error)) throw error;});}
  }
  private freshState(): State {return {schemaVersion: 1, timeZone: this.timeZone, reservations: [], accounts: []};}
  private async transaction<T>(action: (state: State, now: number) => T, write = true, initialize = true): Promise<T> {
    try {
      if (!await this.directory(initialize)) {
        const now = this.now(); if (!integer(now)) throw badInput();
        return action(this.freshState(), now);
      }
      const release = await this.lock(path.join(this.root, 'fallback-store.lock'), performance.now() + 5000);
      try {
        const now = this.now(); if (!integer(now)) throw badInput();
        const file = path.join(this.root, 'fallback-store.json');
        const markerFile = path.join(this.root, 'fallback-store.initialized');
        const marker = await this.read(markerFile), raw = await this.read(file);
        let state: State;
        if (marker === undefined && raw === undefined) {
          // Write the durable marker first: interrupted initialization fails closed, never
          // guesses that a missing ledger with possible liabilities is a fresh installation.
          state = this.freshState();
          if (initialize) {
            await this.durableWrite(markerFile, {schemaVersion: 1});
            await this.durableWrite(file, state);
          }
        } else {
          if (!object(marker) || !keys(marker, ['schemaVersion']) || marker.schemaVersion !== 1 || raw === undefined) throw invalid();
          state = validateState(raw, this.timeZone);
        }
        const result = action(state, now);
        if (write) {this.summarize(state, now); await this.durableWrite(file, state);}
        return result;
      } finally {await release();}
    } catch (error) {if (error instanceof BridgeError) throw error; throw invalid();}
  }
}

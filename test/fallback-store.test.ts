import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { constants, promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { FallbackStore } from '../src/fallback-store.js';
import { BridgeError } from '../src/contracts.js';

async function fixture(t: TestContext, time = '2026-10-18T12:59:00Z') {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-fallback-'));
  t.after(() => fs.rm(parent, {recursive: true, force: true}));
  const root = path.join(await fs.realpath(parent), 'private');
  let now = Date.parse(time);
  return {root, store: new FallbackStore(root, {now: () => now}), now: () => now, advance: (ms: number) => {now += ms;}};
}
const reserve = (id: string, amountUsd: number, scope = 'account-a') => ({id, amountUsd, dailyLimitUsd: 1, totalLimitUsd: 1, scope});
const fails = (code: string) => (error: unknown) => error instanceof BridgeError && error.code === code && error.status !== 502;

test('concurrent reservations across scopes share one cap and duplicate attempts never regrant', async t => {
  const f = await fixture(t);
  const outcomes = await Promise.allSettled(Array.from({length: 12}, (_, i) =>
    new FallbackStore(f.root, {now: f.now}).reserve(reserve(`request-${i}`, 0.2, `key-${i}`))));
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 5);
  assert.equal((await f.store.snapshot()).totalUsd, 1);
  const accepted = outcomes.findIndex(x => x.status === 'fulfilled');
  await assert.rejects(f.store.reserve(reserve(`request-${accepted}`, 0.01)), fails('api_duplicate_attempt'));
});

test('unknown cancellation liability survives local midnight and process restart', async t => {
  const f = await fixture(t);
  await f.store.reserve(reserve('cancelled', 0.8));
  await f.store.settle('cancelled', null);
  f.advance(2 * 60_000); // Melbourne switches from October 18 to October 19.
  const restarted = new FallbackStore(f.root, {now: f.now});
  assert.equal((await restarted.snapshot()).day, '2026-10-19');
  assert.equal((await restarted.snapshot()).todayUsd, 0.8);
  await assert.rejects(restarted.reserve({...reserve('next-day', 0.3), totalLimitUsd: undefined}), fails('api_budget_exceeded'));
  await restarted.settle('cancelled', 0.1);
  const after = await restarted.snapshot();
  assert.equal(after.todayUsd, 0);
  assert.equal(after.totalUsd, 0.1);
});

test('settlement records overruns and cannot replace settled actual cost or reuse an id', async t => {
  const f = await fixture(t);
  await f.store.reserve(reserve('overrun', 0.2));
  await f.store.settle('overrun', 1.2);
  assert.equal((await f.store.snapshot()).totalUsd, 1.2);
  await assert.rejects(f.store.reserve(reserve('more', 0.01)), fails('api_budget_exceeded'));
  await assert.rejects(f.store.settle('overrun', 0), fails('api_already_settled'));
  await assert.rejects(f.store.reserve(reserve('overrun', 0.1)), fails('api_duplicate_attempt'));
  await f.store.settle('overrun', 1.2); // Exact same settlement is harmless.
});

test('settled cost stays on reservation day but cumulative test cap survives midnight', async t => {
  const f = await fixture(t);
  await f.store.reserve(reserve('prior-day', 0.8));
  f.advance(2 * 60_000);
  await f.store.settle('prior-day', 0.8);
  assert.equal((await f.store.snapshot()).todayUsd, 0);
  await assert.rejects(f.store.reserve(reserve('cumulative', 0.3, 'rotated-api-key')), fails('api_budget_exceeded'));
  await f.store.reserve(reserve('allowed', 0.2));
});

test('invalid amounts and unrecognized settlement fail closed', async t => {
  const f = await fixture(t);
  for (const amount of [0, -1, NaN, Infinity]) {
    await assert.rejects(f.store.reserve(reserve('invalid', amount)), fails('api_store_invalid_input'));
  }
  await assert.rejects(f.store.settle('never-reserved', 0), fails('api_unknown_attempt'));
  await assert.rejects(f.store.reserve(null as never), fails('api_store_invalid_input'));
});

test('global and family windows wait for every applicable reset and isolate accounts', async t => {
  const f = await fixture(t);
  await f.store.recordQuota('a', [
    {type: 'five_hour', resetsAt: f.now() + 60_000},
    {type: 'seven_day_opus', resetsAt: f.now() + 120_000},
  ]);
  assert.deepEqual(await f.store.route('b', 'claude-opus-4-6'), {route: 'subscription'});
  assert.deepEqual(await f.store.route('a', 'claude-sonnet-4-6'), {route: 'api'});
  f.advance(60_000);
  assert.deepEqual(await f.store.route('a', 'claude-opus-4-6'), {route: 'api'});
  const sonnet = await f.store.route('a', 'claude-sonnet-4-6');
  assert.equal(sonnet.route, 'subscription');
  assert.ok(sonnet.probeId);
  await f.store.finishProbe('a', sonnet.probeId!, true);
  assert.deepEqual(await f.store.route('a', 'claude-opus-4-6'), {route: 'api'});
  assert.deepEqual(await f.store.route('a', 'claude-sonnet-4-6'), {route: 'subscription'});
});

test('one durable recovery probe is leased across concurrent callers and restart', async t => {
  const f = await fixture(t);
  await f.store.recordQuota('a', [{type: 'seven_day_sonnet', resetsAt: f.now()}]);
  const routes = await Promise.all(Array.from({length: 10}, () =>
    new FallbackStore(f.root, {now: f.now}).route('a', 'claude-sdk-sonnet')));
  assert.equal(routes.filter(x => x.probeId).length, 1);
  assert.equal(routes.filter(x => x.route === 'api').length, 9);
  f.advance(15 * 60_000);
  const recovered = await new FallbackStore(f.root, {now: f.now}).route('a', 'claude-sonnet-4-6');
  assert.ok(recovered.probeId);
  assert.notEqual(recovered.probeId, routes.find(x => x.probeId)!.probeId);
});

test('missing reset backs off from five to at most thirty minutes after renewed rejection', async t => {
  const f = await fixture(t);
  for (const cooldown of [5, 10, 20, 30, 30]) {
    await f.store.recordQuota('a', [{type: 'unknown', resetsAt: null}]);
    f.advance(cooldown * 60_000 - 1);
    assert.deepEqual(await f.store.route('a', 'claude-opus-4-6'), {route: 'api'});
    f.advance(1);
    const probe = await f.store.route('a', 'claude-opus-4-6');
    assert.ok(probe.probeId);
    // A structured renewed quota rejection arrives before the old probe completes.
    await f.store.finishProbe('a', probe.probeId!, false);
  }
});

test('old probe success cannot clear newer quota and cancellation preserves future cooldown', async t => {
  const f = await fixture(t);
  await f.store.recordQuota('a', [{type: 'five_hour', resetsAt: f.now()}]);
  const old = await f.store.route('a', 'claude-opus-4-6');
  await f.store.recordQuota('a', [{type: 'five_hour', resetsAt: f.now() + 60_000}]);
  await f.store.finishProbe('a', old.probeId!, true);
  assert.deepEqual(await f.store.route('a', 'claude-opus-4-6'), {route: 'api'});
  f.advance(60_000);
  const retry = await f.store.route('a', 'claude-opus-4-6');
  await f.store.finishProbe('a', retry.probeId!, false);
  assert.deepEqual(await f.store.route('a', 'claude-opus-4-6'), {route: 'api'});
  f.advance(5 * 60_000);
  assert.ok((await f.store.route('a', 'claude-opus-4-6')).probeId);
});

test('corrupt, missing initialized, unknown schema and nonprivate state cannot reset spending', async t => {
  const f = await fixture(t);
  await f.store.reserve(reserve('protected', 0.7));
  const file = path.join(f.root, 'fallback-store.json');
  const original = await fs.readFile(file, 'utf8');
  for (const value of ['{invalid', '{"schemaVersion":99}']) {
    await fs.writeFile(file, value, {mode: 0o600});
    await assert.rejects(f.store.snapshot(), fails('api_store_invalid'));
  }
  await fs.writeFile(file, original, {mode: 0o600});
  await fs.chmod(file, 0o644);
  await assert.rejects(f.store.snapshot(), fails('api_store_invalid'));
  await fs.chmod(file, 0o600);
  await fs.unlink(file);
  await assert.rejects(f.store.snapshot(), fails('api_store_invalid'));
});

test('symlink state and nonprivate root are rejected without modifying target or permissions', async t => {
  const f = await fixture(t);
  await f.store.snapshot();
  const file = path.join(f.root, 'fallback-store.json');
  const outside = path.join(path.dirname(f.root), 'outside');
  await fs.rename(file, outside);
  await fs.symlink(outside, file);
  await assert.rejects(f.store.snapshot(), fails('api_store_invalid'));
  await fs.unlink(file);
  await fs.rename(outside, file);
  await fs.chmod(f.root, 0o755);
  await assert.rejects(f.store.snapshot(), fails('api_store_invalid'));
  assert.equal((await fs.stat(f.root)).mode & 0o777, 0o755);
});

test('semantically corrupt day and quota reset cannot hide daily costs or recover early', async t => {
  const f = await fixture(t);
  await f.store.reserve(reserve('daily', 0.7));
  await f.store.recordQuota('a', [{type: 'five_hour', resetsAt: f.now() + 60_000}]);
  const file = path.join(f.root, 'fallback-store.json');
  const original = JSON.parse(await fs.readFile(file, 'utf8'));
  const badDay = structuredClone(original);
  badDay.reservations[0].day = '2026-99-99';
  await fs.writeFile(file, JSON.stringify(badDay), {mode: 0o600});
  await assert.rejects(f.store.snapshot(), fails('api_store_invalid'));
  const earlyReset = structuredClone(original);
  earlyReset.accounts[0].windows[0].retryAt = f.now();
  await fs.writeFile(file, JSON.stringify(earlyReset), {mode: 0o600});
  await assert.rejects(f.store.route('a', 'claude-opus-4-6'), fails('api_store_invalid'));
});

test('changing accounting timezone cannot move existing spending to another day', async t => {
  const f = await fixture(t);
  await f.store.reserve(reserve('daily', 0.7));
  await assert.rejects(new FallbackStore(f.root, {timeZone: 'UTC', now: f.now}).snapshot(), fails('api_store_invalid'));
});

test('interprocess reservations serialize and a dead process lock is recovered', {timeout: 20_000}, async t => {
  const f = await fixture(t);
  await f.store.snapshot();
  const moduleUrl = new URL('../src/fallback-store.ts', import.meta.url).href;
  const run = (id: number) => new Promise<number | null>((resolve, reject) => {
    const source = `import {FallbackStore} from ${JSON.stringify(moduleUrl)}; const s=new FallbackStore(${JSON.stringify(f.root)}); try {await s.reserve({id:'child-${id}',amountUsd:0.4,dailyLimitUsd:1,totalLimitUsd:1,scope:'scope-${id}'});} catch(e) {process.exitCode=e.code==='api_budget_exceeded'?2:3;}`;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {stdio: 'pipe'});
    child.on('error', reject); child.on('close', resolve);
  });
  const codes = await Promise.all([run(1), run(2), run(3), run(4)]);
  assert.equal(codes.filter(code => code === 0).length, 2);
  assert.equal(codes.filter(code => code === 2).length, 2);
  const child = spawn(process.execPath, ['-e', ''], {stdio: 'ignore'});
  const pid = child.pid!;
  await new Promise(resolve => child.on('close', resolve));
  await fs.writeFile(path.join(f.root, 'fallback-store.lock'), JSON.stringify({schemaVersion: 1, pid, token: '8fe82e1f-4b8a-4c3a-883f-6a56af52f127'}), {mode: 0o600});
  assert.equal((await f.store.snapshot()).totalUsd, 0.8);
});

for (const handoff of ['released', 'replaced'] as const) test(`a ${handoff} contended lock is retried without treating the ledger as corrupt`, async t => {
  const f = await fixture(t);
  await f.store.snapshot();
  const lock = path.join(f.root, 'fallback-store.lock');
  const owner = {schemaVersion: 1, pid: process.pid, token: '8fe82e1f-4b8a-4c3a-883f-6a56af52f127'};
  await fs.writeFile(lock, JSON.stringify(owner), {mode: 0o600});
  const open = fs.open.bind(fs);
  let interleaved = false;
  // Force the observed real race between lstat(lock) and open(lock), while retaining real filesystem operations.
  t.mock.method(fs, 'open', async (file: Parameters<typeof fs.open>[0], flags: Parameters<typeof fs.open>[1], mode?: Parameters<typeof fs.open>[2]) => {
    if (!interleaved && String(file) === lock && flags === (constants.O_RDONLY | constants.O_NOFOLLOW)) {
      interleaved = true;
      if (handoff === 'released') await fs.unlink(lock);
      else {
        const replacement = path.join(f.root, 'replacement.lock');
        await fs.writeFile(replacement, JSON.stringify({...owner, token: 'ac5219e4-5e4b-4724-bf0b-88daa8a56e16'}), {mode: 0o600});
        await fs.rename(replacement, lock);
        const handle = await open(file, flags, mode);
        await fs.unlink(lock);
        return handle;
      }
    }
    return open(file, flags, mode);
  });
  await f.store.reserve(reserve('after-lock-handoff', 0.4));
  assert.equal((await f.store.snapshot()).totalUsd, 0.4);
});

test('lock handoff tolerance never treats a disappearing ledger as a fresh installation', async t => {
  const f = await fixture(t);
  await f.store.reserve(reserve('protected-ledger', 0.8));
  const ledger = path.join(f.root, 'fallback-store.json');
  const open = fs.open.bind(fs);
  t.mock.method(fs, 'open', async (file: Parameters<typeof fs.open>[0], flags: Parameters<typeof fs.open>[1], mode?: Parameters<typeof fs.open>[2]) => {
    if (String(file) === ledger && flags === (constants.O_RDONLY | constants.O_NOFOLLOW)) await fs.unlink(ledger);
    return open(file, flags, mode);
  });
  await assert.rejects(f.store.reserve(reserve('must-not-reset', 0.3)), fails('api_store_invalid'));
});

test('symlinked ancestors cannot redirect an existing ledger or initialize a new ledger', async t => {
  const f = await fixture(t);
  await f.store.reserve(reserve('protected-ancestor', 0.8));
  const parent = path.dirname(f.root), alias = path.join(parent, 'alias');
  await fs.symlink(f.root, alias);
  const redirected = new FallbackStore(path.join(alias, 'nested'));
  await assert.rejects(redirected.reserve(reserve('redirected', 1)), fails('api_store_invalid'));
  await assert.rejects(fs.lstat(path.join(f.root, 'nested')), {code: 'ENOENT'});
  const moved = path.join(parent, 'retained');
  await fs.rename(f.root, moved);
  const targetParent = path.join(parent, 'target-parent'); await fs.mkdir(targetParent, {mode: 0o700});
  const outer = path.join(parent, 'outer'); await fs.symlink(targetParent, outer);
  await assert.rejects(new FallbackStore(path.join(outer, 'new-store')).snapshot(), fails('api_store_invalid'));
  assert.deepEqual(await fs.readdir(targetParent), []);
  assert.equal((await new FallbackStore(moved, {now: f.now}).snapshot()).totalUsd, 0.8);
});

test('releasing a cancelled or ordinary failed probe keeps every quota window unchanged', async t => {
  const f = await fixture(t);
  await f.store.recordQuota('a', [{type: 'five_hour', resetsAt: f.now()}]);
  const probe = await f.store.route('a', 'claude-sonnet-4-6');
  assert.ok(probe.probeId);
  const before = await f.store.quotaStatus('a');
  f.advance(60_000);
  await f.store.releaseProbe('a', probe.probeId!);
  assert.deepEqual(await f.store.quotaStatus('a'), {windows: before.windows, probePending: false});
  const next = await f.store.route('a', 'claude-sonnet-4-6');
  assert.ok(next.probeId, 'an ordinary failure must not impose another five-minute quota cooldown');
  assert.notEqual(next.probeId, probe.probeId);
});

test('releasing an old probe or another account cannot clear a replacement probe or newer quota', async t => {
  const f = await fixture(t);
  await f.store.recordQuota('a', [{type: 'five_hour', resetsAt: f.now()}]);
  const old = await f.store.route('a', 'claude-sonnet-4-6');
  f.advance(15 * 60_000);
  const replacement = await f.store.route('a', 'claude-sonnet-4-6');
  await f.store.recordQuota('a', [{type: 'seven_day', resetsAt: f.now() + 60_000}]);
  const before = await f.store.quotaStatus('a');
  await f.store.releaseProbe('a', old.probeId!);
  await f.store.releaseProbe('b', replacement.probeId!);
  assert.deepEqual(await f.store.quotaStatus('a'), before);
  await f.store.releaseProbe('a', replacement.probeId!);
  assert.deepEqual(await f.store.quotaStatus('a'), {windows: before.windows, probePending: false});
  assert.deepEqual(await f.store.route('a', 'claude-sonnet-4-6'), {route: 'api'});
});

test('quota diagnostics expose only scoped windows and current probe status without taking a lease', async t => {
  const f = await fixture(t);
  await f.store.recordQuota('private-account-a', [{type: 'five_hour', resetsAt: f.now()}]);
  await f.store.recordQuota('private-account-b', [{type: 'seven_day_opus', resetsAt: f.now() + 60_000}]);
  const file = path.join(f.root, 'fallback-store.json');
  const before = await fs.readFile(file, 'utf8');
  assert.deepEqual(await f.store.quotaStatus('private-account-a'), {
    windows: [{type: 'five_hour', resetsAt: f.now(), retryAt: f.now()}], probePending: false,
  });
  assert.deepEqual(await f.store.quotaStatus('unknown-account'), {windows: [], probePending: false});
  assert.equal(await fs.readFile(file, 'utf8'), before);
  const probe = await f.store.route('private-account-a', 'claude-sonnet-4-6');
  assert.ok(probe.probeId, 'status must not consume the recovery probe');
  assert.equal((await f.store.quotaStatus('private-account-a')).probePending, true);
  f.advance(15 * 60_000);
  const leased = await fs.readFile(file, 'utf8');
  assert.equal((await f.store.quotaStatus('private-account-a')).probePending, false);
  assert.equal(await fs.readFile(file, 'utf8'), leased, 'diagnostics must not mutate an expired lease');
});

test('quota diagnostics never initialize an absent directory, marker, or ledger', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.store.quotaStatus('a'), {windows: [], probePending: false});
  await assert.rejects(fs.lstat(f.root), {code: 'ENOENT'});
  await fs.mkdir(f.root, {mode: 0o700});
  assert.deepEqual(await f.store.quotaStatus('a'), {windows: [], probePending: false});
  assert.deepEqual(await fs.readdir(f.root), []);
});

test('control actions serialize across instances without initializing quota or budget state', async t => {
  const f = await fixture(t);
  let active = 0, peak = 0;
  const results = await Promise.all(Array.from({length: 12}, (_, index) => new FallbackStore(f.root).withControlLock(async () => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 2));
    active--;
    return index;
  })));
  assert.deepEqual(results, Array.from({length: 12}, (_, index) => index));
  assert.equal(peak, 1);
  assert.deepEqual(await fs.readdir(f.root), []);
});

test('control actions can disable fallback despite an invalid ledger and do not share its lock', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.root, {mode: 0o700});
  const ledger = path.join(f.root, 'fallback-store.json');
  await fs.writeFile(ledger, '{corrupt', {mode: 0o600});
  await fs.writeFile(path.join(f.root, 'fallback-store.lock'), JSON.stringify({schemaVersion: 1, pid: process.pid,
    token: '8fe82e1f-4b8a-4c3a-883f-6a56af52f127'}), {mode: 0o600});
  const outcome = await f.store.withControlLock(async () => {
    await fs.writeFile(path.join(f.root, 'disabled'), 'true', {mode: 0o600});
    return 'disabled';
  });
  assert.equal(outcome, 'disabled');
  assert.equal(await fs.readFile(ledger, 'utf8'), '{corrupt');
  await assert.rejects(fs.lstat(path.join(f.root, 'fallback-store.initialized')), {code: 'ENOENT'});
});

test('control actions release their lock on failure and when returning a pending inference promise', async t => {
  const f = await fixture(t);
  await assert.rejects(f.store.withControlLock(async () => {throw new BridgeError(409, 'fixture_cancelled', 'fixture');}), fails('fixture_cancelled'));
  const pending = new Promise<string>(() => {});
  const result = await f.store.withControlLock(async () => ({pending}));
  assert.equal(result.pending, pending);
  assert.equal(await f.store.withControlLock(async () => 'next-action'), 'next-action');
});

import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertNoRouteOverride, loadRuntimePolicy, normalizeSubscription, scanClaudeSettings } from '../src/runtime-policy.js';

const SECRET = 'SECRET-VALUE-4d2e9a';

async function temp(t: TestContext) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'claude-policy-')));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  return dir;
}
const validPolicy = (over: Record<string, unknown> = {}) => ({
  schema_version: 1, claude_path: '/opt/claude/claude', claude_sha256: 'a'.repeat(64), claude_version: '2.1.285',
  subscription_usage_credits_disabled: true, usage_credits_confirmation: {source: 'user', date: '2026-10-04'}, ...over,
});
async function writePolicy(dir: string, content: unknown, mode = 0o600) {
  const file = path.join(dir, 'runtime-policy.json');
  await fs.writeFile(file, typeof content === 'string' ? content : JSON.stringify(content), {mode});
  await fs.chmod(file, mode);
  return file;
}

test('a valid private runtime policy loads', async t => {
  const policy = await loadRuntimePolicy(await writePolicy(await temp(t), validPolicy()));
  assert.equal(policy.claude_version, '2.1.285');
  assert.equal(policy.usage_credits_confirmation.source, 'user');
});

test('a missing, unprivate, symlinked or incomplete runtime policy is refused with an explicit reason', async t => {
  const dir = await temp(t);
  await assert.rejects(loadRuntimePolicy(path.join(dir, 'absent.json')), /runtime policy is missing/);
  await assert.rejects(loadRuntimePolicy('relative.json'), /absolute/);
  await assert.rejects(loadRuntimePolicy(await writePolicy(dir, validPolicy(), 0o644)), /private to the user/);

  const real = await writePolicy(dir, validPolicy());
  const link = path.join(dir, 'linked.json');
  await fs.symlink(real, link);
  await assert.rejects(loadRuntimePolicy(link), /symlink/);

  const invalid: [string, unknown, RegExp][] = [
    ['not JSON', 'not json', /not valid JSON/],
    ['relative executable', validPolicy({claude_path: 'claude'}), /claude_path/],
    ['short hash', validPolicy({claude_sha256: 'abc'}), /claude_sha256/],
    ['loose version', validPolicy({claude_version: 'latest'}), /claude_version/],
    ['extra usage not disabled', validPolicy({subscription_usage_credits_disabled: false}), /subscription_usage_credits_disabled/],
    ['no confirmation', validPolicy({usage_credits_confirmation: undefined}), /usage_credits_confirmation/],
    ['confirmation not from the user', validPolicy({usage_credits_confirmation: {source: 'assumed', date: '2026-10-04'}}), /usage_credits_confirmation/],
    ['impossible confirmation date', validPolicy({usage_credits_confirmation: {source: 'user', date: '2026-02-30'}}), /date/],
    ['unknown field', validPolicy({api_key_fallback: true}), /nrecognized/],
    ['wrong schema version', validPolicy({schema_version: 2}), /schema_version/],
  ];
  for (const [name, content, expected] of invalid) await assert.rejects(loadRuntimePolicy(await writePolicy(dir, content)), expected, name);
});

test('the shipped example is portable and can never be loaded as confirmed', async t => {
  const example = JSON.parse(await fs.readFile(path.resolve('runtime-policy.example.json'), 'utf8'));
  assert.equal(example.subscription_usage_credits_disabled, false);
  assert.notEqual(example.usage_credits_confirmation.source, 'user');
  assert.ok(!JSON.stringify(example).includes('/Users/'), 'no personal paths');
  await assert.rejects(loadRuntimePolicy(await writePolicy(await temp(t), example)), /runtime policy is invalid/);
});

test('route and credential overrides are rejected by name without exposing values', () => {
  const names = ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CLAUDE_CODE_API_KEY',
    'CLAUDE_CODE_API_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR', 'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_SIMPLE', 'CLAUDE_CODE_CONFIG_DIR', 'CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_EFFORT_LEVEL',
    'AWS_BEARER_TOKEN_BEDROCK'];
  for (const name of names) {
    assert.throws(() => assertNoRouteOverride({PATH: '/bin', [name]: SECRET}), (error: Error) => error.message.includes(name) && !error.message.includes(SECRET), name);
  }
  assert.throws(() => assertNoRouteOverride({ANTHROPIC_BASE_URL: 'x', OPENAI_API_KEY: 'y'}), /ANTHROPIC_BASE_URL, OPENAI_API_KEY/);
  // Empty values and harmless tags are not overrides.
  assert.doesNotThrow(() => assertNoRouteOverride({PATH: '/bin', HOME: '/home/test', ANTHROPIC_BASE_URL: '', CLAUDE_CODE_EFFORT_LEVEL: '  ',
    CLAUDE_AGENT_SDK_CLIENT_APP: 'codex-claude-models/test', CODEX_HOME: '/home/test/.codex', CODEX_BIN: '/bin/codex'}));
});

// A throwaway home, an SDK working directory below it, and no managed or MDM sources unless a case adds them.
async function scanFixture(t: TestContext, files: Record<string, unknown>, extra: {managedDirs?: string[]; managedPreferenceFiles?: string[]} = {}) {
  const home = await temp(t);
  const cwd = path.join(home, 'work', 'sdk-cwd');
  await fs.mkdir(cwd, {recursive: true});
  for (const [relative, content] of Object.entries(files)) {
    const file = path.isAbsolute(relative) ? relative : path.join(home, relative);
    await fs.mkdir(path.dirname(file), {recursive: true});
    await fs.writeFile(file, typeof content === 'string' ? content : JSON.stringify(content));
  }
  return {home, run: () => scanClaudeSettings({home, cwd, platform: 'linux', managedDirs: [], managedPreferenceFiles: [], env: {}, ...extra})};
}

test('a clean Claude home passes and reports local-file coverage only', async t => {
  const {run} = await scanFixture(t, {
    '.claude/settings.json': {permissions: {allow: ['Read']}, env: {HARMLESS: '1', ANTHROPIC_BASE_URL: ''}, apiKeyHelper: '', forceLoginMethod: 'claudeai'},
    '.claude.json': {oauthAccount: {apiKeyHelper: 'ignored', emailAddress: 'x@example.invalid'}, mcpServers: {s: {env: {ANTHROPIC_API_KEY: 'ignored'}}}},
  });
  assert.equal((await run()).coverage, 'local_file_scan');
});

test('route-affecting Claude settings are refused wherever they appear', async t => {
  const cases: [string, Record<string, unknown>, RegExp][] = [
    ['env base URL in user settings', {'.claude/settings.json': {env: {ANTHROPIC_BASE_URL: SECRET}}}, /env\.ANTHROPIC_BASE_URL/],
    ['api key helper in local settings', {'.claude/settings.local.json': {apiKeyHelper: SECRET}}, /apiKeyHelper/],
    ['nested aws refresh in .claude.json', {'.claude.json': {projects: {'/x': {awsAuthRefresh: SECRET}}}}, /awsAuthRefresh/],
    ['aws credential export', {'.claude/settings.json': {awsCredentialExport: SECRET}}, /awsCredentialExport/],
    ['login gateway', {'.claude/settings.json': {forceLoginGatewayUrl: 'https://gateway.invalid'}}, /forceLoginGatewayUrl/],
    ['console login method', {'.claude/settings.json': {forceLoginMethod: 'console'}}, /forceLoginMethod/],
    ['policy helper', {'.claude/settings.json': {policyHelper: SECRET}}, /policyHelper/],
    ['project settings above the SDK directory', {'work/.claude/settings.json': {apiKeyHelper: SECRET}}, /apiKeyHelper/],
    ['effort level through env', {'.claude/settings.json': {env: {CLAUDE_CODE_EFFORT_LEVEL: 'high'}}}, /CLAUDE_CODE_EFFORT_LEVEL/],
    ['file that is not JSON', {'.claude/settings.json': '{broken'}, /not valid JSON/],
    ['file that is not a regular file', {}, /cannot be verified/],
  ];
  for (const [name, files, expected] of cases) {
    const {home, run} = await scanFixture(t, files);
    if (name === 'file that is not a regular file') await fs.mkdir(path.join(home, '.claude', 'settings.json'), {recursive: true});
    await assert.rejects(run(), (error: Error) => expected.test(error.message) && !error.message.includes(SECRET), name);
  }
});

test('oversized and unreadable settings files are unverified, not assumed clear', async t => {
  const big = await scanFixture(t, {'.claude/settings.json': ' '.repeat(1024 * 1024 + 1)});
  await assert.rejects(big.run(), /cannot be verified|too large/);
  if (process.getuid?.() !== 0) {
    const locked = await scanFixture(t, {'.claude/settings.json': {}});
    await fs.chmod(path.join(locked.home, '.claude', 'settings.json'), 0o000);
    await assert.rejects(locked.run(), /cannot be verified/);
  }
});

test('managed settings, drop-ins and local managed-preference files are refused or reviewed', async t => {
  const managed = await temp(t);
  const clean = await scanFixture(t, {}, {managedDirs: [managed]});
  await clean.run();

  await fs.mkdir(path.join(managed, 'managed-settings.d'), {recursive: true});
  await fs.writeFile(path.join(managed, 'managed-settings.d', '10-gateway.json'), JSON.stringify({env: {ANTHROPIC_BASE_URL: SECRET}}));
  await assert.rejects(clean.run(), /ANTHROPIC_BASE_URL/);
  await fs.rm(path.join(managed, 'managed-settings.d'), {recursive: true});

  await fs.writeFile(path.join(managed, 'managed-settings.json'), JSON.stringify({apiKeyHelper: SECRET}));
  await assert.rejects(clean.run(), /apiKeyHelper/);

  const plist = path.join(await temp(t), 'com.anthropic.claudecode.plist');
  await fs.writeFile(plist, 'opaque');
  const reviewed = await scanFixture(t, {}, {managedPreferenceFiles: [plist]});
  await assert.rejects(reviewed.run(), /managed-preference file exists[\s\S]*review/);
});

test('an active or default Anthropic profile is refused without reading it', async t => {
  for (const relative of ['.config/anthropic/active_config', '.config/anthropic/configs/default.json']) {
    const {run} = await scanFixture(t, {[relative]: SECRET});
    await assert.rejects(run(), (error: Error) => /profile is present/.test(error.message) && !error.message.includes(SECRET), relative);
  }
});

test('subscription labels are normalised only from exact known names', () => {
  for (const [label, plan] of [['pro', 'pro'], ['Pro', 'pro'], ['Claude Pro', 'pro'], ['max', 'max'], ['Claude Max', 'max']] as const) {
    assert.equal(normalizeSubscription(label), plan, label);
  }
  for (const label of ['team', 'enterprise', 'free', 'max_20x', 'professional', '', undefined, null, 5]) assert.equal(normalizeSubscription(label), null, String(label));
});

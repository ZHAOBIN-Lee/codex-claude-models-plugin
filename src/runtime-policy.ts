import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, constants as fsConstants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { BridgeError } from './contracts.js';

const exec = promisify(execFile);
const blocked = (message: string) => new BridgeError(503, 'runtime_blocked', message);
export const cancelled = () => new BridgeError(499, 'aborted', 'The request was cancelled.');
export function throwIfAborted(signal?: AbortSignal) {if (signal?.aborted) throw cancelled();}

// Guard coverage is local files plus the native CLI/SDK auth checks. MDM, remote and Windows policy are not inspected.
export const GUARD_COVERAGE = 'local_file_scan';

const validDate = (value: string) => new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);
const policySchema = z.object({
  schema_version: z.literal(1),
  claude_path: z.string().min(1).refine(value => path.isAbsolute(value), 'must be an absolute path'),
  claude_sha256: z.string().regex(/^[0-9a-fA-F]{64}$/, 'must be 64 hex characters'),
  claude_version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/, 'must be an exact version'),
  subscription_usage_credits_disabled: z.literal(true),
  usage_credits_confirmation: z.object({
    source: z.literal('user'),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD').refine(value => !Number.isNaN(Date.parse(value)) && validDate(value), 'must be a real date'),
  }).strict(),
}).strict();
export type RuntimePolicy = z.infer<typeof policySchema>;

// The user confirmed extra usage is off; this is a recorded confirmation, never a live Billing read.
export async function loadRuntimePolicy(file: string): Promise<RuntimePolicy> {
  if (!file || !path.isAbsolute(file)) throw blocked('The runtime policy path must be absolute.');
  const stat = await fs.lstat(file).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw blocked(`The runtime policy is missing: ${file}. Create it from runtime-policy.example.json (mode 600) before using Claude.`);
    throw blocked(`The runtime policy cannot be inspected: ${file}.`);
  });
  if (stat.isSymbolicLink()) throw blocked('The runtime policy must not be a symlink.');
  if (!stat.isFile()) throw blocked('The runtime policy must be a regular file.');
  if (stat.mode & 0o077) throw blocked('The runtime policy must be private to the user (chmod 600).');
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw blocked('The runtime policy must be owned by the current user.');
  if (stat.size > 16 * 1024) throw blocked('The runtime policy is too large.');
  let raw: unknown;
  try {raw = JSON.parse(await fs.readFile(file, 'utf8'));} catch {throw blocked('The runtime policy is not valid JSON.');}
  const parsed = policySchema.safeParse(raw);
  if (!parsed.success) {
    throw blocked(`The runtime policy is invalid: ${parsed.error.issues.map(issue => `${issue.path.join('.') || '(root)'} ${issue.message}`).join('; ')}.`);
  }
  return parsed.data;
}

// ---- route and credential overrides ----

const ROUTE_NAME = /^(?:ANTHROPIC_.+|OPENAI_(?:API_KEY|BASE_URL|API_BASE|API_URL)|CLAUDE_CODE_(?:API_KEY|API_BASE_URL|OAUTH_TOKEN|OAUTH_TOKEN_FILE_DESCRIPTOR|USE_.+|SIMPLE|CONFIG_DIR|SUBAGENT_MODEL|EFFORT_LEVEL)|CLAUDE_CONFIG_DIR|AWS_BEARER_TOKEN_BEDROCK)$/;
const nonempty = (value: unknown) => value !== undefined && value !== null && value !== false && String(typeof value === 'object' ? 'x' : value).trim() !== '';
const routeOverride = (name: string, value: unknown) => ROUTE_NAME.test(name) && nonempty(value);

// The router is often started from inside another agent session (a Codex hook or a Claude Code shell). Its route
// overrides and session markers belong to that caller; inheriting them would make every Claude step fail the check below.
export function routerEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([name]) => !ROUTE_NAME.test(name) && !/^(?:CLAUDECODE|CLAUDE_CODE_.+|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_AGENT_SDK_.+)$/.test(name)));
}

// Checks the raw process environment. Names only are reported; values are never shown.
export function assertNoRouteOverride(env: NodeJS.ProcessEnv) {
  const names = Object.keys(env).filter(name => routeOverride(name, env[name])).sort();
  if (names.length) throw blocked(`Route or credential override variables are set (${names.join(', ')}). Unset them; the subscription login is the only allowed route. Values are not shown.`);
}

// ---- Claude settings and profile scan ----

const SETTINGS_LIMIT = 1024 * 1024;
const CLAUDE_JSON_LIMIT = 16 * 1024 * 1024;
const IGNORED_KEYS = new Set(['oauthAccount', 'mcpServers']);
const HELPER_KEYS = new Set(['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'forceLoginGatewayUrl', 'policyHelper']);

// Returns the key path of the first route-affecting setting, or undefined when the tree is clear.
function inspectSettings(value: unknown, trail = '', depth = 0): string | undefined {
  if (depth > 32) return `${trail || '(root)'} (nesting too deep to verify)`;
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {const found = inspectSettings(item, `${trail}[${index}]`, depth + 1); if (found) return found;}
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  for (const [key, item] of Object.entries(value)) {
    if (IGNORED_KEYS.has(key)) continue;
    const here = trail ? `${trail}.${key}` : key;
    if (HELPER_KEYS.has(key) && nonempty(item)) return here;
    if (key === 'forceLoginMethod' && nonempty(item) && item !== 'claudeai') return here;
    if (key === 'env' && typeof item === 'object' && item !== null && !Array.isArray(item)) {
      for (const [name, setting] of Object.entries(item)) if (routeOverride(name, setting)) return `${here}.${name}`;
    }
    const found = inspectSettings(item, here, depth + 1);
    if (found) return found;
  }
  return undefined;
}

// Absent paths are clear; anything else that cannot be inspected is unverified, never assumed clear.
async function lstatIfPresent(file: string, what: string) {
  try {return await fs.lstat(file);}
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw blocked(`${what} cannot be verified: ${file}.`);
  }
}

// A directory that holds settings must be a real directory; following a symlink would scan something else.
async function requirePlainDirectory(dir: string, what: string) {
  const stat = await lstatIfPresent(dir, what);
  if (!stat) return false;
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw blocked(`${what} must be a real directory, not a symlink: ${dir}.`);
  return true;
}

// Settings files are read without following symlinks: lstat first, then an O_NOFOLLOW open whose identity must match.
async function readSettings(file: string, limit: number): Promise<string | undefined> {
  const stat = await lstatIfPresent(file, 'A Claude settings file');
  if (!stat) return undefined;
  if (stat.isSymbolicLink()) throw blocked(`A Claude settings file is a symlink and cannot be verified: ${file}.`);
  if (!stat.isFile() || stat.size > limit) throw blocked(`A Claude settings file cannot be verified (not a regular file or too large): ${file}.`);
  let handle;
  try {handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));}
  catch {throw blocked(`A Claude settings file cannot be verified: ${file}. Fix its access or remove it.`);}
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size > limit) {
      throw blocked(`A Claude settings file changed while it was being verified: ${file}.`);
    }
    // One byte more than the size seen at open detects a file that grows during the read.
    const buffer = Buffer.alloc(opened.size + 1);
    let total = 0;
    while (total < buffer.length) {
      const {bytesRead} = await handle.read(buffer, total, buffer.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total > opened.size) throw blocked(`A Claude settings file changed while it was being verified: ${file}.`);
    return buffer.toString('utf8', 0, total);
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw blocked(`A Claude settings file cannot be verified: ${file}.`);
  } finally {await handle.close();}
}

async function exists(file: string) {
  try {await fs.lstat(file); return true;}
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw blocked(`A Claude route file cannot be verified: ${file}.`);
  }
}

export interface ScanOptions {
  cwd: string;
  home?: string;
  platform?: NodeJS.Platform;
  managedDirs?: string[];
  managedPreferenceFiles?: string[];
  env?: NodeJS.ProcessEnv;
}

function defaultManagedDirs(platform: NodeJS.Platform) {
  if (platform === 'darwin') return ['/Library/Application Support/ClaudeCode'];
  if (platform === 'linux') return ['/etc/claude-code'];
  if (platform === 'win32') return ['C:/Program Files/ClaudeCode'];
  return [];
}
function defaultPreferenceFiles(platform: NodeJS.Platform) {
  if (platform !== 'darwin') return [];
  let user = '';
  try {user = os.userInfo().username;} catch {/* the system-wide file is still checked */}
  return ['/Library/Managed Preferences/com.anthropic.claudecode.plist', ...(user ? [`/Library/Managed Preferences/${user}/com.anthropic.claudecode.plist`] : [])];
}

// Local file scan only. Remote and MDM policy cannot be inspected here; a local managed-preference file is refused for review.
export async function scanClaudeSettings(options: ScanOptions) {
  const home = options.home ?? os.homedir();
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const files = new Map<string, number>();
  const settingsDirs = new Set<string>();
  const managedDirs = new Set<string>();
  const dropinDirs = new Set<string>();
  const addUserLevel = (dir: string) => {
    settingsDirs.add(path.join(dir, '.claude'));
    files.set(path.join(dir, '.claude', 'settings.json'), SETTINGS_LIMIT);
    files.set(path.join(dir, '.claude', 'settings.local.json'), SETTINGS_LIMIT);
    files.set(path.join(dir, '.claude.json'), CLAUDE_JSON_LIMIT);
  };
  addUserLevel(home);
  // The SDK directory and every ancestor can carry project-level settings and a .claude.json.
  for (let dir = path.resolve(options.cwd); ; dir = path.dirname(dir)) {
    addUserLevel(dir);
    if (path.dirname(dir) === dir) break;
  }
  for (const dir of options.managedDirs ?? defaultManagedDirs(platform)) {
    managedDirs.add(dir); dropinDirs.add(path.join(dir, 'managed-settings.d'));
    files.set(path.join(dir, 'managed-settings.json'), SETTINGS_LIMIT);
  }
  for (const preference of options.managedPreferenceFiles ?? defaultPreferenceFiles(platform)) {
    if (await exists(preference)) throw blocked(`A local managed-preference file exists (${preference}). Its contents are not inspected; review it before using Claude.`);
  }
  for (const dir of settingsDirs) await requirePlainDirectory(dir, 'A Claude settings directory');
  for (const dir of managedDirs) await requirePlainDirectory(dir, 'The managed settings directory');
  for (const dir of dropinDirs) {
    if (!await requirePlainDirectory(dir, 'The managed settings drop-in directory')) continue;
    const dropins = await fs.readdir(dir).catch(() => {throw blocked(`The managed settings drop-in directory cannot be verified: ${dir}.`);});
    if (dropins.length > 256) throw blocked('The managed settings drop-in directory has too many files to verify.');
    for (const name of dropins.filter(entry => entry.endsWith('.json')).sort()) files.set(path.join(dir, name), SETTINGS_LIMIT);
  }
  for (const [file, limit] of files) {
    const text = await readSettings(file, limit);
    if (text === undefined || !text.trim()) continue;
    let parsed: unknown;
    try {parsed = JSON.parse(text);} catch {throw blocked(`A Claude settings file is not valid JSON and cannot be verified: ${file}.`);}
    const found = inspectSettings(parsed);
    if (found) throw blocked(`Claude settings override the subscription route: ${found} in ${file}. Remove it or use a different account directory.`);
  }
  // Profile presence only: credentials inside a profile are never read.
  const profileRoots = [path.join(home, '.config', 'anthropic')];
  if (env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME)) profileRoots.push(path.join(env.XDG_CONFIG_HOME, 'anthropic'));
  for (const root of profileRoots) {
    for (const relative of ['active_config', path.join('configs', 'default.json')]) {
      if (await exists(path.join(root, relative))) throw blocked(`An Anthropic API profile is present (${root}). It can change the route; remove or relocate it.`);
    }
  }
  return {coverage: GUARD_COVERAGE, files: files.size};
}

// ---- pinned official CLI ----

const hashes = new Map<string, {signature: string; sha256: string}>();
async function sha256Of(file: string, signature: string, signal?: AbortSignal) {
  const cached = hashes.get(file);
  if (cached?.signature === signature) return cached.sha256;
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file, {signal})) hash.update(chunk as Buffer);
  const sha256 = hash.digest('hex');
  hashes.set(file, {signature, sha256});
  return sha256;
}

async function runCli(claudePath: string, args: string[], options: {signal?: AbortSignal; cwd: string; env: NodeJS.ProcessEnv}) {
  const running = exec(claudePath, args, {signal: options.signal, cwd: options.cwd, env: options.env, timeout: 15000, maxBuffer: 64 * 1024, windowsHide: true});
  running.child.stdin?.end();
  try {return (await running).stdout;}
  catch {
    throwIfAborted(options.signal);
    throw blocked(`The pinned Claude CLI could not run "${args.join(' ')}".`);
  }
}

export type SubscriptionPlan = 'pro' | 'max';
// Only exact, known labels; anything else is unsupported rather than guessed.
export function normalizeSubscription(label: unknown): SubscriptionPlan | null {
  const known: Record<string, SubscriptionPlan> = {pro: 'pro', 'claude pro': 'pro', max: 'max', 'claude max': 'max'};
  return typeof label === 'string' ? known[label.trim().toLowerCase()] ?? null : null;
}

export async function verifyPinnedCli(policy: RuntimePolicy, options: {signal?: AbortSignal; cwd: string; env: NodeJS.ProcessEnv}) {
  const stat = await fs.lstat(policy.claude_path).catch(() => {throw blocked('The pinned Claude executable was not found.');});
  if (stat.isSymbolicLink() || !stat.isFile()) throw blocked('The pinned Claude executable must be a regular file, not a symlink.');
  await fs.access(policy.claude_path, fsConstants.X_OK).catch(() => {throw blocked('The pinned Claude executable is not executable.');});
  // Hash before running anything, so an unverified binary never executes.
  const signature = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`;
  let sha256: string;
  try {sha256 = await sha256Of(policy.claude_path, signature, options.signal);}
  catch {throwIfAborted(options.signal); throw blocked('The pinned Claude executable could not be hashed.');}
  if (sha256 !== policy.claude_sha256.toLowerCase()) throw blocked('The pinned Claude executable does not match the SHA-256 in the runtime policy.');
  throwIfAborted(options.signal);
  const version = /^(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?: \(Claude Code\))?$/.exec((await runCli(policy.claude_path, ['--version'], options)).trim())?.[1];
  if (version !== policy.claude_version) throw blocked('The pinned Claude CLI version does not match the runtime policy.');
  throwIfAborted(options.signal);
  let auth: unknown;
  try {auth = JSON.parse(await runCli(policy.claude_path, ['auth', 'status'], options));}
  catch (error) {if (error instanceof BridgeError) throw error; throw blocked('The pinned Claude CLI returned unreadable auth status.');}
  const status = typeof auth === 'object' && auth !== null ? auth as Record<string, unknown> : {};
  if (status.loggedIn !== true) throw blocked('The pinned Claude CLI is not logged in. Run claude auth login.');
  if (status.authMethod !== 'claude.ai') throw blocked('The pinned Claude CLI must be logged in with a claude.ai subscription, not another method.');
  if (status.subscriptionType !== 'pro' && status.subscriptionType !== 'max') throw blocked('The pinned Claude CLI login must be a Pro or Max subscription.');
  return {version, plan: status.subscriptionType as SubscriptionPlan};
}

export interface VerifiedRuntime {claudePath?: string; claudeVersion?: string; coverage: string}
export interface GuardOptions {
  policyPath: string;
  cwd: string;
  signal?: AbortSignal;
  rawEnv?: NodeJS.ProcessEnv;
  // Called only after the route check, so the cleaned environment can never hide an override.
  childEnv?: () => NodeJS.ProcessEnv;
  scan?: Partial<ScanOptions>;
}

// The scoped child environment pins the runtime without touching the parent's updater configuration.
export function pinnedEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {...source, DISABLE_AUTOUPDATER: '1', DISABLE_UPDATES: '1'};
  delete result.FORCE_AUTOUPDATE_PLUGINS;
  return result;
}

// Order matters: a policy helper in a settings file can execute when the CLI starts, even for --version or auth
// status, so every local settings file is scanned before the pinned CLI is run at all.
export async function verifyRuntime(options: GuardOptions): Promise<VerifiedRuntime> {
  const rawEnv = options.rawEnv ?? process.env;
  throwIfAborted(options.signal);
  assertNoRouteOverride(rawEnv);
  const policy = await loadRuntimePolicy(options.policyPath);
  throwIfAborted(options.signal);
  const scan = await scanClaudeSettings({cwd: options.cwd, env: rawEnv, ...options.scan});
  throwIfAborted(options.signal);
  const env = options.childEnv?.() ?? pinnedEnvironment(rawEnv);
  const cli = await verifyPinnedCli(policy, {signal: options.signal, cwd: options.cwd, env});
  throwIfAborted(options.signal);
  return {claudePath: policy.claude_path, claudeVersion: cli.version, coverage: scan.coverage};
}

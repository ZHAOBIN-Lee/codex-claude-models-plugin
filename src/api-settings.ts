import {constants, promises as fs, type Stats} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {BridgeError} from './contracts.js';
import {FallbackStore} from './fallback-store.js';

const positive = z.number().finite().positive().max(100000);
const configSchema = z.object({
  schema_version: z.literal(1), enabled: z.literal(true),
  dailyLimitUsd: positive, totalLimitUsd: positive.optional(), perRequestLimitUsd: positive,
  maxOutputTokens: z.number().int().min(256).max(128000),
  confirmedSubscriptionAccount: z.string().regex(/^[a-f0-9]{64}$/),
  cache: z.enum(['off', '5m']).default('5m'),
}).strict().refine(v => v.perRequestLimitUsd <= v.dailyLimitUsd &&
  (v.totalLimitUsd === undefined || v.perRequestLimitUsd <= v.totalLimitUsd));
export type ApiConfig = z.infer<typeof configSchema>;
const credentialsSchema = z.object({schema_version: z.literal(1),
  api_key: z.string().min(16).max(1024).regex(/^[A-Za-z0-9_-]+$/),
  workspace_id: z.string().regex(/^wrkspc_[A-Za-z0-9_-]{1,200}$/).optional(),
}).strict();
const failure = () => new BridgeError(424, 'api_configuration_invalid',
  'The private API configuration cannot be verified. Subscription use remains available; paid fallback is blocked.');
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
function privateStat(stat: Stats, directory = false) {
  if (directory ? !stat.isDirectory() : !stat.isFile()) throw failure();
  if ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw failure();
}
async function privateDirectory(root: string, create = false) {
  if (!path.isAbsolute(root)) throw failure();
  if (create) await fs.mkdir(root, {recursive: true, mode: 0o700});
  privateStat(await fs.lstat(root), true);
}
async function read(root: string, name: string): Promise<unknown | undefined> {
  try {
    await privateDirectory(root);
    const file = path.join(root, name), before = await fs.lstat(file);
    privateStat(before);
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat(); privateStat(stat);
      if (stat.ino !== before.ino || stat.dev !== before.dev || stat.size > 16384) throw failure();
      return JSON.parse(await handle.readFile('utf8')) as unknown;
    } finally {await handle.close();}
  } catch (error) {if (missing(error)) return undefined; throw failure();}
}
export async function writeApiPrivate(root: string, name: string, value: unknown): Promise<void> {
  if (path.basename(name) !== name) throw failure();
  let temporary: string | undefined;
  try {
    await privateDirectory(root, true);
    temporary = path.join(root, `.${randomUUID()}.tmp`);
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {await handle.writeFile(JSON.stringify(value) + '\n'); await handle.sync();} finally {await handle.close();}
    await fs.rename(temporary, path.join(root, name));
    const directory = await fs.open(root, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {await directory.sync();} finally {await directory.close();}
  } catch {throw failure();} finally {if (temporary) await fs.unlink(temporary).catch(() => {});}
}

export async function loadApiConfig(root: string): Promise<ApiConfig | null> {
  // Existence alone is enough to disable: this switch must work even if optional JSON is damaged.
  try {await fs.lstat(path.join(root, 'disabled')); return null;}
  catch (error) {if (!missing(error)) throw failure();}
  const value = await read(root, 'config.json');
  try {await fs.lstat(path.join(root, 'disabled')); return null;}
  catch (error) {if (!missing(error)) throw failure();}
  if (value === undefined) return null;
  if (value && typeof value === 'object' && 'enabled' in value && value.enabled === false) return null;
  const parsed = configSchema.safeParse(value);
  if (!parsed.success) throw failure();
  return parsed.data;
}
export async function readApiCredentials(root: string): Promise<{api_key: string; workspace_id?: string}> {
  const parsed = credentialsSchema.safeParse(await read(root, 'credentials.json'));
  if (!parsed.success) throw failure();
  const {schema_version: _, ...credentials} = parsed.data;
  return credentials;
}
export async function saveApiConfig(root: string, value: unknown): Promise<void> {
  const parsed = configSchema.safeParse(value);
  if (!parsed.success) throw failure();
  await new FallbackStore(root).withControlLock(async () => {
    await writeApiPrivate(root, 'config.json', parsed.data);
    await fs.unlink(path.join(root, 'disabled')).catch(error => {if (!missing(error)) throw failure();});
    const directory = await fs.open(root, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {await directory.sync();} finally {await directory.close();}
  });
}
export async function disableApiFallback(root: string): Promise<void> {
  await new FallbackStore(root).withControlLock(() => writeApiPrivate(root, 'disabled', {disabled: true}));
}
// Disable/save and permission to start an inference share one cross-process lock. Only initiation is
// protected; the lock is released while the request is in flight, so emergency disable remains responsive.
export async function withApiSendPermit<T>(root: string, expected: ApiConfig, start: () => Promise<T>): Promise<{pending: Promise<T>}> {
  return new FallbackStore(root).withControlLock(async () => {
    const current = await loadApiConfig(root);
    if (!current) throw new BridgeError(409, 'api_fallback_disabled', 'Paid fallback was disabled before sending.');
    if (JSON.stringify(current) !== JSON.stringify(expected))
      throw new BridgeError(409, 'api_configuration_changed', 'API settings changed before sending.');
    const pending = start(); pending.catch(() => {});
    return {pending};
  });
}
export async function apiStatus(root: string) {
  try {
    const config = await loadApiConfig(root);
    if (!config) return {status: 'disabled' as const};
    await readApiCredentials(root);
    const store = new FallbackStore(root);
    const budget = await store.snapshot(), quota = await store.quotaStatus(config.confirmedSubscriptionAccount);
    return {status: 'configured_unverified' as const, dailyLimitUsd: config.dailyLimitUsd,
      totalLimitUsd: config.totalLimitUsd ?? null, perRequestLimitUsd: config.perRequestLimitUsd,
      maxOutputTokens: config.maxOutputTokens, cache: config.cache,
      budget: {...budget, costBasis: 'local_usage_estimate' as const,
        dailyRemainingUsd: Math.max(0, config.dailyLimitUsd - budget.todayUsd),
        totalRemainingUsd: config.totalLimitUsd === undefined ? null : Math.max(0, config.totalLimitUsd - budget.totalUsd)}, quota};
  } catch {return {status: 'blocked' as const, code: 'api_configuration_invalid'};}
}

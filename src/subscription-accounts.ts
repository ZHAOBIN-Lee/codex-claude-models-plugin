import {promises as fs} from 'node:fs';
import path from 'node:path';
import {z} from 'zod';
import {BridgeError, type RunStep} from './contracts.js';
import {inspectSdk, type RuntimeOptions} from './sdk.js';
import type {ClaudeModel} from './catalog.js';

const accountSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  label: z.string().min(1).max(120).regex(/^[^\u0000-\u001f\u007f]+$/),
  configDir: z.string().refine(value => path.isAbsolute(value), 'must be an absolute path').optional(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type SubscriptionAccount = z.infer<typeof accountSchema>;

const accountsSchema = z.object({schema_version: z.literal(1), accounts: z.array(accountSchema).min(1)}).strict();

// Only profile locations and verified identities live here. Claude Code owns all login credentials.
export async function readSubscriptionAccounts(root: string): Promise<SubscriptionAccount[]> {
  const file = path.join(root, 'subscription-accounts.json');
  let stat;
  try {stat = await fs.lstat(file);} catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077 || stat.size > 64 * 1024
    || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
    throw new BridgeError(503, 'subscription_accounts_invalid', 'subscription-accounts.json must be a private, user-owned regular file (mode 600).');
  }
  let raw: unknown;
  try {raw = JSON.parse(await fs.readFile(file, 'utf8'));}
  catch {throw new BridgeError(503, 'subscription_accounts_invalid', 'subscription-accounts.json could not be read as JSON.');}
  const parsed = accountsSchema.safeParse(raw);
  if (!parsed.success) throw new BridgeError(503, 'subscription_accounts_invalid', 'Invalid subscription-accounts.json. Check account IDs, labels, absolute configuration directories and fingerprints.');
  const accounts = parsed.data.accounts;
  const ids = accounts.map(account => account.id);
  const directories = accounts.map(account => account.configDir ? path.resolve(account.configDir) : 'default');
  const fingerprints = accounts.map(account => account.fingerprint);
  if (new Set(ids).size !== ids.length || new Set(directories).size !== directories.length || new Set(fingerprints).size !== fingerprints.length) {
    throw new BridgeError(503, 'subscription_accounts_invalid', 'Each subscription account must have a unique ID, configuration directory and login identity.');
  }
  return accounts;
}

export function accountRuntime(runtime: RuntimeOptions, account: SubscriptionAccount): RuntimeOptions {
  return {...runtime, configDir: account.configDir, expectedAccount: account.fingerprint};
}

export function accountModelRunner(models: ClaudeModel[], subscription: RunStep, legacy: RunStep): RunStep {
  const accountModels = new Set(models.filter(model => model.account).map(model => model.id));
  return (request, signal, progress) => (accountModels.has(request.model) ? subscription : legacy)(request, signal, progress);
}

export async function inspectAccountModels(cwd: string, runtime: RuntimeOptions, accounts: SubscriptionAccount[], inspect = inspectSdk) {
  const legacy = await inspect(cwd, runtime);
  if (!accounts.length || !legacy.authenticated) return legacy;
  const groups = await Promise.all(accounts.map(async account => {
    const metadata = await inspect(cwd, accountRuntime(runtime, account));
    if (!metadata.authenticated || metadata.accountId !== account.fingerprint) {
      throw new BridgeError(409, 'subscription_account_changed', `Claude account ${account.id} does not match its registered login. Sign in to that account and refresh the catalog.`);
    }
    return metadata.models.map(model => ({...model, id: `${model.id}-account-${account.id}`,
      displayName: `${model.displayName.replace(/^Claude Agent · /, 'Claude ')} · ${account.label}`, account}));
  }));
  const pairs = new Map<string, ClaudeModel[]>();
  for (const model of groups.flat()) {
    const choices = pairs.get(model.sdkModel) ?? [];
    choices.push(model);
    pairs.set(model.sdkModel, choices);
  }
  // Existing chats can still address their original model IDs after the menu gains account choices.
  const models: ClaudeModel[] = [...legacy.models.map(model => ({...model, hidden: true})), ...[...pairs.values()].flat()];
  if (new Set(models.map(model => model.id)).size !== models.length) {
    throw new BridgeError(503, 'subscription_accounts_invalid', 'Account model IDs collide. Choose different account IDs.');
  }
  return {...legacy, models};
}

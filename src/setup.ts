import { promises as fs, openSync, closeSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import TOML from '@iarna/toml';
import { codexCatalog, combinedCatalog, openaiCatalogSchema, type OpenAICatalog, type ClaudeModel } from './catalog.js';
import { VERSION } from './version.js';
import { codexBin, withCodexRpc } from './codex-rpc.js';
import { routerEnvironment } from './runtime-policy.js';

const exec = promisify(execFile);

// npm installs the private runtime. Honour NPM_BIN (an executable or npm-cli.js), then the npm shipped next to this
// Node, then PATH, so a machine whose shell PATH lacks npm (pnpm-only, app-bundled Node) can still install.
export async function npmCommand(env: NodeJS.ProcessEnv = process.env): Promise<[string, string[]]> {
  const configured = env.NPM_BIN;
  if (configured) return /\.[cm]?js$/.test(configured) ? [process.execPath, [configured]] : [configured, []];
  const sibling = path.join(path.dirname(process.execPath), 'npm');
  try {await fs.access(sibling); return [sibling, []];} catch {/* fall back to PATH */}
  return ['npm', []];
}
const PROVIDER = 'claude_agent_sdk';
const ROUTER = 'codex_model_router';
type Config = Record<string, any>;
// What an install intends to own. It lives in `pendingInstall` until config.toml has been committed.
interface Target {
  version: string; port: number; models: ClaudeModel[]; provider: Config;
  files: Record<string, string>;
  routerProvider?: Config;
  openaiModels?: string[];
  openaiSource?: string;
  startHook?: Config;
  // Identity of the install attempt that produced this target. It survives promotion, so a later failure can tell
  // "this attempt was committed" from "an older committed state is still in place".
  attempt?: string;
}
interface State extends Target {
  previous?: Record<string, unknown>;
  selected?: Record<string, unknown>;
  hookTrust?: {key: string; value: Config; previous: Config | null};
  // Journals written before config.toml changes. State fields keep describing the config as last committed;
  // loadState promotes a journal only after config.toml is seen to contain it.
  pendingInstall?: Target;
  pendingSelect?: {selected: Record<string, unknown>; previous: Record<string, unknown>; hookTrust: State['hookTrust'] | null};
}

export function locations(codexHome = process.env.CODEX_HOME ?? path.join(homedir(), '.codex')) {
  const home = path.resolve(codexHome);
  const root = path.join(home, 'claude-models');
  return {home, root, config: path.join(home, 'config.toml'), state: path.join(root, 'state.json'),
    runtime: path.join(root, 'runtime'), catalog: path.join(root, 'catalog.json'),
    combined: path.join(root, 'combined-catalog.json'), token: path.join(root, 'token')};
}
type Paths = ReturnType<typeof locations>;

async function readText(file: string) {
  try {return await fs.readFile(file, 'utf8');} catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error;}
}
export async function readState(p: Paths): Promise<State> {
  const text = await readText(p.state);
  if (!text) throw new Error('Claude models are not installed. Run setup.mjs install first.');
  return JSON.parse(text) as State;
}
async function writePrivate(file: string, content: string) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, content, {mode: 0o600});
  await fs.rename(tmp, file);
}
async function saveState(p: Paths, state: State) {await writePrivate(p.state, `${JSON.stringify(state, null, 2)}\n`);}
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const x = a as Config, y = b as Config;
  return Object.keys(x).length === Object.keys(y).length && Object.keys(x).every(k => same(x[k], y[k]));
}
async function readConfig(p: Paths) {const source = await readText(p.config); return {source, config: TOML.parse(source) as Config};}
function configValue(config: Config, key: string): unknown {
  const [section, field] = key.split('.');
  return field ? config[section!]?.[field] : config[key];
}
function setConfigValue(config: Config, key: string, value: unknown) {
  const [section, field] = key.split('.');
  if (field) {
    if (value !== null) {config[section!] ??= {}; config[section!][field] = value;}
    else if (config[section!]) {delete config[section!][field]; if (!Object.keys(config[section!]).length) delete config[section!];}
  } else if (value === null) delete config[key]; else config[key] = value;
}
async function saveConfig(p: Paths, source: string, config: Config) {
  if (await readText(p.config) !== source) throw new Error('Codex config changed during setup. Retry after the other edit completes.');
  const next = TOML.stringify(config as TOML.JsonMap);
  TOML.parse(next);
  if (source) await writePrivate(path.join(p.root, 'backups', `config-${Date.now()}-${randomBytes(3).toString('hex')}.toml`), source);
  await writePrivate(p.config, next);
}

export async function withLock<T>(p: Paths, action: () => Promise<T>) {
  await fs.mkdir(p.root, {recursive: true, mode: 0o700});
  const lock = path.join(p.root, 'setup.lock');
  let handle;
  try {handle = await fs.open(lock, 'wx', 0o600);} catch {throw new Error(`Another setup is running, or a previous setup left ${lock}.`);}
  try {await handle.writeFile(`${process.pid}\n`); return await action();}
  finally {await handle.close(); await fs.unlink(lock);}
}

function provider(p: Paths, port: number) {
  return {name: 'Claude Agent SDK', base_url: `http://127.0.0.1:${port}/v1`, wire_api: 'responses',
    requires_openai_auth: false, supports_websockets: false, request_max_retries: 0, stream_max_retries: 0,
    auth: {command: process.execPath, args: [path.join(p.root, 'setup.mjs'), 'token', '--codex-home', p.home], timeout_ms: 15000, refresh_interval_ms: 60000}};
}
function routerProvider(port: number, token: string) {
  // Stream retries reconnect a GPT stream that OpenAI drops mid-response ("error decoding response body"); before migration
  // Codex's built-in OpenAI provider did this. Request retries stay off so a busy or failed Claude step is not re-run.
  return {name: 'Codex + Claude Router', base_url: `http://127.0.0.1:${port}/v1`, wire_api: 'responses',
    requires_openai_auth: true, supports_websockets: false, request_max_retries: 0, stream_max_retries: 3,
    http_headers: {'X-Codex-Router-Token': token}};
}
function startupHook(p: Paths) {
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  return {matcher: 'startup|resume|clear', hooks: [{type: 'command',
    command: [process.execPath, path.join(p.root, 'setup.mjs'), 'ensure-hook', '--codex-home', p.home].map(quote).join(' '),
    timeout: 15, statusMessage: 'Starting Codex + Claude router'}]};
}
function removeStartupHook(config: Config, hook?: Config) {
  if (!hook || !Array.isArray(config.hooks?.SessionStart)) return;
  config.hooks.SessionStart = config.hooks.SessionStart.flatMap((entry: unknown, index: number, entries: unknown[]) =>
    !same(entry, hook) ? [entry] : index === entries.length - 1 ? [] : [{hooks: []}]);
  if (!config.hooks.SessionStart.length) delete config.hooks.SessionStart;
  if (!Object.keys(config.hooks).length) delete config.hooks;
}
function restoreHookTrust(config: Config, state: State) {
  const trust = state.hookTrust;
  if (!trust) return;
  // Only an entry still equal to what we wrote is ours to restore. Otherwise our write never landed or the user
  // has since replaced it; either way the journal no longer owns anything and must not shadow later values.
  if (same(config.hooks?.state?.[trust.key], trust.value)) {
    if (trust.previous) config.hooks.state[trust.key] = trust.previous;
    else delete config.hooks.state[trust.key];
    if (!Object.keys(config.hooks.state).length) delete config.hooks.state;
    if (!Object.keys(config.hooks).length) delete config.hooks;
  }
  delete state.hookTrust;
}
function addStartupHook(config: Config, hook: Config) {
  config.hooks ??= {};
  config.hooks.SessionStart ??= [];
  if (!Array.isArray(config.hooks.SessionStart)) throw new Error('hooks.SessionStart must be an array.');
  if (!config.hooks.SessionStart.some((entry: unknown) => same(entry, hook))) config.hooks.SessionStart.push(hook);
}

function hasStartupHook(config: Config, hook: Config) {
  return Array.isArray(config.hooks?.SessionStart) && config.hooks.SessionStart.some((entry: unknown) => same(entry, hook));
}
async function unwrittenFile(target: Target) {
  for (const [file, content] of Object.entries(target.files)) if (await readText(file) !== content) return file;
}
type InstallStatus = 'applied' | 'original' | {conflict: string};
// Judges a pending install by what config.toml and the owned files hold now, never by whether the journal could be saved.
// A same-port replacement leaves config.toml identical before and after, so only then do the owned files decide.
async function installStatus(state: State, config: Config, target: Target): Promise<InstallStatus> {
  const providers = config.model_providers ?? {};
  const old = state.startHook;
  const hookChanged = Boolean(target.startHook && old && !same(old, target.startHook));
  const toTarget = same(providers[PROVIDER], target.provider) && (!target.routerProvider || same(providers[ROUTER], target.routerProvider))
    && !(hookChanged && hasStartupHook(config, old!) && !hasStartupHook(config, target.startHook!));
  const toOld = same(providers[PROVIDER], state.models.length ? state.provider : undefined) && same(providers[ROUTER], state.routerProvider)
    && !(hookChanged && hasStartupHook(config, target.startHook!));
  if (toTarget) {
    const unwritten = await unwrittenFile(target);
    if (!unwritten) return 'applied';
    // Only config.toml tells the commit apart when the definitions differ, so files that differ now changed after it.
    if (!toOld) return {conflict: `config.toml already names the interrupted install but its owned file was edited or removed: ${unwritten}.`};
  }
  if (toOld) return 'original';
  return {conflict: 'The Claude provider or router in config.toml matches neither the committed nor the interrupted install.'};
}
// True when config.toml already names the pending install, even if the journal could not be promoted. False only when the
// install is proved not to have reached it. Anything undecidable throws, because callers treat false as leave-to-rollback.
// With `attempt`, only that attempt's own journal or promoted state counts: an older committed state, or another
// attempt's journal, means this attempt never reached its journal, which is a proved precommit state.
export async function installCommitted(p: Paths, attempt?: string) {
  try {
    const text = await readText(p.state);
    const {config} = await readConfig(p);
    if (!text) {
      if (config.model_providers?.[PROVIDER] || config.model_providers?.[ROUTER]) throw new Error('config.toml has Claude providers but no install state exists');
      return false;
    }
    const state = JSON.parse(text) as State;
    if (attempt && !state.pendingInstall) {
      if (state.attempt !== attempt) return false;
      // The attempted target was promoted into the state, so only config.toml can still disagree with it.
      const providers = config.model_providers ?? {};
      if (!same(providers[PROVIDER], state.provider) || !same(providers[ROUTER], state.routerProvider)) {
        throw new Error('The install state names the attempted install but config.toml does not');
      }
      return true;
    }
    if (!state.pendingInstall) return false;
    if (attempt && state.pendingInstall.attempt !== attempt) return false;
    const status = await installStatus(state, config, state.pendingInstall);
    if (typeof status === 'object') throw new Error(status.conflict);
    return status === 'applied';
  } catch (error) {
    throw new Error(`Cannot tell whether the install reached config.toml: ${error instanceof Error ? error.message : String(error)}`, {cause: error});
  }
}
// What a failed install may do to the runtime directory. installConfig only runs after the runtime swap, so before it
// config.toml is untouched. Only a proved precommit state may restore the old runtime; an unknown one keeps the new one.
export async function failedInstallOutcome(p: Paths, swapped: boolean, attempt?: string): Promise<{outcome: 'committed' | 'precommit' | 'unknown'; reason: string}> {
  if (!swapped) return {outcome: 'precommit', reason: ''};
  try {return {outcome: await installCommitted(p, attempt) ? 'committed' : 'precommit', reason: ''};}
  catch (error) {return {outcome: 'unknown', reason: error instanceof Error ? error.message : String(error)};}
}
async function promoteInstall(state: State) {
  const target = state.pendingInstall;
  if (!target) return;
  for (const [file, expected] of Object.entries(state.files)) {
    if (!(file in target.files) && await readText(file) === expected) await fs.rm(file, {force: true});
  }
  Object.assign(state, target);
  delete state.pendingInstall;
}
function selectConflict(state: State, config: Config, selected: Record<string, unknown>) {
  for (const [key, expected] of Object.entries(selected)) {
    // The app may save another model from this same catalog.
    if (key === 'model' && knownModel(state, config[key])) continue;
    if (!same(configValue(config, key), expected)) return key;
  }
}
// Settles journals left by an interrupted operation, judging only by what config.toml and the owned files contain now.
// A journal is dropped only when it was applied or when everything it touched still matches the prior committed mode;
// otherwise it stays and the conflict is reported instead of overwriting a user's edit.
async function settle(p: Paths, state: State): Promise<{state: State | undefined; installed: boolean}> {
  if (!state.pendingInstall && !state.pendingSelect) return {state, installed: false};
  const {config} = await readConfig(p);
  let installed = false, changed = false, conflict = '';
  const target = state.pendingInstall;
  if (target) {
    const status = await installStatus(state, config, target);
    if (status === 'applied') {await promoteInstall(state); installed = changed = true;}
    else if (typeof status === 'object') conflict = status.conflict;
    else {
      // The interrupted install never reached config.toml. Its files may be partly written; undo only content we wrote.
      for (const [file, content] of Object.entries(target.files)) {
        const existing = await readText(file);
        if (existing && existing !== content && existing !== state.files[file]) conflict ||= `Owned file was edited: ${file}.`;
      }
      if (!conflict) {
        await undoTargetFiles(state.files, target);
        delete state.pendingInstall; changed = true;
        if (!state.models.length) {await fs.rm(p.state, {force: true}); return {state: undefined, installed};}
      }
    }
  }
  const journal = state.pendingSelect;
  if (journal && !conflict) {
    const unapplied = selectConflict(state, config, journal.selected);
    const previousMode = state.selected;
    const original = Object.keys({...previousMode, ...journal.selected}).every(key => {
      if (key === 'model' && previousMode && knownModel(state, config[key])) return true;
      return same(configValue(config, key) ?? null, (previousMode && key in previousMode ? previousMode[key] : journal.previous[key]) ?? null);
    });
    if (!unapplied) {
      state.selected = journal.selected; state.previous = journal.previous;
      if (journal.hookTrust) state.hookTrust = journal.hookTrust; else delete state.hookTrust;
    } else if (!original) conflict = `Setting ${unapplied} was edited after an interrupted mode switch.`;
    if (!conflict) {delete state.pendingSelect; changed = true;}
  }
  if (changed) await saveState(p, state);
  if (conflict) throw new Error(`${conflict} Refusing to overwrite it. Restore it to the interrupted target or its original value, then retry.`);
  return {state, installed};
}
async function loadState(p: Paths) {
  const state = (await settle(p, await readState(p))).state;
  if (!state) throw new Error('Claude models are not installed. Run setup.mjs install first.');
  return state;
}

function defaultModel(models: ClaudeModel[]) {return models.find(m => m.sdkModel === 'sonnet') ?? models[0]!;}
function generatedFiles(p: Paths, models: ClaudeModel[], openai?: OpenAICatalog) {
  const files: Record<string, string> = {[p.catalog]: `${JSON.stringify(codexCatalog(models), null, 2)}\n`};
  files[path.join(p.home, 'claude.config.toml')] = TOML.stringify({model_provider: PROVIDER, model: defaultModel(models).id,
    model_catalog_json: p.catalog, web_search: 'disabled', agents: {default_subagent_model: defaultModel(models).id}} as TOML.JsonMap);
  for (const model of models) {
    const name = model.sdkModel.startsWith('opus') ? 'claude_opus' : model.sdkModel === 'sonnet' ? 'claude_sonnet'
      : model.sdkModel === 'haiku' ? 'claude_haiku' : model.id.replaceAll('-', '_');
    files[path.join(p.home, 'agents', `${name}.toml`)] = TOML.stringify({
      name, description: `Use ${model.displayName} through the installed unified model router or Claude-only profile for a scoped task.`,
      model: model.id,
      model_reasoning_effort: model.efforts.includes('medium') ? 'medium' : 'none',
      developer_instructions: 'Complete the scoped task delegated by the parent. You share the workspace with others; preserve their changes. Use Codex tools and honor its permissions. Return evidence and any remaining limitations.',
    });
  }
  if (openai) {
    const catalog = combinedCatalog(openai, models);
    files[p.combined] = `${JSON.stringify(catalog, null, 2)}\n`;
  }
  return files;
}

export async function installConfig(p: Paths, models: ClaudeModel[], port: number, openai?: OpenAICatalog, openaiSource?: string,
  attempt: string = randomBytes(8).toString('hex')) {
  if (!models.length) throw new Error('The SDK returned no models. No configuration was changed.');
  const previous = await readText(p.state) ? (await settle(p, await readState(p))).state : undefined;
  const {source, config} = await readConfig(p);
  const oldProvider = config.model_providers?.[PROVIDER];
  if (oldProvider && (!previous || !same(oldProvider, previous.provider))) throw new Error('An unmanaged or edited Claude provider already exists.');
  const oldRouter = config.model_providers?.[ROUTER];
  if (oldRouter && (!previous?.routerProvider || !same(oldRouter, previous.routerProvider))) throw new Error('An unmanaged or edited unified router provider already exists.');
  const files = generatedFiles(p, models, openai);
  // A file may still hold either the committed content or content from an interrupted install that never reached config.toml.
  const expectedContents = (file: string) => [previous?.files[file], previous?.pendingInstall?.files[file]].filter((c): c is string => c !== undefined);
  for (const file of new Set([...Object.keys(previous?.files ?? {}), ...Object.keys(previous?.pendingInstall?.files ?? {})])) {
    const existing = await readText(file);
    if (existing && !expectedContents(file).includes(existing)) throw new Error(`Owned file was edited: ${file}. Preserve your changes before reinstalling.`);
  }
  for (const [file, content] of Object.entries(files)) {
    const existing = await readText(file);
    if (existing && existing !== content && !expectedContents(file).length) throw new Error(`Refusing to replace existing file: ${file}`);
  }
  const definition = provider(p, port);
  const target: Target = {version: VERSION, port, models, provider: definition, files, attempt};
  if (openai) {
    const token = (await readText(p.token)).trim();
    if (!token) throw new Error('Missing local router token. Run the full install command.');
    target.routerProvider = routerProvider(port, token);
    target.openaiModels = openai.models.filter(m => !m.slug.startsWith('claude-sdk-')).map(m => m.slug);
    target.openaiSource = openaiSource;
    target.startHook = startupHook(p);
    if (previous?.startHook && hasStartupHook(config, previous.startHook)) {
      removeStartupHook(config, previous.startHook); addStartupHook(config, target.startHook);
    }
  }
  // Journal the intent first. The committed state fields keep matching config.toml until it actually changes,
  // so a failure before the config commit rolls back cleanly and one after it is promoted on the next operation.
  const journal: State = {...(previous ?? {version: VERSION, port, models: [], provider: {}, files: {}}), pendingInstall: target};
  await saveState(p, journal);
  try {
    for (const [file, content] of Object.entries(files)) await writePrivate(file, content);
    config.model_providers ??= {};
    config.model_providers[PROVIDER] = definition;
    if (target.routerProvider) config.model_providers[ROUTER] = target.routerProvider;
    await saveConfig(p, source, config);
  } catch (error) {
    // A rename can take effect and still report failure, so a throw does not prove config.toml was left alone. Judge what it
    // holds now: only a config that provably does not name this install may have the owned files rolled back. A committed or
    // ambiguous outcome keeps the journal and the new files for the next operation to settle.
    if (await configOutcome(p, journal, source, target) === 'untouched') await rollbackInstall(p, previous, target).catch(() => {});
    throw error;
  }
  await promoteInstall(journal);
  await saveState(p, journal);
  return journal;
}

async function configOutcome(p: Paths, journal: State, source: string, target: Target): Promise<'untouched' | 'committed' | 'ambiguous'> {
  try {
    const now = await readText(p.config);
    if (now === source) return 'untouched';
    const status = await installStatus(journal, TOML.parse(now) as Config, target);
    return status === 'applied' ? 'committed' : status === 'original' ? 'untouched' : 'ambiguous';
  } catch {return 'ambiguous';}
}

// Restores every file still holding target content. Keeps going after a failure, then reports it so the journal stays.
async function undoTargetFiles(oldFiles: Record<string, string>, target: Target) {
  let failure: unknown;
  for (const [file, content] of Object.entries(target.files)) {
    try {
      if (await readText(file) !== content) continue;
      const prior = oldFiles[file];
      if (prior === undefined) await fs.rm(file, {force: true});
      else if (prior !== content) await writePrivate(file, prior);
    } catch (error) {failure ??= error;}
  }
  if (failure) throw failure;
}
async function rollbackInstall(p: Paths, previous: State | undefined, target: Target) {
  await undoTargetFiles(previous?.files ?? {}, target);
  if (previous) await saveState(p, previous); else await fs.rm(p.state, {force: true});
}

function knownModel(state: State, model: unknown) {return state.models.some(m => m.id === model) || state.openaiModels?.includes(String(model));}

async function select(p: Paths, state: State, selected: Record<string, unknown>, enableStartup = false) {
  const {source, config} = await readConfig(p);
  const edited = state.selected && selectConflict(state, config, state.selected);
  if (edited) throw new Error(`Active setting ${edited} was edited outside this installer. Resolve that conflict before switching modes.`);
  // Build the next state aside; `state` keeps describing the mode that config.toml really has until the write lands.
  const next: State = {...state, previous: {...state.previous}, selected};
  for (const key of Object.keys(selected)) if (!(key in next.previous!)) next.previous![key] = configValue(config, key) ?? null;
  for (const key of Object.keys(state.selected ?? {})) if (!(key in selected)) {
    setConfigValue(config, key, next.previous![key] ?? null);
    delete next.previous![key];
  }
  restoreHookTrust(config, next);
  removeStartupHook(config, next.startHook);
  if (enableStartup && next.startHook) addStartupHook(config, next.startHook);
  for (const [key, value] of Object.entries(selected)) setConfigValue(config, key, value);
  await saveState(p, {...state, pendingSelect: {selected, previous: next.previous!, hookTrust: next.hookTrust ?? null}});
  try {await saveConfig(p, source, config);}
  catch (error) {await saveState(p, state).catch(() => {}); throw error;}
  await saveState(p, next);
}

export async function activate(p: Paths, modelId?: string) {
  const state = await loadState(p);
  const chosen = modelId ? state.models.find(m => m.id === modelId || m.sdkModel === modelId) : defaultModel(state.models);
  if (!chosen) throw new Error('Unknown model. Use doctor to list installed models.');
  await select(p, state, {model: chosen.id, model_provider: PROVIDER, model_catalog_json: p.catalog, web_search: 'disabled',
    'agents.default_subagent_model': chosen.id});
}

export async function activateRouter(p: Paths, modelId?: string) {
  const state = await loadState(p);
  if (!state.routerProvider || !state.openaiModels?.length) throw new Error('The combined catalog is not installed. Run install first.');
  const {config} = await readConfig(p);
  const chosen = modelId ?? config.model ?? state.openaiModels[0];
  if (!knownModel(state, chosen)) throw new Error(`Model ${String(chosen)} is not in the combined catalog. Pass --model with a listed model.`);
  await select(p, state, {model: chosen, model_provider: ROUTER, model_catalog_json: p.combined, 'features.hooks': true}, true);
}

export async function trustRouterStartup(p: Paths) {
  const state = await loadState(p);
  const command = state.startHook?.hooks?.[0]?.command;
  if (typeof command !== 'string' || state.selected?.model_provider !== ROUTER) throw new Error('Activate the router before registering startup trust.');
  await withCodexRpc(p.home, p.root, async rpc => {
    const read = await rpc<{layers: {name: {type: string; file?: string}; version: string}[]}>('config/read', {includeLayers: true});
    const userLayer = read.layers.find(layer => layer.name.type === 'user');
    const listed = await rpc<{data: {hooks: {key: string; command?: string; sourcePath: string; currentHash: string; eventName: string; isManaged: boolean}[]}[]}>('hooks/list', {cwds: [p.root]});
    const expectedPath = await fs.realpath(p.config);
    const candidates = listed.data.flatMap(entry => entry.hooks).filter(hook => hook.eventName === 'sessionStart'
      && hook.command === command && !hook.isManaged);
    const matches = [];
    for (const hook of candidates) if (await fs.realpath(hook.sourcePath) === expectedPath) matches.push(hook);
    if (matches.length !== 1 || !userLayer) throw new Error('Could not identify exactly one owned user startup hook through Codex.');
    const hook = matches[0]!;
    const {source, config} = await readConfig(p);
    const value = {enabled: true, trusted_hash: hook.currentHash};
    // Keep the original previous value only while our earlier write is what is in config.toml (it landed even if
    // the call reported failure). Otherwise the live entry, possibly edited since, is what must be restored.
    const current = config.hooks?.state?.[hook.key] ?? null;
    const previous = state.hookTrust?.key === hook.key && same(current, state.hookTrust.value) ? state.hookTrust.previous : current;
    // Journal ownership before the RPC write; it stays through any partial failure until restored or released.
    state.hookTrust = {key: hook.key, value, previous};
    await saveState(p, state);
    if (source) await writePrivate(path.join(p.root, 'backups', `config-hook-${Date.now()}.toml`), source);
    await rpc('config/value/write', {keyPath: `hooks.state.${JSON.stringify(hook.key)}`, value, mergeStrategy: 'replace',
      filePath: p.config, expectedVersion: userLayer.version});
  });
}

export async function deactivate(p: Paths) {
  const state = await loadState(p);
  if (!state.selected) return;
  const {source, config} = await readConfig(p);
  const before = TOML.parse(source) as Config;
  for (const [key, expected] of Object.entries(state.selected)) {
    // A key already holding its pre-activation value was restored by an earlier deactivate whose state save failed.
    if (same(configValue(config, key) ?? null, state.previous?.[key] ?? null)) continue;
    if (key === 'model' && knownModel(state, config[key])) continue;
    if (!same(configValue(config, key), expected)) throw new Error(`Active setting ${key} was edited. Refusing to overwrite it.`);
  }
  for (const key of Object.keys(state.selected)) setConfigValue(config, key, state.previous?.[key] ?? null);
  removeStartupHook(config, state.startHook);
  restoreHookTrust(config, state);
  if (!same(config, before)) await saveConfig(p, source, config);
  delete state.previous; delete state.selected; await saveState(p, state);
}

export async function uninstallConfig(p: Paths) {
  const state = await loadState(p);
  // Files of an unfinished install are owned too, holding either their committed or their pending content.
  const owned = Object.keys({...state.pendingInstall?.files, ...state.files});
  // Preflight every owned file before changing configuration or removing anything.
  for (const file of owned) {
    const existing = await readText(file);
    if (existing && existing !== state.files[file] && existing !== state.pendingInstall?.files[file]) throw new Error(`Refusing to remove edited file: ${file}`);
  }
  const current = await readConfig(p);
  if (current.config.model_providers?.[PROVIDER] && !same(current.config.model_providers[PROVIDER], state.provider)) throw new Error('The Claude provider was edited. Refusing to remove it.');
  if (current.config.model_providers?.[ROUTER] && !same(current.config.model_providers[ROUTER], state.routerProvider)) throw new Error('The router provider was edited. Refusing to remove it.');
  await deactivate(p);
  const {source, config} = await readConfig(p);
  const before = TOML.parse(source) as Config;
  removeStartupHook(config, state.startHook);
  restoreHookTrust(config, state);
  if (config.model_providers) {delete config.model_providers[PROVIDER]; delete config.model_providers[ROUTER]; if (!Object.keys(config.model_providers).length) delete config.model_providers;}
  if (!same(config, before)) await saveConfig(p, source, config);
  for (const file of owned) await fs.rm(file, {force: true});
  await fs.rm(p.state, {force: true});
}

async function health(p: Paths, state: State) {
  const token = (await readText(p.token)).trim();
  if (!token) return null;
  try {
    const response = await fetch(`http://127.0.0.1:${state.port}/health`, {headers: {Authorization: `Bearer ${token}`}, signal: AbortSignal.timeout(1000)});
    if (!response.ok) return null;
    const data = await response.json() as {service: string; version: string; pid: number};
    return data.service === 'codex-claude-models' && Number.isInteger(data.pid) ? data : null;
  } catch {return null;}
}

export async function stop(p: Paths) {
  const state = await readState(p);
  const live = await health(p, state);
  if (live) {
    process.kill(live.pid, 'SIGTERM');
    for (let n = 0; n < 30; n++) {if (!await health(p, state)) return; await new Promise(resolve => setTimeout(resolve, 100));}
    throw new Error('Bridge did not stop; configuration has been preserved.');
  }
}

export async function ensure(p: Paths) {
  const state = await readState(p);
  if (!state.models.length) throw new Error('Installation is incomplete. Rerun install.');
  if (await health(p, state)) return;
  const lock = path.join(p.root, 'setup.lock');
  for (let n = 0; n < 100; n++) {
    const owner = Number((await readText(lock)).trim());
    if (!owner || owner === process.pid) break;
    if (await health(p, state)) return;
    if (n === 99) throw new Error('Router installation is still in progress. Retry after it completes.');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const errorLog = openSync(path.join(p.root, 'bridge-error.log'), 'a', 0o600);
  try {
    const child = spawn(process.execPath, [path.join(p.runtime, 'bridge.mjs'), 'serve', '--codex-home', p.home],
      {cwd: p.root, detached: true, stdio: ['ignore', 'ignore', errorLog], env: routerEnvironment()});
    child.on('error', () => {}); child.unref();
  } finally {closeSync(errorLog);}
  for (let n = 0; n < 60; n++) {if (await health(p, state)) return; await new Promise(resolve => setTimeout(resolve, 100));}
  throw new Error(`Bridge did not start. Check ${path.join(p.root, 'bridge-error.log')} and port ${state.port}.`);
}

async function identityOf(file: string) {
  try {const stat = await fs.lstat(file); return `${stat.dev}:${stat.ino}`;}
  catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error;}
}

export async function install(p: Paths, port = 47832) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Port must be an integer between 1024 and 65535.');
  const bundleDir = path.dirname(fileURLToPath(import.meta.url));
  const pluginRoot = path.resolve(bundleDir, '..');
  await fs.mkdir(path.join(p.root, 'sdk-cwd'), {recursive: true, mode: 0o700});
  const staging = await fs.mkdtemp(path.join(p.root, 'runtime-stage-'));
  const backup = `${p.runtime}.backup-${process.pid}-${Date.now()}`;
  let swapped = false, backedUp = false, committed = false;
  // Binds this install to its own journal and promoted state, so a failure can tell its commit from an older one.
  const attempt = randomBytes(8).toString('hex');
  try {
    // Directory identities let a rename that reported failure be judged by what it actually did.
    const stagingId = await identityOf(staging);
    for (const file of ['package.json', 'package-lock.json']) await fs.copyFile(path.join(pluginRoot, 'runtime', file), path.join(staging, file));
    const [npm, npmArgs] = await npmCommand();
    await exec(npm, [...npmArgs, 'ci', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts'], {cwd: staging, timeout: 180000, maxBuffer: 4 * 1024 * 1024})
      .catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('npm was not found. Install Node.js with npm, or set NPM_BIN to an npm executable or npm-cli.js, then rerun install.');
        throw error;
      });
    await fs.copyFile(path.join(bundleDir, 'bridge.mjs'), path.join(staging, 'bridge.mjs'));
    const result = await exec(process.execPath, [path.join(staging, 'bridge.mjs'), 'models', '--codex-home', p.home], {timeout: 40000, maxBuffer: 1024 * 1024, env: routerEnvironment()});
    const metadata = JSON.parse(result.stdout) as {authenticated: boolean; models: ClaudeModel[]};
    if (!metadata.authenticated) throw new Error('No Claude subscription login. Run claude auth login, then retry install.');
    const {catalog, source} = await readOpenAICatalog(p);
    if (!await readText(p.token)) await writePrivate(p.token, `${randomBytes(32).toString('hex')}\n`);
    if (await readText(p.state)) await stop(p);
    const previousRuntimeId = await identityOf(p.runtime);
    if (previousRuntimeId) {
      try {await fs.rename(p.runtime, backup); backedUp = true;}
      catch (error) {
        // The rename may have taken effect before it threw: it did if that very directory now sits at the backup path.
        backedUp = await identityOf(backup).catch(() => undefined) === previousRuntimeId && await identityOf(p.runtime).catch(() => 'unknown') === undefined;
        throw error;
      }
    }
    try {await fs.rename(staging, p.runtime); swapped = true;}
    catch (error) {
      // Likewise, the staged runtime is in place if the runtime path now holds the staging directory itself.
      swapped = stagingId !== undefined && await identityOf(p.runtime).catch(() => undefined) === stagingId;
      throw error;
    }
    await fs.copyFile(path.join(bundleDir, 'setup.mjs'), path.join(p.root, 'setup.mjs'));
    const state = await installConfig(p, metadata.models, port, catalog, source, attempt);
    committed = true;
    if (state.selected?.model_provider === ROUTER) await trustRouterStartup(p);
    await ensure(p);
    if (backedUp) await fs.rm(backup, {recursive: true}).catch(() => {});
    return metadata.models;
  } catch (error) {
    // installConfig may have reached config.toml before failing to record it. Judge that from config.toml itself,
    // not from whether the journal can be saved, since restoring the old runtime under a new config would split them.
    const {outcome, reason} = committed ? {outcome: 'committed' as const, reason: ''} : await failedInstallOutcome(p, swapped, attempt);
    const failure = error instanceof Error ? error.message : String(error);
    const kept = backedUp ? ` The previous runtime was kept at ${backup}.` : '';
    if (outcome === 'committed') {
      // Recording the commit is best effort here; a journal left pending is promoted by the next operation.
      await readState(p).then(state => settle(p, state)).catch(() => {});
      throw new Error(`${failure} Configuration was already updated to the new runtime; fix the cause and rerun install.${kept}`, {cause: error});
    }
    if (outcome === 'unknown') throw new Error(`${failure} It could not be determined whether config.toml was updated, so the new runtime was left in place.${kept} ${reason}. Fix that, then rerun install.`, {cause: error});
    if (backedUp) {
      // Only a runtime this install placed is removed; anything else at that path is left alone.
      if (swapped) await fs.rm(p.runtime, {recursive: true, force: true});
      else if (await identityOf(p.runtime).catch(() => 'unknown')) {
        throw new Error(`${failure} The previous runtime was kept at ${backup}; ${p.runtime} was not placed by this install, so it was left alone.`, {cause: error});
      }
      await fs.rename(backup, p.runtime);
    }
    // The previous bridge was stopped before the swap, so bring it back whenever a committed state exists.
    if (await readText(p.state)) await ensure(p).catch(() => {});
    throw error;
  } finally {await fs.rm(staging, {recursive: true, force: true});}
}

export async function readOpenAICatalog(p: Paths): Promise<{catalog: OpenAICatalog; source: string}> {
  const {config} = await readConfig(p);
  const state = await readText(p.state) ? await readState(p) : undefined;
  const configured = config.model_catalog_json;
  const candidates = [...new Set([configured, state?.openaiSource, path.join(p.home, 'models_cache.json')])]
    .filter((file): file is string => typeof file === 'string' && ![p.catalog, p.combined, 'bundled'].includes(file));
  for (const file of candidates) {
    const source = await readText(file);
    if (!source) continue;
    const catalog = openaiCatalogSchema.parse(JSON.parse(source));
    if (catalog.models.some(m => !m.slug.startsWith('claude-sdk-'))) return {catalog, source: file};
  }
  const {stdout} = await exec(codexBin(), ['debug', 'models', '--bundled'], {timeout: 30000, maxBuffer: 16 * 1024 * 1024});
  return {catalog: openaiCatalogSchema.parse(JSON.parse(stdout)), source: 'bundled'};
}

export async function setupMain() {
  const args = process.argv.slice(2);
  const get = (key: string) => {const i = args.indexOf(key); return i < 0 ? undefined : args[i + 1];};
  const p = locations(get('--codex-home'));
  const command = args[0];
  switch (command) {
    case 'install': await withLock(p, async () => {
      const models = await install(p, Number(get('--port') ?? 47832));
      console.log(JSON.stringify({installed: true, models: models.map(m => ({id: m.id, name: m.displayName})),
        next: 'Run setup.mjs activate-router to keep GPT and Claude together in the normal model picker. The claude profile remains available.'}, null, 2));
    }); break;
    case 'activate': await withLock(p, () => activate(p, get('--model'))); console.log('Claude provider selected. Restart Codex to reload the model picker.'); break;
    case 'activate-router': await withLock(p, async () => {await activateRouter(p, get('--model')); await trustRouterStartup(p);}); await ensure(p); console.log('Combined GPT and Claude model picker enabled. Restart Codex to reload the catalog.'); break;
    case 'deactivate': await withLock(p, () => deactivate(p)); console.log('Previous model provider and catalog restored. Restart Codex.'); break;
    case 'uninstall': await withLock(p, async () => {await stop(p); await uninstallConfig(p);}); console.log('Claude provider and owned catalog/agents removed. Private runtime and backups retained.'); break;
    case 'token': await ensure(p); process.stdout.write((await fs.readFile(p.token, 'utf8')).trim()); break;
    case 'start': await ensure(p); console.log('Claude bridge is running.'); break;
    case 'ensure-hook': if (await readText(p.state)) await ensure(p); break;
    case 'stop': await stop(p); console.log('Claude bridge stopped.'); break;
    case 'doctor': {
      const state = await readState(p);
      const {stdout} = await exec(process.execPath, [path.join(p.runtime, 'bridge.mjs'), 'models', '--codex-home', p.home], {timeout: 40000});
      console.log(JSON.stringify({...(JSON.parse(stdout) as Config), bridgeRunning: !!await health(p, state),
        activated: !!state.selected, routerActivated: state.selected?.model_provider === ROUTER,
        openaiModels: state.openaiModels ?? [], node: process.version, codexHome: p.home}, null, 2)); break;
    }
    default: console.log('Usage: node setup.mjs install|activate-router|activate|deactivate|uninstall|doctor|start|stop [--codex-home PATH] [--port 47832] [--model ID]');
  }
}

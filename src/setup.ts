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
import { withCodexRpc } from './codex-rpc.js';

const exec = promisify(execFile);
const PROVIDER = 'claude_agent_sdk';
const ROUTER = 'codex_model_router';
type Config = Record<string, any>;
interface State {
  version: string; port: number; models: ClaudeModel[]; provider: Config;
  files: Record<string, string>;
  previous?: Record<string, unknown>;
  selected?: Record<string, unknown>;
  routerProvider?: Config;
  openaiModels?: string[];
  openaiSource?: string;
  startHook?: Config;
  hookTrust?: {key: string; value: Config; previous: Config | null};
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
  return {name: 'Codex + Claude Router', base_url: `http://127.0.0.1:${port}/v1`, wire_api: 'responses',
    requires_openai_auth: true, supports_websockets: false, request_max_retries: 0, stream_max_retries: 0,
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
  if (!trust || !same(config.hooks?.state?.[trust.key], trust.value)) return;
  if (trust.previous) config.hooks.state[trust.key] = trust.previous;
  else delete config.hooks.state[trust.key];
  if (!Object.keys(config.hooks.state).length) delete config.hooks.state;
  if (!Object.keys(config.hooks).length) delete config.hooks;
  delete state.hookTrust;
}
function addStartupHook(config: Config, hook: Config) {
  config.hooks ??= {};
  config.hooks.SessionStart ??= [];
  if (!Array.isArray(config.hooks.SessionStart)) throw new Error('hooks.SessionStart must be an array.');
  if (!config.hooks.SessionStart.some((entry: unknown) => same(entry, hook))) config.hooks.SessionStart.push(hook);
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

export async function installConfig(p: Paths, models: ClaudeModel[], port: number, openai?: OpenAICatalog, openaiSource?: string) {
  if (!models.length) throw new Error('The SDK returned no models. No configuration was changed.');
  const previousState = await readText(p.state);
  const previous: State | undefined = previousState ? JSON.parse(previousState) : undefined;
  const {source, config} = await readConfig(p);
  const oldProvider = config.model_providers?.[PROVIDER];
  if (oldProvider && (!previous || !same(oldProvider, previous.provider))) throw new Error('An unmanaged or edited Claude provider already exists.');
  const oldRouter = config.model_providers?.[ROUTER];
  if (oldRouter && (!previous?.routerProvider || !same(oldRouter, previous.routerProvider))) throw new Error('An unmanaged or edited unified router provider already exists.');
  const files = generatedFiles(p, models, openai);
  for (const [file, expected] of Object.entries(previous?.files ?? {})) {
    const existing = await readText(file);
    if (existing && existing !== expected) throw new Error(`Owned file was edited: ${file}. Preserve your changes before reinstalling.`);
  }
  for (const [file, content] of Object.entries(files)) {
    const existing = await readText(file);
    if (existing && existing !== content && !previous?.files[file]) throw new Error(`Refusing to replace existing file: ${file}`);
  }
  const definition = provider(p, port);
  const state: State = {...previous, version: VERSION, port, models, provider: definition, files};
  if (openai) {
    const token = (await readText(p.token)).trim();
    if (!token) throw new Error('Missing local router token. Run the full install command.');
    state.routerProvider = routerProvider(port, token);
    state.openaiModels = openai.models.filter(m => !m.slug.startsWith('claude-sdk-')).map(m => m.slug);
    state.openaiSource = openaiSource;
    state.startHook = startupHook(p);
    if (previous?.startHook && config.hooks?.SessionStart?.some((entry: unknown) => same(entry, previous.startHook))) {
      removeStartupHook(config, previous.startHook); addStartupHook(config, state.startHook);
    }
  }
  // Persist the ownership journal before writes so a failed install is recoverable.
  await saveState(p, state);
  for (const [file, content] of Object.entries(files)) await writePrivate(file, content);
  for (const file of Object.keys(previous?.files ?? {})) if (!files[file]) await fs.rm(file, {force: true});
  config.model_providers ??= {};
  config.model_providers[PROVIDER] = definition;
  if (state.routerProvider) config.model_providers[ROUTER] = state.routerProvider;
  await saveConfig(p, source, config);
  return state;
}

function knownModel(state: State, model: unknown) {return state.models.some(m => m.id === model) || state.openaiModels?.includes(String(model));}

async function select(p: Paths, state: State, selected: Record<string, unknown>, enableStartup = false) {
  const {source, config} = await readConfig(p);
  if (state.selected) for (const [key, expected] of Object.entries(state.selected)) {
    if (key === 'model' && knownModel(state, config[key])) continue;
    if (!same(configValue(config, key), expected)) throw new Error(`Active setting ${key} was edited outside this installer. Resolve that conflict before switching modes.`);
  }
  state.previous ??= {};
  for (const key of Object.keys(selected)) if (!(key in state.previous)) state.previous[key] = configValue(config, key) ?? null;
  for (const key of Object.keys(state.selected ?? {})) if (!(key in selected)) {
    setConfigValue(config, key, state.previous[key] ?? null);
    delete state.previous[key];
  }
  state.selected = selected;
  restoreHookTrust(config, state);
  removeStartupHook(config, state.startHook);
  if (enableStartup && state.startHook) addStartupHook(config, state.startHook);
  await saveState(p, state);
  for (const [key, value] of Object.entries(selected)) setConfigValue(config, key, value);
  await saveConfig(p, source, config);
}

export async function activate(p: Paths, modelId?: string) {
  const state = await readState(p);
  const chosen = modelId ? state.models.find(m => m.id === modelId || m.sdkModel === modelId) : defaultModel(state.models);
  if (!chosen) throw new Error('Unknown model. Use doctor to list installed models.');
  await select(p, state, {model: chosen.id, model_provider: PROVIDER, model_catalog_json: p.catalog, web_search: 'disabled',
    'agents.default_subagent_model': chosen.id});
}

export async function activateRouter(p: Paths, modelId?: string) {
  const state = await readState(p);
  if (!state.routerProvider || !state.openaiModels?.length) throw new Error('The combined catalog is not installed. Run install first.');
  const {config} = await readConfig(p);
  const chosen = modelId ?? config.model ?? state.openaiModels[0];
  if (!knownModel(state, chosen)) throw new Error(`Model ${String(chosen)} is not in the combined catalog. Pass --model with a listed model.`);
  await select(p, state, {model: chosen, model_provider: ROUTER, model_catalog_json: p.combined, 'features.hooks': true}, true);
}

export async function trustRouterStartup(p: Paths) {
  const state = await readState(p);
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
    const previous = state.hookTrust?.key === hook.key ? state.hookTrust.previous : config.hooks?.state?.[hook.key] ?? null;
    state.hookTrust = {key: hook.key, value, previous};
    await saveState(p, state);
    if (source) await writePrivate(path.join(p.root, 'backups', `config-hook-${Date.now()}.toml`), source);
    await rpc('config/value/write', {keyPath: `hooks.state.${JSON.stringify(hook.key)}`, value, mergeStrategy: 'replace',
      filePath: p.config, expectedVersion: userLayer.version});
  });
}

export async function deactivate(p: Paths) {
  const state = await readState(p);
  if (!state.selected) return;
  const {source, config} = await readConfig(p);
  for (const [key, expected] of Object.entries(state.selected)) {
    // The app may save another model from this same Claude catalog.
    if (key === 'model' && knownModel(state, config[key])) continue;
    if (!same(configValue(config, key), expected)) throw new Error(`Active setting ${key} was edited. Refusing to overwrite it.`);
  }
  for (const key of Object.keys(state.selected)) setConfigValue(config, key, state.previous?.[key] ?? null);
  removeStartupHook(config, state.startHook);
  restoreHookTrust(config, state);
  await saveConfig(p, source, config);
  delete state.previous; delete state.selected; await saveState(p, state);
}

export async function uninstallConfig(p: Paths) {
  const state = await readState(p);
  // Preflight every owned file before changing configuration or removing anything.
  for (const [file, expected] of Object.entries(state.files)) {
    const existing = await readText(file);
    if (existing && existing !== expected) throw new Error(`Refusing to remove edited file: ${file}`);
  }
  const current = await readConfig(p);
  if (current.config.model_providers?.[PROVIDER] && !same(current.config.model_providers[PROVIDER], state.provider)) throw new Error('The Claude provider was edited. Refusing to remove it.');
  if (current.config.model_providers?.[ROUTER] && !same(current.config.model_providers[ROUTER], state.routerProvider)) throw new Error('The router provider was edited. Refusing to remove it.');
  await deactivate(p);
  const {source, config} = await readConfig(p);
  removeStartupHook(config, state.startHook);
  restoreHookTrust(config, state);
  if (config.model_providers) {delete config.model_providers[PROVIDER]; delete config.model_providers[ROUTER]; if (!Object.keys(config.model_providers).length) delete config.model_providers;}
  await saveConfig(p, source, config);
  for (const file of Object.keys(state.files)) await fs.rm(file, {force: true});
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
      {cwd: p.root, detached: true, stdio: ['ignore', 'ignore', errorLog]});
    child.on('error', () => {}); child.unref();
  } finally {closeSync(errorLog);}
  for (let n = 0; n < 60; n++) {if (await health(p, state)) return; await new Promise(resolve => setTimeout(resolve, 100));}
  throw new Error(`Bridge did not start. Check ${path.join(p.root, 'bridge-error.log')} and port ${state.port}.`);
}

export async function install(p: Paths, port = 47832) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Port must be an integer between 1024 and 65535.');
  const bundleDir = path.dirname(fileURLToPath(import.meta.url));
  const pluginRoot = path.resolve(bundleDir, '..');
  await fs.mkdir(path.join(p.root, 'sdk-cwd'), {recursive: true, mode: 0o700});
  const staging = await fs.mkdtemp(path.join(p.root, 'runtime-stage-'));
  const backup = `${p.runtime}.backup-${process.pid}-${Date.now()}`;
  let swapped = false, backedUp = false;
  try {
    for (const file of ['package.json', 'package-lock.json']) await fs.copyFile(path.join(pluginRoot, 'runtime', file), path.join(staging, file));
    await exec('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts'], {cwd: staging, timeout: 180000, maxBuffer: 4 * 1024 * 1024});
    await fs.copyFile(path.join(bundleDir, 'bridge.mjs'), path.join(staging, 'bridge.mjs'));
    const result = await exec(process.execPath, [path.join(staging, 'bridge.mjs'), 'models', '--codex-home', p.home], {timeout: 40000, maxBuffer: 1024 * 1024});
    const metadata = JSON.parse(result.stdout) as {authenticated: boolean; models: ClaudeModel[]};
    if (!metadata.authenticated) throw new Error('No Claude subscription login. Run claude auth login, then retry install.');
    const {catalog, source} = await readOpenAICatalog(p);
    if (!await readText(p.token)) await writePrivate(p.token, `${randomBytes(32).toString('hex')}\n`);
    if (await readText(p.state)) await stop(p);
    try {await fs.rename(p.runtime, backup); backedUp = true;}
    catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
    await fs.rename(staging, p.runtime); swapped = true;
    await fs.copyFile(path.join(bundleDir, 'setup.mjs'), path.join(p.root, 'setup.mjs'));
    const state = await installConfig(p, metadata.models, port, catalog, source);
    if (state.selected?.model_provider === ROUTER) await trustRouterStartup(p);
    await ensure(p);
    if (backedUp) await fs.rm(backup, {recursive: true}).catch(() => {});
    return metadata.models;
  } catch (error) {
    if (backedUp) {
      if (swapped) await fs.rm(p.runtime, {recursive: true, force: true});
      await fs.rename(backup, p.runtime);
      if (await readText(p.state)) await ensure(p).catch(() => {});
    }
    throw error;
  } finally {await fs.rm(staging, {recursive: true, force: true});}
}

async function readOpenAICatalog(p: Paths): Promise<{catalog: OpenAICatalog; source: string}> {
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
  const {stdout} = await exec('codex', ['debug', 'models', '--bundled'], {timeout: 30000, maxBuffer: 16 * 1024 * 1024});
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

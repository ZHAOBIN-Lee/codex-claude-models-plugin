import { promises as fs, openSync, closeSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import TOML from '@iarna/toml';
import { codexCatalog, type ClaudeModel } from './catalog.js';

const exec = promisify(execFile);
const PROVIDER = 'claude_agent_sdk';
const VERSION = '0.1.0';
type Config = Record<string, any>;
interface State {
  version: string; port: number; models: ClaudeModel[]; provider: Config;
  files: Record<string, string>;
  previous?: Record<string, unknown>;
  selected?: Record<string, unknown>;
}

export function locations(codexHome = process.env.CODEX_HOME ?? path.join(homedir(), '.codex')) {
  const home = path.resolve(codexHome);
  const root = path.join(home, 'claude-models');
  return {home, root, config: path.join(home, 'config.toml'), state: path.join(root, 'state.json'),
    runtime: path.join(root, 'runtime'), catalog: path.join(root, 'catalog.json'), token: path.join(root, 'token')};
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
const mainKeys = ['model', 'model_provider', 'model_catalog_json', 'web_search', 'agents.default_subagent_model'];
function configValue(config: Config, key: string): unknown {
  return key === 'agents.default_subagent_model' ? config.agents?.default_subagent_model : config[key];
}
function setConfigValue(config: Config, key: string, value: unknown) {
  if (key === 'agents.default_subagent_model') {
    if (value !== null) {config.agents ??= {}; config.agents.default_subagent_model = value;}
    else if (config.agents) {delete config.agents.default_subagent_model; if (!Object.keys(config.agents).length) delete config.agents;}
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

function defaultModel(models: ClaudeModel[]) {return models.find(m => m.sdkModel === 'sonnet') ?? models[0]!;}
function generatedFiles(p: Paths, models: ClaudeModel[]) {
  const files: Record<string, string> = {[p.catalog]: `${JSON.stringify(codexCatalog(models), null, 2)}\n`};
  files[path.join(p.home, 'claude.config.toml')] = TOML.stringify({model_provider: PROVIDER, model: defaultModel(models).id,
    model_catalog_json: p.catalog, web_search: 'disabled', agents: {default_subagent_model: defaultModel(models).id}} as TOML.JsonMap);
  for (const model of models) {
    const name = model.sdkModel.startsWith('opus') ? 'claude_opus' : model.sdkModel === 'sonnet' ? 'claude_sonnet'
      : model.sdkModel === 'haiku' ? 'claude_haiku' : model.id.replaceAll('-', '_');
    files[path.join(p.home, 'agents', `${name}.toml`)] = TOML.stringify({
      name, description: `Use ${model.displayName} for a scoped task ONLY when the parent uses the Claude provider. Codex does not support cross-provider native subagents.`,
      model: model.id,
      model_reasoning_effort: model.efforts.includes('medium') ? 'medium' : 'none',
      developer_instructions: 'Complete the scoped task delegated by the parent. You share the workspace with others; preserve their changes. Use Codex tools and honor its permissions. Return evidence and any remaining limitations.',
    });
  }
  return files;
}

export async function installConfig(p: Paths, models: ClaudeModel[], port: number) {
  if (!models.length) throw new Error('The SDK returned no models. No configuration was changed.');
  const previousState = await readText(p.state);
  const previous: State | undefined = previousState ? JSON.parse(previousState) : undefined;
  const {source, config} = await readConfig(p);
  const oldProvider = config.model_providers?.[PROVIDER];
  if (oldProvider && (!previous || !same(oldProvider, previous.provider))) throw new Error('An unmanaged or edited Claude provider already exists.');
  const files = generatedFiles(p, models);
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
  // Persist the ownership journal before writes so a failed install is recoverable.
  await saveState(p, state);
  for (const [file, content] of Object.entries(files)) await writePrivate(file, content);
  for (const file of Object.keys(previous?.files ?? {})) if (!files[file]) await fs.rm(file, {force: true});
  config.model_providers ??= {};
  config.model_providers[PROVIDER] = definition;
  await saveConfig(p, source, config);
  return state;
}

export async function activate(p: Paths, modelId?: string) {
  const state = await readState(p);
  const chosen = modelId ? state.models.find(m => m.id === modelId || m.sdkModel === modelId) : defaultModel(state.models);
  if (!chosen) throw new Error('Unknown model. Use doctor to list installed models.');
  const {source, config} = await readConfig(p);
  if (state.selected) for (const [key, expected] of Object.entries(state.selected)) {
    if (key === 'model' && state.models.some(m => m.id === config[key])) continue;
    if (!same(configValue(config, key), expected)) throw new Error(`Active setting ${key} was edited outside this installer. Deactivation requires resolving that conflict.`);
  }
  state.previous ??= {};
  for (const key of mainKeys) if (!(key in state.previous)) state.previous[key] = configValue(config, key) ?? null;
  state.selected = {model: chosen.id, model_provider: PROVIDER, model_catalog_json: p.catalog, web_search: 'disabled',
    'agents.default_subagent_model': chosen.id};
  await saveState(p, state);
  for (const [key, value] of Object.entries(state.selected)) setConfigValue(config, key, value);
  await saveConfig(p, source, config);
}

export async function deactivate(p: Paths) {
  const state = await readState(p);
  if (!state.selected) return;
  const {source, config} = await readConfig(p);
  for (const [key, expected] of Object.entries(state.selected)) {
    // The app may save another model from this same Claude catalog.
    if (key === 'model' && state.models.some(m => m.id === config[key])) continue;
    if (!same(configValue(config, key), expected)) throw new Error(`Active setting ${key} was edited. Refusing to overwrite it.`);
  }
  for (const [key, value] of Object.entries(state.previous ?? {})) {
    setConfigValue(config, key, value);
  }
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
  await deactivate(p);
  const {source, config} = await readConfig(p);
  if (config.model_providers) {delete config.model_providers[PROVIDER]; if (!Object.keys(config.model_providers).length) delete config.model_providers;}
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
  await fs.mkdir(p.runtime, {recursive: true, mode: 0o700});
  if (await readText(p.state)) await stop(p);
  for (const file of ['package.json', 'package-lock.json']) await fs.copyFile(path.join(pluginRoot, 'runtime', file), path.join(p.runtime, file));
  await exec('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts'], {cwd: p.runtime, timeout: 180000, maxBuffer: 4 * 1024 * 1024});
  await fs.copyFile(path.join(bundleDir, 'bridge.mjs'), path.join(p.runtime, 'bridge.mjs'));
  await fs.copyFile(path.join(bundleDir, 'setup.mjs'), path.join(p.root, 'setup.mjs'));
  await fs.mkdir(path.join(p.root, 'sdk-cwd'), {recursive: true, mode: 0o700});
  if (!await readText(p.token)) await writePrivate(p.token, `${randomBytes(32).toString('hex')}\n`);
  const result = await exec(process.execPath, [path.join(p.runtime, 'bridge.mjs'), 'models', '--codex-home', p.home], {timeout: 40000, maxBuffer: 1024 * 1024});
  const metadata = JSON.parse(result.stdout) as {authenticated: boolean; models: ClaudeModel[]};
  if (!metadata.authenticated) throw new Error('No Claude subscription login. Run claude auth login, then retry install.');
  await installConfig(p, metadata.models, port);
  await ensure(p);
  return metadata.models;
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
        next: 'Use codex --profile claude, named claude_* subagents, or setup.mjs activate for the desktop Claude picker.'}, null, 2));
    }); break;
    case 'activate': await withLock(p, () => activate(p, get('--model'))); console.log('Claude provider selected. Restart Codex to reload the model picker.'); break;
    case 'deactivate': await withLock(p, () => deactivate(p)); console.log('Previous model provider and catalog restored. Restart Codex.'); break;
    case 'uninstall': await withLock(p, async () => {await stop(p); await uninstallConfig(p);}); console.log('Claude provider and owned catalog/agents removed. Private runtime and backups retained.'); break;
    case 'token': await ensure(p); process.stdout.write((await fs.readFile(p.token, 'utf8')).trim()); break;
    case 'start': await ensure(p); console.log('Claude bridge is running.'); break;
    case 'stop': await stop(p); console.log('Claude bridge stopped.'); break;
    case 'doctor': {
      const state = await readState(p);
      const {stdout} = await exec(process.execPath, [path.join(p.runtime, 'bridge.mjs'), 'models', '--codex-home', p.home], {timeout: 40000});
      console.log(JSON.stringify({...(JSON.parse(stdout) as Config), bridgeRunning: !!await health(p, state),
        activated: !!state.selected, node: process.version, codexHome: p.home}, null, 2)); break;
    }
    default: console.log('Usage: node setup.mjs install|activate|deactivate|uninstall|doctor|start|stop [--codex-home PATH] [--port 47832] [--model sonnet]');
  }
}

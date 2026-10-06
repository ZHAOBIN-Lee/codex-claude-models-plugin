import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as rpcModule from '../src/codex-rpc.js';
import * as setup from '../src/setup.js';

const bundled = {models: [{slug: 'gpt-from-fixture', priority: 0}]};

// A real executable that records how it was launched; no model or Codex install is involved.
async function fakeCodex(t: TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-codex-bin-'));
  const log = path.join(dir, 'invocations.jsonl');
  const bin = path.join(dir, 'fixture codex');
  await fs.writeFile(bin, `#!${process.execPath}
import fs from 'node:fs';
import readline from 'node:readline';
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({argv: process.argv.slice(2), home: process.env.CODEX_HOME, cwd: process.cwd()}) + '\\n');
if (process.argv[2] === 'debug') {process.stdout.write(${JSON.stringify(JSON.stringify(bundled))}); process.exit(0);}
readline.createInterface({input: process.stdin}).on('line', line => {
  const {id, method, params} = JSON.parse(line);
  if (id === undefined) return;
  process.stdout.write(JSON.stringify({id, result: method === 'initialize' ? {} : {echoed: method, params}}) + '\\n');
});
`, {mode: 0o755});
  const saved = process.env.CODEX_BIN;
  process.env.CODEX_BIN = bin;
  t.after(async () => {
    if (saved === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = saved;
    await fs.rm(dir, {recursive: true, force: true});
  });
  const invocations = async () => (await fs.readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  return {bin, invocations};
}

test('withCodexRpc launches the executable named by CODEX_BIN with the requested home and cwd', {timeout: 20000}, async t => {
  const fake = await fakeCodex(t);
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-rpc-cwd-'));
  t.after(() => fs.rm(work, {recursive: true, force: true}));
  const home = path.join(work, 'home');
  const result = await rpcModule.withCodexRpc(home, work, rpc => rpc<{echoed: string; params: unknown}>('config/read', {includeLayers: true}));
  assert.deepEqual(result, {echoed: 'config/read', params: {includeLayers: true}});
  const [call, ...rest] = await fake.invocations();
  assert.equal(rest.length, 0);
  assert.deepEqual(call.argv, ['app-server', '--stdio', '--disable', 'remote_plugin', '--disable', 'apps', '--disable', 'plugins']);
  assert.equal(call.home, home);
  assert.equal(await fs.realpath(call.cwd), await fs.realpath(work));
});

test('the bundled OpenAI catalog fallback runs CODEX_BIN rather than a bare codex', {timeout: 20000}, async t => {
  const fake = await fakeCodex(t);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-catalog-bin-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const p = setup.locations(path.join(root, 'home'));
  await fs.mkdir(p.home, {recursive: true});
  const result = await setup.readOpenAICatalog(p);
  assert.equal(result.source, 'bundled');
  assert.deepEqual(result.catalog.models.map(m => m.slug), ['gpt-from-fixture']);
  assert.deepEqual((await fake.invocations()).map(call => call.argv), [['debug', 'models', '--bundled']]);
});

test('the Codex executable defaults to codex when CODEX_BIN is unset or empty', () => {
  const saved = process.env.CODEX_BIN;
  try {
    delete process.env.CODEX_BIN;
    assert.equal(rpcModule.codexBin(), 'codex');
    process.env.CODEX_BIN = '';
    assert.equal(rpcModule.codexBin(), 'codex');
    process.env.CODEX_BIN = '/opt/custom/codex';
    assert.equal(rpcModule.codexBin(), '/opt/custom/codex');
  } finally {if (saved === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = saved;}
});

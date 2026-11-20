import {test} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {loadApiConfig, readApiCredentials, disableApiFallback, saveApiConfig, apiStatus, withApiSendPermit} from '../src/api-settings.js';

async function fixture(t: any) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'api-settings-')));
  t.after(() => fs.rm(root, {recursive:true,force:true})); return root;
}
const enabled = {schema_version:1,enabled:true,dailyLimitUsd:1,totalLimitUsd:1,perRequestLimitUsd:.5,maxOutputTokens:1024,
  confirmedSubscriptionAccount:'a'.repeat(64),cache:'5m'};
test('absent API config stays subscription-only without reading credentials', async t => {
  const root=await fixture(t); assert.equal(await loadApiConfig(root),null);
  assert.equal((await apiStatus(root)).status,'disabled');
});
test('completed disable prevents queued sends, and never waits for an in-flight inference',async t=>{
  const root=await fixture(t);await saveApiConfig(root,enabled);const config=(await loadApiConfig(root))!;
  let complete!:()=>void; const inflight=new Promise<void>(resolve=>{complete=resolve;});
  const permit=await withApiSendPermit(root,config,()=>inflight);
  await disableApiFallback(root);
  let sent=false;
  await assert.rejects(withApiSendPermit(root,config,async()=>{sent=true;}),{code:'api_fallback_disabled'});
  assert.equal(sent,false);complete();await permit.pending;
});
test('emergency disable takes priority over corrupt optional config and credentials', async t => {
  const root=await fixture(t); await fs.writeFile(path.join(root,'config.json'),'{',{mode:0o600});
  await assert.rejects(loadApiConfig(root)); await disableApiFallback(root);
  assert.equal(await loadApiConfig(root),null); assert.equal((await apiStatus(root)).status,'disabled');
});
test('enabled config requires budgets and a bound account, saves privately', async t => {
  const root=await fixture(t);
  await assert.rejects(saveApiConfig(root,{...enabled,dailyLimitUsd:0}));
  await assert.rejects(saveApiConfig(root,{...enabled,confirmedSubscriptionAccount:''}));
  await saveApiConfig(root,enabled);
  assert.equal((await loadApiConfig(root))?.dailyLimitUsd,1);
  assert.equal((await fs.stat(path.join(root,'config.json'))).mode&0o777,0o600);
});
test('credential validation never includes its value and rejects symlinks or public files', async t => {
  const root=await fixture(t), file=path.join(root,'credentials.json');
  const secret='sk-ant-'+ 'secret'.repeat(8);
  await fs.writeFile(file,JSON.stringify({schema_version:1,api_key:secret}),{mode:0o600});
  assert.equal((await readApiCredentials(root)).api_key,secret);
  await fs.chmod(file,0o644); await assert.rejects(readApiCredentials(root),e => !String(e).includes(secret));
  await fs.rename(file,path.join(root,'other')); await fs.symlink(path.join(root,'other'),file);
  await assert.rejects(readApiCredentials(root));
});

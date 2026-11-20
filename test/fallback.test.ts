import {test} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fallbackRunner} from '../src/fallback.js';
import {BridgeError, type RunStep, type StepResult, requestSchema} from '../src/contracts.js';
import {saveApiConfig, disableApiFallback} from '../src/api-settings.js';
import {attachStepIdentity} from '../src/paid-step-guard.js';
import {SubscriptionQuotaError} from '../src/subscription-limits.js';
import {FallbackStore} from '../src/fallback-store.js';
import {bridgeServer} from '../src/server.js';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';

const account = 'a'.repeat(64), model = {id:'claude-sdk-sonnet',sdkModel:'sonnet',resolvedModel:'claude-sonnet-5-5',displayName:'Sonnet',description:'',efforts:[]};
const result:StepResult = {decision:{text:'done',calls:[]},usage:{input_tokens:10,input_tokens_details:{cached_tokens:5},output_tokens:2,output_tokens_details:{reasoning_tokens:0},total_tokens:12}};
const config = {schema_version:1,enabled:true,dailyLimitUsd:1,totalLimitUsd:1,perRequestLimitUsd:.5,maxOutputTokens:1024,confirmedSubscriptionAccount:account,cache:'5m'};
const quota = () => new SubscriptionQuotaError(account,[{type:'five_hour',resetsAt:Date.now()+100000}]);
function request(identity = 'thread-1') {
  const req=requestSchema.parse({model:model.id,input:'test'});
  attachStepIdentity(req,{'thread-id':identity}); return req;
}
async function fixture(t:any, subscription:RunStep=async()=>{throw quota();}) {
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'fallback-coordinator-')));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await saveApiConfig(root,config);
  let paid=0, prepared=0, subscriptionCalls=0;
  const options = {root,models:[model],subscription:async(...args:Parameters<RunStep>)=>{subscriptionCalls++; return subscription(...args);},
    account:async()=>account, resultAccount:()=>account,
    api:(_config:any)=>({prepare:async()=>{prepared++;return {model:model.resolvedModel,inputTokens:10,maxOutputTokens:1024,reservationUsd:.1,
      execute:async()=>{paid++;return {result,actualModel:model.resolvedModel,requestId:'req_1',messageId:'msg_1',inputTokens:5,cacheReadInputTokens:5,cacheCreationInputTokens:0,outputTokens:2,costUsd:.01};}};}})};
  return {root,options,counts:()=>({paid,prepared,subscriptionCalls}),run:()=>fallbackRunner(options)};
}
test('disabled fallback does not inspect accounts or create API work',async t=>{
  const f=await fixture(t,async()=>result); await disableApiFallback(f.root);
  f.options.account=async()=>{throw Error('must not inspect');};
  assert.deepEqual(await f.run()(request(),new AbortController().signal),result);
  assert.deepEqual(f.counts(),{paid:0,prepared:0,subscriptionCalls:1});
});
test('corrupt optional config preserves successful subscription, blocks paid fallback',async t=>{
  const f=await fixture(t,async()=>result);
  await fs.writeFile(path.join(f.root,'config.json'),'{',{mode:0o600});
  assert.deepEqual(await f.run()(request(),new AbortController().signal),result);
  f.options.subscription=async()=>{throw quota();};
  await assert.rejects(f.run()(request(),new AbortController().signal),{code:'api_configuration_invalid'});
  assert.equal(f.counts().paid,0);
});
test('only verified quota triggers API; ordinary failures do not',async t=>{
  for(const code of ['claude_failed','cancelled','subscription_overage']) {
    const f=await fixture(t,async()=>{throw new BridgeError(403,code,'test');});
    await assert.rejects(f.run()(request(),new AbortController().signal),{code});assert.equal(f.counts().paid,0);
  }
});
test('quota fallback writes receipt, budgets actual cost, reuses quota without re-failing subscription',async t=>{
  const f=await fixture(t), run=f.run(), signal=new AbortController().signal;
  assert.deepEqual(await run(request(),signal),result);
  assert.deepEqual(await run(request('thread-2'),signal),result);
  assert.equal(f.counts().subscriptionCalls,1);assert.equal(f.counts().paid,2);
  assert.equal((await new FallbackStore(f.root).snapshot()).totalUsd,.02);
  const receipts=await fs.readdir(path.join(f.root,'receipts')); assert.equal(receipts.length,2);
  const receipt=JSON.parse(await fs.readFile(path.join(f.root,'receipts',receipts[0]!), 'utf8'));
  assert.equal(receipt.actual_model,model.resolvedModel);assert.equal(receipt.sdk_session_id,undefined);
});
test('account changes and missing client identity block generation',async t=>{
  const f=await fixture(t); f.options.account=async()=> 'b'.repeat(64);
  await assert.rejects(f.run()(request(),new AbortController().signal),{code:'api_account_changed'});
  assert.equal(f.counts().paid,0);
  const g=await fixture(t);
  await assert.rejects(g.run()(requestSchema.parse({model:model.id,input:'x'}),new AbortController().signal),{code:'api_step_identity_missing'});
  assert.equal(g.counts().paid,0);
});
test('duplicate logical step is not generated again and does not leak an extra reservation',async t=>{
  const f=await fixture(t), run=f.run(), signal=new AbortController().signal;
  await run(request(),signal);
  await assert.rejects(run(request(),signal),{code:'api_duplicate_step'});
  assert.equal(f.counts().paid,1);
  const snapshot=await new FallbackStore(f.root).snapshot();assert.equal(snapshot.totalUsd,.01);assert.equal(snapshot.unresolvedCount,0);
});
test('post-send error keeps reservation and never returns a retryable 502',async t=>{
  const f=await fixture(t); f.options.api=()=>({prepare:async()=>({model:model.resolvedModel,inputTokens:10,maxOutputTokens:1024,reservationUsd:.1,
    execute:async()=>{throw Error('remote error secret');}})});
  await assert.rejects(f.run()(request(),new AbortController().signal),e=>e instanceof BridgeError && e.status!==502 && !e.message.includes('secret'));
  const s=await new FallbackStore(f.root).snapshot();assert.equal(s.totalUsd,.1);assert.equal(s.unresolvedCount,1);
});
test('failed stream receipts keep safe diagnostics while unresolved charges and duplicate protection remain intact',async t=>{
  const f=await fixture(t);let sends=0;
  f.options.api=()=>({prepare:async()=>({model:model.resolvedModel,inputTokens:10,maxOutputTokens:1024,reservationUsd:.1,
    execute:async()=>{sends++;throw new BridgeError(424,'api_invalid_stream','Invalid stream',{
      request_id:'req_diagnostic',message_id:'msg_diagnostic',actual_model:model.resolvedModel,
      stream_reason:'multiple_decisions',stream_phase:'event',stream_event:'content_block_start',stream_block_index:'1',stream_block_type:'tool_use',
      prompt:'private-fixture-text',api_key:'private-fixture-key',arbitrary:'private-fixture-body'});}})});
  const run=f.run(),signal=new AbortController().signal;
  await assert.rejects(run(request(),signal),{code:'api_invalid_stream'});
  const firstFiles=await fs.readdir(path.join(f.root,'receipts'));
  const raw=await fs.readFile(path.join(f.root,'receipts',firstFiles[0]!),'utf8'),receipt=JSON.parse(raw);
  assert.equal(receipt.request_id,'req_diagnostic');assert.equal(receipt.message_id,'msg_diagnostic');
  assert.equal(receipt.actual_model,model.resolvedModel);
  assert.equal(receipt.diagnostics.stream_reason,'multiple_decisions');
  assert.equal(receipt.diagnostics.stream_event,'content_block_start');
  assert.equal(receipt.diagnostics.stream_block_index,'1');
  assert.doesNotMatch(raw,/private-fixture/);
  assert.equal(receipt.usage,null);assert.equal(receipt.cost_estimate_usd,null);
  assert.equal(receipt.inference_stage,'sent_outcome_unknown');
  await assert.rejects(run(request(),signal),{code:'api_duplicate_step'});
  assert.equal(sends,1);
  const snapshot=await new FallbackStore(f.root).snapshot();assert.equal(snapshot.totalUsd,.1);assert.equal(snapshot.unresolvedCount,1);
});
test('router timeout preserves the API identifiers already observed before cancellation',async t=>{
  const f=await fixture(t),controller=new AbortController();
  f.options.api=()=>({prepare:async()=>({model:model.resolvedModel,inputTokens:10,maxOutputTokens:1024,reservationUsd:.1,
    execute:async()=>{controller.abort(new BridgeError(504,'timeout','test timeout',{limit:'stall'}));
      throw new BridgeError(409,'api_aborted','Cancelled',{request_id:'req_timeout',message_id:'msg_timeout',actual_model:model.resolvedModel});}})});
  await assert.rejects(f.run()(request(),controller.signal),{code:'timeout'});
  const files=await fs.readdir(path.join(f.root,'receipts'));
  const receipt=JSON.parse(await fs.readFile(path.join(f.root,'receipts',files[0]!),'utf8'));
  assert.equal(receipt.code,'timeout');assert.equal(receipt.status,'failed');
  assert.equal(receipt.request_id,'req_timeout');assert.equal(receipt.message_id,'msg_timeout');
});
test('router deadline remains a timeout in the API receipt instead of a user cancellation',async t=>{
  const f=await fixture(t), controller=new AbortController();
  f.options.api=()=>({prepare:async()=>({model:model.resolvedModel,inputTokens:10,maxOutputTokens:1024,reservationUsd:.1,
    execute:async()=>{controller.abort(new BridgeError(504,'timeout','API idle limit'));throw new BridgeError(409,'api_aborted','cancelled');}})});
  await assert.rejects(f.run()(request(),controller.signal),{code:'timeout'});
  const files=await fs.readdir(path.join(f.root,'receipts'));
  const receipt=JSON.parse(await fs.readFile(path.join(f.root,'receipts',files[0]!), 'utf8'));
  assert.equal(receipt.code,'timeout');assert.equal(receipt.status,'failed');
  assert.equal((await new FallbackStore(f.root).snapshot()).unresolvedCount,1);
});
test('per-request budget and pre-send disable both prevent generation',async t=>{
  const f=await fixture(t);await saveApiConfig(f.root,{...config,perRequestLimitUsd:.05});
  await assert.rejects(f.run()(request(),new AbortController().signal),{code:'api_request_budget_exceeded'});assert.equal(f.counts().paid,0);
  const g=await fixture(t), original=g.options.api;
  g.options.api=c=>({prepare:async(...args:any[])=>{const p=await original(c).prepare();await disableApiFallback(g.root);return p;}});
  await assert.rejects(g.run()(request(),new AbortController().signal),{code:'api_fallback_disabled'});assert.equal(g.counts().paid,0);
});
test('expired quota probes subscription and successful recovery clears applicable state',async t=>{
  const f=await fixture(t,async()=>result), store=new FallbackStore(f.root);
  await store.recordQuota(account,[{type:'five_hour',resetsAt:Date.now()-1000}]);
  assert.deepEqual(await f.run()(request(),new AbortController().signal),result);
  assert.equal((await store.snapshot()).quotaAccountCount,0);assert.equal(f.counts().paid,0);
});
test('ordinary recovery failures never extend quota or cause the next step to become paid',async t=>{
  const f=await fixture(t,async()=>{throw new BridgeError(403,'subscription_overage','test');});
  const store=new FallbackStore(f.root);await store.recordQuota(account,[{type:'five_hour',resetsAt:Date.now()-1000}]);
  for(const identity of ['thread-1','thread-2']) await assert.rejects(f.run()(request(identity),new AbortController().signal),{code:'subscription_overage'});
  assert.equal(f.counts().subscriptionCalls,2);assert.equal(f.counts().paid,0);
});
test('cancellation while acquiring a probe releases the lease before a later request',async t=>{
  const f=await fixture(t,async()=>result), store=new FallbackStore(f.root), controller=new AbortController();
  await store.recordQuota(account,[{type:'five_hour',resetsAt:Date.now()-1000}]);
  const route=FallbackStore.prototype.route;let cancelOnce=true;
  FallbackStore.prototype.route=async function(...args) {const selected=await route.apply(this,args);if(cancelOnce&&selected.probeId){cancelOnce=false;controller.abort();}return selected;};
  t.after(()=>{FallbackStore.prototype.route=route;});
  await assert.rejects(f.run()(request(),controller.signal),{code:'cancelled'});
  assert.equal((await store.quotaStatus(account)).probePending,false);
  await f.run()(request('next-thread'),new AbortController().signal);
  assert.equal(f.counts().subscriptionCalls,1);assert.equal(f.counts().paid,0);
});
test('successful SDK result from a different account cannot clear the original quota',async t=>{
  const f=await fixture(t,async()=>result), store=new FallbackStore(f.root);
  f.options.resultAccount=()=> 'b'.repeat(64);
  await store.recordQuota(account,[{type:'five_hour',resetsAt:Date.now()-1000}]);
  await f.run()(request(),new AbortController().signal);
  assert.equal((await store.snapshot()).quotaAccountCount,1);assert.equal(f.counts().paid,0);
});
test('damaged ledger does not prevent successful subscription',async t=>{
  const f=await fixture(t,async()=>result);
  await fs.writeFile(path.join(f.root,'fallback-store.json'),'{',{mode:0o600});
  assert.deepEqual(await f.run()(request(),new AbortController().signal),result);assert.equal(f.counts().paid,0);
});
test('concurrent duplicate requests can generate only one paid result',async t=>{
  const f=await fixture(t), run=f.run(), signal=new AbortController().signal;
  const outcomes=await Promise.allSettled([run(request(),signal),run(request(),signal)]);
  assert.equal(outcomes.filter(o=>o.status==='fulfilled').length,1);assert.equal(f.counts().paid,1);
  assert.equal((await new FallbackStore(f.root).snapshot()).totalUsd,.01);
});
test('server compaction does not retry an uncertain paid failure; authenticated HTTP carries identity',async t=>{
  const f=await fixture(t);let sends=0;
  f.options.api=()=>({prepare:async()=>({model:model.resolvedModel,inputTokens:10,maxOutputTokens:1024,reservationUsd:.1,
    execute:async()=>{sends++;throw new Error('stream lost');}})});
  const server=bridgeServer({token:'test',run:f.run()});server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>{server.closeAllConnections();server.close();});
  const req={model:model.id,input:'hi',client_metadata:{'x-codex-turn-metadata':JSON.stringify({request_kind:'compaction'})}};
  const response=await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/responses`,{method:'POST',
    headers:{authorization:'Bearer test','content-type':'application/json','thread-id':'test-chat'},body:JSON.stringify(req)});
  const text=await response.text();assert.match(text,/response.failed/);assert.doesNotMatch(text,/response.completed/);assert.equal(sends,1);
});

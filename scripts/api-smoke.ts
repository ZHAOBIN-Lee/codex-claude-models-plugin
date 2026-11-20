// Explicit opt-in, three small official API calls. Separate durable US$1 cumulative test ledger;
// this command never enables paid fallback for the running router or edits subscription login.
import {createHash} from 'node:crypto';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {locations, readState} from '../src/setup.js';
import {readApiCredentials, saveApiConfig} from '../src/api-settings.js';
import {createApiRunner} from '../src/api-runner.js';
import {fallbackRunner} from '../src/fallback.js';
import {API_PRICES} from '../src/api-pricing.js';
import {SubscriptionQuotaError} from '../src/subscription-limits.js';
import {attachStepIdentity} from '../src/paid-step-guard.js';
import {requestSchema} from '../src/contracts.js';
import {FallbackStore} from '../src/fallback-store.js';

async function main() {
  if (!process.argv.includes('--run')) throw new Error('Use --run only after authorizing up to US$1 in cumulative API test usage.');
  const flag=process.argv.indexOf('--codex-home'), p=locations(flag<0?undefined:process.argv[flag+1]);
  const credentialsRoot=path.join(p.root,'api');
  const root=path.join(credentialsRoot,'validation');
  const state=await readState(p), model=state.models.find(m=>m.resolvedModel==='claude-sonnet-5-5');
  if(!model) throw new Error('The installed catalog has no verified Sonnet 5.5 model.');
  const account=createHash('sha256').update('api-validation-synthetic-quota-not-a-real-account').digest('hex');
  await saveApiConfig(root,{schema_version:1,enabled:true,dailyLimitUsd:1,totalLimitUsd:1,perRequestLimitUsd:.25,
    maxOutputTokens:1024,confirmedSubscriptionAccount:account,cache:'5m'});
  const run=fallbackRunner({root,models:[model],account:async()=>account,
    subscription:async()=>{throw new SubscriptionQuotaError(account,[{type:'five_hour',resetsAt:Date.now()+300000}]);},
    api:config=>createApiRunner({credentials:()=>readApiCredentials(credentialsRoot),maxOutputTokens:config.maxOutputTokens,cache:config.cache,prices:API_PRICES})});
  const prefix=Array.from({length:100},(_,i)=>`Reference ${i+1}: Keep the original context. Return the requested short decision; no external action is needed.`).join('\n');
  for(let i=0;i<3;i++) {
    const req=requestSchema.parse({model:model.id,reasoning:{effort:'low'},
      instructions:'This is a bounded adapter smoke test. Use codex_decision to return the requested final decision.',
      input:[{role:'user',content:prefix},{role:'user',content:i<2?'Return the exact text API_SMOKE_OK and no calls.':'Request exactly one echo_value function call with value API_TOOL_OK. Do not execute it.'}],
      tools:i<2?[]:[{type:'function',name:'echo_value',description:'Return a supplied test value.',parameters:{type:'object',properties:{value:{type:'string'}},required:['value'],additionalProperties:false}}],
      ...(i===2?{tool_choice:'required'}:{})});
    attachStepIdentity(req,{'thread-id':`api-validation-${Date.now()}-${i}`});
    const signal=AbortSignal.timeout(90000);
    const result=await run(req,signal);
    if(i<2 && result.decision.text.trim()!=='API_SMOKE_OK') throw new Error('Text smoke produced an unexpected decision.');
    if(i===2 && (result.decision.calls.length!==1 || result.decision.calls[0]?.name!=='echo_value' || JSON.parse(result.decision.calls[0].input).value!=='API_TOOL_OK')) throw new Error('Tool smoke produced an unexpected decision.');
    console.log(JSON.stringify({test:i<2?'text_and_cache':'tool_decision',index:i+1,status:'complete',usage:result.usage}));
  }
  console.log(JSON.stringify({budget:await new FallbackStore(root).snapshot()}));
  const files=await fs.readdir(path.join(root,'receipts'));
  for(const file of files.filter(f=>f.endsWith('.json'))) {
    const r=JSON.parse(await fs.readFile(path.join(root,'receipts',file),'utf8'));
    console.log(JSON.stringify({receipt:file,status:r.status,model:r.actual_model,request_id:r.request_id,message_id:r.message_id,
      cost_estimate_usd:r.cost_estimate_usd,usage:r.usage,simulation:'subscription_quota_only'}));
  }
}
main().catch(error=>{console.error(error instanceof Error?error.message:'API smoke failed.');process.exitCode=1;});

// SPDX-License-Identifier: GPL-3.0-or-later
// Explicit diagnostic: two synthetic requests, no tool execution, no credential persistence.
import fs from 'node:fs';
import path from 'node:path';
import { ProviderClient, addUser } from '../gateway/src/providers.mjs';
const chunks=[];let length=0;for await(const c of process.stdin){length+=c.length;if(length>8192)throw new Error('Input too large');chunks.push(c);}
const input=JSON.parse(Buffer.concat(chunks));
if(input.baseUrl!=='https://worldclawpro.ai/v1'||typeof input.apiKey!=='string')throw new Error('Unexpected target');
const report={endpoint:input.baseUrl,model:'gpt-5.5',test:'Two synthetic protocol diagnostics; no tools executed',results:[]};
for(const mode of ['responses','anthropic']){
 const item={protocol:mode,events:[],types:{}};report.results.push(item);let wirePromise=Promise.resolve();
 const client=new ProviderClient({timeoutMs:60000,fetchImpl:async(...args)=>{
  const r=await fetch(...args);item.httpStatus=r.status;item.contentType=r.headers.get('content-type');
  if(r.ok)wirePromise=(async()=>{
   let text='';const copy=r.clone();
   for await(const chunk of copy.body){text+=Buffer.from(chunk).toString();if(text.length>2*1024*1024)break;}
   for(const block of text.split(/\r?\n\r?\n/)){
    const data=block.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trim()).join('\n');
    if(!data||data==='[DONE]')continue;
    try{const e=JSON.parse(data);const type=e.type||'unknown';item.types[type]=(item.types[type]||0)+1;
     if(item.events.length<50&&(/completed|done|start|failed|error|incomplete/.test(type))){
      item.events.push({type,outputIndex:e.output_index,itemType:e.item?.type,itemName:e.item?.name,
       responseStatus:e.response?.status,outputTypes:e.response?.output?.map(x=>x.type),
       outputTextTypes:e.response?.output?.map(x=>x.content?.map(c=>c.type)),
       stopReason:e.delta?.stop_reason||e.message?.stop_reason});
     }
    }catch{}
   }
  })().catch(()=>{item.wireCapture='incomplete';});
  return r;
 }});
 const history=[];addUser(history,mode,'This is a minimal tool protocol test in an empty workspace. Make exactly one list_files function call with path set to a single dot. Do not answer with text. No shell, writes or other actions are requested.');
 try{const r=await client.round({mode,model:'gpt-5.5',baseUrl:input.baseUrl,apiKey:input.apiKey,maxOutputTokens:1024},history,AbortSignal.timeout(90000));
  item.parsedCalls=r.calls.map(c=>({name:c.name,arguments:c.arguments}));item.parsedText=r.text.slice(0,300);item.usage=r.usage;item.status=r.calls.some(c=>c.name==='list_files')?'TOOL_CALL_RECEIVED':'NO_TOOL_CALL';
 }catch(e){item.status='FAILED';item.error={code:e.code||'ERROR',message:String(e.message).slice(0,250)};}
 await wirePromise;
}
const safe=JSON.stringify(report,null,2).replaceAll(input.apiKey,'[REDACTED]');
fs.mkdirSync(path.dirname(process.argv[2]),{recursive:true});fs.writeFileSync(process.argv[2],safe+'\n');console.log(safe);

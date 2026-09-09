// SPDX-License-Identifier: GPL-3.0-or-later
// Explicit, bounded real endpoint test. Credentials arrive on stdin, never argv or Git.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProviderClient, addUser, addResults } from '../gateway/src/providers.mjs';
import { WorkspaceTools } from '../gateway/src/tools.mjs';
const chunks=[];let bytes=0;for await(const chunk of process.stdin){bytes+=chunk.length;if(bytes>8192)throw new Error('Input too large');chunks.push(chunk);}
const input=JSON.parse(Buffer.concat(chunks).toString());
if(input.baseUrl!=='https://worldclawpro.ai/v1'||typeof input.apiKey!=='string'||input.apiKey.length<20)throw new Error('Invalid authorized test target');
const output=process.argv[2];if(!output)throw new Error('Output path required');
const report={endpoint:input.baseUrl,scope:'Small synthetic live model tests on CI Linux; NOT Android/Gunyah',protocols:[]};
const safeError=e=>({code:typeof e.code==='string'?e.code:'REQUEST_FAILED',message:String(e.message||'Request failed').replaceAll(input.apiKey,'[REDACTED]').slice(0,250)});
let models=[];
try{
 const r=await fetch(input.baseUrl+'/models',{headers:{Authorization:'Bearer '+input.apiKey},signal:AbortSignal.timeout(30000),redirect:'error'});
 report.modelListStatus=r.status;
 if(r.ok){let data='';for await(const b of r.body){data+=Buffer.from(b).toString();if(data.length>2*1024*1024)throw new Error('Models response too large');}
 models=JSON.parse(data).data?.map(x=>x.id).filter(x=>typeof x==='string'&&/^[A-Za-z0-9._:/+-]{1,100}$/.test(x))||[];
 report.models=models.slice(0,80);
 }else await r.body?.cancel();
}catch(e){report.modelListError=safeError(e);}
function choose(mode){
 const candidates=models.filter(x=>mode==='anthropic'?/claude/i.test(x):/gpt|qwen|deepseek|gemini/i.test(x));
 const score=id=>(/mini|flash|haiku/i.test(id)?20:0)+(/gpt/i.test(id)?8:0)-(/pro|opus|sol/i.test(id)?10:0);
 return candidates.sort((a,b)=>score(b)-score(a)||a.localeCompare(b))[0];
}
for(const mode of ['responses','chat-completions','anthropic']){
 const model=choose(mode);const result={protocol:mode,model:model||null,requests:0,executed:[],streamed:false};report.protocols.push(result);
 if(!model){result.status='NO_SUITABLE_MODEL_DISCOVERED';continue;}
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'agbot-live-'));fs.chmodSync(home,0o700);
 const tools=new WorkspaceTools(home,{home});const history=[];
 const client=new ProviderClient({timeoutMs:60000,fetchImpl:async(...args)=>{++result.requests;const r=await fetch(...args);result.httpStatus=r.status;if((r.headers.get('content-type')||'').includes('text/event-stream'))result.streamed=true;return r;}});
 const profile={mode,model,baseUrl:input.baseUrl,apiKey:input.apiKey,maxOutputTokens:768};
 addUser(history,mode,'Synthetic integration test in an EMPTY temporary workspace. You have permission to propose the following two actions; the test approval gate will approve only them. Use write_file to create main.py with EXACT content print("AGBOT_LIVE_OK") followed by a newline. Then use shell with EXACT command python3 main.py and cwd . . After observing its actual output, reply with AGBOT_LIVE_OK. Do not use other commands, create other files or install anything. Read/list of this workspace is allowed.');
 try{
  for(let round=0;round<5;round++){
   const response=await client.round(profile,history,AbortSignal.timeout(90000));
   if(!response.calls.length){result.finalAcknowledged=response.text.includes('AGBOT_LIVE_OK');break;}
   const results=[];
   for(const call of response.calls){
    try{
     const p=tools.prepare(call),a=p.arguments;
     const allowed=(p.name==='write_file'&&a.path==='main.py'&&a.content==='print("AGBOT_LIVE_OK")\n')||
       (p.name==='shell'&&a.command==='python3 main.py'&&a.cwd==='.')||
       (p.name==='list_files'&&a.path==='.')||(p.name==='read_file'&&a.path==='main.py');
     if(!allowed){results.push({id:call.id,content:'Test approval denied: only the exact requested main.py and command are allowed.',error:true});continue;}
     const value=await tools.execute(p,{signal:AbortSignal.timeout(10000),emit:()=>{}});
     result.executed.push({name:p.name,exitCode:value.exitCode??null,outputMarker:typeof value.output==='string'&&value.output.includes('AGBOT_LIVE_OK')});
     results.push({id:call.id,content:JSON.stringify(value)});
    }catch(e){results.push({id:call.id,content:'Tool failed: '+(e.code||'ERROR'),error:true});}
   }
   addResults(history,mode,results);
  }
  result.fileVerified=fs.existsSync(path.join(home,'main.py'))&&fs.readFileSync(path.join(home,'main.py'),'utf8')==='print("AGBOT_LIVE_OK")\n';
  result.status=result.fileVerified&&result.executed.some(x=>x.name==='shell'&&x.exitCode===0&&x.outputMarker)&&result.finalAcknowledged?'PASSED':'INCOMPLETE';
 }catch(e){result.status='FAILED';result.error=safeError(e);}
 finally{fs.rmSync(home,{recursive:true,force:true});}
}
const safeReport=JSON.stringify(report,null,2).replaceAll(input.apiKey,'[REDACTED]');
fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,safeReport+'\n');
console.log(safeReport);

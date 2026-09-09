#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Real cloud-image/NoCloud/installer/agent smoke in QEMU, NOT a phone Gunyah test.
Private seed, TLS keys and tokens remain in a disposable temp directory, not evidence.
"""
import argparse, base64, hashlib, hmac, http.client, http.server, json, os, secrets, shutil, socket, ssl
import subprocess, sys, tempfile, threading, time, urllib.request, uuid
from pathlib import Path
from seed_config import create
ROOT=Path(__file__).resolve().parents[1]

def run(*args, **kw):
    return subprocess.run(list(map(str,args)),check=True,**kw)

def download(url,destination,digest):
    with urllib.request.urlopen(url,timeout=45) as stream,destination.open('wb') as out:
        h=hashlib.sha256();total=0
        while chunk:=stream.read(1048576):
            total+=len(chunk)
            if total>512*1048576:raise RuntimeError('image too large')
            h.update(chunk);out.write(chunk)
    if h.hexdigest()!=digest:raise RuntimeError('image SHA-256 mismatch')

def port():
    with socket.socket() as s:s.bind(('127.0.0.1',0));return s.getsockname()[1]

class Fixture(http.server.BaseHTTPRequestHandler):
    def log_message(self,*args):pass
    def do_POST(self):
        size=int(self.headers.get('Content-Length',0))
        if size>1024*1024:self.send_error(413);return
        try:
            value=json.loads(self.rfile.read(size));messages=value['messages']
            user=next(m['content'] for m in messages if m['role']=='user')
            results=[m for m in messages if m['role']=='tool']
            call=None
            if user=='WORK' and not results:call=('write_file',{'path':'main.py','content':'print("AGBOT_VM_OK")\n'})
            elif user=='WORK' and len(results)==1:call=('shell',{'command':'python3 main.py','cwd':'.'})
            elif user=='REFUSE' and not results:call=('write_file',{'path':'forbidden.txt','content':'must not be written'})
            elif user=='STOP' and not results:call=('shell',{'command':'sleep 120','cwd':'.'})
            msg={'role':'assistant','content':'Fixture finished; inspect actual tool output.'}
            finish='stop'
            if call:
                msg['content']=None;msg['tool_calls']=[{'id':'fixture-'+str(len(results)), 'type':'function','function':{'name':call[0],'arguments':json.dumps(call[1])}}];finish='tool_calls'
            data=json.dumps({'choices':[{'index':0,'message':msg,'finish_reason':finish}]}).encode()
            self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
        except Exception:self.send_error(400)

def proof_pin(log,instance,token):
    import re
    matches=re.findall(r'AGBOT_READY_V1 ([0-9a-f-]{36}) ([0-9a-f]{64}) ([0-9a-f]{64})',log)
    for ident,pin,mac in reversed(matches):
        expected=hmac.new(token.encode(),f'AGBOT_READY_V1\n{ident}\n{pin}'.encode(),hashlib.sha256).hexdigest()
        if ident==instance and hmac.compare_digest(mac,expected):return pin
    return None

class Guest:
    def __init__(self,port,token,pin):self.port,self.token,self.pin=port,token,pin
    def request(self,method,route,body=None):
        # Test client verifies the exact authenticated fingerprint BEFORE sending a bearer.
        context=ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT);context.check_hostname=False;context.verify_mode=ssl.CERT_NONE
        c=http.client.HTTPSConnection('127.0.0.1',self.port,context=context,timeout=60)
        try:
            c.connect()
            if not hmac.compare_digest(hashlib.sha256(c.sock.getpeercert(binary_form=True)).hexdigest(),self.pin):raise RuntimeError('TLS pin mismatch')
            headers={'Authorization':'Bearer '+self.token,'Content-Type':'application/json'}
            c.request(method,route,None if body is None else json.dumps(body),headers);r=c.getresponse();data=r.read(8*1024*1024)
            if r.status>=300:raise RuntimeError('Guest HTTP '+str(r.status))
            return json.loads(data)
        finally:c.close()

def main(arch,output):
    output.mkdir(parents=True,exist_ok=True)
    result={'arch':arch,'test':'QEMU cloud-image integration, NOT Gunyah','cloudModel':'controlled TLS fixture; not a real account','checks':[]}
    with tempfile.TemporaryDirectory(prefix='agbot-guest-') as tmp:
        work=Path(tmp);os.chmod(work,0o700);token=secrets.token_urlsafe(32);instance=str(uuid.uuid4());mac='02:aa:bb:cc:dd:01'
        create(work/'seed',instance,token,mac)
        # Only this CI seed installs a CA for a test-only model endpoint. Production seeds do not.
        key=work/'fixture.key';cert=work/'fixture.crt'
        run('openssl','req','-x509','-newkey','rsa:2048','-nodes','-sha256','-days','1','-subj','/CN=Agbot CI fixture','-addext','subjectAltName=IP:10.0.2.2','-keyout',key,'-out',cert,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        config=json.loads((work/'seed/user-data').read_text().split('\n',1)[1])
        config['write_files'] += [{'path':'/etc/agbot-ci-fixture.crt','permissions':'0644','content':cert.read_text()},
            {'path':'/etc/systemd/system/agbot.service.d/ci-fixture.conf','permissions':'0644','content':'[Service]\nEnvironment=NODE_EXTRA_CA_CERTS=/etc/agbot-ci-fixture.crt\n'}]
        (work/'seed/user-data').write_text('#cloud-config\n'+json.dumps(config))
        fixture=http.server.ThreadingHTTPServer(('0.0.0.0',0),Fixture)
        tls=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);tls.load_cert_chain(cert,key);fixture.socket=tls.wrap_socket(fixture.socket,server_side=True)
        threading.Thread(target=fixture.serve_forever,daemon=True).start()
        javac=work/'java';javac.mkdir();java=ROOT/'android-overlay/app/src/main/java/app/agbot/android'
        run('javac','-d',javac,java/'SeedDisk.java',ROOT/'scripts/SeedHarness.java')
        run('java','-cp',javac,'SeedHarness',work/'seed.img',work/'seed')
        run('fsck.vfat','-n',work/'seed.img')
        result['checks'].append('same-Java-FAT16-writer/fsck.vfat')
        lock=json.loads((ROOT/'guest/images.lock.json').read_text());image=lock[arch]
        print('Downloading pinned '+arch+' image',flush=True)
        download(lock['baseUrl']+image['file'],work/'source.img',image['sha256'])
        result['imageSha256']=image['sha256'];result['checks'].append('pinned-image-sha256')
        run('qemu-img','convert','-f','qcow2','-O','qcow2',work/'source.img',work/'root.qcow2')
        run('qemu-img','resize',work/'root.qcow2','12G')
        listen=port();serial=work/'serial.log';qmp=work/'qmp.sock'
        if arch=='amd64':
            code=Path('/usr/share/OVMF/OVMF_CODE_4M.fd');var=Path('/usr/share/OVMF/OVMF_VARS_4M.fd')
            accel='kvm' if os.access('/dev/kvm',os.R_OK|os.W_OK) else 'tcg'
            command=['qemu-system-x86_64','-machine','q35,accel='+accel,'-cpu','host' if accel=='kvm' else 'max']
        else:
            code=Path('/usr/share/AAVMF/AAVMF_CODE.fd');var=Path('/usr/share/AAVMF/AAVMF_VARS.fd')
            command=['qemu-system-aarch64','-machine','virt,accel=tcg','-cpu','cortex-a72']
        shutil.copyfile(var,work/'vars.fd')
        command+=['-smp','2','-m','2048','-display','none','-serial','file:'+str(serial),'-qmp','unix:'+str(qmp)+',server=on,wait=off',
            '-drive',f'if=pflash,format=raw,readonly=on,file={code}', '-drive',f'if=pflash,format=raw,file={work}/vars.fd',
            '-drive',f'if=virtio,format=qcow2,file={work}/root.qcow2','-drive',f'if=virtio,format=raw,readonly=on,file={work}/seed.img',
            '-device',f'virtio-net-pci,netdev=n1,mac={mac}','-netdev',f'user,id=n1,hostfwd=tcp:127.0.0.1:{listen}-:8765']
        vm=None
        def boot():
            if qmp.exists():qmp.unlink()
            return subprocess.Popen(command,stdout=subprocess.DEVNULL,stderr=(work/'qemu.log').open('ab'))
        def ready(timeout):
            deadline=time.monotonic()+timeout;last=0
            while time.monotonic()<deadline:
                if vm.poll() is not None:raise RuntimeError('QEMU exited before enrollment')
                log=serial.read_text(errors='replace') if serial.exists() else ''
                pin=proof_pin(log,instance,token)
                if pin:
                    try:
                        guest=Guest(listen,token,pin);health=guest.request('GET','/v1/health')
                        if health.get('ok') and health.get('instanceId')==instance and health.get('uid',0)!=0:return guest,health
                    except Exception:pass
                if time.monotonic()-last>30:
                    import re
                    stages=re.findall(r'AGBOT_SETUP_V1 [A-Z_]+',log);print('Waiting for guest: '+(stages[-1] if stages else 'boot/cloud-init'),flush=True);last=time.monotonic()
                time.sleep(3)
            raise RuntimeError('Guest enrollment timed out; inspect sanitized serial evidence')
        try:
            vm=boot();guest,health=ready(1400 if arch=='arm64' else 1100)
            result['health']=health;result['checks']+=['Linux-boot','cloud-init-seed','real-runtime-installer','official-Codex-binary-version-check','HMAC-enrollment','pinned-HTTPS-health','non-root-gateway']
            account=guest.request('GET','/v1/codex/account')
            result['codexAccountPresent']=account.get('account') is not None
            result['checks'].append('real-official-Codex-app-server-account-RPC-not-OAuth-login')
            print('Guest ready; executing controlled agent tasks',flush=True)
            profile={'mode':'chat-completions','model':'ci-fixture','baseUrl':f'https://10.0.2.2:{fixture.server_port}/v1','apiKey':'TEST_ONLY_NOT_A_REAL_KEY','maxOutputTokens':256}
            def task(prompt,decision=True,stop=False):
                session=guest.request('POST','/v1/sessions',{'title':'CI '+prompt,'workspaceName':'ci','mode':'chat-completions','model':'ci-fixture'})
                ident=session['id'];guest.request('POST',f'/v1/sessions/{ident}/turns',{'prompt':prompt,'profile':profile,'requestId':str(uuid.uuid4())})
                approvals=set();deadline=time.monotonic()+150;stop_sent=False
                while time.monotonic()<deadline:
                    state=guest.request('GET',f'/v1/sessions/{ident}')
                    for pending in state.get('pending',[]):
                        if pending['id'] not in approvals:
                            guest.request('POST',f'/v1/sessions/{ident}/approvals/'+pending['id'],{'allow':decision});approvals.add(pending['id'])
                    if stop and approvals and not stop_sent:
                        time.sleep(1);guest.request('POST',f'/v1/sessions/{ident}/stop',{});stop_sent=True
                    if state.get('status') in ('completed','failed','cancelled','interrupted'):
                        return ident,state,len(approvals)
                    time.sleep(.5)
                raise RuntimeError('Agent task timed out')
            ident,state,approvals=task('WORK')
            result['workStatus']=state.get('status');result['workApprovals']=approvals
            if approvals!=2 or state.get('status')!='completed' or not any(e['type']=='tool.completed' and e['data'].get('name')=='shell' and e['data']['result'].get('exitCode')==0 and 'AGBOT_VM_OK' in e['data']['result'].get('output','') for e in state['events']):raise RuntimeError('Real write/Python result was not observed')
            file=guest.request('GET',f'/v1/sessions/{ident}/files?path=main.py&read=1')
            result['file']=file;result['checks']+=['approved-file-write','real-python-execution','tool-result-roundtrip']
            _,refused,_=task('REFUSE',False)
            listing=guest.request('GET',f'/v1/sessions/{ident}/files?path=.');assert 'forbidden.txt' not in json.dumps(listing)
            result['checks'].append('declined-write-not-executed')
            _,stopped,_=task('STOP',stop=True);result['stopStatus']=stopped.get('status');assert stopped.get('status')=='cancelled';result['checks'].append('active-task-stop')
            # Request orderly shutdown via emulated power button, not a filesystem reset.
            with socket.socket(socket.AF_UNIX) as c:
                c.settimeout(15);c.connect(str(qmp));f=c.makefile('rwb');f.readline()
                f.write(b'{"execute":"qmp_capabilities"}\r\n');f.flush();f.readline()
                f.write(b'{"execute":"system_powerdown"}\r\n');f.flush()
            vm.wait(timeout=90);vm=boot();guest,health=ready(240)
            resumed=guest.request('GET',f'/v1/sessions/{ident}');again=guest.request('GET',f'/v1/sessions/{ident}/files?path=main.py&read=1')
            assert file==again
            result['checks']+=['orderly-reboot','persistent-workspace','persistent-session','repeat-enrollment']
            result['ok']=True
        finally:
            if vm and vm.poll() is None:vm.terminate()
            if vm:
                try:vm.wait(timeout=20)
                except subprocess.TimeoutExpired:vm.kill();vm.wait()
            fixture.shutdown()
            for name in ('serial.log','qemu.log'):
                p=work/name
                if p.exists():(output/name).write_text(p.read_text(errors='replace').replace(token,'[REDACTED]')[-800000:])
            (output/'result.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(result,indent=2),flush=True)

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--arch',choices=['amd64','arm64'],default='amd64');p.add_argument('--output',type=Path,required=True);args=p.parse_args()
    main(args.arch,args.output)

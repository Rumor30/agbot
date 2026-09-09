#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Produce CI NoCloud seeds using production assets; CI-only error log hook is explicit."""
import argparse, base64, hashlib, json
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
from package_guest import archive_bytes
ROOT=Path(__file__).resolve().parents[1]
SERVICE='''[Unit]
Description=Agbot dedicated Computer provisioning
After=network-online.target cloud-final.service
Wants=network-online.target
[Service]
Type=oneshot
ExecStart=/usr/bin/python3 /usr/local/sbin/agbot-seed-bootstrap.py
ExecStopPost=/usr/bin/python3 /usr/local/sbin/agbot-ci-diagnostics.py
Restart=on-failure
RestartSec=30
TimeoutStartSec=25min
UMask=0077
[Install]
WantedBy=multi-user.target
'''
DIAGNOSTICS='''import os, json, re
from pathlib import Path
if os.environ.get('SERVICE_RESULT') != 'success':
    p=Path('/var/lib/agbot-bootstrap/install.log')
    text=p.read_text(errors='replace')[-12000:] if p.exists() else 'No installer log'
    seed=Path('/var/lib/agbot-bootstrap/seed.json')
    if seed.exists():
        token=json.loads(seed.read_text()).get('bridgeToken','')
        if token:text=text.replace(token,'[REDACTED]')
    text=re.sub(r'(?s)-----BEGIN .*?PRIVATE KEY-----.*?-----END .*?PRIVATE KEY-----','[PRIVATE KEY REDACTED]',text)
    with open('/dev/console','w') as out:out.write('AGBOT_CI_INSTALL_DIAGNOSTICS\\n'+text+'\\nAGBOT_CI_DIAGNOSTICS_END\\n')
'''
def user_data(script):
    return '#cloud-config\n' + json.dumps({'ssh_pwauth':False,'disable_root':True,'write_files':[
        {'path':'/usr/local/sbin/agbot-seed-bootstrap.py','permissions':'0700','encoding':'b64','content':base64.b64encode(script).decode()},
        {'path':'/etc/systemd/system/agbot-bootstrap.service','permissions':'0644','content':SERVICE},
        {'path':'/usr/local/sbin/agbot-ci-diagnostics.py','permissions':'0700','content':DIAGNOSTICS}],
        'runcmd':[['systemctl','daemon-reload'],['systemctl','enable','agbot-bootstrap.service'],['systemctl','start','--no-block','agbot-bootstrap.service']]})+'\n'
def create(out,instance,token,mac=None):
    out.mkdir(parents=True,exist_ok=True); payload=archive_bytes(ROOT)
    (out/'payload.tgz').write_bytes(payload)
    (out/'user-data').write_text(user_data((ROOT/'guest/seed_bootstrap.py').read_bytes()))
    (out/'meta-data').write_text(json.dumps({'instance-id':instance,'local-hostname':'agbot-computer'}))
    (out/'agbot.json').write_text(json.dumps({'schema':1,'instanceId':instance,'bridgeToken':token,'payloadSha256':hashlib.sha256(payload).hexdigest()}))
    (out/'agbot.json').chmod(0o600)
    if mac:(out/'network-config').write_text(json.dumps({'version':2,'ethernets':{'agbot0':{'match':{'macaddress':mac},'dhcp4':True,'dhcp6':False}}}))
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('output',type=Path);p.add_argument('--instance',required=True);p.add_argument('--token-file',type=Path,required=True);p.add_argument('--mac');a=p.parse_args();create(a.output,a.instance,a.token_file.read_text().strip(),a.mac)

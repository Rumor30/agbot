# SPDX-License-Identifier: GPL-3.0-or-later
import base64, hashlib, hmac, importlib.util, io, json, os, struct, subprocess, sys, tarfile, tempfile, unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts'))
from seed_config import user_data, create

def module(name,path):
    spec=importlib.util.spec_from_file_location(name,path);obj=importlib.util.module_from_spec(spec);spec.loader.exec_module(obj);return obj
bootstrap=module('seed_bootstrap',ROOT/'guest/seed_bootstrap.py')
enroll=module('guest_enroll',ROOT/'guest/enroll.py')

class SeedTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp=tempfile.TemporaryDirectory();cls.classes=Path(cls.tmp.name)/'classes';cls.classes.mkdir()
        java=ROOT/'android-overlay/app/src/main/java/app/agbot/android'
        subprocess.run(['javac','-d',str(cls.classes),str(java/'SeedDisk.java'),str(java/'Enrollment.java'),str(ROOT/'scripts/SeedHarness.java')],check=True)
    @classmethod
    def tearDownClass(cls):cls.tmp.cleanup()
    def test_real_java_fat_seed_preserves_cloudinit_names_and_payload(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);seed=root/'seed';out=root/'cidata.img'
            token='A'*43;instance='12345678-abcd-abcd-abcd-123456789012'
            create(seed,instance,token,'02:12:34:56:78:01')
            subprocess.run(['java','-cp',str(self.classes),'SeedHarness',str(out),str(seed)],check=True)
            data=out.read_bytes();self.assertEqual(len(data),8*1024*1024);self.assertEqual(data[43:54],b'CIDATA     ')
            self.assertEqual(data[510:512],b'\x55\xaa')
            self.assertEqual(data[512:512+32768],data[512+32768:512+65536])
            names={};parts={}
            for o in range(129*512,161*512,32):
                row=data[o:o+32]
                if row[0]==0:break
                if row[11]==8:continue
                if row[11]==15:
                    chars=b''.join(row[n:n+2] for n in (1,3,5,7,9,14,16,18,20,22,24,28,30))
                    parts[row[0]&31]=chars.decode('utf-16-le');continue
                name=''.join(parts[i] for i in sorted(parts)).split('\0')[0];parts={}
                cluster=struct.unpack_from('<H',row,26)[0];size=struct.unpack_from('<I',row,28)[0];chunks=[];seen=set()
                while cluster and cluster<0xfff8:
                    self.assertNotIn(cluster,seen);seen.add(cluster)
                    offset=(161+cluster-2)*512;chunks.append(data[offset:offset+512]);cluster=struct.unpack_from('<H',data,512+2*cluster)[0]
                names[name]=b''.join(chunks)[:size]
            self.assertEqual(set(names),{x.name for x in seed.iterdir()})
            for name,content in names.items():self.assertEqual(content,(seed/name).read_bytes())
            self.assertNotIn(token,names['user-data'].decode());self.assertNotIn(token,names['meta-data'].decode())
            cfg=json.loads(names['user-data'].decode().split('\n',1)[1])
            self.assertEqual(base64.b64decode(cfg['write_files'][0]['content']), (ROOT/'guest/seed_bootstrap.py').read_bytes())
    def test_hmac_is_instance_and_pin_bound(self):
        instance='12345678-abcd-abcd-abcd-123456789012';pin='f'*64;token='A'*43
        expected=hmac.new(token.encode(),f'AGBOT_READY_V1\n{instance}\n{pin}'.encode(),hashlib.sha256).hexdigest()
        self.assertEqual(enroll.proof(instance,pin,token),expected)
        self.assertNotEqual(enroll.proof(instance,'e'*64,token),expected)
        self.assertNotEqual(enroll.proof('0'*36,pin,token),expected)
    def test_rejects_malformed_seed(self):
        for seed in [None,{}, {'schema':1,'instanceId':'../../etc'}, {'schema':1,'instanceId':'1'*36,'bridgeToken':'A'*43,'payloadSha256':'f'*64}]:
            with self.assertRaises(ValueError):bootstrap.validate_seed(seed)
    def test_extract_rejects_symlinks_and_traversal(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            for name,sym in [('../outside',False),('/etc/test',False),('agbot-guest/link',True)]:
                tarpath=root/'bad.tgz'
                with tarfile.open(tarpath,'w:gz') as t:
                    item=tarfile.TarInfo(name)
                    if sym:item.type=tarfile.SYMTYPE;item.linkname='/etc'
                    t.addfile(item,io.BytesIO())
                with self.assertRaises(ValueError):bootstrap.extract_payload(tarpath,root/'unpack')
                self.assertFalse((root/'outside').exists())

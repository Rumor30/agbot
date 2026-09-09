# SPDX-License-Identifier: GPL-3.0-or-later
"""Tests use a synthetic upstream fixture, NOT an Android compilation or device boot."""
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
import xml.etree.ElementTree as ET
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from prepare_android import apply, transform_gradle, transform_manifest, STATE, ANDROID
from package_guest import archive_bytes

GRADLE = '''android {
    namespace = "cn.classfun.droidvm"
    defaultConfig {
        applicationId = "cn.classfun.droidvm"
        versionCode = generatedVersionCode
        versionName = generatedVersionName
    }
}
'''
MANIFEST = '''<manifest xmlns:android="http://schemas.android.com/apk/res/android">
<uses-permission android:name="android.permission.INTERNET"/>
<application android:name=".DroidVMApp" android:allowBackup="true" android:usesCleartextTraffic="true">
<activity android:name=".ui.SplashActivity" android:exported="true">
<intent-filter><action android:name="android.intent.action.MAIN"/><category android:name="android.intent.category.LAUNCHER"/></intent-filter>
</activity>
<activity android:name=".ui.disk.lxc.CreateLinuxVmActivity" android:exported="false"/>
<provider android:name=".FileProvider" android:authorities="cn.classfun.droidvm.files"/>
</application></manifest>'''

def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args], text=True, stderr=subprocess.STDOUT).strip()

class TransformationTests(unittest.TestCase):
    def test_preserves_namespace_and_rebrands_app(self):
        out = transform_gradle(GRADLE)
        self.assertIn('namespace = "cn.classfun.droidvm"', out)
        self.assertIn('applicationId = "app.agbot.android"', out)
        self.assertIn('versionCode = 1', out)
    def test_rejects_changed_gradle_layout(self):
        with self.assertRaises(RuntimeError): transform_gradle(GRADLE.replace('generatedVersionCode', 'different'))
        with self.assertRaises(RuntimeError): transform_gradle(GRADLE + '\napplicationId = "cn.classfun.droidvm"')
    def test_manifest_uses_one_launcher_and_disables_backup(self):
        app = ET.fromstring(transform_manifest(MANIFEST)).find('application')
        self.assertEqual(app.get(ANDROID + 'name'), '.DroidVMApp')
        self.assertEqual(app.get(ANDROID + 'allowBackup'), 'false')
        self.assertEqual(app.get(ANDROID + 'usesCleartextTraffic'), 'true')
        self.assertEqual(app.find('provider').get(ANDROID + 'authorities'), '${applicationId}.files')
        launchers = [a for a in app.findall('activity') if a.find('intent-filter') is not None]
        self.assertEqual(len(launchers), 1)
        self.assertEqual(launchers[0].get(ANDROID + 'name'), 'app.agbot.android.AgbotActivity')
        self.assertEqual(app.findall('activity')[0].get(ANDROID + 'exported'), 'false')
    def test_unknown_manifest_entry_is_rejected(self):
        with self.assertRaises(RuntimeError): transform_manifest(MANIFEST.replace('.ui.SplashActivity', '.Changed'))

class PreparationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.checkout = Path(self.tmp.name) / 'droidvm'; self.checkout.mkdir()
        for name, data in [('app/build.gradle.kts', GRADLE), ('app/src/main/AndroidManifest.xml', MANIFEST)]:
            p = self.checkout / name; p.parent.mkdir(parents=True, exist_ok=True); p.write_text(data)
        git(self.checkout, 'init', '-b', 'main'); git(self.checkout, 'config', 'user.name', 'Fixture')
        git(self.checkout, 'config', 'user.email', 'fixture@localhost'); git(self.checkout, 'add', '.')
        git(self.checkout, 'commit', '-m', 'Synthetic fixture (not DroidVM)')
        self.commit = git(self.checkout, 'rev-parse', 'HEAD')
    def tearDown(self): self.tmp.cleanup()
    def test_applies_twice_idempotently(self):
        apply(self.checkout, self.commit, ROOT)
        first = (self.checkout / STATE).read_bytes()
        apply(self.checkout, self.commit, ROOT)
        self.assertEqual(first, (self.checkout / STATE).read_bytes())
        self.assertTrue((self.checkout / 'app/src/main/java/app/agbot/android/AgbotActivity.java').is_file())
        self.assertTrue((self.checkout / 'app/src/main/assets/agbot/agbot-guest.tar.gz').is_file())
    def test_wrong_commit_does_not_write(self):
        with self.assertRaises(RuntimeError): apply(self.checkout, 'f' * 40, ROOT)
        self.assertEqual((self.checkout / 'app/build.gradle.kts').read_text(), GRADLE)
        self.assertFalse((self.checkout / STATE).exists())
    def test_human_edit_survives(self):
        apply(self.checkout, self.commit, ROOT)
        p = self.checkout / 'app/build.gradle.kts'; edit = p.read_text() + '\n// human change\n'; p.write_text(edit)
        with self.assertRaises(RuntimeError): apply(self.checkout, self.commit, ROOT)
        self.assertEqual(p.read_text(), edit)
    def test_untracked_user_file_is_preserved(self):
        p = self.checkout / 'my-notes.txt'; p.write_text('user data')
        with self.assertRaises(RuntimeError): apply(self.checkout, self.commit, ROOT)
        self.assertEqual(p.read_text(), 'user data'); self.assertFalse((self.checkout / STATE).exists())
    def test_source_checkout_symlink_refused(self):
        (self.checkout / 'app/src/main/java').symlink_to(self.checkout.parent, target_is_directory=True)
        with self.assertRaises(RuntimeError): apply(self.checkout, self.commit, ROOT)
        self.assertFalse((self.checkout.parent / 'app/agbot/android/AgbotActivity.java').exists())

class PackagingTests(unittest.TestCase):
    def test_archive_is_deterministic_source_only(self):
        data = archive_bytes(ROOT); self.assertEqual(data, archive_bytes(ROOT))
        with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as tar:
            names = tar.getnames()
            self.assertIn('agbot-guest/gateway/src/main.mjs', names)
            self.assertIn('agbot-guest/guest/install.sh', names)
            self.assertFalse(any(n.endswith(('.key', '.token', '.apk', '.ttf', '.gguf')) for n in names))
            self.assertFalse(any('/test/' in n for n in names))
            self.assertTrue(all(not m.issym() and not m.islnk() for m in tar.getmembers()))
            self.assertEqual(tar.getmember('agbot-guest/guest/install.sh').mode, 0o755)
    def test_overlay_xml_files_parse(self):
        for p in (ROOT / 'android-overlay').rglob('*.xml'):
            with self.subTest(file=str(p)): ET.parse(p)
    def test_install_requires_explicit_guest_flag_before_mutation(self):
        result = subprocess.run(['bash', str(ROOT / 'guest/install.sh')], capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn('--guest-confirmed', result.stderr)

if __name__ == '__main__': unittest.main()

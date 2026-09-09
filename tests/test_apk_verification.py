# SPDX-License-Identifier: GPL-3.0-or-later
"""Verifier tests with synthetic ZIP/ELF headers, not compiled or installable APKs."""
import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest
import zipfile
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from verify_apk import inspect, verify_elf, REQUIRED_ELF
from package_guest import archive_bytes


def synthetic_elf(machine=183):
    data = bytearray(4096)
    data[:7] = b'\x7fELF\x02\x01\x01'
    struct.pack_into('<H', data, 18, machine)
    struct.pack_into('<Q', data, 32, 64)
    struct.pack_into('<HH', data, 54, 56, 1)
    return bytes(data)


class ElfTests(unittest.TestCase):
    def test_header_accepts_arm64(self):
        self.assertEqual(verify_elf(synthetic_elf(), 'fixture')['machine'], 183)

    def test_rejects_wrong_architecture_or_placeholder(self):
        for data in [b'', b'\x7fELF', synthetic_elf(62), synthetic_elf()[:100]]:
            with self.subTest(length=len(data)):
                with self.assertRaises(ValueError): verify_elf(data, 'fixture')

    def test_rejects_out_of_file_program_headers(self):
        data = bytearray(synthetic_elf())
        struct.pack_into('<Q', data, 32, 4090)
        with self.assertRaises(ValueError): verify_elf(data, 'fixture')


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.upstream = self.root / 'upstream'
        assets = self.upstream / 'app/src/main/assets/prebuilts'
        assets.mkdir(parents=True)
        self.entries = {'AndroidManifest.xml': b'manifest-fixture', 'resources.arsc': b'resource-fixture',
                        'classes.dex': b'dex\n035\x00Lapp/agbot/android/AgbotActivity;',
                        'assets/agbot/agbot-guest.tgz': archive_bytes(ROOT)}
        self.entries.update({name: synthetic_elf() for name in REQUIRED_ELF})
        for name, data in [('prebuilt-arm64-v8a.json', json.dumps({'fixture': 'x' * 2048}).encode()),
                           ('prebuilt-arm64-v8a.tar.xz', b'\xfd7zXZ\x00' + b'x' * 2048)]:
            (assets / name).write_bytes(data)
            self.entries[f'assets/prebuilts/{name}'] = data

    def archive(self):
        apk = self.root / 'synthetic-only.apk'
        with zipfile.ZipFile(apk, 'w') as z:
            for name, data in self.entries.items(): z.writestr(name, data)
        return apk

    def test_structure_report_has_explicit_unverified_runtime(self):
        report = inspect(self.archive(), ROOT, self.upstream)
        self.assertIn('Gunyah-boot', report['notChecked'])
        self.assertEqual(len(report['requiredAarch64Binaries']), len(REQUIRED_ELF))

    def test_missing_daemon_fails(self):
        del self.entries[REQUIRED_ELF[0]]
        with self.assertRaisesRegex(ValueError, 'Missing required runtime binary'):
            inspect(self.archive(), ROOT, self.upstream)

    def test_altered_embedded_runtime_fails(self):
        self.entries['assets/prebuilts/prebuilt-arm64-v8a.tar.xz'] += b'changed'
        with self.assertRaisesRegex(ValueError, 'differs from pinned'):
            inspect(self.archive(), ROOT, self.upstream)

    def test_missing_agbot_compiled_class_fails(self):
        self.entries['classes.dex'] = b'dex\n035\x00OtherClass'
        with self.assertRaisesRegex(ValueError, 'AgbotActivity absent'):
            inspect(self.archive(), ROOT, self.upstream)

    def test_stale_guest_source_fails(self):
        self.entries['assets/agbot/agbot-guest.tgz'] = b'stale'
        with self.assertRaisesRegex(ValueError, 'Guest source differs'):
            inspect(self.archive(), ROOT, self.upstream)


if __name__ == '__main__': unittest.main()

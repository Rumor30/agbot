#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Inspect a built APK; this does not test installation, VM boot or model access."""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import re
import struct
import zipfile
from package_guest import archive_bytes

ARM64_MACHINE = 183
REQUIRED_ELF = (
    'assets/bin/arm64-v8a/daemon',
    'assets/bin/arm64-v8a/droidvm',
    'lib/arm64-v8a/libunixhelper.so',
    'lib/arm64-v8a/libvnc_jni.so',
    'lib/arm64-v8a/liblbx.so',
    'lib/arm64-v8a/libcompat_a16.so',
)
RUNTIME_ASSETS = ('prebuilt-arm64-v8a.json', 'prebuilt-arm64-v8a.tar.xz')


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def verify_elf(data: bytes, name: str) -> dict:
    require(len(data) >= 4096 and data[:4] == b'\x7fELF', f'{name}: not a complete ELF binary')
    require(data[4] == 2 and data[5] == 1, f'{name}: expected little-endian ELF64')
    machine = struct.unpack_from('<H', data, 18)[0]
    require(machine == ARM64_MACHINE, f'{name}: expected AArch64, got machine {machine}')
    phoff = struct.unpack_from('<Q', data, 32)[0]
    phsize, phnum = struct.unpack_from('<HH', data, 54)
    require(phsize == 56 and phnum > 0 and 64 <= phoff <= len(data) - phsize * phnum,
            f'{name}: invalid ELF program header table')
    return {'bytes': len(data), 'machine': machine, 'sha256': hashlib.sha256(data).hexdigest()}


def inspect(apk: Path, project: Path, upstream: Path) -> dict:
    require(apk.is_file(), f'APK does not exist: {apk}')
    with zipfile.ZipFile(apk) as z:
        names = z.namelist()
        require(len(names) == len(set(names)), 'Duplicate ZIP entry names')
        bad = z.testzip()
        require(bad is None, f'ZIP CRC failure: {bad}')
        for name in ('AndroidManifest.xml', 'resources.arsc'):
            require(name in names and z.getinfo(name).file_size > 0, f'Missing Android structure: {name}')
        dex = [n for n in names if re.fullmatch(r'classes(?:\d+)?\.dex', n)]
        require(bool(dex), 'Missing compiled DEX')
        require(all(z.read(n)[:4] == b'dex\n' for n in dex), 'Invalid DEX magic')
        launcher = b'Lapp/agbot/android/AgbotActivity;'
        require(any(launcher in z.read(n) for n in dex), 'AgbotActivity absent from compiled DEX')
        native = {}
        for name in REQUIRED_ELF:
            require(name in names, f'Missing required runtime binary: {name}')
            native[name] = verify_elf(z.read(name), name)
        guest = 'assets/agbot/agbot-guest.tgz'
        require(guest in names, 'Missing packaged Guest source')
        require(z.read(guest) == archive_bytes(project), 'Guest source differs from this Agbot checkout')
        assets = {}
        for name in RUNTIME_ASSETS:
            entry = f'assets/prebuilts/{name}'
            source = upstream / 'app/src/main/assets/prebuilts' / name
            require(entry in names and source.is_file(), f'Missing pinned prebuilt: {name}')
            data = z.read(entry)
            require(data == source.read_bytes(), f'Embedded {name} differs from pinned upstream checkout')
            require(len(data) > 1024, f'Empty or placeholder runtime: {name}')
            assets[entry] = {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
        require(z.read('assets/prebuilts/prebuilt-arm64-v8a.tar.xz')[:6] == b'\xfd7zXZ\x00', 'Invalid XZ runtime')
        json.loads(z.read('assets/prebuilts/prebuilt-arm64-v8a.json'))
        with apk.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        return {
            'apk': apk.name, 'bytes': apk.stat().st_size,
            'sha256': digest,
            'dexFiles': dex, 'requiredAarch64Binaries': native, 'pinnedRuntimeAssets': assets,
            'guestSourceSha256': hashlib.sha256(z.read(guest)).hexdigest(),
            'checked': ['zip-crc', 'compiled-dex', 'AgbotActivity', 'aarch64-elf', 'pinned-prebuilts', 'exact-guest-source'],
            'notChecked': ['installation', 'Gunyah-boot', 'real-model-login', 'one-click-provisioning'],
        }


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('apk', type=Path)
    parser.add_argument('--project', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--upstream', type=Path)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    try:
        result = inspect(args.apk, args.project, args.upstream or args.project / 'upstream/DroidVM')
        text = json.dumps(result, indent=2) + '\n'
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(text)
        print(text, end='')
    except (OSError, ValueError, KeyError, zipfile.BadZipFile) as exc:
        parser.exit(1, f'APK verification failed: {exc}\n')

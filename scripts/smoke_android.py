#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Install and navigate Agbot on a disposable CI emulator. Never a Gunyah test."""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import time
import xml.etree.ElementTree as ET

PACKAGE = 'app.agbot.android'


def adb(*args: str, binary: bool = False, timeout: int = 60):
    return subprocess.check_output(['adb', *args], timeout=timeout, text=not binary)


def ui():
    adb('shell', 'uiautomator', 'dump', '/sdcard/agbot-ci-ui.xml')
    text = adb('exec-out', 'cat', '/sdcard/agbot-ci-ui.xml')
    return text, ET.fromstring(text)


def wait_text(expected: str, output: Path, label: str):
    deadline = time.monotonic() + 45
    last = ''
    while time.monotonic() < deadline:
        try:
            text, root = ui()
            last = text
            if any(n.get('text') == expected for n in root.iter('node')):
                (output / f'{label}.xml').write_text(text)
                (output / f'{label}.png').write_bytes(adb('exec-out', 'screencap', '-p', binary=True))
                return root
        except (subprocess.CalledProcessError, ET.ParseError):
            pass
        time.sleep(1)
    (output / f'{label}-failed.xml').write_text(last)
    raise RuntimeError(f'Expected UI text did not appear: {expected}')


def tap(root, text: str):
    nodes = [n for n in root.iter('node') if n.get('text') == text and n.get('clickable') == 'true']
    if len(nodes) != 1:
        raise RuntimeError(f'Expected one clickable control: {text}')
    bounds = re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', nodes[0].get('bounds', ''))
    if not bounds:
        raise RuntimeError(f'Invalid control bounds: {text}')
    x1, y1, x2, y2 = map(int, bounds.groups())
    adb('shell', 'input', 'tap', str((x1+x2)//2), str((y1+y2)//2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('apk', type=Path)
    parser.add_argument('--output', type=Path, default=Path('smoke-evidence'))
    args = parser.parse_args()
    output = args.output
    output.mkdir(parents=True, exist_ok=True)
    try:
        (output / 'devices.txt').write_text(adb('devices', '-l'))
        (output / 'android-api.txt').write_text(adb('shell', 'getprop', 'ro.build.version.sdk'))
        (output / 'install.txt').write_text(adb('install', '-r', '-t', str(args.apk), timeout=180))
        adb('shell', 'am', 'force-stop', PACKAGE)
        adb('logcat', '-c')
        launch = adb('shell', 'am', 'start', '-W', '-n', PACKAGE + '/.AgbotActivity')
        (output / 'launch.txt').write_text(launch)
        if 'Status: ok' not in launch:
            raise RuntimeError('Android did not report a successful launch')
        root = wait_text('让 AI 使用你的 Linux 电脑', output, 'chat')
        tap(root, 'Computer')
        root = wait_text('本地 Linux Computer', output, 'computer')
        tap(root, '设置')
        root = wait_text('模型与连接', output, 'settings')
        tap(root, '聊天')
        wait_text('让 AI 使用你的 Linux 电脑', output, 'chat-return')
        if not adb('shell', 'pidof', PACKAGE).strip():
            raise RuntimeError('Agbot process exited during UI navigation')
        with args.apk.open('rb') as stream:
            sha = hashlib.file_digest(stream, 'sha256').hexdigest()
        result = {'apkSha256': sha, 'passed': ['install', 'launcher', 'chat', 'computer-tab', 'settings-tab', 'return-to-chat'],
                  'notTested': ['Android-root-authorization', 'Gunyah', 'Linux-VM', 'Guest-installation', 'cloud-models']}
        (output / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps(result))
    finally:
        (output / 'logcat.txt').write_text(adb('logcat', '-d', '-t', '1500'))


if __name__ == '__main__': main()

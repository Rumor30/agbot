#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Apply the Agbot overlay to an exact DroidVM checkout without overwriting human changes."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import xml.etree.ElementTree as ET
from package_guest import archive_bytes

ROOT = Path(__file__).resolve().parents[1]
ANDROID = '{http://schemas.android.com/apk/res/android}'
TOOLS = '{http://schemas.android.com/tools}'
STATE = '.agbot-overlay-state.json'
APP_ID = 'app.agbot.android'
ET.register_namespace('android', ANDROID[1:-1])
ET.register_namespace('tools', TOOLS[1:-1])

def git(checkout: Path, *args: str) -> str:
    return subprocess.check_output(['git', '-C', str(checkout), *args], text=True).strip()

def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()

def replace_once(text: str, old: str, new: str) -> str:
    if text.count(old) != 1:
        raise RuntimeError(f'Upstream layout changed: expected one occurrence of {old!r}')
    return text.replace(old, new, 1)

def transform_gradle(text: str) -> str:
    if 'namespace = "cn.classfun.droidvm"' not in text:
        raise RuntimeError('DroidVM namespace changed; review JNI and manifest class resolution first')
    text = replace_once(text, 'applicationId = "cn.classfun.droidvm"', f'applicationId = "{APP_ID}"')
    text = replace_once(text, 'versionCode = generatedVersionCode', 'versionCode = 1')
    return replace_once(text, 'versionName = generatedVersionName', 'versionName = "0.1.0-dev.1"')

def transform_manifest(data: str) -> bytes:
    parser = ET.XMLParser(target=ET.TreeBuilder(insert_comments=True))
    doc = ET.fromstring(data, parser=parser)
    app = doc.find('application')
    if app is None:
        raise RuntimeError('Upstream application manifest is missing')
    app.set(ANDROID + 'label', 'Agbot')
    app.set(ANDROID + 'appCategory', 'productivity')
    app.set(ANDROID + 'allowBackup', 'false')
    app.set(ANDROID + 'fullBackupContent', 'false')
    app.set(ANDROID + 'dataExtractionRules', '@xml/agbot_data_extraction_rules')
    app.set(ANDROID + 'icon', '@drawable/agbot_icon')
    app.set(ANDROID + 'roundIcon', '@drawable/agbot_icon')
    # Upstream services can need their own cleartext local channels. Restrict the Agbot
    # client itself in GatewayClient instead of globally breaking the VM manager.
    found = False
    for activity in app.findall('activity'):
        name = activity.get(ANDROID + 'name')
        if name in ('.ui.SplashActivity', 'cn.classfun.droidvm.ui.SplashActivity'):
            found = True
            activity.set(ANDROID + 'exported', 'false')
            for intent in list(activity.findall('intent-filter')):
                if any(x.get(ANDROID + 'name') == 'android.intent.category.LAUNCHER' for x in intent.findall('category')):
                    activity.remove(intent)
    if not found:
        raise RuntimeError('Pinned DroidVM splash entry not found')
    for provider in app.findall('provider'):
        authority = provider.get(ANDROID + 'authorities', '')
        if 'cn.classfun.droidvm' in authority:
            provider.set(ANDROID + 'authorities', authority.replace('cn.classfun.droidvm', '${applicationId}'))
    activity = ET.SubElement(app, 'activity', {
        ANDROID + 'name': APP_ID + '.AgbotActivity', ANDROID + 'exported': 'true',
        ANDROID + 'theme': '@style/Theme.Agbot', ANDROID + 'windowSoftInputMode': 'adjustNothing'
    })
    intent = ET.SubElement(activity, 'intent-filter')
    ET.SubElement(intent, 'action', {ANDROID + 'name': 'android.intent.action.MAIN'})
    ET.SubElement(intent, 'category', {ANDROID + 'name': 'android.intent.category.LAUNCHER'})
    ET.indent(doc, space='    ')
    return ET.tostring(doc, encoding='utf-8', xml_declaration=True) + b'\n'

def plan(checkout: Path, root: Path = ROOT) -> dict[str, bytes]:
    outputs = {
        'app/build.gradle.kts': transform_gradle(git(checkout, 'show', 'HEAD:app/build.gradle.kts')).encode(),
        'app/src/main/AndroidManifest.xml': transform_manifest(git(checkout, 'show', 'HEAD:app/src/main/AndroidManifest.xml')),
        'app/src/main/assets/agbot/agbot-guest.tar.gz': archive_bytes(root),
    }
    for source in sorted((root / 'android-overlay').rglob('*')):
        if source.is_file():
            if source.is_symlink():
                raise RuntimeError(f'Overlay symlink refused: {source}')
            outputs[source.relative_to(root / 'android-overlay').as_posix()] = source.read_bytes()
    return outputs

def apply(checkout: Path, expected_commit: str, root: Path = ROOT) -> None:
    if git(checkout, 'rev-parse', 'HEAD') != expected_commit:
        raise RuntimeError('DroidVM HEAD differs from upstream.lock.json; refusing to patch an unreviewed version')
    outputs = plan(checkout, root)
    state_path = checkout / STATE
    old = json.loads(state_path.read_text()) if state_path.is_file() else {'files': {}}
    if old.get('commit', expected_commit) != expected_commit:
        raise RuntimeError('Overlay state belongs to another upstream commit')
    # Fail before the first write if any modified tracked/untracked file is not our exact
    # previously generated output. Never reset --hard, clean -fd, or silently merge a human edit.
    status = subprocess.check_output(['git', '-C', str(checkout), 'status', '--porcelain=v1', '-z', '--untracked-files=all']).decode()
    for entry in status.split('\0'):
        if not entry:
            continue
        name = entry[3:]
        if name == STATE:
            continue
        current = checkout / name
        if name not in outputs or not current.is_file() or current.is_symlink():
            raise RuntimeError(f'Unmanaged local change; preserve it before preparation: {name}')
        if digest(current.read_bytes()) != old.get('files', {}).get(name):
            raise RuntimeError(f'Human/unknown edit detected, left untouched: {name}')
    for name, data in outputs.items():
        target = checkout / name
        if any(p.is_symlink() for p in [target, *target.parents] if p != checkout.parent):
            raise RuntimeError(f'Symlink in output path: {name}')
        target.parent.mkdir(parents=True, exist_ok=True)
        temp = target.with_name(target.name + '.agbot-tmp')
        with temp.open('xb') as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp, target)
    state_path.write_text(json.dumps({'commit': expected_commit, 'files': {k: digest(v) for k, v in outputs.items()}}, indent=2) + '\n')
    print(f'Agbot overlay applied to {expected_commit}. This is source preparation, NOT an APK build.')

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--checkout', type=Path, default=ROOT / 'upstream/DroidVM')
    args = parser.parse_args()
    try:
        lock = json.loads((ROOT / 'upstream.lock.json').read_text())
        apply(args.checkout.resolve(), lock['droidvm']['commit'])
    except (RuntimeError, OSError, ValueError, subprocess.CalledProcessError) as exc:
        parser.exit(1, f'Preparation stopped: {exc}\n')

#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Privileged, local-only provisioning from the read-only CIDATA block device.
No network input is executed. Payload must match the per-instance seed digest.
This script never logs the seed token or a raw installer exception.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tempfile

STATE = Path('/var/lib/agbot-bootstrap')
MOUNT = Path('/run/agbot-seed')

def announce(stage):
    message = 'AGBOT_SETUP_V1 ' + stage + '\n'
    print(message, end='', flush=True)
    try:
        with open('/dev/console', 'w') as console:
            console.write(message)
    except OSError:
        pass

def validate_seed(value):
    if not isinstance(value, dict) or value.get('schema') != 1:
        raise ValueError('seed schema')
    for key, pattern in [('instanceId', r'[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}'),
                         ('bridgeToken', r'[A-Za-z0-9_-]{43}'), ('payloadSha256', r'[0-9a-f]{64}')]:
        if not isinstance(value.get(key), str) or not re.fullmatch(pattern, value[key]):
            raise ValueError('seed field')
    return value

def extract_payload(archive, destination):
    with tarfile.open(archive, 'r:gz') as tar:
        members = tar.getmembers()
        if len(members) > 512 or sum(m.size for m in members) > 16 * 1024 * 1024:
            raise ValueError('payload size')
        for member in members:
            name = Path(member.name)
            if name.is_absolute() or '..' in name.parts or not name.parts or name.parts[0] != 'agbot-guest':
                raise ValueError('payload path')
            if not (member.isdir() or member.isfile()):
                raise ValueError('payload link/device')
        tar.extractall(destination, members=members, filter='data')

def provision():
    if os.geteuid() != 0 or Path('/system/bin/app_process').exists():
        raise RuntimeError('dedicated Linux guest root required')
    os.umask(0o077)
    STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    MOUNT.mkdir(mode=0o700, parents=True, exist_ok=True)
    announce('READ_SEED')
    subprocess.run(['mount', '-t', 'vfat', '-o', 'ro,nosuid,nodev,noexec,umask=077',
                    '/dev/disk/by-label/CIDATA', str(MOUNT)], check=True, timeout=20,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        seed_path = MOUNT / 'agbot.json'
        if seed_path.stat().st_size > 4096:
            raise ValueError('oversize seed')
        seed = validate_seed(json.loads(seed_path.read_text()))
        saved = STATE / 'seed.json'
        if saved.exists():
            old = validate_seed(json.loads(saved.read_text()))
            if (old['instanceId'], old['bridgeToken']) != (seed['instanceId'], seed['bridgeToken']):
                raise ValueError('instance identity changed; refusing to replace credentials')
        payload = MOUNT / 'payload.tgz'
        if payload.stat().st_size > 8 * 1024 * 1024:
            raise ValueError('payload too large')
        actual = hashlib.sha256(payload.read_bytes()).hexdigest()
        if actual != seed['payloadSha256']:
            raise ValueError('payload digest')
        marker = STATE / 'installed.sha256'
        if marker.exists() and marker.read_text().strip() == actual:
            subprocess.run(['systemctl', 'start', 'agbot.service', 'agbot-enroll.service'], check=True, timeout=40)
            announce('SERVICE_STARTED')
            return
        temp_seed = STATE / 'seed.json.new'
        temp_seed.write_text(json.dumps(seed) + '\n')
        temp_seed.chmod(0o600)
        os.replace(temp_seed, saved)
        announce('INSTALLING_RUNTIME')
        with tempfile.TemporaryDirectory(prefix='install-', dir=STATE) as temporary:
            extract_payload(payload, temporary)
            root = Path(temporary) / 'agbot-guest'
            env = dict(os.environ, AGBOT_SEED_FILE=str(saved))
            with (STATE / 'install.log').open('w') as log:
                result = subprocess.run(['bash', str(root / 'guest/install.sh'), '--guest-confirmed'],
                                        env=env, stdout=log, stderr=subprocess.STDOUT, timeout=1200)
            if result.returncode:
                raise RuntimeError('installer failed; private guest log retained')
        new_marker = STATE / 'installed.sha256.new'
        new_marker.write_text(actual + '\n')
        os.replace(new_marker, marker)
        announce('SERVICE_STARTED')
    finally:
        subprocess.run(['umount', str(MOUNT)], check=False, timeout=20,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

if __name__ == '__main__':
    try:
        provision()
    except Exception:
        # cloud-init/systemd journals can be exported to the phone; never print credential-bearing data.
        announce('FAILED_RETRYING')
        raise SystemExit(1)

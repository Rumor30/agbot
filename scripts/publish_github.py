#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Explicit local publication using an already authenticated GitHub CLI. Never reads a token."""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import sys
ROOT = Path(__file__).resolve().parents[1]
TARGET = 'Rumor30/Agbot'

def capture(*args: str) -> str:
    return subprocess.check_output(args, cwd=ROOT, text=True).strip()

def run(*args: str) -> None:
    subprocess.run(args, cwd=ROOT, check=True)

def verify_files() -> None:
    tracked = capture('git', 'ls-files', '-z').split('\0')
    forbidden = {'.env', 'auth.json', 'pairing.json', 'bridge.token', 'guest.key', 'local.properties'}
    for name in tracked:
        p = Path(name)
        if p.name in forbidden or p.suffix.lower() in {'.jks', '.keystore', '.p12', '.pfx', '.key', '.pem', '.apk', '.qcow2', '.img', '.ttf', '.otf'}:
            raise RuntimeError(f'Sensitive/binary file is tracked; refusing upload: {name}')
    lock = json.loads((ROOT / 'upstream.lock.json').read_text())['droidvm']['commit']
    entry = capture('git', 'ls-files', '--stage', 'upstream/DroidVM')
    if not entry.startswith(f'160000 {lock} 0\t'):
        raise RuntimeError('The pinned DroidVM gitlink is missing or changed; review before upload')

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--create-private-repository', action='store_true', help=f'Explicitly create and push {TARGET}')
    args = parser.parse_args()
    if not args.create_private_repository:
        parser.exit(2, f'No changes made. To create PRIVATE {TARGET}, pass --create-private-repository.\n')
    try:
        if not shutil.which('gh'):
            raise RuntimeError('Install GitHub CLI and run gh auth login locally. Do not paste credentials into chat.')
        run('gh', 'auth', 'status', '--hostname', 'github.com')
        if capture('gh', 'api', 'user', '--jq', '.login') != 'Rumor30':
            raise RuntimeError('The authenticated account is not Rumor30. No repository created.')
        if not (ROOT / '.git').exists():
            run('git', 'init', '-b', 'main')
            run('git', 'add', '--', '.', ':!upstream')
            lock = json.loads((ROOT / 'upstream.lock.json').read_text())['droidvm']['commit']
            (ROOT / 'upstream/DroidVM').mkdir(parents=True, exist_ok=True)
            run('git', 'update-index', '--add', '--cacheinfo', f'160000,{lock},upstream/DroidVM')
            verify_files()
            run('git', '-c', 'user.name=Agbot Development', '-c', 'user.email=agbot@localhost', 'commit', '-m', 'Initial Agbot development source')
        if capture('git', 'status', '--porcelain', '--ignore-submodules=all'):
            raise RuntimeError('Local source has uncommitted changes. Review and commit them before publishing.')
        if 'github' in capture('git', 'remote').splitlines():
            raise RuntimeError('A remote named github already exists. Left untouched; no force push performed.')
        verify_files()
        existing = subprocess.run(['gh', 'repo', 'view', TARGET, '--json', 'nameWithOwner'], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if existing.returncode == 0:
            raise RuntimeError(f'{TARGET} already exists. Refusing to replace or merge into it automatically.')
        # gh repo create is atomic with respect to repository name collisions. Failure is not bypassed.
        run('gh', 'repo', 'create', TARGET, '--private', '--source', '.', '--remote', 'github', '--push',
            '--description', 'Android cloud agent with an integrated local DroidVM Linux Computer (development version)')
        print('GitHub publication completed. Inspect the returned repository and its Actions page.')
    except (RuntimeError, OSError, ValueError, subprocess.CalledProcessError) as exc:
        parser.exit(1, f'Publication stopped: {exc}\n')

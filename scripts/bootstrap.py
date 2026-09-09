#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Fetch exact upstream source, then overlay Agbot. Works from a Git bundle or source ZIP."""
from __future__ import annotations
import argparse
import json
import subprocess
from pathlib import Path
from prepare_android import apply
ROOT = Path(__file__).resolve().parents[1]

def run(*args: str, cwd: Path | None = None) -> None:
    subprocess.run(args, cwd=cwd, check=True)

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--build', action='store_true', help='Build debug APK after fetching/preparation; needs Android SDK and JDK')
    args = parser.parse_args()
    lock = json.loads((ROOT / 'upstream.lock.json').read_text())['droidvm']
    checkout = ROOT / 'upstream/DroidVM'
    try:
        if not (checkout / '.git').exists():
            if checkout.exists() and any(checkout.iterdir()):
                raise RuntimeError('upstream/DroidVM is not an empty directory or a Git checkout; left untouched')
            checkout.parent.mkdir(parents=True, exist_ok=True)
            run('git', 'clone', '--no-checkout', lock['repository'], str(checkout))
            run('git', 'checkout', '--detach', lock['commit'], cwd=checkout)
        actual = subprocess.check_output(['git', '-C', str(checkout), 'rev-parse', 'HEAD'], text=True).strip()
        if actual != lock['commit']:
            raise RuntimeError('Existing upstream checkout is not the locked commit; refusing to switch or reset it')
        run('git', 'submodule', 'update', '--init', '--recursive', cwd=checkout)
        apply(checkout, lock['commit'])
        if args.build:
            wrapper = 'gradlew.bat' if __import__('os').name == 'nt' else './gradlew'
            if wrapper == './gradlew': (checkout / 'gradlew').chmod(0o755)
            run(wrapper, ':app:assembleDebug', cwd=checkout)
    except (RuntimeError, OSError, subprocess.CalledProcessError) as exc:
        parser.exit(1, f'Bootstrap stopped without resetting local changes: {exc}\n')

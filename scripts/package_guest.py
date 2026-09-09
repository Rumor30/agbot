#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Produce a deterministic source-only guest archive. No credentials or binary dependencies."""
from __future__ import annotations
import argparse
import gzip
import io
from pathlib import Path
import tarfile

ROOT = Path(__file__).resolve().parents[1]

def archive_bytes(root: Path = ROOT) -> bytes:
    names = [Path('package.json'), Path('LICENSE'), Path('upstream.lock.json')]
    for directory in ('gateway/src', 'guest'):
        names.extend(p.relative_to(root) for p in (root / directory).rglob('*') if p.is_file())
    raw = io.BytesIO()
    with gzip.GzipFile(fileobj=raw, mode='wb', mtime=0, filename='') as gz:
        with tarfile.open(fileobj=gz, mode='w') as tar:
            for relative in sorted(names):
                path = root / relative
                if path.is_symlink():
                    raise RuntimeError(f'Refusing symlink in guest source: {relative}')
                if '__pycache__' in relative.parts or path.suffix == '.pyc':
                    continue
                data = path.read_bytes()
                info = tarfile.TarInfo('agbot-guest/' + relative.as_posix())
                info.size, info.mtime, info.uid, info.gid = len(data), 0, 0, 0
                info.mode = 0o755 if path.suffix in ('.sh', '.py') else 0o644
                tar.addfile(info, io.BytesIO(data))
    return raw.getvalue()

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(archive_bytes())
    print(f'Guest source archive: {args.output}')

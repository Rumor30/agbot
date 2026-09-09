#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""CI entry point: fail promptly once the disposable guest has emitted safe diagnostics."""
import argparse
from pathlib import Path
import guest_smoke
original = guest_smoke.proof_pin

def checked_pin(log, instance, token):
    if 'AGBOT_CI_DIAGNOSTICS_END' in log:
        start = log.rfind('AGBOT_CI_INSTALL_DIAGNOSTICS')
        end = log.find('AGBOT_CI_DIAGNOSTICS_END', start)
        print(log[start:end].replace(token, '[REDACTED]')[-12000:], flush=True)
        raise RuntimeError('Guest installer failed; sanitized diagnostic evidence retained')
    return original(log, instance, token)

guest_smoke.proof_pin = checked_pin
if __name__ == '__main__':
    p=argparse.ArgumentParser();p.add_argument('--arch',choices=['amd64','arm64'],required=True);p.add_argument('--output',type=Path,required=True)
    a=p.parse_args();guest_smoke.main(a.arch,a.output)

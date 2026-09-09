#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Periodically publish an HMAC-authenticated TLS pin, never the bridge token."""
import hashlib
import hmac
import http.client
import json
from pathlib import Path
import re
import ssl
import time

def proof(instance, pin, token):
    return hmac.new(token.encode(), f'AGBOT_READY_V1\n{instance}\n{pin}'.encode(), hashlib.sha256).hexdigest()

def identity_from_seed(instance, seed):
    if not isinstance(seed, dict) or seed.get('schema') != 1 or seed.get('instanceId') != instance:
        raise ValueError('instance identity mismatch')
    token = seed.get('bridgeToken')
    if not re.fullmatch(r'[0-9a-f-]{36}', instance) or not isinstance(token, str) or not re.fullmatch(r'[A-Za-z0-9_-]{43}', token):
        raise ValueError('invalid identity')
    return token

def announcement():
    instance = Path('/etc/agbot/instance-id').read_text().strip()
    # This root service deliberately has no DAC override capabilities. The gateway's
    # agbot-owned 0600 token is unreadable here; use the root-owned 0600 seed instead.
    # No capability or world-readable permission is granted to work around isolation.
    seed_path = Path('/var/lib/agbot-bootstrap/seed.json')
    if seed_path.stat().st_size > 4096:
        raise ValueError('seed too large')
    token = identity_from_seed(instance, json.loads(seed_path.read_text()))
    pem = Path('/etc/agbot/guest.crt').read_text()
    pin = hashlib.sha256(ssl.PEM_cert_to_DER_cert(pem)).hexdigest()
    context = ssl.create_default_context(cafile='/etc/agbot/guest.crt')
    context.check_hostname = False  # Exact locally owned CA cert; endpoint is fixed loopback.
    connection = http.client.HTTPSConnection('127.0.0.1', 8765, context=context, timeout=5)
    try:
        connection.request('GET', '/v1/health', headers={'Authorization': 'Bearer ' + token})
        response = connection.getresponse()
        value = json.loads(response.read(8192))
        if response.status != 200 or not value.get('ok') or value.get('instanceId') != instance:
            raise ValueError('gateway not ready')
    finally:
        connection.close()
    return f'AGBOT_READY_V1 {instance} {pin} {proof(instance, pin, token)}\n'

if __name__ == '__main__':
    while True:
        try:
            line = announcement()
            with open('/dev/console', 'w') as console:
                console.write(line)
                console.flush()
        except Exception:
            pass  # Retry without logging credentials or arbitrary response bodies.
        time.sleep(10)

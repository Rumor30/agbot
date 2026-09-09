#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Periodically publish an HMAC-authenticated TLS pin, never the bridge token."""
import hashlib
import hmac
import http.client
import json
import os
from pathlib import Path
import re
import ssl
import time

def proof(instance, pin, token):
    return hmac.new(token.encode(), f'AGBOT_READY_V1\n{instance}\n{pin}'.encode(), hashlib.sha256).hexdigest()

def announcement():
    instance = Path('/etc/agbot/instance-id').read_text().strip()
    token = Path('/var/lib/agbot/bridge.token').read_text().strip()
    if not re.fullmatch(r'[0-9a-f-]{36}', instance) or not re.fullmatch(r'[A-Za-z0-9_-]{43}', token):
        raise ValueError('invalid identity')
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

#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SessionStore } from './store.mjs';
import { AgentEngine } from './engine.mjs';
import { CodexBridge } from './codex.mjs';
import { createGateway } from './server.mjs';
import { invariant, AgbotError } from './errors.mjs';
import { opaqueToken } from './security.mjs';

try {
  invariant(process.platform === 'linux', 'The production gateway runs in the Linux guest.');
  invariant(process.getuid() !== 0, 'Refusing to run the model/tool gateway as root. Use the agbot guest account.', 'ROOT_REFUSED');
  const home = os.homedir();
  const directory = path.resolve(process.env.AGBOT_DATA_DIR || path.join(home, '.local/state/agbot'));
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const tokenFile = process.env.AGBOT_TOKEN_FILE || path.join(directory, 'bridge.token');
  if (process.argv.includes('--init-token')) {
    const fd = fs.openSync(tokenFile, 'wx', 0o600);
    fs.writeFileSync(fd, opaqueToken() + '\n'); fs.closeSync(fd);
    console.log(`Pairing token created at ${tokenFile}. Its contents are not printed.`);
    process.exit(0);
  }
  if (!fs.existsSync(tokenFile)) throw new AgbotError('Bridge token is missing. Run with --init-token first.');
  const tokenStat = fs.lstatSync(tokenFile);
  invariant(tokenStat.isFile() && !tokenStat.isSymbolicLink() && tokenStat.uid === process.getuid()
    && (tokenStat.mode & 0o077) === 0,
    'Bridge token must be a private regular file owned by the gateway user (mode 0600).');
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  const host = process.env.AGBOT_BIND || '127.0.0.1';
  const port = Number(process.env.AGBOT_PORT || 8765);
  invariant(Number.isInteger(port) && port > 0 && port < 65536, 'Invalid gateway port');
  let tls = null;
  if (process.env.AGBOT_TLS_KEY && process.env.AGBOT_TLS_CERT) tls = {
    key: fs.readFileSync(process.env.AGBOT_TLS_KEY), cert: fs.readFileSync(process.env.AGBOT_TLS_CERT)
  };
  const store = new SessionStore(path.join(directory, 'sessions'));
  const codex = new CodexBridge({ home, command: process.env.AGBOT_CODEX_BIN || 'codex' });
  const engine = new AgentEngine({ store, home, codex, bridgeToken: token,
    workspaceRoot: process.env.AGBOT_WORKSPACE_ROOT || path.join(home, 'workspaces') });
  const server = createGateway({ engine, store, codex, token, host, tls });
  server.on('error', e => { console.error(`Agbot failed to listen (${e.code || 'unknown'}).`); process.exitCode = 1; });
  server.listen(port, host, () => console.log(`Agbot gateway ready on ${tls ? 'HTTPS' : 'loopback HTTP'} port ${port}.`));
  let closing = false;
  const shutdown = async () => {
    if (closing) return; closing = true;
    server.close(); await engine.shutdown(); server.closeAllConnections();
  };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
} catch (e) {
  console.error(`Agbot: ${e.message}`); process.exitCode = 1;
}

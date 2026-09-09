// SPDX-License-Identifier: GPL-3.0-or-later
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { createHash, randomUUID } from 'node:crypto';
import { AgbotError, invariant, abortError } from './errors.mjs';
import { cleanEnvironment } from './security.mjs';
const MAX_FILE = 256 * 1024;
const hash = data => createHash('sha256').update(data).digest('hex');

export class WorkspaceTools {
  constructor(root, { timeoutMs = 90000, maxOutput = 128 * 1024, home = root } = {}) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    this.root = fs.realpathSync(root); this.home = home;
    this.timeoutMs = timeoutMs; this.maxOutput = maxOutput;
  }
  resolve(relative, { allowMissing = false } = {}) {
    invariant(typeof relative === 'string' && relative.length <= 1024 && !relative.includes('\0'), 'Invalid workspace path');
    invariant(!path.isAbsolute(relative) && !relative.split(/[\\/]/).includes('..') && !relative.includes('\\'),
      'Only relative workspace paths without .. are allowed', 'PATH_OUTSIDE_WORKSPACE', 403);
    const result = path.resolve(this.root, relative || '.');
    invariant(result === this.root || result.startsWith(this.root + path.sep), 'Path is outside workspace', 'PATH_OUTSIDE_WORKSPACE', 403);
    let current = this.root;
    const segments = path.relative(this.root, result).split(path.sep).filter(Boolean);
    for (let i = 0; i < segments.length; ++i) {
      current = path.join(current, segments[i]);
      try {
        const stat = fs.lstatSync(current);
        invariant(!stat.isSymbolicLink(), 'Symlink paths are not allowed by file tools', 'SYMLINK_REFUSED', 403);
        if (i < segments.length - 1) invariant(stat.isDirectory(), 'Parent is not a directory');
      } catch (e) {
        if (allowMissing && e.code === 'ENOENT') return result;
        throw e;
      }
    }
    return result;
  }
  fileState(file) {
    try {
      const st = fs.lstatSync(file);
      invariant(st.isFile() && !st.isSymbolicLink(), 'Expected a regular file');
      invariant(st.size <= MAX_FILE, 'File exceeds the 256 KiB file-tool limit');
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const data = fs.readFileSync(fd);
        invariant(data.length <= MAX_FILE, 'File exceeds the file-tool limit');
        invariant(!data.includes(0), 'Binary files must not be read as text');
        return { hash: hash(data), text: data.toString('utf8'), mode: st.mode & 0o777 };
      } finally { fs.closeSync(fd); }
    } catch (e) { if (e.code === 'ENOENT') return { hash: null, text: '', mode: 0o644 }; throw e; }
  }
  prepare(tool) {
    let a = tool.arguments;
    if (typeof a === 'string') {
      try { a = JSON.parse(a); } catch { throw new AgbotError('Tool arguments must be valid JSON'); }
    }
    invariant(a && typeof a === 'object' && !Array.isArray(a), 'Tool arguments must be an object');
    a = structuredClone(a);
    const spec = { list_files: ['path'], read_file: ['path'], write_file: ['path', 'content'], shell: ['command', 'cwd'] }[tool.name];
    invariant(spec, `Unsupported tool: ${tool.name}`, 'UNKNOWN_TOOL');
    invariant(Object.keys(a).every(k => spec.includes(k)) && spec.every(k => typeof a[k] === 'string'), 'Tool argument schema mismatch');
    const prepared = { id: tool.id, name: tool.name, arguments: Object.freeze(a), requiresApproval: ['shell', 'write_file'].includes(tool.name) };
    if (tool.name === 'shell') {
      invariant(a.command.trim().length > 0 && a.command.length <= 32768 && !a.command.includes('\0'), 'Invalid shell command');
      const cwd = this.resolve(a.cwd);
      invariant(fs.statSync(cwd).isDirectory(), 'Working directory is not a directory');
      prepared.preview = { command: a.command, cwd: a.cwd, warning: 'Runs as the guest user. It can access more than this folder. Android root is not available.' };
    } else {
      const file = this.resolve(a.path, { allowMissing: tool.name === 'write_file' });
      if (tool.name === 'write_file') {
        invariant(Buffer.byteLength(a.content) <= MAX_FILE, 'Write exceeds the 256 KiB file-tool limit');
        invariant(file !== this.root, 'Cannot replace the workspace root');
        const previous = this.fileState(file);
        prepared.beforeHash = previous.hash;
        prepared.preview = { path: a.path, beforeHash: previous.hash, afterHash: hash(a.content),
          before: previous.text.slice(0, 6000), after: a.content.slice(0, 6000),
          truncated: previous.text.length > 6000 || a.content.length > 6000 };
      }
    }
    return Object.freeze(prepared);
  }
  async execute(prepared, { signal, emit = () => {} } = {}) {
    if (signal?.aborted) throw abortError();
    const a = prepared.arguments;
    if (prepared.name === 'list_files') {
      const directory = this.resolve(a.path);
      invariant(fs.statSync(directory).isDirectory(), 'Expected a directory');
      const names = fs.readdirSync(directory, { withFileTypes: true });
      return { entries: names.slice(0, 500).map(x => ({ name: x.name,
        type: x.isSymbolicLink() ? 'symlink' : x.isDirectory() ? 'directory' : 'file' })), truncated: names.length > 500 };
    }
    if (prepared.name === 'read_file') {
      const state = this.fileState(this.resolve(a.path));
      invariant(state.hash !== null, 'File does not exist', 'NOT_FOUND', 404);
      return { path: a.path, content: state.text, sha256: state.hash };
    }
    if (prepared.name === 'write_file') {
      const file = this.resolve(a.path, { allowMissing: true });
      const previous = this.fileState(file);
      invariant(previous.hash === prepared.beforeHash, 'File changed since approval was requested; read it again', 'STALE_APPROVAL', 409);
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      this.resolve(path.dirname(a.path));
      const temp = path.join(path.dirname(file), `.agbot-${randomUUID()}.tmp`);
      const fd = fs.openSync(temp, 'wx', previous.mode);
      try { fs.writeFileSync(fd, a.content); fs.fsyncSync(fd); }
      catch (e) { try { fs.unlinkSync(temp); } catch {} throw e; }
      finally { fs.closeSync(fd); }
      try { fs.renameSync(temp, file); } catch (e) { try { fs.unlinkSync(temp); } catch {} throw e; }
      return { path: a.path, beforeHash: previous.hash, afterHash: hash(a.content), bytes: Buffer.byteLength(a.content) };
    }
    return this.shell(a.command, this.resolve(a.cwd), signal, emit);
  }
  shell(command, cwd, signal, emit) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortError());
      const child = spawn('/bin/bash', ['--noprofile', '--norc', '-c', command], {
        cwd, env: cleanEnvironment(this.home), detached: true, stdio: ['ignore', 'pipe', 'pipe']
      });
      let text = '', bytes = 0, truncated = false, timedOut = false, killTimer, settled = false;
      const terminate = () => {
        try { process.kill(-child.pid, 'SIGTERM'); } catch {}
        killTimer ??= setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 750);
        killTimer.unref();
      };
      const timer = setTimeout(() => { timedOut = true; terminate(); }, this.timeoutMs);
      const aborted = () => terminate(); signal?.addEventListener('abort', aborted, { once: true });
      const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
      const consume = kind => chunk => {
        const remaining = Math.max(0, this.maxOutput - bytes);
        const used = chunk.subarray(0, remaining); bytes += used.length;
        if (used.length) { const part = decoders[kind].write(used); text += part; emit('tool.output', { stream: kind, text: part }); }
        if (used.length < chunk.length) truncated = true;
      };
      child.stdout.on('data', consume('stdout')); child.stderr.on('data', consume('stderr'));
      const cleanup = () => { clearTimeout(timer); if (killTimer) clearTimeout(killTimer); signal?.removeEventListener('abort', aborted); };
      child.on('error', error => { if (!settled) { settled = true; cleanup(); reject(error); } });
      child.on('close', (code, terminationSignal) => {
        if (settled) return; settled = true; cleanup();
        if (signal?.aborted) return reject(abortError());
        // Do not manufacture replacement characters for an intentionally truncated UTF-8 suffix.
        if (!truncated) for (const [kind, decoder] of Object.entries(decoders)) {
          const tail = decoder.end(); if (tail) { text += tail; emit('tool.output', { stream: kind, text: tail }); }
        }
        resolve({ exitCode: code, signal: terminationSignal, output: text, truncated, timedOut });
      });
    });
  }
}

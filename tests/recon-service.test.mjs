import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { isLoopbackReconUrl, startLocalRecon } from '../lib/recon-service.mjs';

const LOCAL = { reconApiUrl: 'http://127.0.0.1:8000' };

describe('explicit local ReconAnything startup', () => {
  it('rejects remote/LAN service URLs rather than running local code', async () => {
    assert.equal(isLoopbackReconUrl('http://localhost:8000'), true);
    assert.equal(isLoopbackReconUrl('http://192.168.1.20:8000'), false);
    const result = await startLocalRecon({ reconApiUrl: 'http://192.168.1.20:8000' }, {}, {
      probe: async () => { throw new Error('remote probe must not run'); },
    });
    assert.equal(result.started, false);
    assert.match(result.message, /remote\/LAN/);
  });

  it('does not launch when a scanner is already online', async () => {
    const result = await startLocalRecon(LOCAL, {}, {
      probe: async () => true,
      spawn: () => { throw new Error('must not spawn'); },
    });
    assert.equal(result.ok, true);
    assert.equal(result.started, false);
  });

  it('reports incomplete local installation without starting anything', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'tc-recon-start-'));
    try {
      const dir = path.join(home, 'recon-anything', 'local-run');
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'termux-start.sh'), '#!/bin/bash');
      const result = await startLocalRecon(LOCAL, {}, {
        home, probe: async () => false,
        spawn: () => { throw new Error('must not spawn before setup'); },
      });
      assert.equal(result.started, false);
      assert.match(result.message, /setup is incomplete/);
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it('launches a completed same-device checkout once, waits for health, records pid', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'tc-recon-start-'));
    try {
      const repo = path.join(home, 'recon-anything');
      for (const f of ['local-run/termux-start.sh', '.local-env', '.venv/bin/python',
        'frontend/.next/standalone/server.js']) {
        await mkdir(path.dirname(path.join(repo, f)), { recursive: true });
        await writeFile(path.join(repo, f), 'test');
      }
      let started = false;
      let ready = false;
      let command;
      const spawn = (bin, args, options) => {
        command = { bin, args, options };
        const child = new EventEmitter();
        child.pid = 43210;
        child.unref = () => {};
        queueMicrotask(() => child.emit('spawn'));
        started = true;
        return child;
      };
      const opts = {
        home, probe: async () => ready,
        spawn,
        sleep: async () => { ready = true; },
      };
      const result = await startLocalRecon(LOCAL, {}, opts);
      assert.deepEqual({ ok: result.ok, started: result.started }, { ok: true, started: true });
      assert.equal(started, true);
      assert.equal(command.bin, 'bash');
      assert.equal(command.options.cwd, repo);
      assert.equal(command.options.env.RECON_BIND_HOST, '127.0.0.1');
      assert.equal((await readFile(path.join(home, '.termux-code', 'recon-anything.pid'), 'utf8')).trim(), '43210');
      const again = await startLocalRecon(LOCAL, {}, { ...opts, probe: async () => false, pidAlive: () => true });
      assert.equal(again.started, true);
      assert.equal(started, true);
      assert.match(again.message, /still starting/);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
});

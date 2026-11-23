import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DEVICE_TOOL, runDevice, validateDeviceAction } from '../lib/device.mjs';
import { TOOL_SCHEMA, toolsForOpenAI, runTool } from '../lib/tools.mjs';

describe('Android device tool registration', () => {
  it('is available in native tool schemas and dispatcher', () => {
    assert.ok(TOOL_SCHEMA.some(t => t.name === 'device'));
    assert.equal(toolsForOpenAI().find(t => t.function.name === 'device')?.function.name, DEVICE_TOOL.name);
  });
});

describe('Android device input validation', () => {
  it('rejects unsafe actions and bad inputs', () => {
    for (const [args, fragment] of [
      [{ action: 'shell', text: 'rm -rf' }, 'Unknown'],
      [{ action: 'open_url', url: 'javascript:alert(1)' }, 'HTTP(S)'],
      [{ action: 'open_url', url: 'https://user:pass@example.com' }, 'HTTP(S)'],
      [{ action: 'camera_photo', path: '../secret.jpg' }, 'simple .jpg'],
      [{ action: 'camera_photo', path: '/tmp/out.jpg' }, 'simple .jpg'],
      [{ action: 'camera_photo', path: 'foo.png' }, 'simple .jpg'],
      [{ action: 'camera_photo', path: 'a.jpg', camera_id: -1 }, 'simple .jpg'],
      [{ action: 'location', provider: 'all' }, 'gps or network'],
      [{ action: 'torch', state: 'delete' }, 'on or off'],
      [{ action: 'volume_set', stream: 'music', level: 500 }, '0-15'],
      [{ action: 'vibrate', duration_ms: 10000 }, '1-1000'],
      [{ action: 'call', to: '123; id' }, 'valid phone'],
      [{ action: 'notify', title: 'Hi', text: '' }, 'nonempty'],
      [{ action: 'sms_read', limit: 2000 }, 'between 1 and'],
    ]) assert.match(validateDeviceAction(args).error, new RegExp(fragment), JSON.stringify(args));
  });

  it('does not invoke any command for invalid requests', async () => {
    const out = await runDevice({ action: 'camera_photo', path: '../oops.jpg' }, {}, {
      execFn: async () => { throw Error('unexpected'); },
      commandCheck: async () => { throw Error('unexpected'); },
    });
    assert.match(out, /simple .jpg/);
  });
});

describe('Android device execution and privacy gates', () => {
  it('status reports command availability without claiming permissions are granted', async () => {
    const out = JSON.parse(await runDevice({ action: 'status' }, {}, {
      commandCheck: async cmd => cmd === 'termux-battery-status',
    }));
    assert.equal(out.actions.battery, true);
    assert.equal(out.actions.contacts, false);
    assert.match(out.permissions, /NOT verified/);
    assert.equal(out.root, false);
  });

  it('battery check is read-only and returns bounded output', async () => {
    const seen = [];
    const out = await runDevice({ action: 'battery' }, {}, {
      commandCheck: async () => true,
      execFn: async (cmd, argv) => {
        seen.push([cmd, argv]);
        return { stdout: '{"percentage":85}' };
      },
    });
    assert.equal(out, '{"percentage":85}');
    assert.deepEqual(seen, [['termux-battery-status', []]]);
  });

  it('every sensitive action requires an explicit on-device approval', async () => {
    for (const args of [
      { action: 'clipboard_read' },
      { action: 'clipboard_write', text: 'sample' },
      { action: 'contacts' }, { action: 'notifications' },
      { action: 'sms_read' }, { action: 'location' },
      { action: 'wifi_scan' }, { action: 'camera_photo', path: 'new.jpg' },
      { action: 'notify', title: 'Test', text: 'Message' },
      { action: 'speak', text: 'Hello' }, { action: 'torch', state: 'on' },
      { action: 'vibrate', duration_ms: 100 },
      { action: 'volume_set', stream: 'music', level: 3 },
      { action: 'call', to: '+15551234567' },
      { action: 'open_url', url: 'https://example.com' },
    ]) {
      let count = 0;
      const out = await runDevice(args, { root: os.tmpdir(), approve: async () => false }, {
        commandCheck: async () => true,
        execFn: async () => { count++; throw Error('must not execute'); },
      });
      assert.match(out, /Declined by the user/, args.action);
      assert.equal(count, 0, args.action);
    }
  });

  it('also denies sensitive actions when no approval callback exists', async () => {
    const out = await runDevice({ action: 'contacts' }, {}, {
      commandCheck: async () => true,
      execFn: async () => { throw Error('must not execute'); },
    });
    assert.match(out, /on-device approval required/);
  });

  it('captures camera photos into workspace, never overwrites', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tc-device-'));
    try {
      const calls = [];
      const args = { action: 'camera_photo', path: 'snapshot.jpg', camera_id: 1 };
      const res = await runTool('device', args, {
        root,
        approve: async () => true,
        deviceDeps: {
          commandCheck: async () => true,
          execFn: async (cmd, argv) => {
            calls.push([cmd, argv]);
            await writeFile(path.join(root, 'snapshot.jpg'), 'jpg');
            return { stdout: '' };
          },
        },
      });
      assert.match(res, /photo saved/);
      assert.deepEqual(calls[0], ['termux-camera-photo', ['-c', '1', path.join(root, 'snapshot.jpg')]]);
      const again = await runDevice(args, { root, approve: async () => true }, {
        commandCheck: async () => true,
        execFn: async () => { throw Error('must not overwrite'); },
      });
      assert.match(again, /refuses to overwrite/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('filters contacts and SMS output to requested limit', async () => {
    const entries = Array.from({ length: 40 }, (_, i) => ({ name: 'Person ' + i }));
    const calls = [];
    for (const action of ['contacts', 'sms_read']) {
      const out = JSON.parse(await runDevice({ action, limit: 3 }, {
        root: os.tmpdir(), approve: async () => true,
      }, { commandCheck: async () => true, execFn: async (cmd, argv) => {
        calls.push([cmd, argv]); return { stdout: JSON.stringify(entries) };
      } }));
      assert.equal(out.count, 40);
      assert.equal(out.returned, 3);
      assert.equal(out.records.length, 3);
    }
    assert.deepEqual(calls[1], ['termux-sms-list', ['-l', '3']]);
  });

  it('passes a whitelisted location provider with no shell interpolation', async () => {
    const calls = [];
    await runDevice({ action: 'location', provider: 'network' }, {
      approve: async () => true,
    }, { commandCheck: async () => true, execFn: async (cmd, argv) => {
      calls.push([cmd, argv]); return { stdout: '{}' };
    } });
    assert.deepEqual(calls[0], ['termux-location', ['-p', 'network', '-r', 'once']]);
  });

  it('does not claim an Android action definitely succeeded after submitting', async () => {
    const out = await runDevice({ action: 'call', to: '+15551234567' },
      { approve: async () => true },
      { commandCheck: async () => true, execFn: async () => ({ stdout: '' }) });
    assert.match(out, /submitted/);
    assert.match(out, /may depend/);
  });

  it('reports missing Termux:API binaries instead of pretending it has access', async () => {
    const out = await runDevice({ action: 'camera_info' }, {}, {
      commandCheck: async () => false,
      execFn: async () => { throw Error('should not execute'); },
    });
    assert.match(out, /not installed/);
    assert.match(out, /pkg install termux-api/);
  });
});

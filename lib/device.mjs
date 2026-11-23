/**
 * Permission-aware Android device actions through the official Termux:API
 * bridge. This module does NOT grant Android permissions, bypass sandboxing
 * or acquire root. Every action uses a fixed command with argv (never shell).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
const exec = promisify(execFile);

const MAX_RESULT = 8_000;
const MAX_LIST = 20;
const DEVICE_ACTIONS = [
  'status', 'battery', 'wifi_info', 'wifi_scan', 'camera_info', 'sensor_list', 'volume_get',
  'clipboard_read', 'clipboard_write', 'location', 'contacts', 'notifications',
  'camera_photo', 'notify', 'speak', 'vibrate', 'torch', 'volume_set',
  'open_url', 'call', 'sms_read',
];
const SENSITIVE = new Set([
  'wifi_scan', 'clipboard_read', 'clipboard_write', 'location', 'contacts',
  'notifications', 'camera_photo', 'notify', 'speak', 'vibrate', 'torch',
  'volume_set', 'open_url', 'call', 'sms_read',
]);
const COMMANDS = {
  battery: 'termux-battery-status',
  wifi_info: 'termux-wifi-connectioninfo',
  wifi_scan: 'termux-wifi-scaninfo',
  camera_info: 'termux-camera-info',
  sensor_list: 'termux-sensor',
  volume_get: 'termux-volume',
  clipboard_read: 'termux-clipboard-get',
  clipboard_write: 'termux-clipboard-set',
  location: 'termux-location',
  contacts: 'termux-contact-list',
  notifications: 'termux-notification-list',
  camera_photo: 'termux-camera-photo',
  notify: 'termux-notification',
  speak: 'termux-tts-speak',
  vibrate: 'termux-vibrate',
  torch: 'termux-torch',
  volume_set: 'termux-volume',
  open_url: 'termux-open-url',
  call: 'termux-telephony-call',
  sms_read: 'termux-sms-list',
};
const PHONE = /^\+?[0-9][0-9 ()-]{4,22}$/;
const STREAMS = new Set(['alarm', 'music', 'notification', 'ring', 'system', 'voice_call']);
const clip = (value) => String(value ?? '').slice(0, MAX_RESULT);

export const DEVICE_TOOL = {
  name: 'device',
  description: 'Use real Android features through Termux:API, not imagined device access. Actions: status, battery, wifi_info, wifi_scan, camera_info, sensor_list, volume_get, clipboard_read/write, location, contacts, notifications, camera_photo, notify, speak, vibrate, torch, volume_set, open_url, call, sms_read. Sensitive reads and changes require on-phone approval and Android permission. Call status first when unsure.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: DEVICE_ACTIONS },
      text: { type: 'string', description: 'Clipboard text, notification content, or text to speak.' },
      title: { type: 'string', description: 'Notification title.' },
      path: { type: 'string', description: 'For camera_photo: JPEG filename only within the current workspace.' },
      camera_id: { type: 'integer', description: 'Camera ID, default 0.' },
      provider: { type: 'string', enum: ['gps', 'network'], description: 'Location provider, default network.' },
      state: { type: 'string', enum: ['on', 'off'], description: 'Torch state.' },
      stream: { type: 'string', enum: [...STREAMS], description: 'Android audio stream for volume_set.' },
      level: { type: 'integer', description: 'Volume step, 0-15 (device may support a different range).' },
      duration_ms: { type: 'integer', description: 'Vibration duration, 1-1000 milliseconds.' },
      url: { type: 'string', description: 'HTTP(S) URL to open on the phone.' },
      to: { type: 'string', description: 'Phone number to call.' },
      limit: { type: 'integer', description: 'Maximum contact/notification/SMS items returned, 1-20.' },
    },
    required: ['action'],
  },
};

function within(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

export function validateDeviceAction(args = {}) {
  if (!args || typeof args !== 'object' || !DEVICE_ACTIONS.includes(args.action))
    return { error: 'Unknown device action. Use device(status) to list supported actions.' };
  const { action } = args;
  if (['clipboard_write', 'notify', 'speak'].includes(action) &&
    (typeof args.text !== 'string' || !args.text.trim() || args.text.length > 2000))
    return { error: action + ' needs nonempty text up to 2000 characters.' };
  if (action === 'notify' && (typeof args.title !== 'string' || !args.title.trim() || args.title.length > 100))
    return { error: 'notify needs a title of 1-100 characters.' };
  if (action === 'camera_photo' &&
    (typeof args.path !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}\.(?:jpg|jpeg)$/i.test(args.path) ||
    args.path === '..' || !within(args.camera_id ?? 0, 0, 10)))
    return { error: 'camera_photo needs a simple .jpg filename and camera_id 0-10.' };
  if (action === 'location' && !['gps', 'network'].includes(args.provider ?? 'network'))
    return { error: 'location provider must be gps or network.' };
  if (action === 'torch' && !['on', 'off'].includes(args.state))
    return { error: 'torch state must be on or off.' };
  if (action === 'volume_set' && (!STREAMS.has(args.stream) || !within(args.level, 0, 15)))
    return { error: 'volume_set needs a supported stream and level 0-15.' };
  if (action === 'vibrate' && !within(args.duration_ms, 1, 1000))
    return { error: 'vibrate needs duration_ms 1-1000.' };
  if (action === 'open_url') {
    try {
      const u = new URL(args.url);
      if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password)
        return { error: 'open_url requires a normal HTTP(S) URL without credentials.' };
    } catch { return { error: 'open_url requires a valid HTTP(S) URL.' }; }
  }
  if (action === 'call' && (typeof args.to !== 'string' || !PHONE.test(args.to)))
    return { error: 'call needs a valid phone number.' };
  if (args.limit !== undefined && !within(args.limit, 1, MAX_LIST))
    return { error: 'limit must be between 1 and ' + MAX_LIST + '.' };
  return { ...args, action };
}

async function exists(command, execFn) {
  try {
    await execFn('which', [command], { timeout: 3000 });
    return true;
  } catch { return false; }
}

async function deviceStatus(execFn, commandCheck = exists) {
  const unique = [...new Set(Object.values(COMMANDS))];
  const found = await Promise.all(unique.map(async cmd => [cmd, await commandCheck(cmd, execFn)]));
  const present = Object.fromEntries(found);
  const available = Object.fromEntries(Object.entries(COMMANDS).map(([action, command]) =>
    [action, !!present[command]]));
  return JSON.stringify({
    termuxApiCommandsInstalled: unique.some(cmd => present[cmd]),
    actions: available,
    integration: 'Requires Termux:API Android app and pkg install termux-api, both installed from compatible sources.',
    permissions: 'Availability only checks command installation. Android permissions, notification listener access, and a functioning Termux:API app are NOT verified.',
    root: false,
    deviceControl: 'Restricted by Android app sandbox and the owner-approved permissions; no cross-app UI takeover or arbitrary root access.',
  });
}

function safeResult(stdout, action, limit) {
  const raw = String(stdout ?? '');
  if (['contacts', 'notifications', 'sms_read'].includes(action)) {
    try {
      const records = JSON.parse(raw);
      if (Array.isArray(records)) {
        return JSON.stringify({ count: records.length, returned: Math.min(records.length, limit),
          records: records.slice(0, limit) }).slice(0, MAX_RESULT);
      }
    } catch { /* CLI produced non-JSON error, show clipped text */ }
  }
  return clip(raw);
}

function commandFor(args, root) {
  switch (args.action) {
    case 'sensor_list': return ['termux-sensor', ['-l']];
    case 'location': return ['termux-location', ['-p', args.provider ?? 'network', '-r', 'once']];
    case 'clipboard_write': return ['termux-clipboard-set', [args.text]];
    case 'camera_photo': return ['termux-camera-photo', ['-c', String(args.camera_id ?? 0), path.join(root, args.path)]];
    case 'notify': return ['termux-notification', ['-t', args.title, '-c', args.text]];
    case 'speak': return ['termux-tts-speak', [args.text]];
    case 'vibrate': return ['termux-vibrate', ['-d', String(args.duration_ms)]];
    case 'torch': return ['termux-torch', [args.state]];
    case 'volume_set': return ['termux-volume', [args.stream, String(args.level)]];
    case 'open_url': return ['termux-open-url', [args.url]];
    case 'call': return ['termux-telephony-call', [args.to]];
    case 'sms_read': return ['termux-sms-list', ['-l', String(args.limit ?? 10)]];
    default: return [COMMANDS[args.action], []];
  }
}

function actionDescription(args) {
  const { action } = args;
  switch (action) {
    case 'clipboard_read': return 'Read current clipboard contents (may contain passwords or private text).';
    case 'clipboard_write': return 'Set system clipboard to: ' + args.text.slice(0, 200);
    case 'contacts': return 'Read up to ' + (args.limit ?? 10) + ' saved contacts.';
    case 'notifications': return 'Read up to ' + (args.limit ?? 10) + ' notifications (may contain private messages).';
    case 'sms_read': return 'Read up to ' + (args.limit ?? 10) + ' SMS messages (may contain private information).';
    case 'location': return 'Read current ' + (args.provider ?? 'network') + ' device location.';
    case 'camera_photo': return 'Capture a camera photo and save ' + args.path + ' in current workspace.';
    case 'notify': return 'Display notification: ' + args.title + ' / ' + args.text.slice(0, 100);
    case 'call': return 'Place a cellular call to ' + args.to + ' (carrier fees may apply).';
    case 'open_url': return 'Open Android browser at ' + args.url;
    case 'speak': return 'Speak aloud: ' + args.text.slice(0, 140);
    case 'volume_set': return 'Set ' + args.stream + ' volume to ' + args.level;
    case 'torch': return 'Switch flashlight ' + args.state;
    case 'vibrate': return 'Vibrate phone for ' + args.duration_ms + 'ms';
    case 'wifi_scan': return 'Scan for nearby Wi-Fi networks (may reveal nearby SSIDs/location).';
    default: return 'Use Android capability: ' + action;
  }
}

export async function runDevice(input = {}, ctx = {}, deps = {}) {
  const args = validateDeviceAction(input);
  if (args.error) return args.error;
  const execFn = deps.execFn ?? exec;
  if (args.action === 'status') return deviceStatus(execFn, deps.commandCheck ?? exists);

  const root = path.resolve(ctx.root || process.cwd());
  if (args.action === 'camera_photo') {
    // The target must not be a symlink or pre-existing file, even when a
    // model proposes a filename that resolves inside a writable workspace.
    const output = path.join(root, args.path);
    try {
      const stat = await fs.lstat(output);
      if (stat) return 'camera_photo refuses to overwrite an existing file. Choose a new .jpg filename.';
    } catch (err) {
      if (err.code !== 'ENOENT') return 'Cannot validate photo output path: ' + err.message;
    }
  }
  const [cmd, argv] = commandFor(args, root);
  if (!(await (deps.commandCheck ?? exists)(cmd, execFn)))
    return cmd + ' is not installed. Install the matching Termux:API Android app and run pkg install termux-api. Grant permissions in Android Settings.';

  if (SENSITIVE.has(args.action)) {
    if (typeof ctx.approve !== 'function') return 'Declined: on-device approval required.';
    if (!await ctx.approve('Android: ' + args.action, actionDescription(args)))
      return 'Declined by the user; Android device action was not executed.';
  }
  try {
    const { stdout } = await execFn(cmd, argv, { cwd: root, timeout: 15_000, maxBuffer: 250_000 });
    const limit = args.limit ?? 10;
    if (args.action === 'camera_photo') {
      const dest = path.join(root, args.path);
      if (!(await (deps.fileCheck ?? existsFile)(dest)))
        return 'Camera command completed but the photo file was not created. Check camera permissions.';
      return 'Camera photo saved in workspace: ' + args.path;
    }
    if (['call', 'notify', 'open_url', 'speak', 'clipboard_write', 'vibrate', 'torch', 'volume_set'].includes(args.action))
      return 'Android action submitted: ' + args.action + '. Device-side completion may depend on permissions/system settings.';
    return safeResult(stdout, args.action, limit);
  } catch (err) {
    return args.action + ' unavailable: ' + clip(err.message).slice(0, 250) +
      '. Check Termux:API app installation, Android permissions and battery restrictions.';
  }
}

async function existsFile(file) {
  try { return (await fs.stat(file)).isFile(); } catch { return false; }
}

/**
 * Opt-in Android phone bridge.
 * Requires the Termux:API Android app + pkg install termux-api.
 * No third-party account/number creation is implied by the phone bridge.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const PHONE = /^\+?[0-9][0-9 ()-]{4,22}$/;
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export function validatePhoneAction(args = {}) {
  if (!args || typeof args !== 'object') return { error: 'Expected phone action arguments.' };
  const action = args.action;
  if (!['status', 'own_number', 'send_sms', 'compose_email'].includes(action))
    return { error: 'action must be status, own_number, send_sms, or compose_email.' };
  if (action === 'send_sms') {
    if (typeof args.to !== 'string' || !PHONE.test(args.to)) return { error: 'Valid phone number required.' };
    if (typeof args.message !== 'string' || !args.message.trim() || args.message.length > 1600)
      return { error: 'SMS message must contain 1–1600 characters.' };
  }
  if (action === 'compose_email') {
    if (typeof args.to !== 'string' || !EMAIL.test(args.to) || args.to.length > 254)
      return { error: 'Valid recipient email required.' };
    if (typeof args.subject !== 'string' || args.subject.length > 250 ||
        typeof args.message !== 'string' || args.message.length > 10000)
      return { error: 'Provide a subject (up to 250 characters) and message (up to 10000 characters).' };
  }
  return { action, to: args.to, message: args.message, subject: args.subject };
}

async function commandExists(cmd, execFn) {
  try { await execFn('which', [cmd], { timeout: 5000 }); return true; } catch { return false; }
}

export async function runPhone(args, ctx = {}, deps = {}) {
  const clean = validatePhoneAction(args);
  if (clean.error) return clean.error;
  const execFn = deps.execFn || exec;
  const approve = ctx.approve || (async () => false);
  if (clean.action === 'status') {
    const [api, sms, number, email] = await Promise.all([
      commandExists('termux-battery-status', execFn),
      commandExists('termux-sms-send', execFn),
      commandExists('termux-telephony-deviceinfo', execFn),
      commandExists('termux-open-url', execFn),
    ]);
    return JSON.stringify({ termuxApiInstalled: api, smsAvailable: sms, telephonyInfoAvailable: number, emailComposerAvailable: email,
      note: 'Android permissions and a configured SMS/email app are also required. A phone cannot manufacture a new carrier phone number.' });
  }
  if (clean.action === 'own_number') {
    if (!await commandExists('termux-telephony-deviceinfo', execFn))
      return 'Install Termux:API and pkg install termux-api to read permitted telephony metadata.';
    if (!await approve('Read phone information', 'Access Android telephony metadata; the carrier may not expose the number.'))
      return 'Declined by the user.';
    try {
      const { stdout } = await execFn('termux-telephony-deviceinfo', [], {timeout:12000});
      const data = JSON.parse(stdout);
      const number = data.phone_number || data.line1_number || null;
      return JSON.stringify({number, note: number ? 'Reported by Android telephony API.' : 'Phone number not supplied by Android/carrier.'});
    } catch (e) { return 'Phone information unavailable: ' + String(e.message || e).slice(0,150); }
  }
  if (clean.action === 'send_sms') {
    if (!await commandExists('termux-sms-send', execFn))
      return 'SMS unavailable. Install Termux:API plus pkg install termux-api; grant Android SMS permission.';
    if (!await approve('Send SMS', 'To: ' + clean.to + '\nMessage: ' + clean.message))
      return 'Declined by the user; no SMS sent.';
    try {
      await execFn('termux-sms-send', ['-n', clean.to, clean.message], {timeout:20000});
      return 'SMS command submitted to Android for ' + clean.to + '. Delivery is not confirmed.';
    } catch (e) { return 'SMS failed: ' + String(e.message || e).slice(0,150); }
  }
  if (!await commandExists('termux-open-url', execFn))
    return 'Email composer unavailable. Install termux-tools and configure an email app.';
  if (!await approve('Open email draft', 'To: ' + clean.to + '\nSubject: ' + clean.subject + '\nBody: ' + clean.message.slice(0,400)))
    return 'Declined by the user; email composer not opened.';
  const uri = 'mailto:' + encodeURIComponent(clean.to) + '?subject=' +
    encodeURIComponent(clean.subject) + '&body=' + encodeURIComponent(clean.message);
  try {
    await execFn('termux-open-url', [uri], {timeout:12000});
    return 'Email draft opened in an Android app. Nothing has been sent; review and send it there.';
  } catch (e) { return 'Email composer could not open: ' + String(e.message || e).slice(0,150); }
}

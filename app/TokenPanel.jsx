'use client';

import { useState } from 'react';

/**
 * Gateway token manager. Minting does not revoke previous signed tokens.
 * It reveals the new plaintext once, together
 * with the full Termux install command that carries it.
 */
export default function TokenPanel({ site, existing }) {
  const [token, setToken] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [revoked, setRevoked] = useState(false);
  const [copied, setCopied] = useState('');

  // Read as text first: if the server ever answers a non-JSON body
  // (the old failure mode on runtimes without a token store), report the
  // status instead of leaking a JSON-parse error into the UI.
  async function readJson(res) {
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  async function mint() {
    setBusy(true);
    setError('');
    setCopied('');
    try {
      const res = await fetch('/api/auth/token', { method: 'POST' });
      const data = await readJson(res);
      if (!res.ok || !data?.token)
        throw new Error(data?.error?.message || `Mint failed (server returned ${res.status}).`);
      setToken(data.token);
      setRevoked(false);
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/auth/token', { method: 'DELETE' });
      const data = await readJson(res);
      if (!res.ok)
        throw new Error(data?.error?.message || `Revoke failed (server returned ${res.status}).`);
      setToken(null);
      setRevoked(true);
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      setBusy(false);
    }
  }

  async function copy(text, which) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
    } catch {
      setError('Copy failed — long-press the command to copy it by hand.');
    }
  }

  const command = token
    ? `pkg install nodejs git\ncurl -fsSL ${site}/install.sh | TERMUX_CODE_GATEWAY=${site} TERMUX_CODE_TOKEN=${token} bash\ntermux-code`
    : null;

  return (
    <div>
      {existing?.length > 0 && !token && !revoked && (
        <p className="note">
          Stored legacy token: <code className="tokenline">{existing[0].prefix}…</code> (created{' '}
          {new Date(existing[0].createdAt).toLocaleString()}
          {existing[0].lastUsedAt
            ? `, last used ${new Date(existing[0].lastUsedAt).toLocaleString()}`
            : ', never used yet'}
          ). Its full value can&rsquo;t be shown again — mint a new one if needed; minting does not invalidate the old one.
        </p>
      )}
      {revoked && (
        <p className="note">
          Stored legacy tokens were revoked. Signed tokens remain valid until expiry or signing-secret rotation.
        </p>
      )}
      <div className="btnrow">
        <button type="button" className="btn primary" onClick={mint} disabled={busy}>
          {token || existing?.length ? 'Mint a new gateway token' : 'Mint a gateway token'}
        </button>
        {existing?.length > 0 && (
          <button type="button" className="btn" onClick={revoke} disabled={busy}>
            Revoke stored tokens
          </button>
        )}
      </div>
      <p className="note">Signed gateway tokens are not individually revocable here. Minting a replacement does not invalidate previous signed tokens. Rotate the gateway signing secret to invalidate them.</p>
      {error && <p className="note">{error}</p>}
      {command && (
        <>
          <div className="install">
            <code>{command}</code>
          </div>
          <div className="copyrow">
            <button type="button" className="btn primary big" onClick={() => copy(command, 'command')}>
              Copy the command
            </button>
            {copied === 'command' && <span className="copied">Copied.</span>}
          </div>
          <p className="note">
            Copy it now — this is the only time the full token is shown. Anyone
            with it can use this gateway as you, so treat it like a password.
          </p>
        </>
      )}
    </div>
  );
}

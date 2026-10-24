'use client';

import { useState } from 'react';

/**
 * Gateway token manager. Minting replaces the previous token (one active
 * token per owner) and reveals the new plaintext exactly once, together
 * with the full Termux install command that carries it.
 */
export default function TokenPanel({ site, existing }) {
  const [token, setToken] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [revoked, setRevoked] = useState(false);

  async function mint() {
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/auth/token', { method: 'POST' });
      const data = await res.json();
      if (!res.ok || !data.token) throw new Error(data?.error?.message || 'Minting failed.');
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
      if (!res.ok) throw new Error('Revoke failed.');
      setToken(null);
      setRevoked(true);
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      setBusy(false);
    }
  }

  const command = token
    ? `pkg install nodejs git\ncurl -fsSL ${site}/install.sh | TERMUX_CODE_GATEWAY=${site} TERMUX_CODE_TOKEN=${token} bash\ntermux-code`
    : null;

  return (
    <div>
      {existing?.length > 0 && !token && !revoked && (
        <p className="note">
          Active token: <code>{existing[0].prefix}…</code> (created{' '}
          {new Date(existing[0].createdAt).toLocaleString()}
          {existing[0].lastUsedAt
            ? `, last used ${new Date(existing[0].lastUsedAt).toLocaleString()}`
            : ', never used yet'}
          ). Its full value can&rsquo;t be shown again — mint a new one to
          replace it.
        </p>
      )}
      {revoked && <p className="note">Token revoked. The phone CLI can no longer use the gateway until you mint a new one.</p>}
      <p>
        <button type="button" onClick={mint} disabled={busy}>
          {token || existing?.length ? 'Mint a new gateway token' : 'Mint a gateway token'}
        </button>{' '}
        {existing?.length > 0 && (
          <button type="button" onClick={revoke} disabled={busy}>
            Revoke token
          </button>
        )}
      </p>
      {error && <p className="note">{error}</p>}
      {command && (
        <div className="install">
          <code style={{ whiteSpace: 'pre-wrap' }}>{command}</code>
        </div>
      )}
      {token && (
        <p className="note">
          Copy it now — this is the only time the full token is shown. Anyone
          with it can use this gateway as you, so treat it like a password.
        </p>
      )}
    </div>
  );
}

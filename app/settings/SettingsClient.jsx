'use client';

import { useEffect, useState } from 'react';

const STORAGE_KEY = 'termux-code:model';
const NO_TOOLS = new Set(['gemini', 'cohere', 'horde']);

export default function Settings() {
  const [models, setModels] = useState([]);
  const [selected, setSelected] = useState(null);
  const [filter, setFilter] = useState('');
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState('');
  const [pinned, setPinned] = useState(null);
  const [pinBusy, setPinBusy] = useState(null);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) setSelected(JSON.parse(saved));
    } catch {
      /* no saved choice yet */
    }

    fetch('/api/models')
      .then((r) => r.json())
      .then((data) => {
        if (data.error) throw new Error(data.error);
        setModels(data.models || []);
        setStatus('ready');
      })
      .catch((err) => {
        setError(err.message);
        setStatus('failed');
      });
  }, []);

  function choose(model) {
    setSelected(model);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(model));
  }

  async function pin(model) {
    setPinBusy(model.id);
    try {
      const res = await fetch('/api/models/prefs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinned: model.id, disabled: [] }),
      });
      const data = await res.json();
      if (data.ok) setPinned(model.id);
    } finally {
      setPinBusy(null);
    }
  }

  const needle = filter.trim().toLowerCase();
  const visible = needle
    ? models.filter(
        (m) =>
          m.label.toLowerCase().includes(needle) ||
          m.id.toLowerCase().includes(needle) ||
          (m.providerLabel || m.provider).toLowerCase().includes(needle)
      )
    : models;

  const grouped = visible.reduce((acc, m) => {
    (acc[m.source] ||= []).push(m);
    return acc;
  }, {});

  const sourceCopy = {
    direct: 'Called straight from this deployment with the provider keys set in Vercel.',
    'error-inbox': "Error Inbox's own live pool, with recent success/fail counts from its health log. Pinning here changes its rotation for every agent, not just this session.",
  };

  return (
    <main>
      <p className="lede">Choose a model.</p>
      <p className="sub">
        Your pick is saved here and read by the terminal on its next start.
        Everything below is queried live, so it reflects what&rsquo;s actually
        reachable right now, not a fixed list.
      </p>

      <input
        className="field"
        placeholder="Filter by name or provider"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        aria-label="Filter models"
      />

      {status === 'loading' && <p className="state">Loading the catalogue.</p>}

      {status === 'failed' && (
        <p className="state bad">
          Couldn&rsquo;t reach the catalogue: {error}. Check the provider keys
          and ERROR_INBOX_URL in your environment variables, then reload.
        </p>
      )}

      {status === 'ready' && models.length === 0 && (
        <p className="state">
          No models are reachable. No provider keys are set, and Error Inbox
          didn&rsquo;t answer either.
        </p>
      )}

      {status === 'ready' && models.length > 0 && visible.length === 0 && (
        <p className="state">Nothing matches &ldquo;{filter}&rdquo;. Try a shorter word.</p>
      )}

      {Object.entries(grouped).map(([source, list]) => (
        <section className="group" key={source}>
          <div className="group-head">
            <span>{source}</span>
            <span>{list.length}</span>
          </div>
          {sourceCopy[source] && <p style={{ marginTop: 0 }}>{sourceCopy[source]}</p>}
          <div className="rows">
            {list.map((m) => {
              const active = selected && selected.id === m.id && selected.source === m.source;
              // capabilities.tools comes from the gateway itself; fall back to
              // the old hardcoded set for older deployments.
              const noTools = m.capabilities ? !m.capabilities.tools : NO_TOOLS.has(m.provider);
              return (
                <button
                  className="row"
                  key={`${m.source}:${m.id}`}
                  data-active={active ? 'true' : 'false'}
                  onClick={() => choose(m)}
                  aria-pressed={active}
                >
                  <span className="pip" aria-hidden="true">
                    ●
                  </span>
                  <span>
                    <span className="name">{m.label}</span>
                    <span className="meta">
                      {m.providerLabel || m.provider} · {m.id}
                      {noTools && ' · chat only, no file access'}
                      {m.stats && ` · ${m.stats.ok}/${m.stats.ok + m.stats.fail} recent`}
                    </span>
                  </span>
                  {m.free && <span className="free">free</span>}
                  {source === 'error-inbox' && (
                    <span
                      role="button"
                      tabIndex={0}
                      className="free"
                      style={{ color: pinned === m.id ? 'var(--amber)' : 'var(--dim)' }}
                      onClick={(e) => {
                        e.stopPropagation();
                        pin(m);
                      }}
                    >
                      {pinBusy === m.id ? 'pinning…' : pinned === m.id ? 'pinned' : 'pin'}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </section>
      ))}

      {selected && (
        <section className="block" style={{ marginTop: '3rem' }}>
          <h2>Selected</h2>
          <p>
            {selected.label} from {selected.providerLabel || selected.provider}. Run{' '}
            <code>/model</code> in the terminal to change it there too.
          </p>
        </section>
      )}
    </main>
  );
}

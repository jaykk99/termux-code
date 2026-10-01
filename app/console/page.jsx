'use client';

import { useEffect, useRef, useState } from 'react';

const HISTORY_KEY = 'termux-code:console-history';
const MODEL_KEY = 'termux-code:model';
const MAX_HISTORY = 50;

/* ---------- tiny syntax highlighter: no deps, regex tokenizer ---------- */

const KEYWORDS = new Set(
  'const let var function return if else for while do switch case break continue new class extends import from export default async await try catch finally throw typeof instanceof in of null undefined true false this self def lambda yield with as pass elif except raise print echo cd ls cat grep sed awk curl git npm node python pip pkg sudo fi then done'.split(' ')
);

function tokenize(code) {
  // strings, comments, numbers, then keywords — order matters
  const re = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|\/\/[^\n]*|#[^\n]*|\b\d[\d_]*(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*/g;
  const out = [];
  let last = 0;
  let m;
  while ((m = re.exec(code))) {
    if (m.index > last) out.push({ t: 'plain', s: code.slice(last, m.index) });
    const s = m[0];
    let cls = 'tok';
    if (/^["'`]/.test(s)) cls = 'str';
    else if (/^(\/\/|#)/.test(s)) cls = 'com';
    else if (/^\d/.test(s)) cls = 'num';
    else if (KEYWORDS.has(s)) cls = 'kw';
    out.push({ t: cls, s });
    last = m.index + s.length;
  }
  if (last < code.length) out.push({ t: 'plain', s: code.slice(last) });
  return out;
}

function CodeBlock({ lang, code }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  }
  return (
    <div className="cblock">
      <div className="cblock-head">
        <span>{lang || 'code'}</span>
        <button type="button" onClick={copy}>{copied ? 'copied' : 'copy'}</button>
      </div>
      <pre>
        <code>
          {tokenize(code).map((tok, i) =>
            tok.t === 'plain' ? <span key={i}>{tok.s}</span> : <span key={i} className={tok.t}>{tok.s}</span>
          )}
        </code>
      </pre>
    </div>
  );
}

/* ---------- markdown-ish rendering: code fences + inline code ---------- */

function MessageBody({ text }) {
  const parts = String(text || '').split(/```(\w*)\n?([\s\S]*?)```/g);
  const out = [];
  for (let i = 0; i < parts.length; i += 3) {
    const prose = parts[i];
    if (prose) {
      out.push(
        <p key={i} className="prose">
          {prose.split(/(`[^`]+`)/g).map((seg, j) =>
            /^`[^`]+`$/.test(seg) ? <code key={j}>{seg.slice(1, -1)}</code> : <span key={j}>{seg}</span>
          )}
        </p>
      );
    }
    if (parts[i + 2] !== undefined) {
      out.push(<CodeBlock key={i + 1} lang={parts[i + 1]} code={parts[i + 2].replace(/\n$/, '')} />);
    }
  }
  return <>{out}</>;
}

/* ---------- console ---------- */

export default function Console() {
  const [models, setModels] = useState([]);
  const [modelId, setModelId] = useState('');
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState('');
  const [history, setHistory] = useState([]);
  const [showHistory, setShowHistory] = useState(false);
  const abortRef = useRef(null);
  const logRef = useRef(null);

  useEffect(() => {
    try {
      const h = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
      if (Array.isArray(h)) setHistory(h);
      const saved = JSON.parse(localStorage.getItem(MODEL_KEY) || 'null');
      if (saved?.id) setModelId(saved.id + '|' + saved.source);
    } catch {
      /* fresh start */
    }
    fetch('/api/models')
      .then((r) => r.json())
      .then((data) => {
        if (!data.ok) throw new Error(data.error?.message || 'Catalogue unavailable.');
        setModels(data.models || []);
        setStatus('ready');
      })
      .catch((err) => {
        setError(err.message);
        setStatus('failed');
      });
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [messages]);

  const grouped = models.reduce((acc, m) => {
    (acc[m.source] ||= []).push(m);
    return acc;
  }, {});
  const selected = models.find((m) => m.id + '|' + m.source === modelId);

  function saveHistory(entry) {
    setHistory((prev) => {
      const next = [entry, ...prev].slice(0, MAX_HISTORY);
      try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
      } catch {
        /* storage full or unavailable */
      }
      return next;
    });
  }

  async function send() {
    const prompt = input.trim();
    if (!prompt || busy) return;
    if (!selected) {
      setError('Pick a model first.');
      return;
    }
    setError('');
    setInput('');
    const turn = [{ role: 'user', content: prompt }];
    setMessages((prev) => [...prev, ...turn, { role: 'assistant', content: '', pending: true }]);
    setBusy(true);

    const ctl = new AbortController();
    abortRef.current = ctl;
    const started = Date.now();
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ctl.signal,
        body: JSON.stringify({
          model: { id: selected.id, provider: selected.provider, source: selected.source },
          messages: turn,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error?.message || `Gateway returned ${res.status}.`);
      const reply = data.text || '(empty reply)';
      setMessages((prev) => {
        const next = [...prev];
        next[next.length - 1] = { role: 'assistant', content: reply, truncated: data.truncated };
        return next;
      });
      saveHistory({
        at: new Date().toISOString(),
        ms: Date.now() - started,
        model: selected.label,
        modelId: selected.id,
        prompt: prompt.slice(0, 300),
        reply: reply.slice(0, 500),
        ok: true,
      });
    } catch (err) {
      const failed = err.name === 'AbortError' ? 'Cancelled.' : err.message;
      setMessages((prev) => {
        const next = [...prev];
        next[next.length - 1] = { role: 'error', content: failed };
        return next;
      });
      saveHistory({
        at: new Date().toISOString(),
        ms: Date.now() - started,
        model: selected.label,
        modelId: selected.id,
        prompt: prompt.slice(0, 300),
        reply: failed.slice(0, 500),
        ok: false,
      });
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  function clearHistory() {
    setHistory([]);
    try {
      localStorage.removeItem(HISTORY_KEY);
    } catch {
      /* noop */
    }
  }

  return (
    <main>
      <p className="lede">Gateway console.</p>
      <p className="sub">
        Talk to the gateway the way the Termux CLI does — one completion, no
        tools. Handy for checking a model answers before you burn a whole
        coding session on it.
      </p>

      {status === 'loading' && <p className="state">Loading the catalogue.</p>}
      {status === 'failed' && <p className="state bad">Couldn&rsquo;t reach the catalogue: {error}</p>}

      {status === 'ready' && (
        <>
          <label className="lbl" htmlFor="console-model">Model</label>
          <select
            id="console-model"
            className="field"
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
          >
            <option value="">— pick a model —</option>
            {Object.entries(grouped).map(([source, list]) => (
              <optgroup key={source} label={source}>
                {list.map((m) => (
                  <option key={`${m.source}:${m.id}`} value={`${m.id}|${m.source}`}>
                    {m.label}{m.capabilities && !m.capabilities.tools ? ' · chat only' : ''}{m.free ? ' · free' : ''}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>

          <div className="clog" ref={logRef} aria-live="polite">
            {messages.length === 0 && (
              <p className="state">No turns yet. Type below and hit send.</p>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`cturn ${m.role}`}>
                <div className="cturn-head">{m.role === 'user' ? '› you' : m.role === 'error' ? '✕ error' : '› model'}</div>
                {m.pending ? (
                  <p className="state">thinking…</p>
                ) : m.role === 'error' ? (
                  <p className="cerror">{m.content}</p>
                ) : (
                  <>
                    <MessageBody text={m.content} />
                    {m.truncated && <p className="cnote">Output was truncated at the gateway limit.</p>}
                  </>
                )}
              </div>
            ))}
          </div>

          {error && !busy && <p className="state bad">{error}</p>}

          <div className="crow">
            <textarea
              className="field cinput"
              rows={3}
              placeholder={selected ? `Message ${selected.label}…` : 'Pick a model above first…'}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send();
              }}
              aria-label="Message"
            />
            <div className="cbtns">
              {busy ? (
                <button type="button" className="btn danger" onClick={stop}>stop</button>
              ) : (
                <button type="button" className="btn" onClick={send} disabled={!input.trim() || !selected}>send</button>
              )}
              <button type="button" className="btn ghost" onClick={() => setMessages([])} disabled={busy}>clear</button>
            </div>
          </div>
          <p className="note">Ctrl/⌘+Enter sends. History is kept on this device only.</p>

          <section className="block">
            <h2>
              <button
                type="button"
                className="h2btn"
                onClick={() => setShowHistory((v) => !v)}
                aria-expanded={showHistory}
              >
                Request history ({history.length}) {showHistory ? '▾' : '▸'}
              </button>
            </h2>
            {showHistory && (
              <>
                {history.length === 0 && <p className="state">Nothing yet.</p>}
                {history.length > 0 && (
                  <button type="button" className="btn ghost small" onClick={clearHistory}>clear history</button>
                )}
                <div className="rows">
                  {history.map((h, i) => (
                    <div className="row hrow" key={i}>
                      <span className="pip" style={{ color: h.ok ? 'var(--sky)' : 'var(--rose)' }} aria-hidden="true">●</span>
                      <span>
                        <span className="name">{h.prompt}</span>
                        <span className="meta">
                          {new Date(h.at).toLocaleString()} · {h.model} · {(h.ms / 1000).toFixed(1)}s
                        </span>
                        <span className="meta">{h.reply}</span>
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </section>
        </>
      )}
    </main>
  );
}

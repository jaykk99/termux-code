'use client';

import { useRef, useState } from 'react';

/**
 * The chatbot UI. Sends the conversation to /api/bot/chat (session cookie
 * rides along automatically) and renders the reply plus the tool steps the
 * server executed, so nothing the agent did stays invisible.
 */
export default function ChatClient() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [meta, setMeta] = useState(null);
  const boxRef = useRef(null);

  async function send(e) {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    const next = [...messages, { role: 'user', content: text }];
    setMessages(next);
    setInput('');
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/bot/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: next }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        throw new Error(data?.error?.message || `Chat failed (${res.status}).`);
      }
      setMessages([...next, { role: 'assistant', content: data.text || '(no reply)' }]);
      setMeta({ model: data.model, steps: data.steps || [], attempts: data.attempts || [] });
      requestAnimationFrame(() => boxRef.current?.scrollTo(0, boxRef.current.scrollHeight));
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="chatbox" ref={boxRef}>
        {messages.length === 0 && (
          <p className="note">
            Ask for something real: &ldquo;list my GitHub repos&rdquo;,
            &ldquo;what&rsquo;s my Venice balance&rdquo;, &ldquo;run uname -a
            on the server&rdquo;, &ldquo;generate an image of …&rdquo; (the
            Venice skills teach it how).
          </p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={m.role === 'user' ? 'msg user' : 'msg assistant'}>
            <span className="msgrole">{m.role === 'user' ? 'you' : 'bot'}</span>
            <span style={{ whiteSpace: 'pre-wrap' }}>{m.content}</span>
          </div>
        ))}
        {busy && <p className="note">Working… (tools can take a moment)</p>}
      </div>

      {meta && (
        <div className="note">
          <p>
            Answered by {meta.model?.provider}/{meta.model?.id}
            {meta.attempts?.length > 1 &&
              ` after ${meta.attempts.length} attempt(s): ${meta.attempts
                .map((a) => `${a.provider}/${a.modelId} ${a.ok ? 'ok' : 'failed'}`)
                .join(' · ')}`}
          </p>
          {meta.steps?.length > 0 && (
            <details>
              <summary>{meta.steps.length} tool call(s)</summary>
              {meta.steps.map((s, i) => (
                <div key={i}>
                  <code>
                    {s.tool} {s.args}
                  </code>
                  <pre style={{ whiteSpace: 'pre-wrap' }}>{s.result}</pre>
                </div>
              ))}
            </details>
          )}
        </div>
      )}
      {error && <p className="note">{error}</p>}

      <form onSubmit={send} className="composer">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Message the chatbot…"
          disabled={busy}
        />
        <button type="submit" disabled={busy || !input.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}

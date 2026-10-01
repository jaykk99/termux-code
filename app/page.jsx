import { listModels } from '../lib/models.mjs';

export const dynamic = 'force-dynamic';

export default async function Home() {
  let count = 0;
  let sources = [];
  try {
    const models = await listModels();
    count = models.length;
    sources = [...new Set(models.map((m) => m.source))];
  } catch {
    /* the page still works with an empty catalogue */
  }

  return (
    <main>
      <p className="lede">A coding agent that lives in your phone&rsquo;s terminal.</p>
      <p className="sub">
        Install it in Termux, point it at this deployment, and it runs your models
        with read, edit, grep and shell access to whatever folder you launch it in.
        Nothing writes to disk or runs a command until you say yes.
      </p>

      <div className="install">
        <code>
          <span className="caret">$</span>
          curl -fsSL {process.env.NEXT_PUBLIC_SITE_URL || 'https://termux-code.vercel.app'}
          /install.sh | bash
        </code>
      </div>
      <p className="note">
        Needs Node 18 or newer. Run <code>pkg install nodejs git</code> first if you
        haven&rsquo;t.
      </p>

      <section className="block">
        <h2>Models</h2>
        <p>
          {count > 0
            ? `${count} models are reachable right now, from ${sources.join(', ')}.`
            : 'No models are reachable yet. Kilo, LLM7 and AI Horde need no key at all — set ERROR_INBOX_URL to at least see those.'}
        </p>
        <p>
          Pick one in <a href="/settings">settings</a>, or type <code>/model</code> in
          the terminal to switch mid-session. Three providers work with zero setup;
          everything else turns on the moment its key is set in Vercel.
        </p>
      </section>

      <section className="block">
        <h2>Why the keys live here</h2>
        <p>
          The CLI asks this deployment for completions instead of calling providers
          directly. Your Groq, Cerebras, NVIDIA, Anthropic and other keys stay in
          Vercel&rsquo;s environment, so a phone that gets lost doesn&rsquo;t take them
          with it.
        </p>
        <p>
          Tools still run locally. Your code never leaves the device except as the
          snippets the model asks to read. Two providers here — Gemini and Cohere —
          answer in chat only; their function-calling shape differs enough from
          OpenAI&rsquo;s that wiring it in without a live key to test against risked
          shipping it wrong, so those two can&rsquo;t touch files for now.
        </p>
      </section>

      <section className="block">
        <h2>Your Error Inbox agent</h2>
        <p>
          <code>/ask &lt;message&gt;</code> sends straight to your Error Inbox agent
          instead — its own tools, its own model routing, the same brain behind its
          in-app DM. It can&rsquo;t touch this phone&rsquo;s files; for that, use{' '}
          <code>/model</code> instead. Mint a key on Error Inbox&rsquo;s Settings page
          and save it with <code>/inbox-key &lt;token&gt;</code>.
        </p>
      </section>

      <section className="block">
        <h2>Try the gateway</h2>
        <p>
          The <a href="/console">console</a> talks to the gateway exactly the
          way the Termux CLI does — pick a model, send one message, see the
          reply. Useful for checking a model answers before you commit a whole
          coding session to it.
        </p>
      </section>

      <section className="block">
        <h2>Commands</h2>
        <p>
          <code>/model</code> switch model, <code>/models</code> list everything,{' '}
          <code>/ask</code> message your Error Inbox agent, <code>/inbox-key</code>{' '}
          save its API key, <code>/gateway</code> point at a different deployment,{' '}
          <code>/clear</code> start over, <code>/cwd</code> show the workspace root.
        </p>
      </section>
    </main>
  );
}

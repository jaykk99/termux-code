import { cookies } from 'next/headers';
import {
  sessionFromCookieValue,
  SESSION_COOKIE,
  oauthConfigured,
} from '../lib/auth.mjs';
import { listModels } from '../lib/models.mjs';

export const dynamic = 'force-dynamic';

/**
 * The hosted app is single-owner. Anonymous visitors get the sign-in
 * screen and nothing else — no catalogue, no console, no content. The
 * owner lands on a small dashboard linking the chatbot, the console and
 * settings.
 */
export default async function Home() {
  const store = await cookies();
  const session = sessionFromCookieValue(store.get(SESSION_COOKIE)?.value);

  if (!session) {
    return (
      <main>
        <p className="lede">termux-code, hosted.</p>
        <p className="sub">
          A private chatbot and phone gateway for one owner. Sign in with the
          owner&rsquo;s GitHub account to continue.
        </p>
        {oauthConfigured() ? (
          <p>
            <a className="signin" href="/api/auth/github">
              Sign in with GitHub
            </a>
          </p>
        ) : (
          <p className="note">
            GitHub sign-in is not configured on this deployment yet. The owner
            needs to create a GitHub OAuth app (callback:{' '}
            <code>/api/auth/callback</code>) and set{' '}
            <code>GITHUB_OAUTH_CLIENT_ID</code> and{' '}
            <code>GITHUB_OAUTH_CLIENT_SECRET</code>.
          </p>
        )}
      </main>
    );
  }

  let count = 0;
  try {
    count = (await listModels()).length;
  } catch {
    /* dashboard still renders with no catalogue */
  }

  return (
    <main>
      <p className="lede">Signed in as {session.login}.</p>
      <p className="sub">
        {count > 0 ? `${count} models are reachable right now. ` : ''}
        The chatbot runs Venice first, with GitHub, terminal, web and Venice
        API tools behind this sign-in. The phone CLI reaches the same models
        through the gateway with the token from the chat page.
      </p>

      <section className="block">
        <h2>
          <a href="/chat">Chatbot</a>
        </h2>
        <p>
          Chat with tools, plus the Termux connect command and gateway token
          for your phone.
        </p>
      </section>

      <section className="block">
        <h2>
          <a href="/console">Console</a>
        </h2>
        <p>One-shot gateway check: pick a model, send one message.</p>
      </section>

      <section className="block">
        <h2>
          <a href="/settings">Settings</a>
        </h2>
        <p>Pin or disable models on the Error Inbox pool.</p>
      </section>

      <form method="POST" action="/api/auth/logout">
        <button className="signout" type="submit">
          Sign out
        </button>
      </form>
    </main>
  );
}

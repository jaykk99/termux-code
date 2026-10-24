import { cookies, headers } from 'next/headers';
import {
  sessionFromCookieValue,
  SESSION_COOKIE,
  oauthConfigured,
  listGatewayTokens,
} from '../lib/auth.mjs';
import TokenPanel from './TokenPanel.jsx';

export const dynamic = 'force-dynamic';

/**
 * The whole website is a gate, nothing more. Anonymous visitors get the
 * sign-in screen and nothing else — no catalogue, no content, and no chat:
 * the chat lives in Termux on the owner's phone. After sign-in this page
 * is the Termux command page: the copy-paste install command carrying the
 * owner's gateway token, plus the token manager. The token itself is only
 * ever revealed by the mint button (POST /api/auth/token), never rendered
 * into this page's HTML from the store.
 */
export default async function Home() {
  const store = await cookies();
  const session = sessionFromCookieValue(store.get(SESSION_COOKIE)?.value);

  if (!session) {
    return (
      <main>
        <p className="lede">
          termux-code<span className="accent">.</span>
        </p>
        <p className="sub">
          A private coding agent that lives in Termux on the owner&rsquo;s
          phone. This page is just the gate: sign in with the owner&rsquo;s
          GitHub account to get the command that connects your phone.
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

  const hdrs = await headers();
  const proto = hdrs.get('x-forwarded-proto') || 'http';
  const host = hdrs.get('x-forwarded-host') || hdrs.get('host') || 'localhost:3000';
  const site = (process.env.NEXT_PUBLIC_SITE_URL || `${proto}://${host}`).replace(/\/$/, '');
  const tokens = await listGatewayTokens(session.login).catch(() => []);

  return (
    <main>
      <p className="lede">
        Connect your phone<span className="accent">.</span>
      </p>
      <p className="sub">
        Signed in as {session.login}. There is no chat on this website — the
        agent runs in Termux. Mint a gateway token, run the command on your
        phone, and you&rsquo;re in.
      </p>

      <ol className="steps">
        <li>
          <span>
            <strong>Mint a token</strong> with the button below. It is shown
            once, inside the command.
          </span>
        </li>
        <li>
          <span>
            <strong>Copy the command</strong> and paste it into Termux. It
            installs the client and points it at this deployment as you — no
            provider keys ever live on the phone.
          </span>
        </li>
        <li>
          <span>
            <strong>Run <code>termux-code</code></strong> and chat there. The
            agent answers with your models and your tools, GitHub and Composio
            included.
          </span>
        </li>
      </ol>

      <section className="block">
        <h2>Your Termux command</h2>
        <TokenPanel site={site} existing={tokens} />
        <p className="note">
          Already installed? Mint a token above, then inside the CLI run{' '}
          <code>/gateway-token &lt;token&gt;</code> and{' '}
          <code>/gateway {site}</code>.
        </p>
      </section>

      <form method="POST" action="/api/auth/logout">
        <button className="signout" type="submit">
          Sign out
        </button>
      </form>
    </main>
  );
}

import { cookies, headers } from 'next/headers';
import {
  sessionFromCookieValue,
  SESSION_COOKIE,
  listGatewayTokens,
} from '../../lib/auth.mjs';
import ChatClient from './ChatClient.jsx';
import TokenPanel from './TokenPanel.jsx';

export const dynamic = 'force-dynamic';

/**
 * The chatbot page. Server-side gate: anonymous visitors get the sign-in
 * screen only. The owner gets the chat UI plus the phone connect panel —
 * the copy-paste Termux command and the gateway token manager. The token
 * itself is only ever revealed by the mint button (POST /api/auth/token),
 * never rendered into this page's HTML from the store.
 */
export default async function ChatPage() {
  const store = await cookies();
  const session = sessionFromCookieValue(store.get(SESSION_COOKIE)?.value);

  if (!session) {
    return (
      <main>
        <p className="lede">Sign in required.</p>
        <p className="sub">
          The chatbot and its tools are owner-only.{' '}
          <a href="/api/auth/github">Sign in with GitHub</a>
        </p>
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
      <p className="lede">Chatbot</p>
      <p className="sub">
        Venice first ({process.env.VENICE_MODEL || 'venice-uncensored-1-2'}),
        failover after. Tools: GitHub as you, a sandboxed server terminal,
        web fetch and search, and the Venice API with its skills loaded on
        demand. Every tool call is audit-logged.
      </p>

      <ChatClient />

      <section className="block">
        <h2>Connect your phone (Termux)</h2>
        <p>
          Run this in Termux on your phone. It installs the termux-code
          client and points it at this deployment with your personal gateway
          token, so the phone signs in as you — no provider keys on the
          phone, ever.
        </p>
        <TokenPanel site={site} existing={tokens} />
        <p className="note">
          Already installed? Mint a token above, then inside the CLI run{' '}
          <code>/gateway-token &lt;token&gt;</code> and{' '}
          <code>/gateway {site}</code>.
        </p>
      </section>
    </main>
  );
}

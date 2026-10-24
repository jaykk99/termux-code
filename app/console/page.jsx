import { cookies } from 'next/headers';
import { sessionFromCookieValue, SESSION_COOKIE } from '../../lib/auth.mjs';
import ConsoleClient from './ConsoleClient.jsx';

export const dynamic = 'force-dynamic';

/** Owner-only: the console talks to the gateway with the owner's keys. */
export default async function ConsolePage() {
  const store = await cookies();
  const session = sessionFromCookieValue(store.get(SESSION_COOKIE)?.value);
  if (!session) {
    return (
      <main>
        <p className="lede">Sign in required.</p>
        <p className="sub">
          The console is owner-only. <a href="/api/auth/github">Sign in with GitHub</a>
        </p>
      </main>
    );
  }
  return <ConsoleClient />;
}

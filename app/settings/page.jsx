import { cookies } from 'next/headers';
import { sessionFromCookieValue, SESSION_COOKIE } from '../../lib/auth.mjs';
import SettingsClient from './SettingsClient.jsx';

export const dynamic = 'force-dynamic';

/** Owner-only: these settings steer the owner's own model pool. */
export default async function SettingsPage() {
  const store = await cookies();
  const session = sessionFromCookieValue(store.get(SESSION_COOKIE)?.value);
  if (!session) {
    return (
      <main>
        <p className="lede">Sign in required.</p>
        <p className="sub">
          Settings are owner-only. <a href="/api/auth/github">Sign in with GitHub</a>
        </p>
      </main>
    );
  }
  return <SettingsClient />;
}

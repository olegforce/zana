'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

// undefined means the session is unknown; null means confirmed signed out.
type Account = { username: string } | null | undefined;

export function useNavAccount(pathname: string): Account {
  const [account, setAccount] = useState<Account>(undefined);

  useEffect(() => {
    let disposed = false;
    let pending = false;
    let controller: AbortController | undefined;

    async function refresh() {
      if (pending) return;
      pending = true;
      controller = new AbortController();
      const timeout = window.setTimeout(() => controller?.abort(), 8_000);
      try {
        const response = await fetch('/api/auth/session/', {
          credentials: 'same-origin', cache: 'no-store', signal: controller.signal
        });
        if (!response.ok) throw new Error('Session unavailable');
        const data = await response.json();
        if (data.user !== null && (typeof data.user?.username !== 'string' || !data.user.username)) {
          throw new Error('Invalid session response');
        }
        if (!disposed) setAccount(data.user);
      } catch {
        if (!disposed) setAccount(undefined);
      } finally {
        window.clearTimeout(timeout);
        pending = false;
      }
    }

    function onVisible() {
      if (document.visibilityState === 'visible') void refresh();
    }

    void refresh();
    window.addEventListener('focus', refresh);
    window.addEventListener('pageshow', refresh);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      disposed = true;
      controller?.abort();
      window.removeEventListener('focus', refresh);
      window.removeEventListener('pageshow', refresh);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [pathname]);

  return account;
}

export function NavAccountLink({ account, small = false, current = false }: { account: Account; small?: boolean; current?: boolean }) {
  const label = account ? `Dashboard · ${account.username}` : account === null ? 'Log in' : 'Account';
  const props = {
    className: `zcc-btn zcc-btn-ghost nav-account-link${small ? ' zcc-btn-sm' : ''}${current ? ' active' : ''}`,
    title: label
  };
  // On the sign-in page, start OAuth without losing a pending desktop/phone approval.
  if (current && account === null) {
    const returnTo = `/connect/${typeof window === 'undefined' ? '' : window.location.search}`;
    return <a {...props} href={`/api/auth/github/login/?returnTo=${encodeURIComponent(returnTo)}`}>{label}</a>;
  }
  return <Link {...props} href="/connect/" aria-current={current ? 'page' : undefined}>
    {account ? <>Dashboard · <span className="nav-account-name">{account.username}</span></> : label}
  </Link>;
}

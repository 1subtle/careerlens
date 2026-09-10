'use client';

import { useCareerText } from '@/lib/i18n/career';
import { useLanguage } from '@/lib/context/language-context';
import { Fragment } from 'react';
import { useAuth } from './auth-provider';
import { PublicHeader, PublicSite } from './public-site';
import s from './auth.module.css';

export function AuthLoading() {
  const tr = useCareerText();
  const auth = useAuth();
  return (
    <div className={s.page}>
      <PublicHeader back />
      <div className={s.status}>
        <p role={auth?.error ? 'alert' : 'status'}>
          {auth?.error ? tr(auth.error) : tr('正在连接 CareerLens…')}
        </p>
        {auth?.error && (
          <button className={s.button} onClick={() => void auth.refresh()}>
            {' '}
            {tr('重新连接')}{' '}
          </button>
        )}
      </div>
    </div>
  );
}
export function AuthGate({ children }: { children: React.ReactNode }) {
  const { isLoading } = useLanguage();
  const auth = useAuth();
  if (!auth?.session || (auth.session.user && isLoading)) return <AuthLoading />;
  if (auth.session.mode === 'hosted' && !auth.session.user)
    return <PublicSite session={auth.session} notice={auth.notice} />;
  return <Fragment key={auth.epoch}>{children}</Fragment>;
}

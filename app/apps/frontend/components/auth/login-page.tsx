'use client';

import { useCareerText } from '@/lib/i18n/career';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AuthError, authApi, type EmailChallenge } from '@/lib/api/auth';
import { useAuth } from './auth-provider';
import { AuthLoading } from './auth-gate';
import { PublicHeader } from './public-site';
import s from './auth.module.css';

export function LoginPage() {
  const tr = useCareerText();
  const auth = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState<EmailChallenge | null>(null);
  const [retryAt, setRetryAt] = useState(0);
  const [expiresAt, setExpiresAt] = useState(0);
  const [now, setNow] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const wait = Math.max(0, Math.ceil((retryAt - now) / 1000));
  const expired = !!challenge && now >= expiresAt;
  const send = async () => {
    setBusy(true);
    setError('');
    setCode('');
    try {
      const next = await authApi.start(email.trim());
      setEmail(next.email);
      setChallenge(next);
      const time = Date.now();
      setNow(time);
      setRetryAt(time + next.retry_after_seconds * 1000);
      setExpiresAt(time + next.expires_in_seconds * 1000);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : tr('验证码发送失败，请重试。'));
      if (cause instanceof AuthError && cause.retryAfter)
        setRetryAt(Date.now() + cause.retryAfter * 1000);
    } finally {
      setBusy(false);
    }
  };
  if (!auth?.session) return <AuthLoading />;
  const session = auth.session;
  if (session.mode === 'local' || session.user)
    return (
      <div className={s.page}>
        <PublicHeader back />
        <main className={s.form}>
          <h1>{session.mode === 'local' ? tr('本地工作区已就绪') : tr('欢迎回来')}</h1>
          <p className={s.muted}>
            {session.mode === 'local' ? tr('当前为本地模式，无需登录。') : session.user?.email}
          </p>
          <Link className={`${s.button} ${s.primary}`} href="/">
            {' '}
            {tr('进入工作区')}{' '}
          </Link>
        </main>
      </div>
    );
  return (
    <div className={s.page}>
      <PublicHeader back />
      <main className={s.form}>
        <h1>{tr('用邮箱进入 CareerLens')}</h1>
        <p className={s.muted}>
          {' '}
          {tr(
            '首次验证邮箱注册，赠送 20 免费积分，用于 AI 简历润色与岗位分析。已有账户会直接登录。'
          )}{' '}
        </p>
        {auth.notice && (
          <p className={s.notice} role="status">
            {tr(auth.notice)}
          </p>
        )}
        {!session.email_login_available ? (
          <p className={s.notice}>{tr('邮箱登录暂未开放，请稍后再试。')}</p>
        ) : (
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              if (!challenge) {
                await send();
                return;
              }
              setBusy(true);
              setError('');
              try {
                const next = await authApi.verify(challenge.email, code, challenge.challenge_id);
                setCode('');
                auth.signedIn(next);
                router.replace('/');
                router.refresh();
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : tr('验证失败，请重试。'));
              } finally {
                setBusy(false);
              }
            }}
          >
            <label className={s.field}>
              <span>{tr('邮箱地址')}</span>
              <input
                type="email"
                autoComplete="email"
                required
                maxLength={254}
                value={email}
                disabled={busy || !!challenge}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@example.com"
              />
            </label>
            {challenge && (
              <>
                <p className={s.muted}>
                  {tr('验证码已发送至')} {challenge.email}。
                </p>
                <label className={s.field}>
                  <span>{tr('6 位验证码')}</span>
                  <input
                    className={s.code}
                    autoComplete="one-time-code"
                    inputMode="numeric"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    required
                    value={code}
                    disabled={busy || expired}
                    onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                  />
                </label>
                {expired && (
                  <p className={s.error} role="alert">
                    {' '}
                    {tr('验证码已过期，请重新发送。')}{' '}
                  </p>
                )}
              </>
            )}
            {error && (
              <p className={s.error} role="alert">
                {error}
              </p>
            )}
            <button
              type="submit"
              className={`${s.button} ${s.primary}`}
              disabled={
                busy || (challenge ? expired || code.length !== 6 : !email.trim() || wait > 0)
              }
            >
              {busy
                ? tr('正在处理…')
                : challenge
                  ? tr('验证并进入工作区')
                  : wait > 0
                    ? tr('{0} 秒后重试', wait)
                    : tr('发送验证码')}
            </button>
            {challenge && (
              <div className={s.resend}>
                <button
                  type="button"
                  className={s.plainButton}
                  disabled={busy || wait > 0}
                  onClick={() => void send()}
                >
                  {wait > 0 ? tr('{0} 秒后可重新发送', wait) : tr('重新发送验证码')}
                </button>
                <button
                  type="button"
                  className={s.plainButton}
                  disabled={busy}
                  onClick={() => {
                    setChallenge(null);
                    setCode('');
                    setError('');
                  }}
                >
                  {' '}
                  {tr('更换邮箱')}{' '}
                </button>
              </div>
            )}
          </form>
        )}
      </main>
    </div>
  );
}

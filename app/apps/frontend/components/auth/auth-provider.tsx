'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { authApi, type AuthSession } from '@/lib/api/auth';
import { ACCOUNT_ACTIVITY_EVENT, AUTH_EXPIRED_EVENT, resetApiSession } from '@/lib/api/client';

interface AuthState {
  session: AuthSession | null;
  error: string;
  notice: string;
  epoch: number;
  refresh: () => Promise<void>;
  signedIn: (session: AuthSession) => void;
  logout: () => Promise<void>;
}
const AuthContext = createContext<AuthState | null>(null);
export const useAuth = () => useContext(AuthContext);

function clearPrivateDrafts() {
  for (const kind of ['localStorage', 'sessionStorage'] as const) {
    try {
      const storage = window[kind];
      for (const key of Object.keys(storage)) {
        if (
          key === 'master_resume_id' ||
          key.startsWith('resume_builder_') ||
          key.startsWith('resume_wizard_')
        )
          storage.removeItem(key);
      }
    } catch {
      /* Storage may be disabled; the protected React tree is still discarded. */
    }
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<AuthSession | null>(null);
  const current = useRef<AuthSession | null>(null);
  const request = useRef(0);
  const channel = useRef<BroadcastChannel | null>(null);
  const [epoch, setEpoch] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const invalidateSessionRead = useCallback(() => {
    request.current++;
  }, []);
  const adopt = useCallback((next: AuthSession) => {
    request.current++;
    const previous = current.current;
    if (previous?.mode !== next.mode || previous?.user?.id !== next.user?.id) {
      if (previous?.mode === 'hosted' || next.mode === 'hosted') clearPrivateDrafts();
      resetApiSession();
      setEpoch((value) => value + 1);
    }
    current.current = next;
    setSession(next);
    setError('');
  }, []);
  const refresh = useCallback(async () => {
    const id = ++request.current;
    try {
      const next = await authApi.session();
      if (id === request.current) adopt(next);
    } catch (cause) {
      if (id === request.current)
        setError(cause instanceof Error ? cause.message : '暂时无法连接服务。');
    }
  }, [adopt]);
  const discard = useCallback(() => {
    request.current++;
    resetApiSession();
    clearPrivateDrafts();
    setEpoch((value) => value + 1);
  }, []);
  useEffect(() => {
    void refresh();
    const expired = () => {
      if (current.current?.mode !== 'hosted') return;
      discard();
      const anonymous = { ...current.current, user: null };
      current.current = anonymous;
      setSession(anonymous);
      setNotice('登录已过期，请重新验证邮箱。');
    };
    const activity = () => {
      if (current.current?.mode === 'hosted' && current.current.user) void refresh();
    };
    window.addEventListener(AUTH_EXPIRED_EVENT, expired);
    window.addEventListener(ACCOUNT_ACTIVITY_EVENT, activity);
    window.addEventListener('focus', refresh);
    if (typeof BroadcastChannel !== 'undefined') {
      const connection = new BroadcastChannel('careerlens-auth');
      channel.current = connection;
      connection.onmessage = () => {
        if (current.current?.mode !== 'hosted') return;
        discard();
        current.current = null;
        setSession(null);
        void refresh();
      };
    }
    return () => {
      invalidateSessionRead();
      window.removeEventListener(AUTH_EXPIRED_EVENT, expired);
      window.removeEventListener(ACCOUNT_ACTIVITY_EVENT, activity);
      window.removeEventListener('focus', refresh);
      channel.current?.close();
    };
  }, [refresh, discard, invalidateSessionRead]);
  const signedIn = useCallback(
    (next: AuthSession) => {
      adopt(next);
      setNotice('');
      channel.current?.postMessage('changed');
    },
    [adopt]
  );
  const logout = useCallback(async () => {
    await authApi.logout();
    if (current.current) adopt({ ...current.current, user: null });
    setNotice('你已退出登录。');
    channel.current?.postMessage('changed');
  }, [adopt]);
  return (
    <AuthContext.Provider value={{ session, error, notice, epoch, refresh, signedIn, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

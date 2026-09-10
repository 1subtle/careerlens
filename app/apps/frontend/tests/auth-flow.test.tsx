import { useState, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider as SessionProvider, useAuth } from '@/components/auth/auth-provider';
import { AuthGate } from '@/components/auth/auth-gate';
import { LoginPage } from '@/components/auth/login-page';
import { AccountPage } from '@/components/auth/account-page';
import SettingsPage from '@/app/(default)/settings/page';
import { apiFetch, resetApiSession } from '@/lib/api/client';
import type { AuthSession } from '@/lib/api/auth';
import { LanguageProvider } from '@/lib/context/language-context';
function AuthProvider({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      <LanguageProvider>{children}</LanguageProvider>
    </SessionProvider>
  );
}

const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
const anonymous: AuthSession = {
  mode: 'hosted',
  user: null,
  email_login_available: true,
  github_url: null,
};
const signed = (email: string, credits = 20): AuthSession => ({
  ...anonymous,
  user: { id: email, email, credits },
});
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
let session: AuthSession;
let sentEmail: string;
let requests: { url: string; options?: RequestInit }[];
beforeEach(() => {
  session = anonymous;
  sentEmail = '';
  requests = [];
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal('BroadcastChannel', undefined);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options?: RequestInit) => {
      requests.push({ url, options });
      if (url.endsWith('/auth/session')) return json(session);
      if (url.endsWith('/career/state') && session.user)
        return json({
          resumes: [],
          jobs: [],
          matches: [],
          model: { configured: true, provider: 'test', model: 'test' },
          rule_version: 'test',
        });
      if (url.endsWith('/account/profile') && session.user)
        return json({
          id: session.user.id,
          email: session.user.email,
          display_name: '',
          ui_language: 'zh',
          content_language: 'zh',
          timezone: 'Asia/Shanghai',
          created_at: 1,
        });
      if (url.endsWith('/billing/summary'))
        return json({
          balance: session.user?.credits ?? 0,
          reserved: 0,
          signup_grant: 20,
          cost_per_generation: 1,
          payment_enabled: false,
          packages: [],
        });
      if (url.includes('/billing/ledger')) return json({ items: [], next_before_id: null });
      if (url.endsWith('/billing/orders')) return json({ items: [] });
      const body = options?.body ? JSON.parse(options.body as string) : {};
      if (url.endsWith('/auth/email/start')) {
        sentEmail = body.email;
        return json({
          challenge_id: `challenge-${sentEmail}`,
          email: sentEmail,
          retry_after_seconds: 60,
          expires_in_seconds: 600,
        });
      }
      if (url.endsWith('/auth/email/verify')) {
        if (body.code !== '123456') return json({ detail: '验证码错误，请重试。' }, 400);
        session = signed(body.email);
        return json(session);
      }
      if (url.endsWith('/auth/logout')) {
        session = anonymous;
        return json({ ok: true });
      }
      return json({ detail: '请先登录。' }, 401);
    })
  );
});
afterEach(() => {
  cleanup();
  resetApiSession();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function WorkspaceProbe() {
  const auth = useAuth();
  const [text, setText] = useState('');
  return (
    <div>
      <p>工作区：{auth?.session?.user?.email ?? '本地'}</p>
      <label>
        简历草稿
        <input
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            localStorage.setItem('resume_builder_draft', event.target.value);
          }}
        />
      </label>
    </div>
  );
}
function Portal() {
  const auth = useAuth();
  return auth?.session?.user ? (
    <AuthGate>
      <WorkspaceProbe />
      <AccountPage />
    </AuthGate>
  ) : (
    <LoginPage />
  );
}
async function sendCode(email = 'one@example.com') {
  fireEvent.change(await screen.findByLabelText('邮箱地址'), { target: { value: email } });
  fireEvent.click(screen.getByRole('button', { name: '发送验证码' }));
  await screen.findByLabelText('6 位验证码');
}
async function verifyCode() {
  fireEvent.change(screen.getByLabelText('6 位验证码'), { target: { value: '123456' } });
  fireEvent.click(screen.getByRole('button', { name: '验证并进入工作区' }));
  await screen.findByLabelText('简历草稿');
}

describe('runtime authentication and account isolation', () => {
  it('logs in by email code, preserves retry after an error, then clears drafts across logout and a different account', async () => {
    render(
      <AuthProvider>
        <Portal />
      </AuthProvider>
    );
    await sendCode();
    expect(screen.getByRole('button', { name: '60 秒后可重新发送' })).toBeDisabled();
    expect(screen.getByLabelText('6 位验证码')).toHaveAttribute('autocomplete', 'one-time-code');
    fireEvent.change(screen.getByLabelText('6 位验证码'), { target: { value: '000000' } });
    fireEvent.click(screen.getByRole('button', { name: '验证并进入工作区' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('验证码错误');
    await verifyCode();
    expect(screen.getByText('工作区：one@example.com')).toBeVisible();
    fireEvent.change(screen.getByLabelText('简历草稿'), {
      target: { value: '第一个账户的私人简历' },
    });
    sessionStorage.setItem('resume_wizard_draft', 'private wizard');
    fireEvent.click(screen.getByRole('button', { name: '退出登录' }));
    await screen.findByLabelText('邮箱地址');
    expect(screen.queryByDisplayValue('第一个账户的私人简历')).not.toBeInTheDocument();
    expect(localStorage.getItem('resume_builder_draft')).toBeNull();
    expect(sessionStorage.getItem('resume_wizard_draft')).toBeNull();
    await sendCode('two@example.com');
    await verifyCode();
    expect(screen.getByText('工作区：two@example.com')).toBeVisible();
    expect(screen.getByLabelText('简历草稿')).toHaveValue('');
    const verified = requests.filter((request) => request.url.endsWith('/email/verify'));
    expect(JSON.parse(verified.at(-1)!.options!.body as string)).toEqual({
      email: 'two@example.com',
      code: '123456',
      challenge_id: 'challenge-two@example.com',
    });
    expect(requests.every((request) => request.options?.credentials === 'include')).toBe(true);
    expect(Object.values(localStorage).some((value) => String(value).includes('123456'))).toBe(
      false
    );
  });

  it('allows resend after 60 seconds and expires a challenge after ten minutes', async () => {
    vi.useFakeTimers();
    await act(async () => {
      render(
        <AuthProvider>
          <LoginPage />
        </AuthProvider>
      );
    });
    fireEvent.change(screen.getByLabelText('邮箱地址'), { target: { value: 'one@example.com' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '发送验证码' }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(screen.getByRole('button', { name: '重新发送验证码' })).toBeEnabled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(540_000);
    });
    expect(screen.getByRole('alert')).toHaveTextContent('验证码已过期');
    expect(screen.getByLabelText('6 位验证码')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '重新发送验证码' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByLabelText('6 位验证码')).toBeEnabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('discards a protected workspace on 401 and aborts responses from the previous session', async () => {
    session = signed('one@example.com');
    render(
      <AuthProvider>
        <AuthGate>
          <WorkspaceProbe />
        </AuthGate>
      </AuthProvider>
    );
    fireEvent.change(await screen.findByLabelText('简历草稿'), { target: { value: '私人草稿' } });
    const late = vi.fn();
    vi.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          late.mockImplementation(resolve);
        })
    );
    const pending = apiFetch('/career/slow');
    const caught = pending.catch((error) => error);
    await act(async () => {
      await apiFetch('/career/expired').catch(() => {});
    });
    expect(screen.getByText('登录已过期，请重新验证邮箱。')).toBeVisible();
    expect(screen.queryByLabelText('简历草稿')).not.toBeInTheDocument();
    expect(localStorage.getItem('resume_builder_draft')).toBeNull();
    expect((await caught).name).toBe('SessionChangedError');
    await act(async () => {
      late(json({ data: '旧账户的迟到数据' }));
    });
    expect(screen.queryByText('旧账户的迟到数据')).not.toBeInTheDocument();
  });

  it('enters local mode directly without deleting local drafts', async () => {
    session = { ...anonymous, mode: 'local' };
    localStorage.setItem('resume_builder_draft', '本地草稿');
    render(
      <AuthProvider>
        <AuthGate>
          <WorkspaceProbe />
        </AuthGate>
      </AuthProvider>
    );
    expect(await screen.findByText('工作区：本地')).toBeVisible();
    expect(localStorage.getItem('resume_builder_draft')).toBe('本地草稿');
    expect(screen.queryByText('在线使用')).not.toBeInTheDocument();
    vi.mocked(fetch).mockResolvedValueOnce(json({ ok: true }));
    await act(async () => {
      await apiFetch('/career/state');
    });
    expect(requests.filter((request) => request.url.endsWith('/auth/session'))).toHaveLength(1);
  });

  it('refreshes credits after AI actions and background polling without discarding drafts', async () => {
    session = signed('one@example.com');
    render(
      <AuthProvider>
        <Portal />
      </AuthProvider>
    );
    expect(await screen.findByLabelText('剩余 20 积分')).toBeVisible();
    fireEvent.change(screen.getByLabelText('简历草稿'), { target: { value: '继续编辑的简历' } });

    for (const [endpoint, options, remaining] of [
      ['/career/rewrites', { method: 'POST' }, 18],
      ['/resumes?resume_id=background', undefined, 17],
    ] as const) {
      session = signed('one@example.com', remaining);
      vi.mocked(fetch).mockResolvedValueOnce(json({ ok: true }));
      await act(async () => {
        await apiFetch(endpoint, options);
      });
      expect(await screen.findByLabelText(`剩余 ${remaining} 积分`)).toBeVisible();
      expect(screen.getByLabelText('简历草稿')).toHaveValue('继续编辑的简历');
    }

    session = signed('one@example.com', 0);
    vi.mocked(fetch).mockResolvedValueOnce(
      json({ detail: '积分已用完，暂时无法继续使用 AI 功能' }, 402)
    );
    await act(async () => {
      await expect(apiFetch('/career/rewrites', { method: 'POST' })).rejects.toThrow(
        '积分已用完，暂时无法继续使用 AI 功能'
      );
    });
    expect(await screen.findByLabelText('剩余 0 积分')).toBeVisible();
    expect(screen.getByText('充值暂未开放')).toBeVisible();
    expect(screen.getByLabelText('简历草稿')).toHaveValue('继续编辑的简历');
  });

  it('discards an old tab immediately before loading the account announced by another tab', async () => {
    let notifySession = () => {};
    vi.stubGlobal(
      'BroadcastChannel',
      class {
        onmessage: (() => void) | null = null;
        postMessage = vi.fn();
        close = vi.fn();
        constructor() {
          notifySession = () => this.onmessage?.();
        }
      }
    );
    session = signed('one@example.com');
    render(
      <AuthProvider>
        <AuthGate>
          <WorkspaceProbe />
        </AuthGate>
      </AuthProvider>
    );
    fireEvent.change(await screen.findByLabelText('简历草稿'), {
      target: { value: '旧标签页中的私人草稿' },
    });
    const finishSession = vi.fn();
    vi.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSession.mockImplementation(resolve);
        })
    );
    act(() => notifySession());
    expect(screen.queryByLabelText('简历草稿')).not.toBeInTheDocument();
    expect(localStorage.getItem('resume_builder_draft')).toBeNull();
    await act(async () => {
      session = signed('two@example.com');
      finishSession(json(session));
    });
    expect(screen.getByText('工作区：two@example.com')).toBeVisible();
    expect(screen.getByLabelText('简历草稿')).toHaveValue('');
  });

  it('keeps the workspace closed when runtime session discovery fails', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('服务连接失败'));
    render(
      <AuthProvider>
        <AuthGate>
          <WorkspaceProbe />
        </AuthGate>
      </AuthProvider>
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('服务连接失败');
    expect(screen.queryByLabelText('简历草稿')).not.toBeInTheDocument();
  });

  it('keeps private state cleared if refreshing a changed account fails', async () => {
    let notifySession = () => {};
    vi.stubGlobal(
      'BroadcastChannel',
      class {
        onmessage: (() => void) | null = null;
        postMessage = vi.fn();
        close = vi.fn();
        constructor() {
          notifySession = () => this.onmessage?.();
        }
      }
    );
    session = signed('one@example.com');
    render(
      <AuthProvider>
        <AuthGate>
          <WorkspaceProbe />
          <AccountPage />
        </AuthGate>
      </AuthProvider>
    );
    fireEvent.change(await screen.findByLabelText('简历草稿'), {
      target: { value: '旧账户的私人经历' },
    });
    for (const storage of [localStorage, sessionStorage]) {
      storage.setItem('resume_builder_attachment_draft:one', '旧账户的求职信');
      storage.setItem('resume_wizard_draft', '旧账户的向导回答');
      storage.setItem('master_resume_id', 'one');
    }
    vi.mocked(fetch).mockRejectedValueOnce(new Error('会话刷新失败'));
    await act(async () => notifySession());
    expect(await screen.findByRole('alert')).toHaveTextContent('会话刷新失败');
    expect(screen.queryByLabelText('简历草稿')).not.toBeInTheDocument();
    expect(screen.queryByText('one@example.com')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('剩余 20 积分')).not.toBeInTheDocument();
    for (const storage of [localStorage, sessionStorage]) {
      expect(storage.getItem('resume_builder_draft')).toBeNull();
      expect(storage.getItem('resume_builder_attachment_draft:one')).toBeNull();
      expect(storage.getItem('resume_wizard_draft')).toBeNull();
      expect(storage.getItem('master_resume_id')).toBeNull();
    }

    session = signed('two@example.com', 7);
    fireEvent.click(screen.getByRole('button', { name: '重新连接' }));
    expect(await screen.findByText('工作区：two@example.com')).toBeVisible();
    expect(screen.getByLabelText('简历草稿')).toHaveValue('');
    expect(screen.getByLabelText('剩余 7 积分')).toBeVisible();
    expect(screen.queryByText('会话刷新失败')).not.toBeInTheDocument();
  });

  it('ignores a session response that arrives after logout', async () => {
    session = signed('one@example.com');
    render(
      <AuthProvider>
        <Portal />
      </AuthProvider>
    );
    await screen.findByLabelText('简历草稿');
    let finishSession: (response: Response) => void = () => {};
    vi.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSession = resolve;
        })
    );
    fireEvent(window, new Event('focus'));
    fireEvent.click(screen.getByRole('button', { name: '退出登录' }));
    await screen.findByLabelText('邮箱地址');
    await act(async () => finishSession(json(signed('one@example.com'))));
    expect(screen.queryByLabelText('简历草稿')).not.toBeInTheDocument();
    expect(screen.queryByText('one@example.com')).not.toBeInTheDocument();
    expect(screen.getByText('你已退出登录。')).toBeVisible();
  });

  it.each([null, {}, { ...anonymous, mode: 'unknown' }, signed('one@example.com', -1)])(
    'keeps the workspace closed when a successful HTTP response is not a valid session: %j',
    async (body) => {
      vi.mocked(fetch).mockResolvedValue(json(body));
      render(
        <AuthProvider>
          <AuthGate>
            <WorkspaceProbe />
          </AuthGate>
        </AuthProvider>
      );
      expect(await screen.findByRole('alert')).toHaveTextContent('登录服务返回异常');
      expect(screen.queryByLabelText('简历草稿')).not.toBeInTheDocument();
    }
  );

  it('renders account information at hosted settings without requesting server model configuration', async () => {
    session = signed('one@example.com');
    render(
      <AuthProvider>
        <AuthGate>
          <SettingsPage />
        </AuthGate>
      </AuthProvider>
    );
    expect(await screen.findByRole('heading', { name: '个人中心', level: 1 })).toBeVisible();
    expect(screen.getByRole('heading', { name: '个人设置', level: 2 })).toBeVisible();
    expect(screen.getAllByText('one@example.com')[0]).toBeVisible();
    expect(requests.some((request) => request.url.includes('/config/'))).toBe(false);
    expect(await screen.findByLabelText(/登录邮箱/)).toHaveValue('one@example.com');
    expect(screen.getByLabelText('网页语言')).toHaveValue('zh');
  });
});

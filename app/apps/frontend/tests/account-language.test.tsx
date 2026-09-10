import { useEffect } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LanguageProvider, useLanguage } from '@/lib/context/language-context';
import { useAuth } from '@/components/auth/auth-provider';
import { accountApi, type AccountProfile } from '@/lib/api/account';
import { fetchLanguageConfig, updateLanguageConfig } from '@/lib/api/config';
import { PublicSite } from '@/components/auth/public-site';

vi.mock('@/components/auth/auth-provider', () => ({ useAuth: vi.fn() }));
vi.mock('@/lib/api/account', () => ({ accountApi: { profile: vi.fn(), updateProfile: vi.fn() } }));
vi.mock('@/lib/api/config', () => ({
  fetchLanguageConfig: vi.fn(),
  updateLanguageConfig: vi.fn(),
}));

const profile: AccountProfile = {
  id: 'a',
  email: 'a@example.com',
  created_at: 1,
  display_name: 'A',
  ui_language: 'en',
  content_language: 'zh',
  timezone: 'UTC',
};
const session = {
  mode: 'hosted' as const,
  user: { id: 'a', email: 'a@example.com', credits: 20 },
  email_login_available: true,
  github_url: null,
};
let language: ReturnType<typeof useLanguage>;
function Probe() {
  const current = useLanguage();
  useEffect(() => {
    language = current;
  }, [current]);
  return (
    <p data-testid="current">
      {current.accountProfile?.id ?? '-'}:{current.uiLanguage}:{current.contentLanguage}
    </p>
  );
}
function Tree() {
  return (
    <LanguageProvider>
      <Probe />
      <PublicSite session={session} />
    </LanguageProvider>
  );
}
function authenticate(id: string | null, mode: 'hosted' | 'local' = 'hosted') {
  vi.mocked(useAuth).mockReturnValue({
    session: { ...session, mode, user: id ? { ...session.user, id } : null },
    epoch: 0,
    error: '',
    notice: '',
    refresh: vi.fn(),
    signedIn: vi.fn(),
    logout: vi.fn(),
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  authenticate('a');
  vi.mocked(accountApi.profile).mockResolvedValue(profile);
});

describe('account language preferences', () => {
  it('loads hosted account preferences, changes the public UI and html lang, and never reads global language config', async () => {
    localStorage.setItem('resume_matcher_ui_language', 'ko');
    localStorage.setItem('resume_matcher_content_language', 'ja');
    render(<Tree />);
    expect(await screen.findByText('a:en:zh')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Understand your experience. Find your next step.' })
    ).toBeVisible();
    await waitFor(() => expect(document.documentElement.lang).toBe('en'));
    expect(fetchLanguageConfig).not.toHaveBeenCalled();
    expect(accountApi.profile).toHaveBeenCalledOnce();
  });

  it('discards a late profile read when a different account signs in', async () => {
    const old = deferred<AccountProfile>();
    const next = deferred<AccountProfile>();
    vi.mocked(accountApi.profile)
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(next.promise);
    const view = render(<Tree />);
    authenticate('b');
    view.rerender(<Tree />);
    expect(screen.getByTestId('current')).toHaveTextContent('-:zh:zh');
    await act(async () => next.resolve({ ...profile, id: 'b', ui_language: 'zh' }));
    await act(async () => old.resolve(profile));
    expect(screen.getByTestId('current')).toHaveTextContent('b:zh:zh');
    expect(document.documentElement.lang).toBe('zh');
  });

  it('reports a failed save and applies only a successful profile update', async () => {
    render(<Tree />);
    await screen.findByText('a:en:zh');
    vi.mocked(accountApi.updateProfile).mockRejectedValueOnce(new Error('Save failed'));
    await act(async () => {
      await expect(language.setUiLanguage('zh')).rejects.toThrow('Save failed');
    });
    expect(language.uiLanguage).toBe('en');
    vi.mocked(accountApi.updateProfile).mockResolvedValueOnce({ ...profile, ui_language: 'zh' });
    await act(async () => {
      await language.setUiLanguage('zh');
    });
    expect(screen.getByRole('heading', { name: '看清经历，找到更合适的下一步。' })).toBeVisible();
    expect(document.documentElement.lang).toBe('zh');
    expect(accountApi.updateProfile).toHaveBeenLastCalledWith({ ui_language: 'zh' });
    expect(updateLanguageConfig).not.toHaveBeenCalled();
    expect(localStorage.getItem('careerlens_profile_changed')).not.toContain(profile.email);
  });

  it('refreshes the current account after another tab changes preferences and ignores other account events', async () => {
    render(<Tree />);
    await screen.findByText('a:en:zh');
    window.dispatchEvent(
      new StorageEvent('storage', { key: 'careerlens_profile_changed', newValue: '{"id":"b"}' })
    );
    expect(accountApi.profile).toHaveBeenCalledOnce();
    vi.mocked(accountApi.profile).mockResolvedValueOnce({ ...profile, ui_language: 'zh' });
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', { key: 'careerlens_profile_changed', newValue: '{"id":"a"}' })
      );
    });
    await screen.findByText('a:zh:zh');
    expect(accountApi.profile).toHaveBeenCalledTimes(2);
    act(() => language.applyProfile({ ...profile, id: 'b' }));
    expect(language.accountProfile?.id).toBe('a');
  });

  it('does not apply a stale save to the next account', async () => {
    const view = render(<Tree />);
    await screen.findByText('a:en:zh');
    const save = deferred<AccountProfile>();
    vi.mocked(accountApi.updateProfile).mockReturnValueOnce(save.promise);
    let saving!: Promise<void>;
    act(() => {
      saving = language.setUiLanguage('zh');
    });
    authenticate('b');
    vi.mocked(accountApi.profile).mockResolvedValueOnce({ ...profile, id: 'b' });
    // A context update can occur without replacing the provider instance.
    view.rerender(<Tree />);
    await screen.findByText('b:en:zh');
    await act(async () => {
      save.resolve({ ...profile, ui_language: 'zh' });
      await saving;
    });
    expect(screen.getByTestId('current')).toHaveTextContent('b:en:zh');
  });

  it('shows a load error without inventing a loaded account profile and supports retry', async () => {
    vi.mocked(accountApi.profile).mockRejectedValueOnce(new Error('Offline'));
    render(<Tree />);
    await waitFor(() => expect(language.preferencesError).toBe('Offline'));
    expect(language.accountProfile).toBeNull();
    await act(async () => language.reloadProfile());
    expect(language.accountProfile?.id).toBe('a');
    expect(language.preferencesError).toBe('');
  });

  it('keeps the seven-language local configuration and storage behavior', async () => {
    authenticate(null, 'local');
    localStorage.setItem('resume_matcher_ui_language', 'es');
    vi.mocked(fetchLanguageConfig).mockResolvedValue({
      ui_language: 'zh',
      content_language: 'fr',
      supported_languages: ['zh', 'en', 'es', 'fr', 'ja', 'ko', 'pt'],
    });
    vi.mocked(updateLanguageConfig).mockResolvedValue({
      ui_language: 'es',
      content_language: 'ja',
      supported_languages: ['zh', 'en', 'es', 'fr', 'ja', 'ko', 'pt'],
    });
    render(<Tree />);
    await screen.findByText('-:es:fr');
    await act(async () => {
      await language.setUiLanguage('ko');
      await language.setContentLanguage('ja');
    });
    expect(screen.getByTestId('current')).toHaveTextContent('-:ko:ja');
    expect(updateLanguageConfig).toHaveBeenCalledWith({ content_language: 'ja' });
    expect(localStorage.getItem('resume_matcher_ui_language')).toBe('ko');
    expect(accountApi.profile).not.toHaveBeenCalled();
  });

  it('keeps public preferences separate from authenticated accounts and avoids protected endpoints', async () => {
    authenticate(null);
    render(<Tree />);
    await act(async () => language.setUiLanguage('en'));
    expect(localStorage.getItem('careerlens_public_ui_language')).toBe('en');
    expect(accountApi.profile).not.toHaveBeenCalled();
    expect(fetchLanguageConfig).not.toHaveBeenCalled();
    await expect(language.setContentLanguage('en')).rejects.toThrow('Sign in');
  });
});

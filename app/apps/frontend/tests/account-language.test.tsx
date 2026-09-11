import { useEffect } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

function stubMatchMedia(matches: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((media: string) => ({
      matches,
      media,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  authenticate('a');
  vi.mocked(accountApi.profile).mockResolvedValue(profile);
});

afterEach(() => vi.unstubAllGlobals());

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

  it('provides homepage anchors and a keyboard-operated translated product demo', async () => {
    stubMatchMedia(true);
    render(<Tree />);
    await screen.findByText('a:en:zh');

    const navigation = screen.getByRole('navigation', { name: 'Home page navigation' });
    expect(within(navigation).getByRole('link', { name: 'Product demo' })).toHaveAttribute(
      'href',
      '#demo'
    );
    expect(within(navigation).getByRole('link', { name: 'Capabilities' })).toHaveAttribute(
      'href',
      '#features'
    );
    expect(within(navigation).getByRole('link', { name: 'How it works' })).toHaveAttribute(
      'href',
      '#process'
    );
    expect(
      within(
        screen.getByRole('region', {
          name: 'Understand your experience. Find your next step.',
        })
      ).getByRole('link', { name: 'Product demo' })
    ).toHaveAttribute('href', '#demo');

    const demo = screen.getByRole('region', {
      name: 'Try it once, without uploading your resume.',
    });
    const tabs = within(demo).getAllByRole('tab');
    expect(tabs).toHaveLength(3);
    expect(within(demo).getByRole('tablist', { name: 'Product demo' })).toHaveAttribute(
      'aria-orientation',
      'horizontal'
    );
    expect(within(demo).getAllByRole('tabpanel', { hidden: true })).toHaveLength(3);
    tabs.forEach((tab) => {
      expect(document.getElementById(tab.getAttribute('aria-controls')!)).toHaveAttribute(
        'role',
        'tabpanel'
      );
    });
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    const experience = within(demo).getByRole('textbox', { name: 'Sample experience' });
    const editedExperience =
      'Interviewed users, improved the registration process, and used SQL to review form data.';
    fireEvent.change(experience, { target: { value: editedExperience } });

    fireEvent.keyDown(tabs[0], { key: 'ArrowRight' });
    expect(tabs[1]).toHaveFocus();
    expect(tabs[1]).toHaveAttribute('aria-selected', 'true');
    expect(
      within(demo).getByRole('heading', {
        name: 'Review job requirements against your evidence',
      })
    ).toBeVisible();
    expect(within(demo).getAllByText('Direct evidence found')).toHaveLength(2);
    expect(
      within(demo).getByText('This demo uses fixed keyword rules and does not call AI.')
    ).toBeVisible();

    fireEvent.click(tabs[2]);
    expect(tabs[2]).toHaveAttribute('aria-selected', 'true');
    const reviewPanel = within(demo).getByRole('tabpanel');
    expect(within(reviewPanel).getByText(editedExperience)).toBeVisible();
    expect(within(demo).getByRole('textbox', { name: 'Rule-based draft' })).toHaveValue(
      `Targeted for the Product Operations Intern role: ${editedExperience}`
    );
    expect(
      within(demo).getByText(
        'The demo rules found evidence of user feedback, process improvement and SQL analysis.'
      )
    ).toBeVisible();

    fireEvent.click(within(demo).getByRole('radio', { name: 'Keep original' }));
    fireEvent.click(within(demo).getByRole('button', { name: 'Confirm sample choice' }));
    expect(within(demo).getByRole('status')).toHaveTextContent(
      'Original selected. This demo will not save anything.'
    );
    fireEvent.click(within(demo).getByRole('radio', { name: 'Use rule-based draft' }));
    fireEvent.click(within(demo).getByRole('button', { name: 'Confirm sample choice' }));
    expect(within(demo).getByRole('status')).toHaveTextContent(
      'Rule-based draft selected. This demo will not save anything.'
    );

    vi.mocked(accountApi.updateProfile).mockResolvedValueOnce({ ...profile, ui_language: 'zh' });
    await act(async () => language.setUiLanguage('zh'));
    expect(within(demo).getByRole('tab', { name: '确认优化' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(within(demo).getByRole('textbox', { name: '演示整理稿' })).toHaveValue(
      '面向产品运营实习生岗位整理：负责校园活动报名流程，访谈参与者后重写说明并调整表单字段，减少了重复咨询和无效提交。'
    );
  });

  it('uses vertical arrow keys for the desktop product demo', async () => {
    stubMatchMedia(false);
    render(<Tree />);
    await screen.findByText('a:en:zh');

    const demo = screen.getByRole('region', {
      name: 'Try it once, without uploading your resume.',
    });
    const tablist = within(demo).getByRole('tablist', { name: 'Product demo' });
    const tabs = within(tablist).getAllByRole('tab');
    expect(tablist).toHaveAttribute('aria-orientation', 'vertical');

    fireEvent.keyDown(tabs[0], { key: 'ArrowRight' });
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(tabs[0], { key: 'ArrowDown' });
    expect(tabs[1]).toHaveFocus();
    expect(tabs[1]).toHaveAttribute('aria-selected', 'true');
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

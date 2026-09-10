import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountCenter } from '@/components/account/account-center';
import { SettingsPanel, SecurityPanel, DataPanel } from '@/components/account/settings-panels';
import { accountApi, type AccountProfile } from '@/lib/api/account';
import { downloadBlobAsFile } from '@/lib/utils/download';

const state = vi.hoisted(() => ({
  language: 'zh',
  applyProfile: vi.fn(),
  logout: vi.fn(),
  replace: vi.fn(),
}));
const profile: AccountProfile = {
  id: 'owner',
  email: 'owner@example.com',
  created_at: 1,
  display_name: '原昵称',
  ui_language: 'zh',
  content_language: 'zh',
  timezone: 'Asia/Shanghai',
};
vi.mock('@/lib/context/language-context', () => ({
  useLanguage: () => ({
    uiLanguage: state.language,
    accountProfile: profile,
    preferencesError: '',
    reloadProfile: vi.fn(),
    applyProfile: state.applyProfile,
  }),
}));
vi.mock('@/components/auth/auth-provider', () => ({
  useAuth: () => ({
    session: { mode: 'hosted', user: { id: 'owner', email: 'owner@example.com' } },
    logout: state.logout,
  }),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: state.replace }) }));
vi.mock('@/lib/api/account', () => ({
  accountApi: {
    updateProfile: vi.fn(),
    sessions: vi.fn(),
    revokeSession: vi.fn(),
    revokeOthers: vi.fn(),
    exportData: vi.fn(),
  },
}));
vi.mock('@/lib/utils/download', () => ({ downloadBlobAsFile: vi.fn() }));
vi.mock('@/components/account/billing-panels', () => ({
  WalletPanel: () => <div>钱包内容</div>,
  OrdersPanel: () => <div>订单内容</div>,
  UsagePanel: () => <div>日志内容</div>,
}));

beforeEach(() => {
  vi.clearAllMocks();
  state.language = 'zh';
});

describe('personal center preferences', () => {
  it('saves editable preferences only and applies language after server success', async () => {
    let resolve: (value: AccountProfile) => void = () => {};
    vi.mocked(accountApi.updateProfile).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    render(<SettingsPanel profile={profile} onDirtyChange={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/昵称/), { target: { value: '  New name  ' } });
    fireEvent.change(screen.getByLabelText('网页语言'), { target: { value: 'en' } });
    fireEvent.change(screen.getByLabelText('时区'), { target: { value: 'UTC' } });
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }));
    expect(accountApi.updateProfile).toHaveBeenCalledWith({
      display_name: 'New name',
      ui_language: 'en',
      timezone: 'UTC',
    });
    expect(state.applyProfile).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '正在保存…' })).toBeDisabled();
    const updated = {
      ...profile,
      display_name: 'New name',
      ui_language: 'en' as const,
      timezone: 'UTC',
    };
    await act(async () => resolve(updated));
    expect(state.applyProfile).toHaveBeenCalledWith(updated);
    expect(screen.getByRole('status')).toHaveTextContent('Preferences saved');
  });

  it('keeps a failed draft for retry without applying preferences', async () => {
    vi.mocked(accountApi.updateProfile).mockRejectedValueOnce(new Error('保存失败，请重试'));
    render(<SettingsPanel profile={profile} onDirtyChange={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/昵称/), { target: { value: '我的草稿' } });
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('保存失败');
    expect(screen.getByLabelText(/昵称/)).toHaveValue('我的草稿');
    expect(state.applyProfile).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '取消修改' }));
    expect(screen.getByLabelText(/昵称/)).toHaveValue('原昵称');
    expect(screen.getByRole('button', { name: '保存设置' })).toBeDisabled();
  });

  it('updates a clean form after a profile refresh and preserves a local draft', () => {
    const onDirtyChange = vi.fn();
    const { rerender } = render(<SettingsPanel profile={profile} onDirtyChange={onDirtyChange} />);
    rerender(
      <SettingsPanel
        profile={{ ...profile, display_name: '其他标签页' }}
        onDirtyChange={onDirtyChange}
      />
    );
    expect(screen.getByLabelText(/昵称/)).toHaveValue('其他标签页');
    fireEvent.change(screen.getByLabelText(/昵称/), { target: { value: '当前草稿' } });
    rerender(
      <SettingsPanel
        profile={{ ...profile, display_name: '再次刷新' }}
        onDirtyChange={onDirtyChange}
      />
    );
    expect(screen.getByLabelText(/昵称/)).toHaveValue('当前草稿');
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  });

  it('does not overwrite unrelated preferences changed in another tab', async () => {
    const onDirtyChange = vi.fn();
    const { rerender } = render(<SettingsPanel profile={profile} onDirtyChange={onDirtyChange} />);
    fireEvent.change(screen.getByLabelText(/昵称/), { target: { value: '我的草稿' } });
    const current = { ...profile, ui_language: 'en' as const, timezone: 'UTC' };
    rerender(<SettingsPanel profile={current} onDirtyChange={onDirtyChange} />);
    vi.mocked(accountApi.updateProfile).mockResolvedValue({ ...current, display_name: '我的草稿' });
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }));
    await waitFor(() =>
      expect(accountApi.updateProfile).toHaveBeenCalledWith({ display_name: '我的草稿' })
    );
    expect(await screen.findByRole('status')).toHaveTextContent('Preferences saved');
  });

  it('switches sections inside the workspace and protects unsaved preferences when signing out', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<AccountCenter section="settings" />);
    for (const [name] of [
      ['钱包管理', 'wallet'],
      ['充值账单', 'orders'],
      ['消费日志', 'usage'],
      ['个人设置', 'settings'],
      ['账号安全', 'security'],
      ['数据管理', 'data'],
    ]) {
      expect(screen.getByRole('button', { name })).toBeVisible();
    }
    expect(screen.getByRole('button', { name: '个人设置' })).toHaveAttribute(
      'aria-current',
      'page'
    );
    fireEvent.change(screen.getByLabelText(/昵称/), { target: { value: '未保存' } });
    fireEvent.click(screen.getByRole('button', { name: '退出登录' }));
    expect(confirm).toHaveBeenCalledOnce();
    expect(state.logout).not.toHaveBeenCalled();
    confirm.mockRestore();
  });
});

describe('security and personal data', () => {
  it('confirms revocation and preserves the current session', async () => {
    const current = {
      id: 'current',
      current: true,
      created_at: 1,
      expires_at: 1900000000,
      user_agent: 'Chrome on Mac',
    };
    vi.mocked(accountApi.sessions)
      .mockResolvedValueOnce({ items: [current, { ...current, id: 'other', current: false }] })
      .mockResolvedValue({ items: [current] });
    vi.mocked(accountApi.revokeSession).mockResolvedValue(undefined);
    render(<SecurityPanel timeZone="UTC" />);
    fireEvent.click(await screen.findByRole('button', { name: '退出此会话' }));
    expect(accountApi.revokeSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '确认退出' }));
    await waitFor(() => expect(accountApi.revokeSession).toHaveBeenCalledWith('other'));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: '退出此会话' })).not.toBeInTheDocument()
    );
    expect(screen.getByText('当前会话')).toBeVisible();
    expect(screen.getByRole('button', { name: '退出其他所有会话' })).toBeDisabled();
  });

  it('downloads the authenticated export and reports a download failure', async () => {
    const blob = new Blob(['{}'], { type: 'application/json' });
    vi.mocked(accountApi.exportData)
      .mockResolvedValueOnce(blob)
      .mockRejectedValueOnce(new Error('导出失败'));
    render(<DataPanel />);
    fireEvent.click(screen.getByRole('button', { name: '导出我的数据' }));
    await waitFor(() =>
      expect(downloadBlobAsFile).toHaveBeenCalledWith(
        blob,
        expect.stringMatching(/^careerlens-data-.*\.json$/)
      )
    );
    fireEvent.click(screen.getByRole('button', { name: '导出我的数据' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('导出失败');
    expect(downloadBlobAsFile).toHaveBeenCalledTimes(1);
  });
});

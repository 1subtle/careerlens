'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Database,
  LogOut,
  ReceiptText,
  ShieldCheck,
  SlidersHorizontal,
  Wallet,
  ListFilter,
} from 'lucide-react';
import { useAuth } from '@/components/auth/auth-provider';
import { useLanguage } from '@/lib/context/language-context';
import type { AccountSection } from '@/lib/account-sections';
import { WalletPanel, OrdersPanel, UsagePanel } from './billing-panels';
import { SettingsPanel, SecurityPanel, DataPanel } from './settings-panels';
import s from './account.module.css';
export { accountSections, type AccountSection } from '@/lib/account-sections';

const navigation = [
  {
    id: 'wallet',
    zh: '钱包管理',
    en: 'Wallet',
    icon: Wallet,
    hint: '查看积分余额，管理充值。',
    englishHint: 'Your credit balance and top-ups, in one place.',
  },
  {
    id: 'orders',
    zh: '充值账单',
    en: 'Top-up orders',
    icon: ReceiptText,
    hint: '查看每笔充值的金额、时间和到账状态。',
    englishHint: 'Review payments, dates and order status.',
  },
  {
    id: 'usage',
    zh: '消费日志',
    en: 'Usage history',
    icon: ListFilter,
    hint: '每次积分消费、预留和退回都有记录。',
    englishHint: 'Follow every credit charge, reservation and return.',
  },
  {
    id: 'settings',
    zh: '个人设置',
    en: 'Preferences',
    icon: SlidersHorizontal,
    hint: '管理个人资料、网页语言和时区。',
    englishHint: 'Manage your profile, language and time zone.',
  },
  {
    id: 'security',
    zh: '账号安全',
    en: 'Account security',
    icon: ShieldCheck,
    hint: '查看登录会话，退出不再使用的设备。',
    englishHint: 'Review active sessions and sign out other devices.',
  },
  {
    id: 'data',
    zh: '数据管理',
    en: 'Your data',
    icon: Database,
    hint: '下载属于你的简历、岗位和分析记录。',
    englishHint: 'Download a copy of your resumes, jobs and analyses.',
  },
] as const;

export function AccountCenter({
  section = 'wallet',
  onSectionChange,
  onDirtyChange,
  onWorkspace,
  onBeforeLogout,
}: {
  section?: AccountSection;
  onSectionChange?: (section: AccountSection) => void;
  onDirtyChange?: (dirty: boolean) => void;
  onWorkspace?: () => void;
  onBeforeLogout?: () => boolean;
}) {
  const auth = useAuth();
  const { uiLanguage, accountProfile, preferencesError, reloadProfile } = useLanguage();
  const router = useRouter();
  const text = (zh: string, en: string) => (uiLanguage === 'zh' ? zh : en);
  const [localSection, setLocalSection] = useState(section);
  const selected = onSectionChange ? section : localSection;
  const [dirty, setDirty] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [error, setError] = useState('');
  const user = auth?.session?.user;
  const profile = accountProfile?.id === user?.id ? accountProfile : null;
  const displayName = profile?.display_name || user?.email?.split('@')[0] || 'CareerLens';
  const current = navigation.find((item) => item.id === selected)!;
  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const canLeave = () =>
    !dirty ||
    window.confirm(
      text('有尚未保存的设置，确定离开吗？', 'You have unsaved preferences. Leave this page?')
    );
  const select = (next: AccountSection) => {
    if (next === selected || !canLeave()) return;
    setDirty(false);
    if (onSectionChange) onSectionChange(next);
    else setLocalSection(next);
  };
  const logout = async () => {
    if (!(onBeforeLogout ? onBeforeLogout() : canLeave())) return;
    setLoggingOut(true);
    setError('');
    try {
      await auth?.logout();
      router.replace('/login');
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : text('退出失败，请重试。', 'Could not sign out. Please retry.')
      );
    } finally {
      setLoggingOut(false);
    }
  };
  return (
    <section className={s.center} aria-label={text('个人中心内容', 'Personal center content')}>
      <div className={s.identityRow}>
        <div className={s.accountIdentity}>
          <span className={s.identityAvatar} aria-hidden="true">
            {Array.from(displayName)[0]?.toUpperCase()}
          </span>
          <div className={s.identityDetails}>
            <strong>{displayName}</strong>
            <span>{user?.email}</span>
          </div>
        </div>
        <button className={s.logout} disabled={loggingOut} onClick={() => void logout()}>
          <LogOut size={16} aria-hidden="true" />
          {loggingOut ? text('正在退出…', 'Signing out…') : text('退出登录', 'Sign out')}
        </button>
      </div>
      <nav className={s.accountTabs} aria-label={text('个人中心栏目', 'Personal center sections')}>
        {navigation.map(({ id, zh, en, icon: Icon }) => (
          <button
            key={id}
            type="button"
            aria-current={selected === id ? 'page' : undefined}
            onClick={() => select(id)}
          >
            <Icon size={16} aria-hidden="true" />
            {text(zh, en)}
          </button>
        ))}
      </nav>
      <div className={s.cardHeading}>
        <h2>{text(current.zh, current.en)}</h2>
        <p>{text(current.hint, current.englishHint)}</p>
      </div>
      {error && (
        <p className={s.error} role="alert">
          {error}
        </p>
      )}
      {preferencesError && (
        <div className={s.error} role="alert">
          {text(
            '个人设置加载失败，账单仍可使用。',
            'Could not load preferences. Billing remains available.'
          )}{' '}
          <button onClick={() => void reloadProfile()}>{text('重试', 'Retry')}</button>
        </div>
      )}
      <div key={`${user?.id}:${selected}`} className={s.content}>
        {selected === 'wallet' && <WalletPanel locale={uiLanguage} timeZone={profile?.timezone} />}
        {selected === 'orders' && <OrdersPanel locale={uiLanguage} timeZone={profile?.timezone} />}
        {selected === 'usage' && <UsagePanel locale={uiLanguage} timeZone={profile?.timezone} />}
        {selected === 'settings' &&
          (profile ? (
            <SettingsPanel profile={profile} onDirtyChange={setDirty} />
          ) : (
            !preferencesError && (
              <p className={s.loading} role="status">
                {text('正在读取个人设置…', 'Loading preferences…')}
              </p>
            )
          ))}
        {selected === 'security' && <SecurityPanel timeZone={profile?.timezone} />}
        {selected === 'data' && (
          <DataPanel onWorkspace={onWorkspace} onUsage={() => select('usage')} />
        )}
      </div>
    </section>
  );
}

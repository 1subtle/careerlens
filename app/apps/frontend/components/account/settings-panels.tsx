'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Check,
  Copy,
  Download,
  Globe2,
  Mail,
  Monitor,
  RefreshCw,
  Save,
  ShieldCheck,
} from 'lucide-react';
import { accountApi, type AccountProfile, type AccountSession } from '@/lib/api/account';
import { useLanguage } from '@/lib/context/language-context';
import { useAuth } from '@/components/auth/auth-provider';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { downloadBlobAsFile } from '@/lib/utils/download';
import type { Locale } from '@/i18n/config';
import { safeAccountTimeZone } from '@/lib/utils/account-timezone';
import s from './account.module.css';

function useText() {
  const { uiLanguage } = useLanguage();
  return (zh: string, en: string) => (uiLanguage === 'zh' ? zh : en);
}
function failure(cause: unknown) {
  return cause instanceof Error ? cause.message : 'Request failed. Please retry.';
}
const editable = (profile: AccountProfile) => ({
  display_name: profile.display_name,
  ui_language: profile.ui_language,
  timezone: profile.timezone,
});

export function SettingsPanel({
  profile,
  onDirtyChange,
}: {
  profile: AccountProfile;
  onDirtyChange: (value: boolean) => void;
}) {
  const text = useText();
  const { applyProfile } = useLanguage();
  const [draft, setDraft] = useState(() => editable(profile));
  const [saved, setSaved] = useState(() => editable(profile));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [copied, setCopied] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const dirtyRef = useRef(dirty);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);
  useEffect(() => {
    if (!dirtyRef.current) {
      setDraft(editable(profile));
      setSaved(editable(profile));
    }
  }, [profile]);
  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const update = Object.fromEntries(
        Object.entries(draft).filter(([key, value]) => value !== saved[key as keyof typeof saved])
      );
      if (typeof update.display_name === 'string') update.display_name = update.display_name.trim();
      const next = await accountApi.updateProfile(update);
      applyProfile(next);
      setDraft(editable(next));
      setSaved(editable(next));
      setNotice(
        next.ui_language === 'zh'
          ? '设置已保存，下次登录会继续使用。'
          : 'Preferences saved for your next sign-in.'
      );
    } catch (cause) {
      setError(failure(cause));
    } finally {
      setSaving(false);
    }
  };
  const zones = Array.from(
    new Set([
      profile.timezone,
      'Asia/Shanghai',
      'Asia/Hong_Kong',
      'Asia/Tokyo',
      'Asia/Singapore',
      'Europe/London',
      'Europe/Paris',
      'America/New_York',
      'America/Los_Angeles',
      'Australia/Sydney',
      'UTC',
    ])
  );
  return (
    <form onSubmit={(event) => void save(event)}>
      <section className={s.card} aria-labelledby="profile-title">
        <div className={s.cardHeading}>
          <h2 id="profile-title">{text('个人资料', 'Profile')}</h2>
          <p>{text('在这里设置你希望显示的称呼。', 'Choose the name you would like to use.')}</p>
        </div>
        <div className={s.profileSummary}>
          <span className={s.largeAvatar} aria-hidden="true">
            {Array.from(draft.display_name || profile.email)[0]?.toUpperCase()}
          </span>
          <div>
            <strong>{draft.display_name || profile.email.split('@')[0]}</strong>
            <span>
              <ShieldCheck size={14} aria-hidden="true" />
              {text('邮箱已验证', 'Email verified')}
            </span>
          </div>
        </div>
        <div className={s.formGrid}>
          <label className={s.field}>
            {text('昵称', 'Display name')}
            <input
              value={draft.display_name}
              maxLength={60}
              autoComplete="nickname"
              placeholder={text('怎么称呼你', 'Your preferred name')}
              onChange={(event) => {
                setDraft({ ...draft, display_name: event.target.value });
                setNotice('');
              }}
              disabled={saving}
            />
            <small>
              {text(
                '最多 60 个字符。留空时显示邮箱名称。',
                'Up to 60 characters. Leave blank to use your email name.'
              )}
            </small>
          </label>
          <label className={s.field}>
            {text('登录邮箱', 'Sign-in email')}
            <input value={profile.email} readOnly type="email" />
            <small>
              {text(
                '通过邮箱验证码登录，无需设置密码。',
                'Sign in with an email code. No password is required.'
              )}
            </small>
          </label>
        </div>
        <div className={s.idRow}>
          <div>
            <span>{text('账号 ID', 'Account ID')}</span>
            <code>{profile.id}</code>
          </div>
          <button
            type="button"
            className={s.iconButton}
            aria-label={text('复制账号 ID', 'Copy account ID')}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(profile.id);
                setCopied(true);
              } catch {
                setError(
                  text(
                    '无法复制，请手动选择账号 ID。',
                    'Could not copy. Select the account ID manually.'
                  )
                );
              }
            }}
          >
            {copied ? <Check size={16} /> : <Copy size={16} />}
          </button>
        </div>
      </section>
      <section className={s.card} aria-labelledby="preferences-title">
        <div className={s.cardHeading}>
          <h2 id="preferences-title">{text('语言与地区', 'Language & region')}</h2>
          <p>{text('设置会保存在当前账号下。', 'These preferences are saved to your account.')}</p>
        </div>
        <div className={s.settingRow}>
          <div>
            <label htmlFor="account-language">
              <Globe2 size={18} aria-hidden="true" />
              {text('网页语言', 'Website language')}
            </label>
            <p>
              {text(
                '更改界面语言，简历原文和已保存的分析保持原语言。',
                'Changes interface text. Your documents and saved analyses keep their original language.'
              )}
            </p>
          </div>
          <select
            id="account-language"
            value={draft.ui_language === 'zh' ? 'zh' : 'en'}
            onChange={(event) => {
              setDraft({ ...draft, ui_language: event.target.value as Locale });
              setNotice('');
            }}
            disabled={saving}
          >
            <option value="zh">简体中文</option>
            <option value="en">English</option>
          </select>
        </div>
        <div className={s.settingRow}>
          <div>
            <label htmlFor="account-timezone">{text('时区', 'Time zone')}</label>
            <p>
              {text(
                '用于显示充值账单、消费日志和登录会话的时间。',
                'Used for dates in orders, usage history and login sessions.'
              )}
            </p>
          </div>
          <select
            id="account-timezone"
            value={draft.timezone}
            onChange={(event) => {
              setDraft({ ...draft, timezone: event.target.value });
              setNotice('');
            }}
            disabled={saving}
          >
            {zones.map((zone) => (
              <option key={zone} value={zone}>
                {zone === 'Asia/Shanghai'
                  ? text('中国标准时间（上海）', 'China Standard Time (Shanghai)')
                  : zone}
              </option>
            ))}
          </select>
        </div>
      </section>
      {error && (
        <p className={s.error} role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className={s.success} role="status">
          <Check size={17} aria-hidden="true" />
          {notice}
        </p>
      )}
      <div className={s.formActions}>
        <button
          className={s.secondaryButton}
          type="button"
          disabled={!dirty || saving}
          onClick={() => {
            setDraft(editable(profile));
            setSaved(editable(profile));
            setError('');
          }}
        >
          {text('取消修改', 'Discard changes')}
        </button>
        <button className={s.primaryButton} type="submit" disabled={!dirty || saving}>
          <Save size={16} aria-hidden="true" />
          {saving ? text('正在保存…', 'Saving…') : text('保存设置', 'Save preferences')}
        </button>
      </div>
    </form>
  );
}

export function SecurityPanel({ timeZone = 'Asia/Shanghai' }: { timeZone?: string }) {
  const text = useText();
  const { uiLanguage } = useLanguage();
  const auth = useAuth();
  const userId = auth?.session?.user?.id;
  const [sessions, setSessions] = useState<AccountSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirm, setConfirm] = useState<string | null>(null);
  const [revoking, setRevoking] = useState(false);
  const request = useRef(0);
  const load = useCallback(async () => {
    const id = ++request.current;
    setLoading(true);
    try {
      const result = await accountApi.sessions();
      if (id === request.current) {
        setSessions(result.items);
        setError('');
      }
    } catch (cause) {
      if (id === request.current) setError(failure(cause));
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    setSessions([]);
    void load();
    const invalidate = () => {
      request.current++;
    };
    return invalidate;
  }, [load, userId]);
  const date = (value: number | null) =>
    value == null
      ? text('较早的登录', 'Earlier sign-in')
      : new Intl.DateTimeFormat(uiLanguage === 'zh' ? 'zh-CN' : 'en-US', {
          dateStyle: 'medium',
          timeStyle: 'short',
          timeZone: safeAccountTimeZone(timeZone),
        }).format(new Date(value * 1000));
  const revoke = async () => {
    if (!confirm) return;
    setRevoking(true);
    setError('');
    try {
      if (confirm === 'others') await accountApi.revokeOthers();
      else await accountApi.revokeSession(confirm);
      setConfirm(null);
      setNotice(text('所选登录会话已退出。', 'Selected sessions have been signed out.'));
      await load();
    } catch (cause) {
      setError(failure(cause));
    } finally {
      setRevoking(false);
    }
  };
  return (
    <>
      <section className={s.card}>
        <div className={s.cardHeading}>
          <h2>{text('登录方式', 'Sign-in method')}</h2>
        </div>
        <div className={s.method}>
          <Mail size={22} aria-hidden="true" />
          <div>
            <strong>{text('邮箱验证码', 'Email verification code')}</strong>
            <p>{auth?.session?.user?.email}</p>
          </div>
          <span className={s.verified}>{text('已验证', 'Verified')}</span>
        </div>
      </section>
      <section className={s.card} aria-labelledby="sessions-title">
        <div className={s.cardToolbar}>
          <div className={s.cardHeading}>
            <h2 id="sessions-title">{text('登录会话', 'Active sessions')}</h2>
            <p>
              {text(
                '退出会话后，该设备需要重新验证邮箱。',
                'Signed-out devices will need to verify your email again.'
              )}
            </p>
          </div>
          <button
            className={s.iconButton}
            onClick={() => void load()}
            disabled={loading || revoking}
            aria-label={text('刷新登录会话', 'Refresh sessions')}
          >
            <RefreshCw size={17} aria-hidden="true" />
          </button>
        </div>
        {loading && (
          <p className={s.loading} role="status">
            {text('正在读取登录会话…', 'Loading sessions…')}
          </p>
        )}
        {!loading && !error && sessions.length === 0 && (
          <p className={s.loading}>{text('没有可显示的登录会话。', 'No sessions to display.')}</p>
        )}
        <ul className={s.sessions}>
          {sessions.map((session) => (
            <li key={session.id}>
              <span className={s.deviceIcon}>
                <Monitor size={21} aria-hidden="true" />
              </span>
              <div className={s.sessionInfo}>
                <strong>
                  {session.user_agent || text('未知设备', 'Unknown device')}
                  {session.current && (
                    <span className={s.currentBadge}>{text('当前会话', 'This session')}</span>
                  )}
                </strong>
                <span>
                  {text('登录时间：', 'Signed in: ')}
                  {date(session.created_at)}
                </span>
                <span>
                  {text('到期时间：', 'Expires: ')}
                  {date(session.expires_at)}
                </span>
              </div>
              {!session.current && (
                <button
                  className={s.secondaryButton}
                  disabled={revoking}
                  onClick={() => setConfirm(session.id)}
                >
                  {text('退出此会话', 'Sign out')}
                </button>
              )}
            </li>
          ))}
        </ul>
        <div className={s.cardBottom}>
          <button
            className={s.secondaryButton}
            disabled={loading || revoking || !sessions.some((item) => !item.current)}
            onClick={() => setConfirm('others')}
          >
            {text('退出其他所有会话', 'Sign out all other sessions')}
          </button>
          <p>{text('保留当前会话，方便你继续操作。', 'Your current session stays signed in.')}</p>
        </div>
      </section>
      {error && (
        <p className={s.error} role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className={s.success} role="status">
          {notice}
        </p>
      )}
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open && !revoking) setConfirm(null);
        }}
        title={text('退出登录会话', 'Sign out sessions')}
        description={
          confirm === 'others'
            ? text(
                '其他设备需要重新验证邮箱才能使用账户。当前会话会保留。',
                'Other devices will need to verify your email again. Your current session stays signed in.'
              )
            : text(
                '该设备将需要重新验证邮箱才能继续使用。',
                'This device will need to verify your email again.'
              )
        }
        confirmLabel={revoking ? text('正在退出…', 'Signing out…') : text('确认退出', 'Sign out')}
        cancelLabel={text('取消', 'Cancel')}
        confirmDisabled={revoking}
        cancelDisabled={revoking}
        closeOnConfirm={false}
        onConfirm={() => void revoke()}
        errorMessage={error || undefined}
      />
    </>
  );
}

export function DataPanel({
  onWorkspace,
  onUsage,
}: { onWorkspace?: () => void; onUsage?: () => void } = {}) {
  const text = useText();
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const download = async () => {
    setExporting(true);
    setError('');
    setNotice('');
    try {
      const data = await accountApi.exportData();
      downloadBlobAsFile(data, `careerlens-data-${new Date().toISOString().slice(0, 10)}.json`);
      setNotice(
        text('数据已准备好，下载已开始。', 'Your export is ready and the download has started.')
      );
    } catch (cause) {
      setError(failure(cause));
    } finally {
      setExporting(false);
    }
  };
  return (
    <>
      <section className={s.card}>
        <div className={s.cardHeading}>
          <h2>{text('下载我的数据', 'Download my data')}</h2>
          <p>
            {text(
              '保存一份当前账号的数据副本，便于备份和迁移。',
              'Keep a copy of your account data for backup or migration.'
            )}
          </p>
        </div>
        <div className={s.exportBody}>
          <span className={s.exportIcon}>
            <Download size={27} aria-hidden="true" />
          </span>
          <div>
            <strong>
              {text('个人数据包', 'Personal data export')}{' '}
              <span className={s.formatBadge}>JSON</span>
            </strong>
            <p>
              {text(
                '包含个人设置、简历、岗位、投递和历史分析记录。',
                'Includes preferences, resumes, jobs, applications and saved analyses.'
              )}
            </p>
            <p>
              {text(
                '文件可能包含个人联系方式，请保存在你信任的位置。',
                'The file may contain personal contact details. Save it in a trusted location.'
              )}
            </p>
          </div>
        </div>
        <div className={s.cardBottom}>
          <button className={s.primaryButton} disabled={exporting} onClick={() => void download()}>
            <Download size={16} aria-hidden="true" />
            {exporting
              ? text('正在准备下载…', 'Preparing download…')
              : text('导出我的数据', 'Export my data')}
          </button>
        </div>
      </section>
      <section className={s.card}>
        <div className={s.cardHeading}>
          <h2>{text('管理已有记录', 'Manage your records')}</h2>
          <p>
            {text(
              '简历、岗位和分析记录可以在工作区中逐条查看或删除。',
              'View or delete individual resumes, jobs and analyses in your workspace.'
            )}
          </p>
        </div>
        <div className={s.cardBottom}>
          <button type="button" className={s.secondaryButton} onClick={onWorkspace}>
            {text('前往工作区', 'Open workspace')}
          </button>
          <button type="button" className={s.textLink} onClick={onUsage}>
            {text('查看与导出消费日志', 'View and export usage history')}
          </button>
        </div>
      </section>
      {error && (
        <p className={s.error} role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className={s.success} role="status">
          {notice}
        </p>
      )}
    </>
  );
}

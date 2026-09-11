'use client';

import { useCareerText } from '@/lib/i18n/career';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AccountCenter } from '@/components/account/account-center';
import type { AccountSection } from '@/lib/account-sections';
import Link from 'next/link';
import Image from 'next/image';
import {
  FileText,
  BriefcaseBusiness,
  ScanText,
  Search,
  Plus,
  Settings2,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react';
import { careerApi, type CareerState } from '@/lib/api/career';
import { ResumePanel } from './resume-panel';
import { JobsPanel } from './jobs-panel';
import { MatchPanel } from './match-panel';
import { MarketPanel } from './market-panel';
import s from './workspace.module.css';
import { useAuth } from '@/components/auth/auth-provider';

export type RunAction = (message: string, task: () => Promise<void>) => Promise<void>;
const pages = [
  { id: 'resume', name: '我的简历', hint: '看清经历，让亮点被看见。', icon: FileText },
  {
    id: 'jobs',
    name: '目标岗位',
    hint: '记下心动的岗位，准备下一次出发。',
    icon: BriefcaseBusiness,
  },
  { id: 'match', name: '诊断与优化', hint: '让你的经历，回应岗位的期待。', icon: ScanText },
  { id: 'market', name: '实时岗位', hint: '发现新机会，找到自己的下一站。', icon: Search },
] as const;
type Page = (typeof pages)[number]['id'];

export default function CareerWorkspace({
  initialAccountSection,
}: { initialAccountSection?: AccountSection } = {}) {
  const tr = useCareerText();
  const auth = useAuth();
  const hosted = auth?.session?.mode === 'hosted';
  const [state, setState] = useState<CareerState | null>(null);
  const [page, setPage] = useState<Page>('resume');
  const [requestedAccountSection, setAccountSection] = useState<AccountSection | null>(
    initialAccountSection ?? null
  );
  const accountSection = hosted ? requestedAccountSection : null;
  const [accountDirty, setAccountDirty] = useState(false);
  const [resumeId, setResumeId] = useState('');
  const [jobId, setJobId] = useState('');
  const [marketKeyword, setMarketKeyword] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState(false);
  const [useAi, setUseAi] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const content = useRef<HTMLDivElement>(null);
  const status = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (content.current) content.current.scrollTop = 0;
  }, [page, accountSection]);
  useEffect(() => {
    if (!dirty && !accountDirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, accountDirty]);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mobile = window.matchMedia('(max-width: 760px)');
    const showMobileNavigation = () => {
      if (mobile.matches) setSidebarCollapsed(false);
    };
    showMobileNavigation();
    mobile.addEventListener('change', showMobileNavigation);
    return () => mobile.removeEventListener('change', showMobileNavigation);
  }, []);
  useLayoutEffect(() => {
    const main = content.current;
    const bar = status.current;
    if (!main || !bar) {
      main?.style.removeProperty('--workspace-status-height');
      return;
    }
    const syncHeight = () =>
      main.style.setProperty('--workspace-status-height', `${bar.offsetHeight}px`);
    syncHeight();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(syncHeight);
    observer?.observe(bar);
    window.addEventListener('resize', syncHeight);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', syncHeight);
      main.style.removeProperty('--workspace-status-height');
    };
  }, [notice, accountSection]);
  const showAccount = (section: AccountSection | null) => {
    setAccountSection(section);
    const url = new URL(window.location.href);
    url.pathname = '/';
    if (section) url.searchParams.set('account', section);
    else url.searchParams.delete('account');
    window.history.replaceState(
      window.history.state,
      '',
      `${url.pathname}${url.search}${url.hash}`
    );
  };
  const refresh = useCallback(async (selectedResume?: string, selectedJob?: string) => {
    const data = await careerApi.state();
    const recentUse = new Map<string, string>();
    for (const match of data.matches) {
      if (match.created_at > (recentUse.get(match.job_id) ?? '')) {
        recentUse.set(match.job_id, match.created_at);
      }
    }
    const jobs = data.jobs
      .filter((job) => job.source_type !== 'synthetic')
      .sort((a, b) =>
        (recentUse.get(b.job_id) ?? b.created_at).localeCompare(
          recentUse.get(a.job_id) ?? a.created_at
        )
      );
    const jobIds = new Set(jobs.map((job) => job.job_id));
    const next = {
      ...data,
      jobs,
      matches: data.matches.filter((match) => jobIds.has(match.job_id)),
    };
    const recentResume = [...next.resumes]
      .filter((resume) => !resume.title.startsWith('虚构示例 ·'))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
    setState(next);
    setResumeId(
      (previous) =>
        selectedResume ??
        (next.resumes.some((r) => r.id === previous) ? previous : (recentResume?.id ?? 'new'))
    );
    setJobId(
      (previous) => selectedJob ?? (previous === 'new' || jobIds.has(previous) ? previous : '')
    );
  }, []);
  useEffect(() => {
    refresh().catch(() => {
      setError(true);
      setNotice('无法连接后端，请确认服务已启动，再点击重试。');
    });
  }, [refresh]);
  const run: RunAction = async (message, task) => {
    setBusy(true);
    setError(false);
    setNotice(`${message}…`);
    try {
      await task();
      setNotice(tr('{0}完成', message));
    } catch (cause) {
      setError(true);
      setNotice(cause instanceof Error ? cause.message : tr('操作未完成，请重试。'));
    } finally {
      setBusy(false);
    }
  };
  const confirmAccountLeave = () => {
    if (busy || (accountDirty && !window.confirm(tr('有尚未保存的设置，确定离开吗？'))))
      return false;
    return true;
  };
  const confirmLeave = () => {
    if (!confirmAccountLeave()) return false;
    if (busy || (dirty && !window.confirm(tr('当前内容尚未保存，确定离开并放弃这些编辑吗？')))) {
      return false;
    }
    setDirty(false);
    return true;
  };
  const leave = (task: () => void) => {
    if (confirmLeave()) {
      showAccount(null);
      task();
    }
  };
  const guardNavigation = (event: { preventDefault: () => void }) => {
    if (!confirmLeave()) event.preventDefault();
  };
  const current = accountSection
    ? { name: '个人中心', hint: '管理积分、账单与个人设置。' }
    : pages.find((item) => item.id === page)!;
  const selectedResume = state?.resumes.find((item) => item.id === resumeId);
  const selectedJob = state?.jobs.find((item) => item.job_id === jobId);
  return (
    <div
      className={s.workspace}
      data-hosted={hosted}
      data-account={!!accountSection}
      data-sidebar-collapsed={sidebarCollapsed}
    >
      <aside
        id="workspace-sidebar"
        className={s.sidebar}
        aria-label={tr('工作区侧栏')}
        aria-hidden={sidebarCollapsed || undefined}
        inert={sidebarCollapsed}
      >
        <div className={s.brand}>
          <Image src="/illustrations/careerlens-icon.webp" width={44} height={44} alt="" priority />
          <span className={s.brandName}>
            CareerLens<small>{tr('看清经历 · 看见机会')}</small>
          </span>
        </div>
        <nav className={s.nav} aria-label={tr('工作区导航')} data-hosted={hosted}>
          {pages.map(({ id, name, icon: Icon }) => (
            <button
              key={id}
              aria-label={tr(name)}
              aria-current={!accountSection && page === id ? 'page' : undefined}
              disabled={busy}
              onClick={() => {
                if (page !== id) leave(() => setPage(id));
                else if (accountSection && confirmAccountLeave()) showAccount(null);
              }}
            >
              <Icon size={17} aria-hidden="true" />
              <span className={id === 'match' ? s.fullNavLabel : undefined}>{tr(name)}</span>
              {id === 'match' && <span className={s.shortNavLabel}>{tr('诊断优化')}</span>}
            </button>
          ))}
          {hosted && (
            <button
              aria-current={accountSection ? 'page' : undefined}
              disabled={busy}
              onClick={() => {
                if (!accountSection) showAccount('wallet');
              }}
            >
              <Settings2 size={17} aria-hidden="true" />
              <span>{tr('个人中心')}</span>
            </button>
          )}
        </nav>
        <div className={s.documents}>
          <div className={s.documentsHeading}>
            <span>
              {' '}
              {tr('简历文档')} <span className={s.documentCount}>{state?.resumes.length ?? 0}</span>
            </span>
            <button
              aria-label={tr('新建空白简历')}
              title={tr('新建空白简历')}
              disabled={busy || !state || (page === 'resume' && resumeId === 'new')}
              onClick={() =>
                leave(() => {
                  setResumeId('new');
                  setPage('resume');
                })
              }
            >
              <Plus size={16} aria-hidden="true" />
            </button>
          </div>
          <nav className={s.documentList} aria-label={tr('简历文档')}>
            {resumeId === 'new' && (
              <span className={s.newDocument}>
                <FileText size={15} aria-hidden="true" /> {tr('未命名简历')}{' '}
              </span>
            )}
            {state?.resumes.map((resume) => (
              <button
                key={resume.id}
                title={resume.title}
                aria-pressed={!accountSection && page === 'resume' && resumeId === resume.id}
                disabled={busy}
                onClick={() => {
                  if (page !== 'resume' || resumeId !== resume.id)
                    leave(() => {
                      setResumeId(resume.id);
                      setPage('resume');
                    });
                  else if (accountSection && confirmAccountLeave()) showAccount(null);
                }}
              >
                <FileText size={15} aria-hidden="true" />
                <span>{resume.title}</span>
              </button>
            ))}
          </nav>
          <label className={s.mobileVersions}>
            <span className={s.srOnly}>{tr('选择简历版本')}</span>
            <select
              value={resumeId}
              disabled={busy || !state}
              onChange={(event) => {
                if (page === 'resume' && resumeId === event.target.value) {
                  if (accountSection && confirmAccountLeave()) showAccount(null);
                  return;
                }
                leave(() => {
                  setResumeId(event.target.value);
                  setPage('resume');
                });
              }}
            >
              <option value="new">{tr('新建简历')}</option>
              {state?.resumes.map((resume) => (
                <option key={resume.id} value={resume.id}>
                  {resume.title}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className={s.sidebarFooter}>
          <button
            className={s.aiSwitch}
            type="button"
            role="switch"
            aria-label={tr('AI 辅助')}
            aria-checked={useAi}
            disabled={busy}
            onClick={() => setUseAi((enabled) => !enabled)}
          >
            <span className={s.switchTrack} aria-hidden="true" />
            AI {useAi ? tr('已开启') : tr('已关闭')}
          </button>
          {!hosted && (
            <Link className={s.settingsLink} href="/settings" onNavigate={guardNavigation}>
              <Settings2 size={16} aria-hidden="true" />
              {state?.model.configured ? tr('模型设置') : tr('配置模型')}
            </Link>
          )}
          {state && useAi && !state.model.configured && !hosted && (
            <Link className={s.modelHint} href="/settings" onNavigate={guardNavigation}>
              {' '}
              {tr('配置模型后开始使用')}{' '}
            </Link>
          )}
        </div>
      </aside>
      <div ref={content} className={s.main} aria-busy={busy} data-workspace-main>
        <header className={s.topbar}>
          <div className={s.topbarLead}>
            <button
              type="button"
              className={s.sidebarToggle}
              aria-controls="workspace-sidebar"
              aria-expanded={!sidebarCollapsed}
              aria-label={tr(sidebarCollapsed ? '展开侧栏' : '收起侧栏')}
              title={tr(sidebarCollapsed ? '展开侧栏' : '收起侧栏')}
              onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
            >
              {sidebarCollapsed ? (
                <PanelLeftOpen size={18} aria-hidden="true" />
              ) : (
                <PanelLeftClose size={18} aria-hidden="true" />
              )}
            </button>
            <div className={s.topbarTitle}>
              <h1>{tr(current.name)}</h1>
              <p>{tr(current.hint)}</p>
            </div>
          </div>
          <div className={s.topbarMeta}>
            <div className={s.accountMeta}>
              {(dirty || accountDirty || !hosted) && (
                <span className={dirty || accountDirty ? s.editingBadge : s.workspaceInfo}>
                  {dirty || accountDirty ? tr('有未保存的编辑') : tr('个人工作区')}
                </span>
              )}
              {hosted && (
                <span className={s.creditBalance} role="status" aria-atomic="true">
                  {' '}
                  {tr('积分余额')} {auth.session?.user?.credits ?? '—'}
                </span>
              )}
            </div>
            <Image
              className={s.topbarArt}
              src={
                page === 'resume' || page === 'match'
                  ? '/illustrations/career-guide.webp'
                  : '/illustrations/opportunity-discovery.webp'
              }
              width={76}
              height={54}
              loading="eager"
              alt=""
            />
          </div>
        </header>
        {hosted && !accountSection && (page !== 'resume' || auth.session?.user?.credits === 0) && (
          <p className={s.creditHint}>
            {auth.session?.user?.credits === 0
              ? tr('积分余额已用完。关闭 AI 辅助后，仍可编辑简历、核对材料并导出。')
              : tr('每次 AI 生成消耗 1 积分，失败自动退回。')}
          </p>
        )}
        {notice && !accountSection && (
          <div
            ref={status}
            className={s.status}
            role={error ? 'alert' : 'status'}
            data-error={error}
          >
            <span>{tr(notice)}</span>
            {!busy && (
              <button onClick={() => setNotice('')} aria-label={tr('关闭提示')}>
                {' '}
                {tr('关闭')}{' '}
              </button>
            )}
          </div>
        )}
        {accountSection && (
          <div className={s.accountCanvas}>
            <AccountCenter
              section={accountSection}
              onSectionChange={showAccount}
              onDirtyChange={setAccountDirty}
              onWorkspace={() => {
                if (confirmAccountLeave()) showAccount(null);
              }}
              onBeforeLogout={() =>
                !busy &&
                (!(dirty || accountDirty) ||
                  window.confirm(tr('有尚未保存的内容，退出后将放弃这些修改，确定退出吗？')))
              }
            />
          </div>
        )}
        {!state ? (
          <div
            className={s.empty}
            hidden={!!accountSection}
            style={accountSection ? { display: 'none' } : undefined}
          >
            <p>{error ? tr('服务尚未连接。') : tr('正在读取工作区…')}</p>
            <button
              className={s.button}
              onClick={() => void run(tr('连接工作区'), () => refresh())}
            >
              {' '}
              {tr('重试连接')}{' '}
            </button>
          </div>
        ) : (
          <fieldset
            className={page === 'resume' ? s.documentCanvas : s.canvas}
            disabled={busy}
            hidden={!!accountSection}
            style={accountSection ? { display: 'none' } : undefined}
          >
            {page === 'resume' && (
              <>
                <ResumePanel
                  key={resumeId}
                  resume={selectedResume}
                  active={!accountSection}
                  busy={busy}
                  useAi={useAi}
                  run={run}
                  onDirty={() => setDirty(true)}
                  onNavigate={guardNavigation}
                  onSaved={async (r) => {
                    setDirty(false);
                    await refresh(r.id);
                  }}
                  onDeleted={async () => {
                    setDirty(false);
                    await refresh();
                  }}
                  onNext={() => leave(() => setPage('jobs'))}
                />
              </>
            )}
            {page === 'jobs' && (
              <JobsPanel
                key={jobId}
                jobs={state.jobs}
                selected={selectedJob}
                busy={busy}
                useAi={useAi}
                run={run}
                onDirty={() => setDirty(true)}
                onSelect={(id) => {
                  if (id !== jobId) leave(() => setJobId(id));
                }}
                onSaved={async (j) => {
                  setDirty(false);
                  await refresh(undefined, j.job_id);
                }}
                onDeleted={async () => {
                  setDirty(false);
                  await refresh();
                }}
                onNext={() => leave(() => setPage('match'))}
              />
            )}
            {page === 'match' && (
              <MatchPanel
                state={state}
                resumeId={resumeId}
                jobId={jobId}
                setResumeId={setResumeId}
                setJobId={setJobId}
                busy={busy}
                useAi={useAi}
                run={run}
                refresh={refresh}
                onFindJobs={(keyword) =>
                  leave(() => {
                    setMarketKeyword(keyword);
                    setPage('market');
                  })
                }
                onResume={(id) => {
                  setResumeId(id);
                  setPage('resume');
                }}
              />
            )}
            {page === 'market' && (
              <MarketPanel
                jobs={state.jobs}
                initialKeyword={marketKeyword}
                busy={busy}
                useAi={useAi}
                run={run}
                onJob={async (id) => {
                  await refresh(undefined, id);
                  setPage('jobs');
                }}
              />
            )}
          </fieldset>
        )}
      </div>
    </div>
  );
}

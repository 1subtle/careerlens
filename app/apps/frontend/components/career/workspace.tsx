'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { careerApi, type CareerState } from '@/lib/api/career';
import { ResumePanel } from './resume-panel';
import { JobsPanel } from './jobs-panel';
import { MatchPanel } from './match-panel';
import { MarketPanel } from './market-panel';
import s from './workspace.module.css';

export type RunAction = (message: string, task: () => Promise<void>) => Promise<void>;
const pages = [
  {
    id: 'resume',
    name: '我的简历',
    title: '从你的真实经历开始。',
    description: '建立一份完整的基础简历。粘贴文本、导入文件，或直接填写；保存前核对每一项事实。',
  },
  {
    id: 'jobs',
    name: '目标岗位',
    title: '把岗位要求看清楚。',
    description: '保留 JD 原文与来源，校对技能、任务和重要程度，为每一次匹配建立可靠依据。',
  },
  {
    id: 'match',
    name: '诊断与优化',
    title: '每一分，都有依据。',
    description: '先检查材料能支持哪些岗位要求，再补充事实、改进表达，保留原版与每次修改。',
  },
  {
    id: 'market',
    name: '市场观察',
    title: '从岗位样本，找到方向。',
    description: '查看技能频次、薪资披露区间与不同岗位的要求。所有统计均来自当前岗位库。',
  },
] as const;
type Page = (typeof pages)[number]['id'];

export default function CareerWorkspace() {
  const [state, setState] = useState<CareerState | null>(null);
  const [page, setPage] = useState<Page>('resume');
  const [resumeId, setResumeId] = useState('');
  const [jobId, setJobId] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState(false);
  const [useAi, setUseAi] = useState(false);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const refresh = useCallback(async (selectedResume?: string, selectedJob?: string) => {
    const next = await careerApi.state();
    setState(next);
    setResumeId(
      (previous) =>
        selectedResume ??
        (next.resumes.some((r) => r.id === previous)
          ? previous
          : (next.resumes.find((r) => r.is_master)?.id ?? next.resumes[0]?.id ?? ''))
    );
    setJobId(
      (previous) =>
        selectedJob ??
        (next.jobs.some((j) => j.job_id === previous) ? previous : (next.jobs[0]?.job_id ?? ''))
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
      setNotice(`${message}完成`);
    } catch (cause) {
      setError(true);
      setNotice(cause instanceof Error ? cause.message : '操作未完成，请重试。');
    } finally {
      setBusy(false);
    }
  };
  const leave = (task: () => void) => {
    if (dirty && !window.confirm('当前内容尚未保存，确定离开并放弃这些编辑吗？')) return;
    setDirty(false);
    task();
  };
  const current = pages.find((item) => item.id === page)!;
  const selectedResume = state?.resumes.find((item) => item.id === resumeId);
  const selectedJob = state?.jobs.find((item) => item.job_id === jobId);
  return (
    <div className={s.workspace}>
      <header className={s.header}>
        <Link href="/" className={s.brand}>
          CareerLens<span>简历诊断与岗位匹配</span>
        </Link>
        <div className={s.headerActions}>
          <label className={s.check}>
            <input
              type="checkbox"
              checked={useAi}
              disabled={!state?.model.configured || busy}
              onChange={(e) => setUseAi(e.target.checked)}
            />
            使用 AI 辅助
          </label>
          <Link href="/settings">{state?.model.configured ? '模型设置' : '配置模型'}</Link>
        </div>
      </header>
      {notice && (
        <div className={s.status} role={error ? 'alert' : 'status'} data-error={error}>
          <span>{notice}</span>
          {!busy && (
            <button onClick={() => setNotice('')} aria-label="关闭提示">
              关闭
            </button>
          )}
        </div>
      )}
      <div className={s.layout}>
        <aside className={s.sidebar}>
          <p className={s.eyebrow}>YOUR CAREER WORKSPACE</p>
          <nav className={s.nav} aria-label="工作区导航">
            {pages.map((item, i) => (
              <button
                key={item.id}
                aria-current={page === item.id ? 'page' : undefined}
                disabled={busy}
                onClick={() => leave(() => setPage(item.id))}
              >
                <small>0{i + 1}</small>
                {item.name}
              </button>
            ))}
          </nav>
          <div className={s.sideNote}>
            <p>本地个人工作区</p>
            <p>材料由你掌握，事实由你确认。匹配分数表示材料覆盖度。</p>
            <p style={{ marginTop: 16 }}>
              {state?.resumes.length ?? 0} 份简历版本
              <br />
              {state?.jobs.length ?? 0} 条岗位记录
            </p>
          </div>
        </aside>
        <div className={s.main} aria-busy={busy}>
          <div className={s.heading}>
            <div>
              <p className={s.eyebrow}>CAREERLENS / {current.name}</p>
              <h1>{current.title}</h1>
              <p className={s.lead}>{current.description}</p>
            </div>
            <div className={s.actions}>
              {dirty && <span className={s.muted}>有未保存的编辑</span>}
              {state && state.jobs.length === 0 && (
                <button
                  className={s.button}
                  disabled={busy}
                  onClick={() =>
                    void run('载入虚构示例', async () => {
                      await careerApi.demo();
                      await refresh();
                    })
                  }
                >
                  试用虚构示例
                </button>
              )}
            </div>
          </div>
          {!state ? (
            <div className={s.empty}>
              <p>{error ? '服务尚未连接。' : '正在读取本地工作区…'}</p>
              <button className={s.button} onClick={() => void run('连接工作区', () => refresh())}>
                重试连接
              </button>
            </div>
          ) : (
            <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
              {page === 'resume' && (
                <>
                  <div className={s.toolbar}>
                    <label className={s.field}>
                      <span>当前简历 / 版本</span>
                      <select
                        aria-label="选择简历版本"
                        value={resumeId}
                        disabled={busy}
                        onChange={(e) => leave(() => setResumeId(e.target.value))}
                      >
                        <option value="new">新建简历</option>
                        {state.resumes.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.title.replace(/ · (基础版|定向版)$/, '')}
                            {r.is_master ? ' · 基础版' : r.parent_id ? ' · 定向版' : ''}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div />
                    <button
                      className={s.button}
                      disabled={busy}
                      onClick={() => leave(() => setResumeId('new'))}
                    >
                      新建空白简历
                    </button>
                  </div>
                  <ResumePanel
                    key={`${resumeId}:${selectedResume?.hash}`}
                    resume={selectedResume}
                    busy={busy}
                    useAi={useAi}
                    run={run}
                    onDirty={() => setDirty(true)}
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
                  onSelect={(id) => leave(() => setJobId(id))}
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
                  onResume={(id) => {
                    setResumeId(id);
                    setPage('resume');
                  }}
                />
              )}
              {page === 'market' && (
                <MarketPanel
                  jobs={state.jobs}
                  busy={busy}
                  useAi={useAi}
                  run={run}
                  onJob={(id) => {
                    setJobId(id);
                    setPage('jobs');
                  }}
                />
              )}
            </fieldset>
          )}
          <footer className={s.footer}>
            <span>CAREERLENS · 基于 Resume Matcher 构建</span>
            <span>{useAi ? 'AI 辅助已启用' : '规则与事实整理模式'}</span>
          </footer>
        </div>
      </div>
    </div>
  );
}

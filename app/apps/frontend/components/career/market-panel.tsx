'use client';

import { useCareerText, CareerLoading } from '@/lib/i18n/career';

import { useCallback, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import Image from 'next/image';
import { ArrowUpRight, BarChart3, BookmarkPlus, Copy, Search, Sparkles } from 'lucide-react';
import {
  careerApi,
  saveJson,
  type CareerJob,
  type LiveJobs,
  type MarketAnalysis,
  type MarketHistoryItem,
  type RecruitmentProvider,
} from '@/lib/api/career';
import type { RunAction } from './workspace';
import { MarketScope, SavedMarketPanel } from './saved-market-panel';
import s from './workspace.module.css';
import m from './saved-market-panel.module.css';

const Charts = dynamic(() => import('./market-charts'), {
  ssr: false,
  loading: () => (
    <p>
      <CareerLoading text="正在载入图表…" />
    </p>
  ),
});

// Official search entry points, checked on 2026-09-10. These are not data providers.
const externalPlatforms = [
  { name: 'BOSS直聘', url: 'https://www.zhipin.com/web/geek/job', keywordParam: 'query' },
  { name: '智联招聘', url: 'https://www.zhaopin.com/sou', keywordParam: '' },
  { name: '前程无忧', url: 'https://we.51job.com/pc/search', keywordParam: '' },
  { name: '猎聘', url: 'https://www.liepin.com/zhaopin/?init=1', keywordParam: '' },
  { name: '实习僧', url: 'https://www.shixiseng.com/interns', keywordParam: '' },
];

interface Props {
  jobs: CareerJob[];
  initialKeyword?: string;
  busy: boolean;
  useAi: boolean;
  run: RunAction;
  onJob: (id: string) => void | Promise<void>;
}

export function MarketPanel({ jobs, initialKeyword = '', busy, useAi, run, onJob }: Props) {
  const tr = useCareerText();
  const [view, setView] = useState<'live' | 'saved'>('live');
  const [keyword, setKeyword] = useState(initialKeyword);
  const [copiedKeyword, setCopiedKeyword] = useState('');
  const [copyFailed, setCopyFailed] = useState(false);
  const [provider, setProvider] = useState<RecruitmentProvider>('ncss');
  const [geo, setGeo] = useState('');
  const [applied, setApplied] = useState({
    keyword: '',
    provider: 'ncss' as RecruitmentProvider,
    geo: '',
  });
  const [result, setResult] = useState<LiveJobs | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [chartsOpen, setChartsOpen] = useState(false);
  const [analysis, setAnalysis] = useState<MarketAnalysis | null>(null);
  const [history, setHistory] = useState<MarketHistoryItem[] | null>(null);
  const [historyResult, setHistoryResult] = useState<MarketAnalysis | null>(null);
  const [question, setQuestion] = useState(tr('这些岗位有哪些共同要求？我应该怎样准备项目经历？'));
  const requestId = useRef(0);

  const search = useCallback(
    async (query: string, page: number, source: RecruitmentProvider, region: string) => {
      const id = ++requestId.current;
      setLoading(true);
      setError('');
      try {
        const next = await careerApi.liveJobs(query.trim(), page, source, region);
        if (id !== requestId.current) return;
        setResult(next);
        setApplied({ keyword: query.trim(), provider: source, geo: region });
        setAnalysis(null);
      } catch (cause) {
        if (id !== requestId.current) return;
        setError(cause instanceof Error ? cause.message : '岗位查询失败，请稍后重试。');
      } finally {
        if (id === requestId.current) setLoading(false);
      }
    },
    []
  );
  useEffect(() => {
    void search(initialKeyword, 1, 'ncss', '');
    return () => {
      requestId.current += 1;
    };
  }, [search, initialKeyword]);

  const locked = busy || loading;
  return (
    <>
      <nav className={m.navigation} aria-label={tr('岗位市场视图')}>
        <button
          type="button"
          className={s.button}
          aria-pressed={view === 'live'}
          onClick={() => setView('live')}
        >
          <Search size={18} aria-hidden="true" />
          {tr('实时招聘搜索')}
        </button>
        <button
          type="button"
          className={s.button}
          aria-pressed={view === 'saved'}
          onClick={() => setView('saved')}
        >
          <BarChart3 size={18} aria-hidden="true" />
          {tr('已保存岗位分析')}
        </button>
      </nav>
      <div hidden={view !== 'saved'}>
        <SavedMarketPanel
          jobs={jobs}
          busy={busy}
          useAi={useAi}
          run={run}
          onSearch={() => setView('live')}
          onSaved={async () => {
            if (history !== null) setHistory(await careerApi.marketHistory());
          }}
        />
      </div>
      <div hidden={view !== 'live'}>
        <form
          className={s.panel}
          onSubmit={(event) => {
            event.preventDefault();
            void search(keyword, 1, provider, provider === 'jobicy' ? geo : '');
          }}
        >
          <div className={s.searchBar}>
            <label className={s.field}>
              <span>{tr('想找什么岗位？')}</span>
              <input
                value={keyword}
                onChange={(event) => {
                  setKeyword(event.target.value);
                  setCopyFailed(false);
                }}
                minLength={provider === 'jobicy' ? 3 : undefined}
                maxLength={provider === 'jobicy' ? 50 : 100}
                placeholder={
                  provider === 'jobicy'
                    ? tr('试试 Python、data 或 design')
                    : tr('试试 数据分析、产品经理')
                }
              />
            </label>
            <button type="submit" className={`${s.button} ${s.primary}`} disabled={locked}>
              <Search size={18} aria-hidden="true" />
              {loading ? tr('正在查询…') : tr('查找岗位')}
            </button>
          </div>
          <div className={s.marketFilters}>
            <label className={s.field}>
              <span>{tr('招聘来源')}</span>
              <select
                value={provider}
                onChange={(event) => setProvider(event.target.value as RecruitmentProvider)}
              >
                <option value="ncss">{tr('国家大学生就业服务平台 · 国内多公司')}</option>
                <option value="tencent">{tr('腾讯招聘')}</option>
                <option value="jobicy">{tr('Jobicy · 国际远程')}</option>
              </select>
            </label>
            {provider === 'jobicy' && (
              <label className={s.field}>
                <span>{tr('远程适用地区')}</span>
                <select value={geo} onChange={(event) => setGeo(event.target.value)}>
                  <option value="">{tr('全部地区')}</option>
                  <option value="china">{tr('中国')}</option>
                  <option value="usa">{tr('美国')}</option>
                  <option value="europe">{tr('欧洲')}</option>
                </select>
              </label>
            )}
          </div>
        </form>
        <section className={s.panel} aria-label={tr('更多国内招聘平台')}>
          <div className={s.sourceBar}>
            <strong>{tr('更多国内招聘平台')}</strong>
            <span className={s.muted}>{tr('外部搜索入口 · 不计入本页统计')}</span>
          </div>
          <div className={s.actions}>
            {externalPlatforms.map((platform) => {
              const url = new URL(platform.url);
              if (platform.keywordParam && keyword.trim()) {
                url.searchParams.set(platform.keywordParam, keyword.trim());
              }
              return (
                <a
                  key={platform.name}
                  className={s.button}
                  href={url.toString()}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={tr('在{0}搜索（新窗口）', tr(platform.name))}
                >
                  {tr(platform.name)}
                  <ArrowUpRight size={16} aria-hidden="true" />
                </a>
              );
            })}
            {keyword.trim() && (
              <button
                type="button"
                className={s.button}
                onClick={async () => {
                  setCopiedKeyword('');
                  setCopyFailed(false);
                  try {
                    await navigator.clipboard.writeText(keyword.trim());
                    setCopiedKeyword(keyword.trim());
                    setCopyFailed(false);
                  } catch {
                    setCopyFailed(true);
                  }
                }}
              >
                <Copy size={16} aria-hidden="true" />
                {copiedKeyword === keyword.trim() ? tr('关键词已复制') : tr('复制关键词')}
              </button>
            )}
          </div>
          {copyFailed && (
            <p role="status" className={s.note}>
              {tr('无法自动复制，请手动复制上方关键词。')}
            </p>
          )}
          <p className={s.muted}>
            {tr('在官网继续查找，找到合适岗位后可将完整 JD 粘贴到「目标岗位」。')}
          </p>
        </section>
        {error && (
          <p role="alert" className={s.note}>
            {tr(error)}
            {result && tr(' 下方保留上次查询结果，可再次查询。')}
          </p>
        )}
        <div aria-live="polite" aria-busy={loading}>
          {loading && <p className={s.note}>{tr('正在获取岗位及完整任职要求，请稍候…')}</p>}
          {result && (
            <>
              <div className={s.sourceBar}>
                <span className={s.tag}>
                  {result.source_name} · {result.coverage}
                </span>
                <a href={result.source_url} target="_blank" rel="noreferrer">
                  {' '}
                  {tr('查看招聘来源 ↗')}{' '}
                </a>
              </div>
              <div className={s.stats}>
                <p>
                  <span className={s.number}>{result.total}</span>
                  {result.total_kind === 'sample'
                    ? tr('本次返回岗位')
                    : result.total_kind === 'capped'
                      ? tr('公开检索结果')
                      : tr('来源命中岗位')}
                </p>
                <p>
                  <span className={s.number}>
                    {new Set(result.jobs.map((job) => job.company).filter(Boolean)).size}
                  </span>{' '}
                  {tr('本页雇主')}{' '}
                </p>
                <p>
                  <span className={s.number}>{result.summary.count}</span>
                  {tr('本页完整 JD 样本')}{' '}
                </p>
              </div>
              <p className={s.muted} style={{ margin: '16px 0' }}>
                {' '}
                {tr('查询：')}
                {applied.keyword || tr('全部岗位')}
                {applied.geo
                  ? tr(
                      ' · 地区筛选：{0}',
                      tr(
                        { china: '中国相关远程机会', usa: '美国', europe: '欧洲' }[applied.geo] ||
                          applied.geo
                      )
                    )
                  : ''}{' '}
                {tr('· 获取于')} {tr.date(result.fetched_at)}
              </p>
              {result.warnings.map((warning) => (
                <p className={s.note} key={warning}>
                  {warning}
                </p>
              ))}
              {!result.jobs.length ? (
                <div className={s.empty}>
                  <Image
                    src="/illustrations/opportunity-discovery.webp"
                    width={180}
                    height={120}
                    alt=""
                  />
                  <h2>{tr('换个关键词，再找找。')}</h2>
                  <p>{tr('试试技能名称，或换一个地区。')}</p>
                </div>
              ) : (
                <div className={s.liveJobs}>
                  {result.jobs.map((job) => {
                    const remembered = jobs.some(
                      (item) =>
                        item.source_type === 'api' &&
                        item.source_name === job.source_name &&
                        item.external_id === job.external_id
                    );
                    return (
                      <details className={s.liveJob} key={job.job_id}>
                        <summary>
                          <span className={s.jobHeading}>
                            <strong>{job.title}</strong>
                            <span className={s.muted}>
                              {job.company} · {job.remote_scope || job.city || tr('地点见原文')} ·{' '}
                              {job.category || tr('其他')}
                              {remembered ? tr(' · 已记住') : ''}
                            </span>
                          </span>
                          <span className={s.jobDate}>
                            {job.source_updated_at
                              ? tr('更新 {0}', job.source_updated_at)
                              : job.published_at
                                ? tr('发布 {0}', job.published_at.slice(0, 10))
                                : tr('日期未注明')}
                          </span>
                        </summary>
                        <div className={s.jobBody}>
                          {!job.description_complete && (
                            <p className={s.note}>
                              {' '}
                              {tr('完整 JD 暂未取回，以下为职责概要；请打开官网查看。')}{' '}
                            </p>
                          )}
                          {(job.salary_display || job.salary_text) && (
                            <p className={s.muted}>
                              {' '}
                              {tr('来源标注薪资：')}
                              {job.salary_display || job.salary_text}
                            </p>
                          )}
                          <p className={s.jdText}>{job.content}</p>
                          <div className={s.actions}>
                            <button
                              className={`${s.button} ${s.primary}`}
                              disabled={locked || !job.description_complete}
                              onClick={() =>
                                void run(tr('记住 JD'), async () => {
                                  const saved = await careerApi.rememberLiveJob(
                                    job.external_id,
                                    result.provider,
                                    applied.keyword,
                                    applied.geo
                                  );
                                  await onJob(saved.job_id);
                                })
                              }
                            >
                              <BookmarkPlus size={18} aria-hidden="true" />
                              {remembered ? tr('再次使用这份 JD') : tr('使用并记住这份 JD')}
                            </button>
                            {job.source_url && /^https?:\/\//i.test(job.source_url) && (
                              <a
                                className={s.button}
                                href={job.source_url}
                                target="_blank"
                                rel="noreferrer"
                              >
                                {' '}
                                {tr('查看岗位原文 ↗')}{' '}
                              </a>
                            )}
                          </div>
                        </div>
                      </details>
                    );
                  })}
                </div>
              )}
              <nav className={s.pagination} aria-label={tr('实时岗位分页')}>
                <button
                  className={s.button}
                  disabled={locked || result.page <= 1}
                  onClick={() =>
                    void search(applied.keyword, result.page - 1, applied.provider, applied.geo)
                  }
                >
                  {' '}
                  {tr('上一页')}{' '}
                </button>
                <span className={s.muted}>
                  {' '}
                  {tr('第')} {result.page} {tr('页 · 每页最多')} {result.page_size} {tr('条')}{' '}
                </span>
                <button
                  className={s.button}
                  disabled={
                    locked ||
                    result.page >= 100 ||
                    (result.has_more !== undefined
                      ? !result.has_more
                      : result.page * result.page_size >= result.total)
                  }
                  onClick={() =>
                    void search(applied.keyword, result.page + 1, applied.provider, applied.geo)
                  }
                >
                  {' '}
                  {tr('下一页')}{' '}
                </button>
              </nav>
              {result.summary.count > 0 && (
                <>
                  <details
                    className={s.section}
                    open={chartsOpen}
                    onToggle={(event) => setChartsOpen(event.currentTarget.open)}
                  >
                    <summary>
                      {tr('查看本页岗位的技能与薪资统计 ·')} {result.summary.count}{' '}
                      {tr('份完整 JD')}
                    </summary>
                    {chartsOpen && <Charts summary={result.summary} />}
                    <details>
                      <summary>{tr('查看技能频次明细')}</summary>
                      <div className={s.tableWrap}>
                        <table className={s.table}>
                          <thead>
                            <tr>
                              <th>{tr('技能')}</th>
                              <th>{tr('提及岗位数 / 本页样本')}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {result.summary.skills.map((skill) => (
                              <tr key={skill.name}>
                                <td>{skill.name}</td>
                                <td>
                                  {skill.value} / {result.summary.count}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </details>
                    <button
                      className={s.button}
                      onClick={() => saveJson(result, tr('CareerLens-实时岗位样本.json'))}
                    >
                      {' '}
                      {tr('导出本页样本与统计')}{' '}
                    </button>
                    <button
                      className={s.button}
                      disabled={locked}
                      onClick={() =>
                        void run(tr('保存本页统计'), async () => {
                          setHistoryResult(
                            await careerApi.analyzeLiveJobs(result.jobs, tr('本页岗位统计'), false)
                          );
                          if (history !== null) setHistory(await careerApi.marketHistory());
                        })
                      }
                    >
                      {' '}
                      {tr('保存本页统计到历史')}{' '}
                    </button>
                  </details>
                  <details className={s.section}>
                    <summary>
                      {useAi ? tr('让 AI 解读本页招聘要求') : tr('查看本页岗位的准备建议')}
                    </summary>
                    <label className={s.field}>
                      <span>{tr('想了解什么')}</span>
                      <textarea
                        rows={3}
                        maxLength={1000}
                        value={question}
                        onChange={(event) => setQuestion(event.target.value)}
                      />
                    </label>
                    <button
                      className={s.button}
                      disabled={locked || !question.trim()}
                      onClick={() =>
                        void run(tr('生成本页岗位解读'), async () => {
                          setAnalysis(
                            await careerApi.analyzeLiveJobs(result.jobs, question, useAi)
                          );
                          if (history !== null) setHistory(await careerApi.marketHistory());
                        })
                      }
                    >
                      <Sparkles size={18} aria-hidden="true" />
                      {useAi ? tr('AI 解读这些 JD') : tr('生成统计说明')}
                    </button>
                    {analysis && (
                      <div className={s.panel} style={{ marginTop: 24 }}>
                        <p className={s.muted}>
                          {analysis.mode === 'ai' ? tr('AI 辅助解读') : tr('规则统计说明')}{' '}
                          {tr('· 本页内')} {analysis.summary.count} {tr('份 JD')}{' '}
                          {analysis.summary.filters.category &&
                            ` · ${analysis.summary.filters.category}`}
                          {analysis.summary.filters.city && ` · ${analysis.summary.filters.city}`}
                        </p>
                        {analysis.points.map((point) => (
                          <p key={point}>{point}</p>
                        ))}
                        <p className={s.note}>{analysis.advice}</p>
                      </div>
                    )}
                  </details>
                </>
              )}
            </>
          )}
        </div>
      </div>
      <details
        className={s.section}
        onToggle={(event) => {
          if (event.currentTarget.open)
            void run(tr('读取岗位统计历史'), async () =>
              setHistory(await careerApi.marketHistory())
            );
        }}
      >
        <summary>{tr('岗位统计与解读历史')}</summary>
        <p className={s.muted}>{tr('每份记录保留当时的岗位样本、筛选条件与结果。')}</p>
        {history?.length === 0 && <p>{tr('还没有岗位统计记录。')}</p>}
        {history?.map((item) => (
          <article className={s.analysisFinding} key={item.id}>
            <h3>{item.question || tr('岗位样本统计')}</h3>
            <p className={s.muted}>
              {tr.date(item.created_at)} ·{' '}
              {item.source === 'live' ? tr('实时岗位样本') : tr('已保存 JD')} · {item.count}{' '}
              {tr('份 JD')}{' '}
            </p>
            <div className={s.actions}>
              <button
                className={s.button}
                disabled={locked}
                onClick={() =>
                  void run(tr('查看岗位统计历史'), async () =>
                    setHistoryResult(await careerApi.getMarketHistory(item.id))
                  )
                }
              >
                {' '}
                {tr('查看这次统计')}{' '}
              </button>
              <button
                className={s.button}
                disabled={locked}
                onClick={() => {
                  if (window.confirm(tr('删除这次统计记录？已保存的 JD 会保留。')))
                    void run(tr('删除岗位统计历史'), async () => {
                      await careerApi.deleteMarketHistory(item.id);
                      setHistory((items) => items?.filter((entry) => entry.id !== item.id) ?? null);
                      if (historyResult?.history_id === item.id) setHistoryResult(null);
                    });
                }}
              >
                {' '}
                {tr('删除记录')}{' '}
              </button>
            </div>
          </article>
        ))}
      </details>
      {historyResult && (
        <section className={s.section} aria-label={tr('岗位统计历史详情')}>
          <h2>{historyResult.input_snapshot?.question || tr('已保存的岗位统计')}</h2>
          <p className={s.muted}>
            {historyResult.created_at && tr.date(historyResult.created_at)} ·{' '}
            {historyResult.summary.count} {tr('份 JD ·')}{' '}
            {historyResult.mode === 'ai' ? tr('AI 解读') : tr('统计说明')}
          </p>
          <MarketScope summary={historyResult.summary} />
          <Charts summary={historyResult.summary} />
          {historyResult.points.map((point) => (
            <p key={point}>{point}</p>
          ))}
          {historyResult.advice && <p>{historyResult.advice}</p>}
          {historyResult.input_snapshot && (
            <details>
              <summary>{tr('查看保存时的岗位样本')}</summary>
              {historyResult.input_snapshot.jobs
                .filter((job) => historyResult.summary.job_ids.includes(job.job_id))
                .map((job) => (
                  <details key={job.job_id}>
                    <summary>
                      {job.title} · {job.company}
                    </summary>
                    <p className={s.jdText}>{job.content}</p>
                  </details>
                ))}
            </details>
          )}
          <div className={s.actions}>
            <button
              className={s.button}
              onClick={() => saveJson(historyResult, tr('CareerLens-岗位统计历史.json'))}
            >
              {' '}
              {tr('导出统计与岗位样本')}{' '}
            </button>
            <button className={s.button} onClick={() => setHistoryResult(null)}>
              {' '}
              {tr('收起历史详情')}{' '}
            </button>
          </div>
        </section>
      )}
    </>
  );
}

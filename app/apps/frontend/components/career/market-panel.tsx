'use client';

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import {
  careerApi,
  saveJson,
  type CareerJob,
  type MarketAnalysis,
  type MarketFilters,
  type MarketSummary,
} from '@/lib/api/career';
import type { RunAction } from './workspace';
import s from './workspace.module.css';

const Charts = dynamic(() => import('./market-charts'), {
  ssr: false,
  loading: () => <p>正在载入图表…</p>,
});
interface Props {
  jobs: CareerJob[];
  busy: boolean;
  useAi: boolean;
  run: RunAction;
  onJob: (id: string) => void;
}
export function MarketPanel({ jobs, busy, useAi, run, onJob }: Props) {
  const [filters, setFilters] = useState<MarketFilters>({
    category: '',
    city: '',
    since: null,
    include_demo: false,
  });
  const [summary, setSummary] = useState<MarketSummary | null>(null);
  const [analysis, setAnalysis] = useState<MarketAnalysis | null>(null);
  const [question, setQuestion] = useState('这些岗位有哪些共同要求？我应该怎样补充项目经历？');
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    careerApi
      .market(filters)
      .then((value) => {
        if (!cancelled) {
          setSummary(value);
          setError('');
        }
      })
      .catch(() => {
        if (!cancelled) setError('统计读取失败，请调整筛选或刷新页面重试。');
      });
    return () => {
      cancelled = true;
    };
  }, [filters]);
  const update = <K extends keyof MarketFilters>(key: K, value: MarketFilters[K]) => {
    setFilters((previous) => ({ ...previous, [key]: value }));
    setSummary(null);
    setAnalysis(null);
  };
  const categories = [...new Set(jobs.map((j) => j.category || '其他'))].sort();
  const cities = [...new Set(jobs.map((j) => j.city).filter(Boolean))];
  return (
    <>
      <div className={s.formGrid}>
        <label className={s.field}>
          <span>岗位类别</span>
          <select value={filters.category} onChange={(e) => update('category', e.target.value)}>
            <option value="">全部类别</option>
            {categories.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <label className={s.field}>
          <span>城市</span>
          <select value={filters.city} onChange={(e) => update('city', e.target.value)}>
            <option value="">全部城市</option>
            {cities.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <label className={s.field}>
          <span>发布日期起点</span>
          <input
            type="date"
            value={filters.since || ''}
            onChange={(e) => update('since', e.target.value || null)}
          />
        </label>
      </div>
      <label className={s.check}>
        <input
          type="checkbox"
          checked={filters.include_demo}
          onChange={(e) => update('include_demo', e.target.checked)}
        />
        包含虚构示例（仅用于功能演示）
      </label>
      {filters.since && <p className={s.muted}>已排除发布日期未知的岗位。</p>}
      {error && (
        <p role="alert" className={s.note}>
          {error}
        </p>
      )}
      {!summary ? (
        <p className={s.muted} style={{ marginTop: 24 }}>
          正在统计当前范围…
        </p>
      ) : !summary.count ? (
        <div className={s.empty}>
          <h2>当前范围没有岗位样本。</h2>
          <p>
            在“目标岗位”中录入真实 JD 后即可生成统计。虚构示例默认不计入；勾选上方选项可以体验图表。
          </p>
        </div>
      ) : (
        <>
          <div className={s.stats}>
            <p>
              <span className={s.number}>{summary.count}</span> 去重岗位
            </p>
            <p>
              <span className={s.number}>{summary.salaries.length}</span> 有效薪资
            </p>
            <p>
              <span className={s.number}>{summary.salary_missing}</span> 薪资缺失 / 无法解析
            </p>
          </div>
          {!!summary.demo_count && (
            <p className={s.note} style={{ margin: '24px 0' }}>
              当前统计包含 {summary.demo_count} 条虚构示例，仅展示功能和计算口径。
            </p>
          )}
          <Charts summary={summary} />
          <section className={s.section}>
            <h2>基于样本的观察</h2>
            <label className={s.field}>
              <span>
                {useAi ? '问题会转换为已存在的类别与城市筛选' : '规则模式按上方筛选生成统计说明'}
              </span>
              <textarea
                rows={3}
                maxLength={1000}
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
              />
            </label>
            <button
              className={`${s.button} ${s.primary}`}
              disabled={busy || !question.trim()}
              onClick={() =>
                void run('生成样本解读', async () => {
                  const value = await careerApi.analyze(filters, question, useAi);
                  setFilters(value.summary.filters);
                  setSummary(value.summary);
                  setAnalysis(value);
                })
              }
            >
              {useAi ? 'AI 解读当前岗位样本' : '生成统计说明'}
            </button>
            {analysis && (
              <div className={s.panel} style={{ marginTop: 24 }}>
                <span className={s.tag}>
                  {analysis.mode === 'ai' ? 'AI 辅助解读' : '规则统计说明'}
                </span>
                <p className={s.muted}>
                  范围：{analysis.summary.filters.category || '全部类别'} /{' '}
                  {analysis.summary.filters.city || '全部城市'} · {analysis.summary.count} 条岗位
                </p>
                {analysis.points.map((point) => (
                  <p key={point}>{point}</p>
                ))}
                <p className={s.note} style={{ marginTop: 16 }}>
                  {analysis.advice}
                </p>
              </div>
            )}
          </section>
          <section className={s.section}>
            <h2>统计明细与来源</h2>
            <div className={s.actions}>
              <button
                className={s.button}
                onClick={() => saveJson(analysis ?? summary, 'CareerLens-市场统计.json')}
              >
                导出统计 JSON
              </button>
              <span className={s.muted}>
                统计日期 {summary.date} · 样本指纹 {summary.dataset_hash.slice(0, 12)}
              </span>
            </div>
            <p className={s.muted} style={{ marginTop: 16 }}>
              这些结果描述当前录入样本。日薪、月薪和年薪独立比较，未披露金额保留缺失。
            </p>
            <details>
              <summary>查看技能频次与类别分母</summary>
              <div className={s.tableWrap}>
                <table className={s.table}>
                  <thead>
                    <tr>
                      <th>技能</th>
                      <th>岗位数 / 总数</th>
                      {summary.distribution.map((category) => (
                        <th key={category.category}>{category.category}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {summary.skills.map((skill) => (
                      <tr key={skill.name}>
                        <td>{skill.name}</td>
                        <td>
                          {skill.value} / {summary.count}
                        </td>
                        {summary.distribution.map((category) => (
                          <td key={category.category}>
                            {category.skills.find((item) => item.name === skill.name)?.count ?? 0} /{' '}
                            {category.count}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
            <div className={s.tableWrap}>
              <table className={s.table}>
                <thead>
                  <tr>
                    <th>岗位 / 来源</th>
                    <th>类别 / 城市</th>
                    <th>薪资原文</th>
                    <th>发布日期</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.job_ids.map((id) => {
                    const job = jobs.find((j) => j.job_id === id);
                    return job ? (
                      <tr key={id}>
                        <td>
                          <button
                            style={{
                              textAlign: 'left',
                              color: '#1d4ed8',
                              textDecoration: 'underline',
                              cursor: 'pointer',
                            }}
                            onClick={() => onJob(id)}
                          >
                            {job.title || '未命名岗位'}
                          </button>
                          <p className={s.muted}>
                            {job.company} ·{' '}
                            {job.source_type === 'synthetic'
                              ? '虚构示例'
                              : job.source_type === 'course'
                                ? '课程数据'
                                : '人工采集'}
                          </p>
                          {job.source_url && /^https?:\/\//i.test(job.source_url) && (
                            <a
                              href={job.source_url}
                              target="_blank"
                              rel="noreferrer"
                              className={s.muted}
                            >
                              打开原始来源 ↗
                            </a>
                          )}
                        </td>
                        <td>
                          {job.category}
                          <br />
                          {job.city || '未知'}
                        </td>
                        <td>{job.salary_text || '未披露'}</td>
                        <td>{job.published_at || '未知'}</td>
                      </tr>
                    ) : null;
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </>
  );
}

'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import { BarChart3, Search, Sparkles } from 'lucide-react';
import {
  careerApi,
  saveJson,
  type CareerJob,
  type MarketAnalysis,
  type MarketFilters,
  type MarketSummary,
} from '@/lib/api/career';
import { CareerLoading, useCareerText } from '@/lib/i18n/career';
import type { RunAction } from './workspace';
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

function recentDate(days: number) {
  const date = new Date();
  date.setDate(date.getDate() - days + 1);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

export function MarketScope({ summary }: { summary: MarketSummary }) {
  const tr = useCareerText();
  const coverage = summary.coverage;
  return (
    <div className={m.scope}>
      <p>
        {tr('统计范围：')}
        {summary.filters.category || tr('全部类别')} · {summary.filters.city || tr('全部城市')} ·{' '}
        {summary.filters.since ? tr('{0} 起发布', summary.filters.since) : tr('全部时间')}
      </p>
      {coverage && (
        <p className={s.muted}>
          {tr(
            '日期筛选前 {0} 份 · 日期未知 {1} 份 · 本次按日期排除 {2} 份',
            coverage.sample_count,
            coverage.published_missing,
            coverage.date_excluded_count
          )}
        </p>
      )}
      <p className={s.muted}>
        {tr('按岗位发布日期筛选；未注明发布日期的岗位仅在“全部时间”中纳入。')}
      </p>
    </div>
  );
}

interface Props {
  jobs: CareerJob[];
  busy: boolean;
  useAi: boolean;
  run: RunAction;
  onSearch: () => void;
  onSaved: () => Promise<void>;
}

export function SavedMarketPanel({ jobs, busy, useAi, run, onSearch, onSaved }: Props) {
  const tr = useCareerText();
  const [category, setCategory] = useState('');
  const [city, setCity] = useState('');
  const [period, setPeriod] = useState('all');
  const [customDate, setCustomDate] = useState(recentDate(30));
  const [summary, setSummary] = useState<MarketSummary | null>(null);
  const [analysis, setAnalysis] = useState<MarketAnalysis | null>(null);
  const [question, setQuestion] = useState(tr('这些岗位有哪些共同要求？我应该怎样准备项目经历？'));
  const [pending, setPending] = useState<'summary' | 'analysis' | null>(null);
  const [error, setError] = useState('');
  const savedJobs = jobs.filter((job) => job.source_type !== 'synthetic');
  const categories = [...new Set(savedJobs.map((job) => job.category).filter(Boolean))].sort();
  const cities = [...new Set(savedJobs.map((job) => job.city).filter(Boolean))].sort();
  const filters: MarketFilters = {
    category,
    city,
    since: period === 'all' ? null : period === 'custom' ? customDate : recentDate(Number(period)),
    include_demo: false,
  };
  const changed =
    summary !== null &&
    (summary.filters.category !== filters.category ||
      summary.filters.city !== filters.city ||
      summary.filters.since !== filters.since);
  const locked = busy || pending !== null;

  const calculate = async (selected = filters) => {
    if (locked) return;
    setPending('summary');
    setError('');
    try {
      await run(tr('统计已保存岗位'), async () => {
        try {
          setSummary(await careerApi.market(selected));
          setAnalysis(null);
          await onSaved();
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : tr('统计未完成，请重试。'));
          throw cause;
        }
      });
    } finally {
      setPending(null);
    }
  };

  const interpret = async () => {
    if (!summary || changed || locked || !question.trim()) return;
    setPending('analysis');
    setError('');
    try {
      await run(tr('解读已保存岗位'), async () => {
        try {
          const next = await careerApi.analyze(summary.filters, question.trim(), useAi);
          setSummary(next.summary);
          setAnalysis(next);
          await onSaved();
        } catch (cause) {
          setError(
            cause instanceof Error ? cause.message : tr('解读未完成，统计图表仍可查看，请重试。')
          );
          throw cause;
        }
      });
    } finally {
      setPending(null);
    }
  };

  return (
    <section className={m.saved} aria-label={tr('已保存岗位分析')}>
      <div className={s.panel}>
        <h2>{tr('从已保存的 JD，看清岗位要求')}</h2>
        <p className={s.muted}>
          {tr(
            '比较你已记住的岗位，查看技能、薪资与类别分布。统计会去重并排除演示数据，每次结果自动保存到下方历史。'
          )}
        </p>
        {!savedJobs.length ? (
          <div className={s.note}>
            <p>
              {tr(
                '还没有已保存的岗位。先在实时招聘中记住一份完整 JD，或到“目标岗位”粘贴并保存 JD。'
              )}
            </p>
            <button type="button" className={s.button} onClick={onSearch}>
              <Search size={18} aria-hidden="true" />
              {tr('前往实时招聘搜索')}
            </button>
          </div>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void calculate();
            }}
          >
            <fieldset className={m.filters} disabled={locked}>
              <legend className={s.srOnly}>{tr('已保存岗位筛选')}</legend>
              <label className={s.field}>
                <span>{tr('岗位类别')}</span>
                <select value={category} onChange={(event) => setCategory(event.target.value)}>
                  <option value="">{tr('全部类别')}</option>
                  {categories.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
              <label className={s.field}>
                <span>{tr('城市')}</span>
                <select value={city} onChange={(event) => setCity(event.target.value)}>
                  <option value="">{tr('全部城市')}</option>
                  {cities.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
              <label className={s.field}>
                <span>{tr('发布时间范围')}</span>
                <select value={period} onChange={(event) => setPeriod(event.target.value)}>
                  <option value="30">{tr('近 30 天')}</option>
                  <option value="90">{tr('近 90 天')}</option>
                  <option value="all">{tr('全部时间')}</option>
                  <option value="custom">{tr('自选起始日期')}</option>
                </select>
              </label>
              {period === 'custom' && (
                <label className={s.field}>
                  <span>{tr('起始发布日期')}</span>
                  <input
                    type="date"
                    required
                    max={recentDate(1)}
                    value={customDate}
                    onChange={(event) => setCustomDate(event.target.value)}
                  />
                </label>
              )}
            </fieldset>
            <div className={s.actions}>
              <button
                type="submit"
                className={`${s.button} ${s.primary}`}
                disabled={locked || (period === 'custom' && !customDate)}
              >
                <BarChart3 size={18} aria-hidden="true" />
                {pending === 'summary' ? tr('正在统计…') : tr('更新岗位统计')}
              </button>
              <span className={s.muted}>
                {tr('未提供类别的实时岗位按标题归类，可在“目标岗位”校对。')}
              </span>
            </div>
          </form>
        )}
      </div>
      {error && (
        <p className={s.note} role="alert">
          {error}
        </p>
      )}
      <div aria-busy={pending !== null}>
        {changed && (
          <p className={s.note} role="status">
            {tr('筛选条件已更改。下方保留上次统计，点击“更新岗位统计”后再解读新范围。')}
          </p>
        )}
        {!summary && savedJobs.length > 0 && (
          <p className={s.note}>
            {tr('选择范围后点击“更新岗位统计”，查看当前样本的三项图表与准备建议。')}
          </p>
        )}
        {summary && (
          <>
            <MarketScope summary={summary} />
            <div className={s.stats} aria-label={tr('已保存岗位统计概览')}>
              <p>
                <span className={s.number}>{summary.count}</span>
                {tr('当前范围 JD 样本')}
              </p>
              <p>
                <span className={s.number}>{summary.skills.length}</span>
                {tr('高频技能')}
              </p>
              <p>
                <span className={s.number}>{summary.salaries.length}</span>
                {tr('可比较薪资样本')}
              </p>
            </div>
            {!summary.count ? (
              <div className={s.note}>
                <p>{tr('当前范围没有岗位样本。可扩大时间范围，或先记住更多 JD。')}</p>
                <div className={s.actions}>
                  <button
                    type="button"
                    className={s.button}
                    disabled={locked}
                    onClick={() => {
                      setCategory('');
                      setCity('');
                      setPeriod('all');
                      void calculate({ category: '', city: '', since: null, include_demo: false });
                    }}
                  >
                    {tr('查看全部已保存岗位')}
                  </button>
                  <button type="button" className={s.button} onClick={onSearch}>
                    {tr('前往实时招聘搜索')}
                  </button>
                </div>
              </div>
            ) : (
              <>
                <Charts summary={summary} />
                <details className={s.section}>
                  <summary>{tr('查看统计明细')}</summary>
                  <div className={s.tableWrap}>
                    <table className={s.table}>
                      <caption>{tr('技能提及频次')}</caption>
                      <thead>
                        <tr>
                          <th>{tr('技能')}</th>
                          <th>{tr('提及岗位数 / 当前样本')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {summary.skills.map((skill) => (
                          <tr key={skill.name}>
                            <td>{skill.name}</td>
                            <td>
                              {skill.value} / {summary.count}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {summary.salaries.length > 0 && (
                      <table className={s.table}>
                        <caption>{tr('岗位披露薪资')}</caption>
                        <thead>
                          <tr>
                            <th>{tr('岗位')}</th>
                            <th>{tr('岗位类别')}</th>
                            <th>{tr('来源标注薪资：')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {summary.salaries.map((salary) => (
                            <tr key={salary.job_id}>
                              <td>{salary.title}</td>
                              <td>{salary.category}</td>
                              <td>{salary.raw}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                    <table className={s.table}>
                      <caption>{tr('类别技能明细')}</caption>
                      <thead>
                        <tr>
                          <th>{tr('岗位类别')}</th>
                          <th>{tr('岗位数')}</th>
                          <th>{tr('技能提及数与占比')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {summary.distribution.map((item) => (
                          <tr key={item.category}>
                            <td>{item.category}</td>
                            <td>{item.count}</td>
                            <td>
                              {item.skills
                                .map((skill) => `${skill.name} ${skill.count} (${skill.percent}%)`)
                                .join(' · ')}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
                <section className={s.section} aria-label={tr('已保存岗位解读')}>
                  <h3>{useAi ? tr('AI 解读当前样本') : tr('当前样本准备建议')}</h3>
                  <label className={s.field}>
                    <span>{tr('想了解什么')}</span>
                    <textarea
                      rows={3}
                      maxLength={1000}
                      value={question}
                      disabled={locked}
                      onChange={(event) => setQuestion(event.target.value)}
                    />
                  </label>
                  <button
                    type="button"
                    className={`${s.button} ${s.primary}`}
                    disabled={locked || changed || !question.trim()}
                    onClick={() => void interpret()}
                  >
                    <Sparkles size={18} aria-hidden="true" />
                    {pending === 'analysis'
                      ? tr('正在解读…')
                      : useAi
                        ? tr('AI 解读当前样本')
                        : tr('生成统计说明')}
                  </button>
                  {analysis && (
                    <div className={m.interpretation}>
                      <p className={s.muted}>
                        {analysis.mode === 'ai' ? tr('AI 辅助解读') : tr('规则统计说明')} ·{' '}
                        {tr('{0} 份已保存 JD', analysis.summary.count)}
                      </p>
                      {analysis.points.map((point) => (
                        <p key={point}>{point}</p>
                      ))}
                      <p className={s.note}>{analysis.advice}</p>
                    </div>
                  )}
                </section>
              </>
            )}
            <div className={m.export}>
              <button
                type="button"
                className={s.button}
                onClick={() => saveJson(analysis || summary, tr('CareerLens-已保存岗位统计.json'))}
              >
                {tr('导出当前统计')}
              </button>
              <span className={s.muted}>{tr('本次统计已保存，可在下方历史中查看原始样本。')}</span>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

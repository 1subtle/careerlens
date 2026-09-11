'use client';

import { useCareerText } from '@/lib/i18n/career';

import { useEffect, useState } from 'react';
import {
  careerApi,
  saveJson,
  type CareerState,
  type Comparison,
  type Match,
} from '@/lib/api/career';
import type { RunAction } from './workspace';
import s from './workspace.module.css';

export const conditionLabels: Record<string, string> = {
  met: '符合',
  unmet: '未满足',
  unknown: '需要确认',
  not_stated: 'JD 未明确',
};
export const scoreText = (score: number | null) => (score === null ? '—' : score.toFixed(1));

export function ComparePanel({
  state,
  resumeId,
  busy,
  useSemantic,
  useAi = false,
  run,
  refresh,
  onOpen,
  reviewedMatch,
}: {
  state: CareerState;
  resumeId: string;
  busy: boolean;
  useSemantic: boolean;
  useAi?: boolean;
  run: RunAction;
  refresh: () => Promise<void>;
  onOpen: (match: Match) => void;
  reviewedMatch: Match | null;
}) {
  const tr = useCareerText();
  const [selected, setSelected] = useState<string[]>([]);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  useEffect(() => {
    if (!reviewedMatch) return;
    setComparison((current) => {
      if (!current || reviewedMatch.snapshot_id !== current.snapshot_id) return current;
      const previous = current.matches.find((match) => match.job_id === reviewedMatch.job_id);
      if (
        !previous ||
        previous.id === reviewedMatch.id ||
        Date.parse(previous.created_at) > Date.parse(reviewedMatch.created_at)
      )
        return current;
      return {
        ...current,
        matches: current.matches.map((match) =>
          match.job_id === reviewedMatch.job_id ? reviewedMatch : match
        ),
      };
    });
  }, [reviewedMatch]);
  const ids = selected.filter((id) => state.jobs.some((j) => j.job_id === id));
  const matches = comparison?.matches ?? [];
  const changed =
    comparison &&
    (JSON.stringify(state.resumes.find((r) => r.id === resumeId)?.data) !==
      JSON.stringify(comparison.matches[0]?.resume_data) ||
      comparison.matches.some(
        (m) =>
          JSON.stringify(state.jobs.find((j) => j.job_id === m.job_id)) !== JSON.stringify(m.job)
      ));
  return (
    <section className={s.section}>
      <h2>{tr('多岗位横向比较')}</h2>
      <p className={s.muted}>
        {' '}
        {tr('选择 2—5 个已保存岗位，比较')}
        {useAi ? tr(' AI 岗位适合度与') : ''}
        {tr('经历匹配情况。')}{' '}
      </p>
      <fieldset disabled={busy}>
        <legend>{tr('选择比较岗位（已选 {0} / 5）', ids.length)}</legend>
        <div className={s.comparisonChoices}>
          {state.jobs.map((job) => (
            <label className={s.check} key={job.job_id}>
              <input
                type="checkbox"
                checked={ids.includes(job.job_id)}
                disabled={!ids.includes(job.job_id) && ids.length >= 5}
                onChange={(e) =>
                  setSelected(
                    e.target.checked ? [...ids, job.job_id] : ids.filter((id) => id !== job.job_id)
                  )
                }
              />
              <span>
                {job.title || tr('未命名岗位')} · {job.company || tr('公司未填写')}
                <small className={s.muted}> · {job.city || tr('城市未填写')}</small>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <button
        className={`${s.button} ${s.primary}`}
        disabled={busy || !state.resumes.some((resume) => resume.id === resumeId) || ids.length < 2}
        onClick={() =>
          void run(tr('比较所选岗位'), async () => {
            setComparison(await careerApi.compare(resumeId, ids, useSemantic, useAi));
            await refresh();
          })
        }
      >
        {' '}
        {tr('比较所选岗位')}{' '}
      </button>
      {comparison && (
        <div className={s.section}>
          <p className={s.muted}>
            {' '}
            {tr('本次结果 ·')} {comparison.rule_version}{' '}
            {tr('· 对照各岗位要求，查看可用经历与需要补充的信息。')}{' '}
          </p>
          {changed && (
            <p className={s.note}>
              {' '}
              {tr('简历或岗位已修改，下表保留比较当时的快照。请重新比较以更新结果。')}{' '}
            </p>
          )}
          <div className={s.tableWrap} role="region" aria-label={tr('多岗位比较结果')} tabIndex={0}>
            <table className={s.table}>
              <thead>
                <tr>
                  <th scope="col">{tr('岗位')}</th>
                  <th scope="col">{tr('AI 岗位适合度')}</th>
                  <th scope="col">{tr('经历匹配')}</th>
                  <th scope="col">{tr('要求核对')}</th>
                  <th scope="col">{tr('条件状态')}</th>
                  <th scope="col">{tr('操作')}</th>
                </tr>
              </thead>
              <tbody>
                {matches.map((m) => (
                  <tr key={m.job_id}>
                    <td>
                      <strong>{m.job.title}</strong>
                      <p className={s.muted}>
                        {m.job.company} · {m.job.city}
                      </p>
                    </td>
                    <td>
                      {m.ai_analysis ? (
                        <>
                          <strong>{scoreText(m.ai_analysis.fit_score)}</strong>
                          <p className={s.muted}>{m.ai_analysis.summary}</p>
                          <p className={s.muted}>
                            {m.ai_analysis.provider} / {m.ai_analysis.model}
                          </p>
                          <time className={s.muted} dateTime={m.ai_analysis.analyzed_at}>
                            {tr.date(m.ai_analysis.analyzed_at)}
                          </time>
                        </>
                      ) : (
                        <span className={s.muted}>{tr('本次为规则分析')}</span>
                      )}
                    </td>
                    <td>
                      {m.ai_analysis?.requirement_matches?.length ? (
                        <>
                          <p>
                            {tr('已匹配')}{' '}
                            {
                              m.ai_analysis.requirement_matches.filter(
                                (r) => r.status === 'matched'
                              ).length
                            }
                          </p>
                          <p>
                            {tr('可进一步完善')}{' '}
                            {
                              m.ai_analysis.requirement_matches.filter(
                                (r) => r.status === 'partial'
                              ).length
                            }
                          </p>
                          <p>
                            {tr('尚未体现')}{' '}
                            {
                              m.ai_analysis.requirement_matches.filter(
                                (r) => r.status === 'missing'
                              ).length
                            }
                          </p>
                        </>
                      ) : (
                        <span>{tr('查看关键词核对')}</span>
                      )}
                    </td>
                    <td>
                      <details>
                        <summary>{tr('关键词核对')}</summary>
                        <p>{scoreText(m.score)} / 100</p>
                        {tr('有证据')} {m.details.filter((d) => d.status === 'supported').length}
                        <br /> {tr('仅提及')}{' '}
                        {m.details.filter((d) => d.status === 'mentioned').length}
                        <br /> {tr('待确认')}{' '}
                        {m.details.filter((d) => d.status === 'pending').length}
                        <br /> {tr('已确认缺口')}{' '}
                        {m.details.filter((d) => d.status === 'gap').length}
                      </details>
                    </td>
                    <td>
                      {m.conditions.map((c) => (
                        <p key={c.name}>
                          {c.name}：{tr(conditionLabels[c.status])}
                          {c.confirmed_by === 'user' ? tr('（本人确认）') : ''}
                        </p>
                      ))}
                    </td>
                    <td>
                      <button
                        className={s.button}
                        disabled={busy}
                        onClick={() =>
                          void run(tr('打开岗位诊断'), async () =>
                            onOpen(await careerApi.getMatch(m.id))
                          )
                        }
                      >
                        {' '}
                        {tr('查看证据')}{' '}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {matches.some((m) => m.retrieval?.mode === 'unavailable') && (
            <p className={s.note}>{tr('部分语义检索未完成，关键词诊断已保留；可重新比较。')}</p>
          )}
          <button
            className={s.button}
            style={{ marginTop: 16 }}
            onClick={() => saveJson({ ...comparison, matches }, tr('CareerLens-多岗位比较.json'))}
          >
            {' '}
            {tr('导出比较结果')}{' '}
          </button>
        </div>
      )}
    </section>
  );
}

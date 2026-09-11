'use client';

import { useCareerText } from '@/lib/i18n/career';

import { useEffect, useImperativeHandle, useRef, useState } from 'react';
import Link from 'next/link';
import {
  careerApi,
  saveJson,
  type CareerState,
  type CareerDirections,
  type DirectionHistoryItem,
  type Condition,
  type Evidence,
  type EvidenceStatus,
  type Match,
  type MatchDetail,
  type Rewrite,
} from '@/lib/api/career';
import type { RunAction } from './workspace';
import { ComparePanel, conditionLabels, scoreText } from './compare-panel';
import { RewriteComparison } from './rewrite-comparison';
import { RewriteGuidance } from './rewrite-guidance';
import { AiMatchResults, AnalysisSource, DirectionResults } from './analysis-results';
import s from './workspace.module.css';
import { useAuth } from '@/components/auth/auth-provider';

const labels: Record<EvidenceStatus, string> = {
  supported: '有具体证据',
  mentioned: '仅有提及',
  pending: '待补充确认',
  gap: '本人确认缺口',
};

interface Props {
  state: CareerState;
  resumeId: string;
  jobId: string;
  setResumeId: (id: string) => void;
  setJobId: (id: string) => void;
  busy: boolean;
  useAi: boolean;
  run: RunAction;
  refresh: () => Promise<void>;
  onResume: (id: string) => void;
  onFindJobs?: (keyword: string) => void;
}
export function MatchPanel({
  state,
  resumeId,
  jobId,
  setResumeId,
  setJobId,
  busy,
  useAi,
  run,
  refresh,
  onResume,
  onFindJobs,
}: Props) {
  const tr = useCareerText();
  const hosted = useAuth()?.session?.mode === 'hosted';
  const rewriteRef = useRef<{ generate: (id: string) => void }>(null);
  const [match, setMatch] = useState<Match | null>(null);
  const [directions, setDirections] = useState<CareerDirections | null>(null);
  const [directionHistory, setDirectionHistory] = useState<DirectionHistoryItem[] | null>(null);
  const [useSemantic, setUseSemantic] = useState(state.semantic?.ready ?? false);
  const resume = state.resumes.find((item) => item.id === resumeId);
  const associationStatuses =
    match?.details.map((item) =>
      item.confirmed_by === 'user'
        ? { supported: 'matched', mentioned: 'partial', pending: 'missing', gap: 'missing' }[
            item.status
          ]
        : match.ai_analysis?.requirement_matches?.find((r) => r.requirement_id === item.id)?.status
    ) ?? [];
  const valid = !!resume && state.jobs.some((job) => job.job_id === jobId);
  const analyzeMatch = (targetId: string) =>
    void run(tr('分析目标岗位匹配度'), async () => {
      const result = await careerApi.match(resumeId, targetId, useSemantic, useAi);
      setMatch(result);
      setJobId(targetId);
      await refresh();
    });
  const analyzeDirections = () =>
    void run(tr('分析岗位方向与推荐'), async () => {
      setDirections(await careerApi.directions(resumeId, useAi));
      if (directionHistory !== null) setDirectionHistory(await careerApi.directionHistory());
    });
  return (
    <div className={s.diagnosisLayout}>
      {state.resumes.length === 0 ? (
        <section className={`${s.panel} ${s.diagnosisEmpty}`} aria-label={tr('诊断与优化')}>
          <p className={s.diagnosisEmptyMessage} role="status">
            {tr('请先保存一份简历，再进行诊断与优化。')}
          </p>
          <button
            className={`${s.button} ${s.primary}`}
            disabled={busy}
            onClick={() => onResume('new')}
          >
            {tr('创建第一份简历')}
          </button>
        </section>
      ) : (
        <section className={`${s.panel} ${s.diagnosisSetup}`}>
          <p id="diagnosis-resume-help" className={`${s.note} ${s.diagnosisContext}`} role="status">
            {resume
              ? tr('本次分析使用：{0}。可在下方切换简历版本。', resume.title)
              : tr('请先选择本次要分析的简历。')}
          </p>
          <div className={s.toolbar}>
            <label className={s.field}>
              <span>{tr('选择已保存的简历')}</span>
              <select
                value={resume?.id ?? ''}
                aria-describedby="diagnosis-resume-help"
                disabled={busy}
                onChange={(e) => {
                  setResumeId(e.target.value);
                  setMatch(null);
                  setDirections(null);
                }}
              >
                <option value="">{tr('请选择')}</option>
                {state.resumes.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.title}
                  </option>
                ))}
              </select>
            </label>
            <label className={s.field}>
              <span>{tr('目标 JD（岗位方向分析可不选）')}</span>
              <select
                value={jobId}
                disabled={busy}
                onChange={(e) => {
                  setJobId(e.target.value);
                  setMatch(null);
                }}
              >
                <option value="">{tr('请选择')}</option>
                {state.jobs.map((j) => (
                  <option key={j.job_id} value={j.job_id}>
                    {j.title || tr('未命名')} · {j.company}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className={s.diagnosticActions}>
            <button
              className={s.button}
              disabled={busy || !resume || !useAi}
              onClick={analyzeDirections}
            >
              {' '}
              {tr('分析适合的岗位方向')}{' '}
            </button>
            <button
              className={`${s.button} ${s.primary}`}
              disabled={busy || !valid}
              onClick={() => analyzeMatch(jobId)}
            >
              {' '}
              {tr('分析目标 JD 匹配度')}{' '}
            </button>
          </div>
          <section className={s.diagnosticSubsection}>
            <h2>{tr('诊断选项')}</h2>
            <p className={s.muted}>
              {useAi
                ? tr('AI 辅助已开启：分析岗位适合度、匹配理由和改进方向。')
                : tr('AI 辅助已关闭：当前分析材料覆盖度；开启后可分析岗位方向和推荐岗位。')}
              {useAi && !state.model.configured && (
                <>
                  {' '}
                  <Link href="/settings">{hosted ? tr('查看服务信息') : tr('配置分析模型')}</Link>
                </>
              )}
            </p>
            <label className={s.check}>
              <input
                type="checkbox"
                checked={useSemantic}
                disabled={busy}
                onChange={(e) => setUseSemantic(e.target.checked)}
              />{' '}
              {tr('查找语义相关的经历（辅助 JD 匹配与比较）')}{' '}
            </label>
            {!state.semantic?.ready && (
              <p className={s.muted}>{tr('语义模型未就绪，仍可进行 AI 分析与关键词证据核对。')}</p>
            )}
          </section>
        </section>
      )}
      <details
        className={s.section}
        onToggle={(event) => {
          if (event.currentTarget.open)
            void run(tr('读取方向分析历史'), async () =>
              setDirectionHistory(await careerApi.directionHistory())
            );
        }}
      >
        <summary>{tr('岗位方向分析历史')}</summary>
        <p className={s.muted}>
          {tr('保存每次分析的参考简历、岗位样本和结果，删除原材料后仍可查看。')}
        </p>
        {directionHistory?.length === 0 && <p>{tr('还没有方向分析记录。')}</p>}
        {directionHistory?.map((item) => (
          <article className={s.analysisFinding} key={item.id}>
            <h3>{item.resume_title}</h3>
            <p className={s.muted}>{tr.date(item.created_at)}</p>
            <p>{item.summary}</p>
            <div className={s.actions}>
              <button
                className={s.button}
                disabled={busy}
                onClick={() =>
                  void run(tr('查看方向分析历史'), async () => {
                    const saved = await careerApi.getDirectionHistory(item.id);
                    setDirections(saved);
                    setMatch(null);
                    setResumeId(
                      state.resumes.some((resume) => resume.id === saved.resume_id)
                        ? saved.resume_id
                        : ''
                    );
                  })
                }
              >
                {' '}
                {tr('查看这次方向分析')}{' '}
              </button>
              <button
                className={s.button}
                disabled={busy}
                onClick={() => {
                  if (window.confirm(tr('删除这次方向分析记录？原简历和 JD 会保留。')))
                    void run(tr('删除方向分析历史'), async () => {
                      await careerApi.deleteDirectionHistory(item.id);
                      setDirectionHistory(
                        (items) => items?.filter((entry) => entry.id !== item.id) ?? null
                      );
                      if (directions?.history_id === item.id) setDirections(null);
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
      {directions && (
        <>
          <DirectionResults
            analysis={directions}
            stale={resume?.hash !== directions.resume_hash}
            busy={busy}
            onMatch={analyzeMatch}
            onFindJobs={onFindJobs}
            availableJobIds={state.jobs.map((job) => job.job_id)}
          />
          {directions.input_snapshot && (
            <details className={s.section}>
              <summary>{tr('查看本次方向分析使用的材料')}</summary>
              <h3>{directions.input_snapshot.resume.title}</h3>
              <p className={s.jdText}>
                {directions.input_snapshot.resume.source_text ||
                  directions.evidence.map((item) => item.text).join('\n\n')}
              </p>
              {directions.input_snapshot.jobs.map((job) => (
                <details key={job.job_id}>
                  <summary>
                    {job.title} · {job.company}
                  </summary>
                  <p className={s.jdText}>{job.content}</p>
                </details>
              ))}
              <button
                className={s.button}
                onClick={() => saveJson(directions, tr('CareerLens-岗位方向分析历史.json'))}
              >
                {' '}
                {tr('导出结果与参考材料')}{' '}
              </button>
            </details>
          )}
        </>
      )}
      {(state.resumes.length > 0 || match) &&
        (!match ? (
          !directions && (
            <p className={s.muted}>
              {tr('选择简历后可以先分析岗位方向，或选择目标 JD 查看匹配证据。')}
            </p>
          )
        ) : (
          <>
            {match.stale && (
              <p className={s.note}>
                {' '}
                {tr(
                  '这是一份历史快照，原简历或岗位已修改。可以回看原记录；采纳新建议前请重新诊断。'
                )}{' '}
              </p>
            )}
            {match.retrieval?.mode === 'unavailable' && (
              <p className={s.note}>{match.retrieval.message}</p>
            )}
            {match.retrieval?.mode === 'vector' && (
              <p className={s.muted}>
                {tr('语义检索已完成。候选经历列在对应要求下，核对后可保存结果。')}
              </p>
            )}
            {match.ai_analysis ? (
              <AiMatchResults
                analysis={match.ai_analysis}
                evidence={match.evidence}
                busy={busy || !!match.stale}
                onRewrite={(id) => rewriteRef.current?.generate(id)}
              />
            ) : (
              <AnalysisSource mode="rules" analyzed_at={match.created_at} />
            )}
            <div className={s.matchIntro}>
              <p className={s.eyebrow}>{tr('经历与岗位要求')}</p>
              <h2>{tr('已有经历如何匹配，还需要补充什么')}</h2>
              <p className={s.muted}>
                {tr('逐项查看已关联的经历，直接改写相关段落，或按提示补充具体信息。')}
              </p>
              <div className={s.actions}>
                {match.ai_analysis?.requirement_matches?.length ? (
                  <>
                    <span className={s.stateTag} data-state="supported">
                      {tr('已匹配')}{' '}
                      {associationStatuses.filter((status) => status === 'matched').length}
                    </span>
                    <span className={s.stateTag} data-state="mentioned">
                      {tr('可进一步完善')}{' '}
                      {associationStatuses.filter((status) => status === 'partial').length}
                    </span>
                    <span className={s.stateTag} data-state="pending">
                      {tr('尚未体现')}{' '}
                      {associationStatuses.filter((status) => status === 'missing').length}
                    </span>
                  </>
                ) : (
                  <p>
                    {tr('当前为关键词关联结果。重新运行 AI 匹配，可逐项分析同义表达与可迁移经历。')}
                  </p>
                )}
              </div>
            </div>
            <RewritePanel
              key={match.id}
              rewriteRef={rewriteRef}
              match={match}
              busy={busy}
              useAi={useAi}
              run={run}
              refresh={refresh}
              onResume={onResume}
            />
            <section className={s.diagnosticEvidenceList} aria-label={tr('岗位要求与简历证据')}>
              <h2>{tr('岗位要求与简历证据')}</h2>
              {match.details.map((item) => {
                const ai =
                  item.confirmed_by === 'user'
                    ? undefined
                    : match.ai_analysis?.requirement_matches?.find(
                        (r) => r.requirement_id === item.id
                      );
                const ids = ai ? ai.resume_refs.map((r) => r.evidence_id) : item.evidence_ids;
                const editable = ids.find((id) =>
                  match.evidence.some(
                    (e) => e.id === id && ['experience', 'summary'].includes(e.kind)
                  )
                );
                return (
                  <article className={s.diagnosticRequirement} key={item.id}>
                    <header className={s.diagnosticHeading}>
                      <h3>{item.name}</h3>
                      <span
                        className={s.stateTag}
                        data-state={
                          ai
                            ? { matched: 'supported', partial: 'mentioned', missing: 'pending' }[
                                ai.status
                              ]
                            : item.status
                        }
                      >
                        {ai
                          ? tr(
                              { matched: '已匹配', partial: '可进一步完善', missing: '尚未体现' }[
                                ai.status
                              ]
                            )
                          : tr(labels[item.status])}
                      </span>
                      <span className={s.muted}>
                        {item.priority === 'preferred' ? tr('优先 / 加分') : tr('普通要求')}{' '}
                      </span>
                    </header>
                    <p className={s.muted}>{tr('JD 原文')}</p>
                    <blockquote className={s.evidence}>{item.source_text}</blockquote>
                    <p>{ai?.reason ?? item.reason}</p>
                    {ids.map((id) => {
                      const evidence = match.evidence.find((e) => e.id === id);
                      return evidence ? (
                        <blockquote key={id} className={s.evidence}>
                          <strong>
                            {tr('简历原文 ·')} {evidence.title}
                          </strong>
                          <br />
                          {evidence.text}
                        </blockquote>
                      ) : null;
                    })}
                    {ai?.suggestion && (
                      <p className={s.supplementNote}>
                        <strong>{tr('建议补充')} · </strong>
                        {ai.suggestion}
                      </p>
                    )}
                    <div className={s.actions}>
                      {editable && (
                        <button
                          className={`${s.button} ${s.primary}`}
                          disabled={busy || !!match.stale}
                          onClick={() => rewriteRef.current?.generate(editable)}
                        >
                          {tr('直接改写这段经历')}
                        </button>
                      )}
                      <button
                        className={s.button}
                        disabled={busy}
                        onClick={() => onResume(match.resume_id)}
                      >
                        {tr('到简历中补充')}
                      </button>
                    </div>
                    {!ai && !!item.candidates?.length && (
                      <section className={s.diagnosticSubsection}>
                        <h3>
                          {tr('语义检索找到')} {item.candidates.length} {tr('段待核对经历')}
                        </h3>
                        <p className={s.muted}>{tr('候选尚未计入覆盖度，可在下方确认关联。')}</p>
                        {item.candidates.map((candidate) => {
                          const evidence = match.evidence.find(
                            (e) => e.id === candidate.evidence_id
                          );
                          return evidence ? (
                            <blockquote className={s.evidence} key={evidence.id}>
                              <strong>{evidence.title}</strong>
                              <br />
                              {evidence.text}
                            </blockquote>
                          ) : null;
                        })}
                      </section>
                    )}
                    <details className={s.diagnosticSubsection}>
                      <summary>{tr('核对 / 修正此项')}</summary>
                      <ReviewControl
                        key={`${match.id}:${item.id}`}
                        item={
                          ai
                            ? {
                                ...item,
                                evidence_ids: ai.status === 'missing' ? [] : ids,
                                status:
                                  ai.status === 'missing'
                                    ? 'pending'
                                    : ai.status === 'matched' &&
                                        ids.some((id) =>
                                          match.evidence.some(
                                            (e) => e.id === id && e.kind === 'experience'
                                          )
                                        )
                                      ? 'supported'
                                      : 'mentioned',
                              }
                            : item
                        }
                        evidence={match.evidence}
                        busy={busy || !!match.stale}
                        onSave={(status, ids) =>
                          void run(tr('保存核对结果'), async () => {
                            setMatch(await careerApi.review(match.id, item.id, status, ids));
                            await refresh();
                          })
                        }
                      />
                    </details>
                  </article>
                );
              })}
            </section>
            <details className={s.diagnosticSubsection}>
              <summary>{tr('关键词核对详情与导出')}</summary>
              <p>
                {tr('关键词材料覆盖度')}：{scoreText(match.score)} / 100
              </p>
              <p className={s.muted}>
                {' '}
                {tr(
                  '覆盖度 = 100 × Σ（权重 × 支持系数）/ Σ 权重。具体应用记 1，仅提及记 0.5，待确认或本人确认缺口记 0；总分保留一位小数。此分数衡量材料支持程度，AI 岗位适合度另列。'
                )}{' '}
              </p>
              <button
                className={s.button}
                style={{ marginTop: 16 }}
                onClick={() =>
                  saveJson(match, tr('CareerLens-诊断-{0}.json', match.id.slice(0, 8)))
                }
              >
                {' '}
                {tr('导出含证据的诊断 JSON')}{' '}
              </button>
            </details>
            <section className={s.section}>
              <h2>{tr('单独核对的条件')}</h2>
              <div className={s.conditions}>
                {match.conditions.map((item) => (
                  <div className={s.condition} key={item.name}>
                    <h3>{item.name}</h3>
                    <span className={s.tag}>{tr(conditionLabels[item.status] || item.status)}</span>
                    <p>{item.requirement}</p>
                    <p className={s.muted}>{item.observed}</p>
                    {item.confirmed_by === 'user' && (
                      <p className={s.muted}>{tr('已由本人确认并保存')}</p>
                    )}
                    {item.status !== 'not_stated' && (
                      <ConditionControl
                        key={`${match.id}:${item.name}`}
                        item={item}
                        busy={busy || !!match.stale}
                        onSave={(status, observed) =>
                          void run(tr('保存条件确认'), async () => {
                            setMatch(
                              await careerApi.confirmCondition(
                                match.id,
                                item.name,
                                status,
                                observed
                              )
                            );
                            await refresh();
                          })
                        }
                      />
                    )}
                  </div>
                ))}
              </div>
            </section>
          </>
        ))}
      {state.resumes.length > 0 && (
        <ComparePanel
          key={resumeId}
          state={state}
          resumeId={resumeId}
          busy={busy}
          useSemantic={useSemantic}
          useAi={useAi}
          run={run}
          refresh={refresh}
          reviewedMatch={match}
          onOpen={(value) => {
            setMatch(value);
            setJobId(value.job_id);
          }}
        />
      )}
      {(state.resumes.length > 0 || state.matches.length > 0) && (
        <section className={s.section}>
          <h2>{tr('历史诊断')}</h2>
          <div className={s.actions}>
            <label className={`${s.field} ${s.history}`} style={{ marginBottom: 0 }}>
              <span>{tr('选择一次诊断')}</span>
              <select
                aria-label={tr('历史诊断')}
                value={match?.id ?? ''}
                disabled={busy}
                onChange={(e) => {
                  const id = e.target.value;
                  if (id)
                    void run(tr('读取历史诊断'), async () => {
                      const value = await careerApi.getMatch(id);
                      setMatch(value);
                      setDirections(null);
                      setResumeId(value.resume_id);
                      setJobId(value.job_id);
                    });
                }}
              >
                <option value="">{tr('选择历史记录')}</option>
                {state.matches.map((m) => (
                  <option key={m.id} value={m.id}>
                    {tr.date(m.created_at)} ·{' '}
                    {state.jobs.find((j) => j.job_id === m.job_id)?.title}{' '}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </section>
      )}
    </div>
  );
}

function ConditionControl({
  item,
  busy,
  onSave,
}: {
  item: Condition;
  busy: boolean;
  onSave: (status: string, observed: string) => void;
}) {
  const tr = useCareerText();
  const [status, setStatus] = useState(item.status);
  const [observed, setObserved] = useState(item.confirmed_by === 'user' ? item.observed : '');
  return (
    <section className={s.diagnosticSubsection}>
      <h3>{tr('填写 / 更新实际情况')}</h3>
      <label className={s.field}>
        <span>
          {item.name}
          {tr('：确认状态')}
        </span>
        <select value={status} disabled={busy} onChange={(e) => setStatus(e.target.value)}>
          <option value="unknown">{tr('尚不能确认')}</option>
          <option value="met">{tr('确认符合')}</option>
          <option value="unmet">{tr('确认未满足')}</option>
        </select>
      </label>
      <label className={s.field}>
        <span>
          {item.name}
          {tr('：实际情况与依据')}
        </span>
        <textarea
          value={observed}
          maxLength={1000}
          rows={3}
          disabled={busy}
          onChange={(e) => setObserved(e.target.value)}
          placeholder={tr('例如：每周可到岗 4 天，可以连续实习 6 个月。')}
        />
      </label>
      <button
        className={s.button}
        disabled={busy || !observed.trim()}
        onClick={() => onSave(status, observed)}
      >
        {' '}
        {tr('确认并保存条件')}{' '}
      </button>
    </section>
  );
}

function ReviewControl({
  item,
  evidence,
  busy,
  onSave,
}: {
  item: MatchDetail;
  evidence: Evidence[];
  busy: boolean;
  onSave: (status: EvidenceStatus, ids: string[]) => void;
}) {
  const tr = useCareerText();
  const [status, setStatus] = useState(item.status);
  const [ids, setIds] = useState(item.evidence_ids);
  const needsEvidence = status === 'supported' || status === 'mentioned';
  return (
    <div className={s.review}>
      <label className={s.field}>
        <span>{tr('核对后的状态')}</span>
        <select
          value={status}
          disabled={busy}
          onChange={(e) => setStatus(e.target.value as EvidenceStatus)}
        >
          {Object.entries(labels).map(([key, label]) => (
            <option key={key} value={key}>
              {tr(label)}
            </option>
          ))}
        </select>
      </label>
      {needsEvidence &&
        [...evidence]
          .sort(
            (a, b) =>
              Number(!!item.candidates?.some((c) => c.evidence_id === b.id)) -
              Number(!!item.candidates?.some((c) => c.evidence_id === a.id))
          )
          .map((e) => (
            <label className={s.check} key={e.id}>
              <input
                type="checkbox"
                checked={ids.includes(e.id)}
                disabled={busy || (!ids.includes(e.id) && ids.length >= 20)}
                onChange={(event) =>
                  setIds((previous) =>
                    event.target.checked
                      ? [...previous, e.id]
                      : previous.filter((id) => id !== e.id)
                  )
                }
              />
              <span>
                {item.candidates?.some((c) => c.evidence_id === e.id) && (
                  <span className={s.tag}>{tr('语义候选')}</span>
                )}{' '}
                {e.title}：{e.text}
              </span>
            </label>
          ))}
      <button
        className={s.button}
        disabled={busy || (needsEvidence && ids.length === 0)}
        onClick={() => onSave(status, ids)}
      >
        {' '}
        {tr('保存为新的诊断记录')}{' '}
      </button>
    </div>
  );
}

function RewritePanel({
  rewriteRef,
  match,
  busy,
  useAi,
  run,
  refresh,
  onResume,
}: {
  rewriteRef: React.Ref<{ generate: (id: string) => void }>;
  match: Match;
  busy: boolean;
  useAi: boolean;
  run: RunAction;
  refresh: () => Promise<void>;
  onResume: (id: string) => void;
}) {
  const tr = useCareerText();
  const eligible = match.evidence.filter((e) => e.kind === 'experience' || e.kind === 'summary');
  const [sectionId, setSectionId] = useState(eligible[0]?.id ?? '');
  const [facts, setFacts] = useState('');
  const factsInput = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState<Rewrite | null>(match.rewrites?.[0] ?? null);
  const [after, setAfter] = useState<Match | null>(null);
  const beforeText = match.evidence.find((e) => e.id === (draft?.section_id ?? sectionId))?.text;
  const draftModel =
    typeof draft?.model === 'object' && draft.model
      ? draft.model
      : { provider: draft?.provider, model: draft?.model ?? undefined };
  const panel = useRef<HTMLElement>(null);
  const output = useRef<HTMLDivElement>(null);
  const revealDraft = useRef(false);
  useEffect(() => {
    if (revealDraft.current) {
      output.current?.scrollIntoView({ behavior: 'instant', block: 'start' });
      revealDraft.current = false;
    }
  }, [draft?.id]);
  const generate = (id: string, supplements = facts) => {
    setSectionId(id);
    setFacts(supplements);
    panel.current?.scrollIntoView({ behavior: 'instant', block: 'start' });
    void run(useAi ? tr('直接改写经历') : tr('整理内容草稿'), async () => {
      const next = await careerApi.rewrite(
        match.id,
        id,
        supplements
          .split('\n')
          .map((x) => x.trim())
          .filter(Boolean),
        useAi
      );
      revealDraft.current = true;
      setDraft(next);
      setAfter(null);
    });
  };
  useImperativeHandle(rewriteRef, () => ({
    generate: (id) => generate(id, id === sectionId ? facts : ''),
  }));
  return (
    <section ref={panel} className={`${s.section} ${s.rewriteWorkbench}`}>
      <h2>{tr('AI 直接改写')}</h2>
      <p className={s.muted}>
        {' '}
        {tr(
          '选择一段经历，AI 会结合岗位要求直接生成可用正文。补充信息可留空，生成后可采纳为定向版简历。'
        )}{' '}
      </p>
      <div className={s.split} style={{ marginTop: 24 }}>
        <div>
          <label className={s.field}>
            <span>{tr('选择需要优化的段落')}</span>
            <select value={sectionId} onChange={(e) => setSectionId(e.target.value)}>
              <option value="">{tr('请选择一段经历')}</option>
              {eligible.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.title} · {e.text.slice(0, 50)}
                </option>
              ))}
            </select>
          </label>
          <label className={s.field}>
            <span>{tr('补充信息（每行一项，可留空）')}</span>
            <textarea
              ref={factsInput}
              rows={4}
              value={facts}
              maxLength={8000}
              onChange={(e) => {
                setFacts(e.target.value);
              }}
              placeholder={tr('例如：我负责清洗流程中的重复记录检查，希望突出数据处理方法。')}
            />
          </label>
          <button
            className={`${s.button} ${s.primary}`}
            disabled={busy || !sectionId || match.stale}
            onClick={() => generate(sectionId)}
          >
            {useAi ? tr('直接生成改写正文') : tr('生成整理草稿')}
          </button>
        </div>
        <aside className={s.note}>
          <strong>{useAi ? tr('AI 辅助改写') : tr('当前使用内容整理模式')}</strong>
          <p>
            {useAi
              ? tr('查看修改前后的文字和参考材料，按需要采纳或继续调整。')
              : tr(
                  '把原文与补充内容整理在一起，方便验证版本流程。开启顶部 AI 辅助后可生成 STAR 改写。'
                )}
          </p>
        </aside>
      </div>
      {!!match.rewrites?.length && (
        <label className={s.field} style={{ marginTop: 24 }}>
          <span>{tr('此诊断的历史建议')}</span>
          <select
            value={draft?.id ?? ''}
            onChange={(e) => {
              setDraft(match.rewrites?.find((r) => r.id === e.target.value) ?? null);
              setAfter(null);
            }}
          >
            {draft && !match.rewrites.some((r) => r.id === draft.id) && (
              <option value={draft.id}>{tr('刚生成的建议')}</option>
            )}
            {match.rewrites.map((r) => (
              <option key={r.id} value={r.id}>
                {r.status === 'accepted'
                  ? tr('已采纳')
                  : r.status === 'rejected'
                    ? tr('已拒绝')
                    : tr('待审阅')}{' '}
                · {r.draft.slice(0, 55)}
              </option>
            ))}
          </select>
        </label>
      )}
      {draft && (
        <div ref={output} className={s.section} style={{ scrollMarginTop: 24 }}>
          <div className={s.actions} style={{ marginBottom: 24 }}>
            <span className={s.tag}>{draft.mode === 'ai' ? tr('AI 改写') : tr('内容整理')}</span>
            <span className={s.tag}>
              {draft.status === 'accepted'
                ? tr('已采纳')
                : draft.status === 'rejected'
                  ? tr('已拒绝')
                  : tr('待你审阅')}
            </span>
          </div>
          <AnalysisSource
            mode={draft.mode}
            provider={draftModel.provider}
            model={draftModel.model}
            analyzed_at={draft.analyzed_at}
          />
          <RewriteComparison before={beforeText ?? ''} after={draft.draft} />
          {draft.status === 'draft' && (
            <>
              <div className={s.actions}>
                <button
                  className={`${s.button} ${s.primary}`}
                  disabled={busy || match.stale}
                  onClick={() =>
                    void run(tr('采纳并创建定向版'), async () => {
                      const result = await careerApi.apply(draft.id);
                      setDraft(result.rewrite);
                      await refresh();
                    })
                  }
                >
                  {' '}
                  {tr('采纳并生成独立版本')}{' '}
                </button>
                <button
                  className={s.button}
                  disabled={busy}
                  onClick={() =>
                    void run(tr('拒绝建议'), async () => setDraft(await careerApi.reject(draft.id)))
                  }
                >
                  {' '}
                  {tr('拒绝建议')}{' '}
                </button>
              </div>
            </>
          )}
          {draft.improvement && draft.improvement.summary !== draft.reason && (
            <p className={s.muted}>{draft.improvement.summary}</p>
          )}
          <h3 className={s.diagnosticSubsection}>{tr('改进理由')}</h3>
          <p>{draft.reason}</p>
          <details className={s.diagnosticSubsection}>
            <summary>{tr('查看 STAR 分析与补充建议')}</summary>
            <RewriteGuidance
              draft={draft}
              onSupplement={() => {
                setSectionId(draft.section_id);
                factsInput.current?.focus();
              }}
            />
          </details>
          {!!draft.changes?.length && (
            <div className={s.section}>
              <h3>{tr('本次修改类型')}</h3>
              {draft.changes.map((change, i) => (
                <p key={i}>
                  <span className={s.tag}>
                    {change.type === 'user_fact' ? tr('纳入补充信息') : tr('基于原文调整表达')}
                  </span>{' '}
                  {change.text}
                </p>
              ))}
            </div>
          )}
          {!draft.star?.length && !!draft.missing_facts.length && (
            <div style={{ marginTop: 24 }}>
              <h3>{tr('可继续补充的信息')}</h3>
              {draft.missing_facts.map((question) => (
                <p key={question} className={s.muted}>
                  — {question}
                </p>
              ))}
            </div>
          )}
          <section className={s.diagnosticSubsection}>
            <h3>{tr('修改建议的参考材料')}</h3>
            <ul className={s.sourceList}>
              {draft.claims.map((claim, i) => (
                <li key={i}>
                  <p>
                    <strong>{claim.text}</strong>
                  </p>
                  {claim.source_ids.map((id) => {
                    const source = draft.sources.find((item) => item.id === id);
                    return (
                      <p className={s.muted} key={id}>
                        {source?.type === 'user' ? tr('本人补充') : tr('简历原文')}：{source?.text}
                      </p>
                    );
                  })}
                </li>
              ))}
            </ul>
          </section>
          {draft.status === 'accepted' && draft.result_resume_id && (
            <>
              <div className={s.actions} style={{ marginTop: 24 }}>
                <button className={s.button} onClick={() => onResume(draft.result_resume_id!)}>
                  {' '}
                  {tr('查看定向版简历 →')}{' '}
                </button>
                <button
                  className={s.button}
                  disabled={busy}
                  onClick={() =>
                    void run(tr('同一岗位复评'), async () => {
                      const original = await careerApi.getMatch(match.id);
                      if (original.stale)
                        throw new Error(
                          tr('原始材料或 JD 已改变，无法直接对比本次覆盖度。请重新诊断。')
                        );
                      setAfter(
                        await careerApi.match(
                          draft.result_resume_id!,
                          match.job_id,
                          match.retrieval?.mode === 'vector',
                          useAi
                        )
                      );
                      await refresh();
                    })
                  }
                >
                  {' '}
                  {tr('复评定向版')}{' '}
                </button>
                <button
                  className={s.button}
                  disabled={busy}
                  onClick={() =>
                    void run(tr('导出定向版 PDF'), () =>
                      careerApi.downloadPdf(draft.result_resume_id!)
                    )
                  }
                >
                  {' '}
                  {tr('导出定向版 PDF')}{' '}
                </button>
              </div>
              {after && (
                <p className={s.note} style={{ marginTop: 20 }}>
                  {after.ai_analysis ? (
                    <>
                      {tr('定向版 AI 岗位适合度')}：{scoreText(after.ai_analysis.fit_score)} / 100。
                      {after.ai_analysis.summary}
                    </>
                  ) : (
                    <>
                      {tr('定向版关键词材料覆盖度')}：{scoreText(after.score)} / 100。
                    </>
                  )}
                </p>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}

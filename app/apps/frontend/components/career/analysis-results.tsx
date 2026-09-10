'use client';

import { useCareerText } from '@/lib/i18n/career';

import type {
  AiMatchAnalysis,
  CareerDirections,
  Evidence,
  ResumeReference,
} from '@/lib/api/career';
import s from './workspace.module.css';

export function AnalysisSource({
  mode,
  provider,
  model,
  analyzed_at,
}: {
  mode: string;
  provider?: string;
  model?: string;
  analyzed_at?: string;
}) {
  const tr = useCareerText();
  return (
    <p className={s.analysisSource}>
      <span>{mode === 'ai' ? tr('AI 分析') : tr('规则分析')}</span>
      {mode === 'ai' && (
        <span>{[provider, model].filter(Boolean).join(' / ') || tr('模型未记录')}</span>
      )}
      {analyzed_at && <time dateTime={analyzed_at}>{tr.date(analyzed_at)}</time>}
    </p>
  );
}

function EvidenceReferences({
  resumeRefs,
  jdRefs = [],
  evidence,
}: {
  resumeRefs: ResumeReference[];
  jdRefs?: { quote: string }[];
  evidence: Evidence[];
}) {
  const tr = useCareerText();
  return (
    <div className={s.analysisReferences}>
      {resumeRefs.map((reference, i) => (
        <blockquote key={`${reference.evidence_id}:${i}`} className={s.evidence}>
          <strong>
            {' '}
            {tr('简历原文')}{' '}
            {evidence.find((item) => item.id === reference.evidence_id)?.title
              ? ` · ${evidence.find((item) => item.id === reference.evidence_id)!.title}`
              : ''}
          </strong>
          <br />
          {reference.quote}
        </blockquote>
      ))}
      {jdRefs.map((reference, i) => (
        <blockquote key={i} className={s.evidence}>
          <strong>{tr('JD 原文')}</strong>
          <br />
          {reference.quote}
        </blockquote>
      ))}
    </div>
  );
}

export function AiMatchResults({
  analysis,
  evidence,
}: {
  analysis: AiMatchAnalysis;
  evidence: Evidence[];
}) {
  const tr = useCareerText();
  return (
    <section className={s.section} aria-label={tr('AI 岗位匹配分析')}>
      <div className={s.diagnosticHeading}>
        <h2>{tr('AI 岗位匹配分析')}</h2>
        <strong className={s.fitScore}>
          {analysis.fit_score.toFixed(1)}
          <small> {tr('/ 100 · AI 岗位适合度')}</small>
        </strong>
      </div>
      <AnalysisSource {...analysis} />
      <p>{analysis.summary}</p>
      <p className={s.muted}>{analysis.score_note}</p>
      {(
        [
          [tr('适合的理由'), analysis.strengths],
          [tr('差距与待补充信息'), analysis.gaps],
          [tr('下一步改进'), analysis.actions],
        ] as const
      ).map(([title, findings]) => (
        <section className={s.diagnosticSubsection} key={title}>
          <h3>{title}</h3>
          {findings.length === 0 ? (
            <p className={s.muted}>{tr('本次未列出此类建议。')}</p>
          ) : (
            findings.map((finding, index) => (
              <article className={s.analysisFinding} key={index}>
                <h4>{finding.title}</h4>
                <p>{finding.detail}</p>
                <EvidenceReferences
                  resumeRefs={finding.resume_refs}
                  jdRefs={finding.jd_refs}
                  evidence={evidence}
                />
              </article>
            ))
          )}
        </section>
      ))}
    </section>
  );
}

export function DirectionResults({
  analysis,
  stale,
  busy,
  onMatch,
  onFindJobs,
  availableJobIds,
}: {
  analysis: CareerDirections;
  stale: boolean;
  busy: boolean;
  onMatch: (jobId: string) => void;
  onFindJobs?: (keyword: string) => void;
  availableJobIds?: string[];
}) {
  const tr = useCareerText();
  return (
    <section className={s.section} aria-label={tr('岗位方向与推荐结果')}>
      <AnalysisSource {...analysis} />
      {stale && (
        <p className={s.note}>
          {' '}
          {tr('这是一份历史记录。原简历已修改或删除，仍可查看当时的分析和参考材料。')}{' '}
        </p>
      )}
      <p>{analysis.summary}</p>
      <h2>{tr('适合的岗位方向')}</h2>
      {analysis.directions.map((direction, index) => (
        <article className={s.analysisFinding} key={index}>
          <h3>{direction.title}</h3>
          <p>{direction.reason}</p>
          <EvidenceReferences resumeRefs={direction.resume_refs} evidence={analysis.evidence} />
          {direction.next_steps.length > 0 && (
            <ul>
              {direction.next_steps.map((step, i) => (
                <li key={i}>{step}</li>
              ))}
            </ul>
          )}
          {onFindJobs && (
            <button
              type="button"
              className={s.button}
              disabled={busy}
              onClick={() => onFindJobs(direction.title)}
            >
              {' '}
              {tr('查找相关实时岗位')}{' '}
            </button>
          )}
        </article>
      ))}
      <h2 className={s.diagnosticSubsection}>{tr('已保存岗位推荐')}</h2>
      <p className={s.muted}>{tr('以下岗位来自已保存的 JD，招聘状态以原岗位页面为准。')}</p>
      {analysis.saved_jobs.length === 0 && (
        <p>{tr('当前没有可推荐的已保存岗位。保存感兴趣的 JD 后可以重新推荐。')}</p>
      )}
      {analysis.saved_jobs.map((job) => (
        <article className={s.analysisFinding} key={job.job_id}>
          <h3>
            {job.title}
            {job.company && ` · ${job.company}`}
          </h3>
          <p>{job.reason}</p>
          <EvidenceReferences
            resumeRefs={job.resume_refs}
            jdRefs={job.jd_refs}
            evidence={analysis.evidence}
          />
          <div className={s.actions}>
            <button
              type="button"
              className={s.button}
              disabled={
                busy ||
                stale ||
                (availableJobIds !== undefined && !availableJobIds.includes(job.job_id))
              }
              onClick={() => onMatch(job.job_id)}
            >
              {' '}
              {tr('分析此岗位匹配度')}{' '}
            </button>
            {/^https?:\/\//i.test(job.source_url) && (
              <a
                className={s.button}
                href={job.source_url}
                target="_blank"
                rel="noopener noreferrer"
              >
                {' '}
                {tr('查看原岗位')}{' '}
              </a>
            )}
          </div>
        </article>
      ))}
    </section>
  );
}

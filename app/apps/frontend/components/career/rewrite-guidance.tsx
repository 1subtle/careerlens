'use client';

import type { Rewrite } from '@/lib/api/career';
import { useCareerText } from '@/lib/i18n/career';
import s from './workspace.module.css';
import styles from './rewrite-guidance.module.css';

const stages = { S: '情境', T: '任务', A: '行动', R: '结果' } as const;

export function RewriteGuidance({
  draft,
  onSupplement,
}: {
  draft: Rewrite;
  onSupplement: () => void;
}) {
  const tr = useCareerText();
  const star = draft.star ?? [];
  const keywords = draft.keyword_suggestions ?? [];
  const questions = [
    ...new Set([
      ...(draft.quantification_suggestions ?? []),
      ...(star.length ? draft.missing_facts : []),
    ]),
  ].filter((question) => !star.some((item) => item.question === question));
  if (!star.length && !keywords.length && !questions.length) return null;

  return (
    <section className={s.diagnosticSubsection} aria-label={tr('STAR 与岗位表达建议')}>
      {star.length > 0 && (
        <>
          <h3>{tr('这段经历的 STAR 要素')}</h3>
          <p className={s.muted}>{tr('已有内容来自你的材料，待补充的问题帮助你把经历说完整。')}</p>
          <dl className={styles.stages}>
            {(['S', 'T', 'A', 'R'] as const).map((stage) => {
              const item = star.find((entry) => entry.stage === stage);
              if (!item) return null;
              return (
                <div className={styles.stage} key={stage}>
                  <dt>
                    <span className={styles.letter}>{stage}</span>
                    {tr(stages[stage])}
                  </dt>
                  <dd>
                    <span className={item.evidence ? styles.available : styles.missing}>
                      {item.evidence ? tr('已有依据') : tr('待补充')}
                    </span>
                    {item.evidence ? (
                      <blockquote>{item.evidence}</blockquote>
                    ) : (
                      <p>{item.question}</p>
                    )}
                  </dd>
                </div>
              );
            })}
          </dl>
        </>
      )}
      {keywords.length > 0 && (
        <section className={s.diagnosticSubsection}>
          <h3>{tr('对照 JD 调整表达')}</h3>
          <div className={styles.keywords}>
            {keywords.map((item) => (
              <div className={s.analysisFinding} key={item.keyword}>
                <strong>{item.keyword}</strong>
                <p>{item.suggestion}</p>
              </div>
            ))}
          </div>
        </section>
      )}
      {questions.length > 0 && (
        <section className={s.diagnosticSubsection}>
          <h3>{tr('让成果更具体')}</h3>
          <p className={s.muted}>{tr('补充你能确认的规模、过程或交付结果，再生成一版建议。')}</p>
          <ul className={styles.questions}>
            {questions.map((question) => (
              <li key={question}>{question}</li>
            ))}
          </ul>
        </section>
      )}
      {(star.some((item) => item.question) || questions.length > 0) && (
        <button type="button" className={s.button} onClick={onSupplement}>
          {tr('补充这些信息')}
        </button>
      )}
    </section>
  );
}

'use client';

import { useCareerText } from '@/lib/i18n/career';

import s from './workspace.module.css';

export function RewriteComparison({ before, after }: { before: string; after: string }) {
  const tr = useCareerText();
  const original = Array.from(before);
  const revised = Array.from(after);
  let start = 0;
  while (start < original.length && start < revised.length && original[start] === revised[start])
    start++;
  let end = 0;
  while (
    end < original.length - start &&
    end < revised.length - start &&
    original[original.length - end - 1] === revised[revised.length - end - 1]
  )
    end++;
  const unchanged = before.replace(/\s+/g, '') === after.replace(/\s+/g, '');
  const smallChange =
    !unchanged && (start + end) / Math.max(original.length, revised.length) >= 0.95;
  const renderText = (characters: string[], kind: 'before' | 'after') => {
    if (unchanged) return characters.join('');
    const changed = characters.slice(start, characters.length - end).join('');
    return (
      <>
        {characters.slice(0, start).join('')}
        {changed && (kind === 'before' ? <del>{changed}</del> : <ins>{changed}</ins>)}
        {end > 0 && characters.slice(-end).join('')}
      </>
    );
  };
  return (
    <div>
      {(unchanged || smallChange) && (
        <p className={s.note}>
          {unchanged
            ? tr('本次正文与原文基本一致，尚无实质改写。')
            : tr('本次改动较少，主要调整了局部文字。')}
        </p>
      )}
      <div className={`${s.compare} ${s.rewriteDiff}`}>
        <section aria-label={tr('改写前')}>
          <h3>{tr('原始段落')}</h3>
          <p className={s.compareText}>{renderText(original, 'before')}</p>
        </section>
        <section aria-label={tr('改写后')}>
          <h3>{tr('建议正文')}</h3>
          <p className={s.compareText}>{renderText(revised, 'after')}</p>
        </section>
      </div>
    </div>
  );
}

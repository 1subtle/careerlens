'use client';

import { useMemo } from 'react';
import { useLanguage } from '@/lib/context/language-context';
import english from './career.en.json';
import { safeAccountTimeZone } from '@/lib/utils/account-timezone';

/** Translate authored interface copy only; resume, job and generated content is kept intact. */
export function useCareerText() {
  const { uiLanguage, accountProfile } = useLanguage();
  return useMemo(() => {
    const translate = (text: string, ...values: (string | number)[]) => {
      const translated =
        uiLanguage === 'zh' ? text : ((english as Record<string, string>)[text] ?? text);
      return translated.replace(/\{(\d+)\}/g, (match, index) =>
        String(values[Number(index)] ?? match)
      );
    };
    return Object.assign(translate, {
      date: (value: string | number | Date) =>
        new Date(value).toLocaleString(uiLanguage, {
          timeZone: safeAccountTimeZone(accountProfile?.timezone),
          hour12: false,
        }),
      language: uiLanguage,
    });
  }, [uiLanguage, accountProfile?.timezone]);
}

export function CareerLoading({ text }: { text: string }) {
  const tr = useCareerText();
  return tr(text);
}

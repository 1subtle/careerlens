'use client';

import { useEffect, useLayoutEffect, type RefObject } from 'react';

function fitTextareas(container: HTMLElement | null) {
  container?.querySelectorAll('textarea').forEach((field) => {
    field.style.overflowY = 'hidden';
    field.style.height = 'auto';
    const border = field.offsetHeight - field.clientHeight;
    field.style.height = `${field.scrollHeight + border}px`;
  });
}

/** Expand controlled text fields with their content and the available document width. */
export function useAutoSizeTextareas(
  ref: RefObject<HTMLElement | null>,
  value: unknown,
  enabled = true
) {
  useLayoutEffect(() => {
    if (enabled) fitTextareas(ref.current);
  }, [enabled, ref, value]);

  useEffect(() => {
    const container = ref.current;
    if (!enabled || !container) return;
    let width: number | undefined;
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width !== width) {
        width = entry.contentRect.width;
        fitTextareas(container);
      }
    });
    observer.observe(container);
    let active = true;
    void document.fonts?.ready.then(() => {
      if (active) fitTextareas(container);
    });
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [enabled, ref]);
}

import { afterEach, expect, it, vi } from 'vitest';
import { CAREER_LAYOUT_DEFAULTS, fitResumeLayout } from '@/lib/utils/career-layout';

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

it('uses measured wrapping to expand a short resume and keeps long content readable', async () => {
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { ready: Promise.resolve() },
  });
  const measurement = document.createElement('div');
  measurement.innerHTML = '<div><p>已填写的简历内容</p></div>';
  document.body.appendChild(measurement);
  let contentLength = 25;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const body = this.firstElementChild as HTMLElement;
    const font = parseFloat(body?.style.getPropertyValue('--font-size-base') || '15');
    const line = Number(body?.style.getPropertyValue('--line-height') || '1.45');
    return { height: contentLength * font * line } as DOMRect;
  });
  const short = await fitResumeLayout(measurement, CAREER_LAYOUT_DEFAULTS);
  expect(short.pages).toBe(1);
  expect(short.settings.fontSize.base).toBe(5);
  expect(short.settings.spacing.lineHeight).toBe(5);
  contentLength = 160;
  const long = await fitResumeLayout(measurement, CAREER_LAYOUT_DEFAULTS);
  expect(long.pages).toBeGreaterThan(1);
  expect(long.settings.fontSize.base).toBeGreaterThanOrEqual(3);
  expect(measurement.innerHTML).toBe('<div><p>已填写的简历内容</p></div>');
  expect(document.body.children).toHaveLength(1);
});

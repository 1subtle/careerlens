import {
  DEFAULT_TEMPLATE_SETTINGS,
  settingsToCssVars,
  type SpacingLevel,
  type TemplateSettings,
} from '@/lib/types/template-settings';
import { getContentAreaPx } from '@/lib/constants/page-dimensions';

export const CAREER_LAYOUT_DEFAULTS: TemplateSettings = {
  ...DEFAULT_TEMPLATE_SETTINGS,
  margins: { top: 14, bottom: 14, left: 14, right: 14 },
  spacing: { section: 4, item: 3, lineHeight: 4 },
  fontSize: { base: 4, headerScale: 3, headerFont: 'sans-serif', bodyFont: 'sans-serif' },
};

// Measure the rendered content, including line wrapping and photos, at print width.
// Keep body text at least 10.5 pt; long resumes may need more than one page.
export async function fitResumeLayout(
  measurement: HTMLDivElement,
  current: TemplateSettings
): Promise<{ settings: TemplateSettings; pages: number }> {
  await document.fonts.ready;
  await Promise.all(
    Array.from(measurement.querySelectorAll('img')).map((img) => img.decode().catch(() => {}))
  );
  const clone = measurement.cloneNode(true) as HTMLDivElement;
  clone.style.position = 'fixed';
  clone.style.left = '-10000px';
  clone.style.top = '0';
  clone.style.visibility = 'hidden';
  clone.setAttribute('aria-hidden', 'true');
  const body = clone.firstElementChild as HTMLElement;
  if (!body || !measurement.textContent?.trim()) throw new Error('请先填写简历内容，再进行排版。');
  document.body.appendChild(clone);
  const area = getContentAreaPx(current.pageSize, current.margins);
  clone.style.width = `${area.width}px`;
  let best = { settings: current, pages: 1, cost: Infinity };
  try {
    for (const [font, line, section, item] of [
      [5, 5, 5, 4],
      [5, 4, 4, 3],
      [5, 3, 3, 2],
      [5, 2, 3, 2],
      [4, 5, 5, 4],
      [4, 4, 4, 3],
      [4, 3, 3, 2],
      [3, 4, 4, 3],
      [3, 3, 3, 2],
      [3, 2, 2, 2],
    ] as SpacingLevel[][]) {
      const settings: TemplateSettings = {
        ...current,
        compactMode: false,
        fontSize: { ...current.fontSize, base: font },
        spacing: { lineHeight: line, section, item },
      };
      const vars = settingsToCssVars(
        { ...settings, margins: { top: 0, bottom: 0, left: 0, right: 0 } },
        'zh'
      );
      for (const [key, value] of Object.entries(vars)) body.style.setProperty(key, String(value));
      const height = clone.getBoundingClientRect().height;
      const pages = Math.max(1, Math.ceil(height / (area.height * 0.98)));
      const cost = (pages - 1) * 10 + Math.abs(0.92 - height / (pages * area.height));
      if (cost < best.cost) best = { settings, pages, cost };
    }
    return best;
  } finally {
    clone.remove();
  }
}

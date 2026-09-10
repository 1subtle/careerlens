'use client';

import { useCareerText } from '@/lib/i18n/career';

import { useRef, useState } from 'react';
import { WandSparkles, RotateCcw } from 'lucide-react';
import type { ResumeData } from '@/components/dashboard/resume-component';
import { PaginatedPreview } from '@/components/preview/paginated-preview';
import { CAREER_LAYOUT_DEFAULTS, fitResumeLayout } from '@/lib/utils/career-layout';
import {
  applyTemplatePreset,
  FONT_SIZE_MAP,
  LINE_HEIGHT_MAP,
  type SpacingLevel,
  type TemplateSettings,
} from '@/lib/types/template-settings';
import s from './resume-panel.module.css';

export function ResumeLayout({
  data,
  settings,
  onChange,
  busy,
}: {
  data: ResumeData;
  settings: TemplateSettings;
  onChange: (value: TemplateSettings) => void;
  busy: boolean;
}) {
  const tr = useCareerText();
  const measurement = useRef<HTMLDivElement>(null);
  const [fitting, setFitting] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const set = (value: TemplateSettings) => {
    setNotice('');
    onChange(value);
  };
  return (
    <section className={s.layout} aria-label={tr('简历排版')}>
      <fieldset className={s.layoutControls} disabled={busy || fitting}>
        <div className={s.layoutIntro}>
          <div>
            <strong>{tr('排版工作台')}</strong>
            <span>{tr('调整当前简历，预览同步更新')}</span>
          </div>
          <button
            className={`${s.button} ${s.primary}`}
            onClick={async () => {
              if (!measurement.current) return;
              setFitting(true);
              setError('');
              try {
                const result = await fitResumeLayout(measurement.current, settings);
                onChange(result.settings);
                setNotice(
                  result.pages === 1
                    ? tr('已按一页调整字号与间距，可继续微调。')
                    : tr('内容较多，已调整为舒适的多页排版。')
                );
              } catch (e) {
                setError(e instanceof Error ? e.message : tr('排版失败，请重试。'));
              } finally {
                setFitting(false);
              }
            }}
          >
            <WandSparkles size={15} aria-hidden="true" />
            {fitting ? tr('正在排版…') : tr('按内容自动排版')}
          </button>
          <button
            className={s.button}
            onClick={() => set({ ...CAREER_LAYOUT_DEFAULTS, template: settings.template })}
          >
            <RotateCcw size={14} aria-hidden="true" /> {tr('重置排版')}{' '}
          </button>
        </div>
        <div className={s.layoutFields}>
          <label>
            {' '}
            {tr('简历样式')}{' '}
            <select
              value={settings.template}
              onChange={(e) =>
                set(applyTemplatePreset(settings, e.target.value as TemplateSettings['template']))
              }
            >
              <option value="swiss-single">{tr('经典 · 清晰分节')}</option>
              <option value="clean">{tr('简洁 · 轻量标题')}</option>
              <option value="modern">{tr('现代 · 彩色强调')}</option>
            </select>
          </label>
          <label>
            {' '}
            {tr('正文大小')}{' '}
            <select
              value={settings.fontSize.base}
              onChange={(e) =>
                set({
                  ...settings,
                  fontSize: { ...settings.fontSize, base: Number(e.target.value) as SpacingLevel },
                })
              }
            >
              {([3, 4, 5] as SpacingLevel[]).map((v) => (
                <option key={v} value={v}>
                  {parseFloat(FONT_SIZE_MAP[v]) * 0.75} {tr('磅')}{' '}
                </option>
              ))}
            </select>
          </label>
          <label>
            {' '}
            {tr('行距')}{' '}
            <select
              value={settings.spacing.lineHeight}
              onChange={(e) =>
                set({
                  ...settings,
                  compactMode: false,
                  spacing: {
                    ...settings.spacing,
                    lineHeight: Number(e.target.value) as SpacingLevel,
                  },
                })
              }
            >
              {([1, 2, 3, 4, 5] as SpacingLevel[]).map((v) => (
                <option key={v} value={v}>
                  {LINE_HEIGHT_MAP[v]} {tr('倍')}{' '}
                </option>
              ))}
            </select>
          </label>
          <label>
            {' '}
            {tr('章节间距')}{' '}
            <select
              value={settings.spacing.section}
              onChange={(e) =>
                set({
                  ...settings,
                  compactMode: false,
                  spacing: { ...settings.spacing, section: Number(e.target.value) as SpacingLevel },
                })
              }
            >
              {[tr('很紧凑'), tr('紧凑'), tr('标准'), tr('舒展'), tr('宽松')].map((v, i) => (
                <option key={v} value={i + 1}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label>
            {' '}
            {tr('经历间距')}{' '}
            <select
              value={settings.spacing.item}
              onChange={(e) =>
                set({
                  ...settings,
                  compactMode: false,
                  spacing: { ...settings.spacing, item: Number(e.target.value) as SpacingLevel },
                })
              }
            >
              {[tr('很紧凑'), tr('紧凑'), tr('标准'), tr('舒展'), tr('宽松')].map((v, i) => (
                <option key={v} value={i + 1}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label>
            {' '}
            {tr('纸张')}{' '}
            <select
              value={settings.pageSize}
              onChange={(e) =>
                set({ ...settings, pageSize: e.target.value as TemplateSettings['pageSize'] })
              }
            >
              <option value="A4">A4</option>
              <option value="LETTER">Letter</option>
            </select>
          </label>
          {(['top', 'bottom', 'left', 'right'] as const).map((side, i) => (
            <label key={side}>
              {[tr('上'), tr('下'), tr('左'), tr('右')][i]}
              {tr('边距 · mm')}{' '}
              <input
                type="number"
                min={5}
                max={25}
                value={settings.margins[side]}
                onChange={(e) => {
                  const value = Number(e.target.value);
                  if (Number.isInteger(value) && value >= 5 && value <= 25)
                    set({ ...settings, margins: { ...settings.margins, [side]: value } });
                }}
              />
            </label>
          ))}
        </div>
      </fieldset>
      {notice && (
        <p className={s.layoutNotice} role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className={s.layoutNotice} role="alert">
          {error}
        </p>
      )}
      <div className={s.paperPreview}>
        <PaginatedPreview
          resumeData={data}
          settings={settings}
          measurementRef={measurement}
          locale={tr.language}
        />
      </div>
    </section>
  );
}

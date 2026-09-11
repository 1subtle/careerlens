'use client';

import { useCareerText } from '@/lib/i18n/career';

import { useRef, useState } from 'react';
import { WandSparkles, RotateCcw, ChevronDown, ChevronUp, SlidersHorizontal } from 'lucide-react';
import Image from 'next/image';
import { RESUME_TEMPLATE_CATALOG } from '@/lib/resume-template-catalog';
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
  const [templatesOpen, setTemplatesOpen] = useState(true);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const templateToggle = useRef<HTMLButtonElement>(null);
  const selected = RESUME_TEMPLATE_CATALOG.find((item) => item.id === settings.template);
  const fonts = [
    ['sans-serif', '思源黑体'],
    ['serif', '思源宋体'],
    ['mono', '等宽英文字体'],
  ] as const;
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const set = (value: TemplateSettings) => {
    setNotice('');
    onChange(value);
  };
  return (
    <section className={s.layout} aria-label={tr('简历排版')}>
      <fieldset className={s.layoutControls} disabled={busy || fitting}>
        <div className={s.layoutQuickBar}>
          <button
            ref={templateToggle}
            className={s.button}
            aria-expanded={templatesOpen}
            aria-controls="resume-template-gallery"
            onClick={() => setTemplatesOpen(!templatesOpen)}
          >
            {tr(selected?.name ?? '已保存的双栏模板')} ·{' '}
            {tr(templatesOpen ? '收起模板' : '更换模板')}
            {templatesOpen ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
          </button>
          <label>
            {tr('正文字体')}
            <select
              value={settings.fontSize.bodyFont}
              onChange={(e) =>
                set({
                  ...settings,
                  fontSize: {
                    ...settings.fontSize,
                    bodyFont: e.target.value as TemplateSettings['fontSize']['bodyFont'],
                  },
                })
              }
            >
              {fonts.map(([value, name]) => (
                <option key={value} value={value}>
                  {tr(name)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {tr('字号')}
            <select
              value={settings.fontSize.base}
              onChange={(e) =>
                set({
                  ...settings,
                  fontSize: { ...settings.fontSize, base: Number(e.target.value) as SpacingLevel },
                })
              }
            >
              {([1, 2, 3, 4, 5] as SpacingLevel[]).map((value) => (
                <option key={value} value={value}>
                  {parseFloat(FONT_SIZE_MAP[value]) * 0.75} {tr('磅')}
                </option>
              ))}
            </select>
          </label>
          <button
            className={s.button}
            aria-expanded={advancedOpen}
            aria-controls="resume-layout-advanced"
            onClick={() => setAdvancedOpen(!advancedOpen)}
          >
            <SlidersHorizontal size={15} aria-hidden="true" />
            {tr(advancedOpen ? '收起设置' : '更多排版')}
          </button>
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
        {templatesOpen && (
          <div
            className={s.templateGallery}
            id="resume-template-gallery"
            role="group"
            aria-label={tr('选择简历模板')}
          >
            {RESUME_TEMPLATE_CATALOG.map(({ id, name, description, category }) => (
              <button
                type="button"
                key={id}
                className={s.templateCard}
                aria-pressed={settings.template === id}
                onClick={() => {
                  set(applyTemplatePreset(settings, id));
                  setTemplatesOpen(false);
                  templateToggle.current?.focus();
                }}
              >
                <Image
                  src={`/resume-templates/${id}.jpg`}
                  width={210}
                  height={297}
                  alt=""
                  className={s.templateThumbnail}
                  unoptimized
                />
                <strong>
                  {tr(name)}
                  {settings.template === id ? ` · ${tr('已选择')}` : ''}
                </strong>
                <small>
                  {tr(category)} · {tr(description)}
                </small>
              </button>
            ))}
          </div>
        )}
        {advancedOpen && (
          <div className={s.layoutAdvanced} id="resume-layout-advanced">
            <div className={s.layoutFields}>
              <label>
                {tr('标题字体')}
                <select
                  value={settings.fontSize.headerFont}
                  onChange={(e) =>
                    set({
                      ...settings,
                      fontSize: {
                        ...settings.fontSize,
                        headerFont: e.target.value as TemplateSettings['fontSize']['headerFont'],
                      },
                    })
                  }
                >
                  {fonts.map(([value, name]) => (
                    <option key={value} value={value}>
                      {tr(name)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {tr('标题大小')}
                <select
                  value={settings.fontSize.headerScale}
                  onChange={(e) =>
                    set({
                      ...settings,
                      fontSize: {
                        ...settings.fontSize,
                        headerScale: Number(e.target.value) as SpacingLevel,
                      },
                    })
                  }
                >
                  {[1, 2, 3, 4, 5].map((value) => (
                    <option key={value} value={value}>
                      {tr(['较小', '偏小', '标准', '偏大', '较大'][value - 1])}
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
                      spacing: {
                        ...settings.spacing,
                        section: Number(e.target.value) as SpacingLevel,
                      },
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
                      spacing: {
                        ...settings.spacing,
                        item: Number(e.target.value) as SpacingLevel,
                      },
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
          </div>
        )}
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

'use client';

import { useCareerText, CareerLoading } from '@/lib/i18n/career';

import { useCallback, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import {
  ArrowLeft,
  ArrowRight,
  Download,
  Eye,
  MoreHorizontal,
  PencilLine,
  Save,
  SlidersHorizontal,
  UploadCloud,
  X,
} from 'lucide-react';
import { useTranslations } from '@/lib/i18n';
import { getAllSections, withLocalizedDefaultSections } from '@/lib/utils/section-helpers';
import { useAutoSizeTextareas } from '@/hooks/use-autosize-textareas';
import type { ResumeData } from '@/components/dashboard/resume-component';
import { careerApi, type CareerResume } from '@/lib/api/career';
import type { RunAction } from './workspace';
import s from './resume-panel.module.css';
import { CAREER_LAYOUT_DEFAULTS } from '@/lib/utils/career-layout';
import type { TemplateSettings } from '@/lib/types/template-settings';

const ResumeLayout = dynamic(() => import('./resume-layout').then((m) => m.ResumeLayout), {
  ssr: false,
  loading: () => (
    <p>
      <CareerLoading text="正在载入排版工作台…" />
    </p>
  ),
});

const ResumeForm = dynamic(
  () => import('@/components/builder/resume-form').then((m) => m.ResumeForm),
  {
    loading: () => (
      <p>
        <CareerLoading text="正在载入编辑器…" />
      </p>
    ),
  }
);
const Resume = dynamic(() => import('@/components/dashboard/resume-component'), { ssr: false });
const blank: ResumeData = {
  personalInfo: { name: '', title: '', email: '', phone: '', location: '' },
  summary: '',
  education: [],
  workExperience: [],
  personalProjects: [],
  additional: { technicalSkills: [], languages: [], certificationsTraining: [], awards: [] },
};

interface Props {
  resume?: CareerResume;
  active?: boolean;
  busy: boolean;
  useAi: boolean;
  run: RunAction;
  onDirty: () => void;
  onSaved: (resume: CareerResume) => Promise<void>;
  onDeleted: () => Promise<void>;
  onNext: () => void;
  onNavigate?: (event: { preventDefault: () => void }) => void;
}
export function ResumePanel({
  resume,
  active = true,
  busy,
  useAi,
  run,
  onDirty,
  onSaved,
  onDeleted,
  onNext,
  onNavigate,
}: Props) {
  const tr = useCareerText();
  const { t } = useTranslations();
  const fileInput = useRef<HTMLInputElement>(null);
  const moreDialog = useRef<HTMLDialogElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<ResumeData>(resume?.data ?? blank);
  const [title, setTitle] = useState(resume?.title ?? tr('我的简历'));
  const [text, setText] = useState(resume?.source_text ?? '');
  const [view, setView] = useState<'edit' | 'preview' | 'import' | 'layout'>('edit');
  const [layout, setLayout] = useState<TemplateSettings>(
    resume?.template_settings ?? CAREER_LAYOUT_DEFAULTS
  );
  const [parseMode, setParseMode] = useState('');
  const [warning, setWarning] = useState('');
  const localizedData = withLocalizedDefaultSections(data, t);
  useAutoSizeTextareas(viewport, text, view === 'import');
  const update = (value: ResumeData) => {
    setData(value);
    onDirty();
  };
  const importResult = (value: {
    data: ResumeData;
    source_text: string;
    mode: string;
    warning?: string;
  }) => {
    update(value.data);
    setText(value.source_text);
    setParseMode(value.mode);
    setWarning(value.warning ?? '');
    setView('edit');
  };
  const save = useCallback(() => {
    if (busy || !title.trim()) return;
    void run(tr('保存简历'), async () =>
      onSaved(
        await careerApi.saveResume(
          {
            title,
            data,
            source_text: text,
            expected_hash: resume?.hash,
            expected_revision: resume?.revision,
            template_settings: layout,
          },
          resume?.id
        )
      )
    );
  }, [
    busy,
    title,
    data,
    text,
    layout,
    resume?.hash,
    resume?.revision,
    resume?.id,
    run,
    onSaved,
    tr,
  ]);

  const exportDocument = (format: 'pdf' | 'word') => {
    if (busy || !title.trim()) return;
    void run(format === 'pdf' ? tr('保存并导出 PDF') : tr('保存并导出 Word'), async () => {
      const saved = await careerApi.saveResume(
        {
          title,
          data,
          source_text: text,
          expected_hash: resume?.hash,
          expected_revision: resume?.revision,
          template_settings: layout,
        },
        resume?.id
      );
      await onSaved(saved);
      if (format === 'pdf') await careerApi.downloadPdf(saved.id, layout);
      else await careerApi.downloadWord(saved.id);
    });
  };

  useEffect(() => {
    if (!active) return;
    const handleSave = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        if (!event.repeat) save();
      }
    };
    window.addEventListener('keydown', handleSave);
    return () => window.removeEventListener('keydown', handleSave);
  }, [active, save]);

  return (
    <div className={s.panel}>
      <header className={s.toolbar} aria-label={tr('简历文档工具栏')}>
        <input
          className={s.title}
          aria-label={tr('版本名称')}
          title={tr('编辑版本名称')}
          maxLength={120}
          value={title}
          disabled={busy}
          onChange={(e) => {
            setTitle(e.target.value);
            onDirty();
          }}
        />
        <div className={s.actions}>
          <button
            className={`${s.button} ${s.primary}`}
            disabled={busy || !title.trim()}
            onClick={save}
            title={tr('保存简历（⌘S / Ctrl+S）')}
          >
            <Save size={15} aria-hidden="true" /> {tr('保存简历')}{' '}
          </button>
          <div className={s.modes} role="group" aria-label={tr('文档模式')}>
            <button
              className={s.button}
              aria-pressed={view === 'edit'}
              disabled={busy}
              onClick={() => setView('edit')}
            >
              <PencilLine size={15} aria-hidden="true" /> {tr('编辑')}{' '}
            </button>
            <button
              className={s.button}
              aria-pressed={view === 'preview'}
              disabled={busy}
              onClick={() => setView('preview')}
            >
              <Eye size={15} aria-hidden="true" /> {tr('预览')}{' '}
            </button>
          </div>
          <button
            className={s.button}
            aria-pressed={view === 'layout'}
            disabled={busy}
            onClick={() => setView('layout')}
          >
            <SlidersHorizontal size={15} aria-hidden="true" /> {tr('排版')}{' '}
          </button>
          <button
            className={s.button}
            disabled={busy}
            aria-pressed={view === 'import'}
            onClick={() => setView('import')}
          >
            <UploadCloud size={15} aria-hidden="true" /> {tr('导入')}{' '}
          </button>
          <button
            className={s.button}
            disabled={busy || !resume}
            title={tr('保存当前内容与排版，然后导出')}
            onClick={() => exportDocument('pdf')}
          >
            <Download size={15} aria-hidden="true" /> {tr('导出 PDF')}{' '}
          </button>
          <button
            className={s.button}
            disabled={busy || !resume}
            title={tr('保存并导出可编辑的 Word 文档')}
            onClick={() => exportDocument('word')}
          >
            <Download size={15} aria-hidden="true" /> {tr('导出 Word')}{' '}
          </button>
          <button
            className={`${s.button} ${s.iconButton}`}
            aria-label={tr('更多版本操作')}
            disabled={busy}
            onClick={() => moreDialog.current?.showModal()}
          >
            <MoreHorizontal size={18} aria-hidden="true" />
          </button>
        </div>
        <input
          ref={fileInput}
          aria-label={tr('导入简历文件')}
          type="file"
          accept=".pdf,.docx,.txt,.md"
          disabled={busy}
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file)
              void run(useAi ? tr('提取文件并进行 AI 解析') : tr('提取文件内容'), async () =>
                importResult(await careerApi.parseFile(file, useAi))
              );
            e.target.value = '';
          }}
        />
      </header>
      {view === 'edit' && (
        <nav className={s.chapters} aria-label={tr('简历章节')}>
          {getAllSections(localizedData).map((section) => (
            <a
              key={section.id}
              href={`#resume-section-${section.id}`}
              data-hidden={!section.isVisible}
              title={section.isVisible ? undefined : tr('此章节在导出中隐藏，仍可编辑')}
            >
              {section.displayName}
            </a>
          ))}
        </nav>
      )}
      <div
        ref={viewport}
        className={`${s.viewport} ${view === 'layout' ? s.layoutViewport : ''}`}
        role="region"
        aria-label={tr('简历内容')}
      >
        {parseMode && (
          <p className={s.note} role="status">
            {parseMode === 'ai' ? tr('AI 解析') : tr('规则解析')}
            {tr('完成，可继续编辑。')}{' '}
          </p>
        )}
        {warning && (
          <p className={s.note} role="alert">
            {warning}
          </p>
        )}
        {view === 'edit' && (
          <div className={s.document}>
            <fieldset className={s.editor} disabled={busy} inert={busy}>
              <ResumeForm resumeData={localizedData} onUpdate={update} documentMode />
            </fieldset>
            {resume && (
              <button className={s.next} disabled={busy} onClick={onNext}>
                {' '}
                {tr('选择目标岗位')} <ArrowRight size={15} aria-hidden="true" />
              </button>
            )}
          </div>
        )}
        {view === 'preview' && (
          <section className={s.preview} aria-label={tr('简历预览')}>
            <p className={s.previewHint}>
              {' '}
              {tr('预览当前编辑。点击“排版”调整纸张与间距，导出时会一并保存。')}{' '}
            </p>
            <Resume
              resumeData={localizedData}
              settings={layout}
              locale={tr.language}
              sectionHeadings={{
                summary: tr('个人简介'),
                experience: tr('工作经历'),
                education: tr('教育背景'),
                projects: tr('项目经历'),
                skills: tr('技能'),
                certifications: tr('证书'),
                languages: tr('语言'),
                awards: tr('奖项'),
                links: tr('链接'),
              }}
            />
          </section>
        )}
        {view === 'layout' && (
          <ResumeLayout
            data={localizedData}
            settings={layout}
            busy={busy}
            onChange={(value) => {
              setLayout(value);
              onDirty();
            }}
          />
        )}
        {view === 'import' && (
          <section className={s.importView} aria-label={tr('导入简历')}>
            <button className={s.back} onClick={() => setView('edit')} disabled={busy}>
              <ArrowLeft size={15} aria-hidden="true" /> {tr('返回文档')}{' '}
            </button>
            <h2>{tr('导入简历')}</h2>
            <p>{tr('解析后将替换文档内容，保存前仍可继续编辑。')}</p>
            <div className={s.fileImport}>
              <button
                className={s.button}
                disabled={busy}
                onClick={() => fileInput.current?.click()}
              >
                <UploadCloud size={15} aria-hidden="true" /> {tr('导入文件')}{' '}
              </button>
              <span>{tr('PDF、DOCX、TXT、Markdown · 最大 5 MB')}</span>
            </div>
            <label className={s.field}>
              <span>{tr('简历原文')}</span>
              <textarea
                autoFocus
                rows={16}
                maxLength={300000}
                value={text}
                disabled={busy}
                onChange={(e) => {
                  setText(e.target.value);
                  onDirty();
                }}
                placeholder={tr('教育背景、工作或项目经历、技能…')}
              />
            </label>
            <button
              className={`${s.button} ${s.primary}`}
              disabled={busy || !text.trim()}
              onClick={() =>
                void run(tr('解析简历'), async () =>
                  importResult(await careerApi.parseResume(text, useAi))
                )
              }
            >
              {useAi ? tr('AI 解析到文档') : tr('规则解析到文档')}
            </button>
          </section>
        )}
      </div>
      <dialog ref={moreDialog} className={s.dialog} aria-label={tr('更多版本操作')}>
        <div className={s.dialogHeader}>
          <h2>{tr('更多版本操作')}</h2>
          <button
            className={`${s.button} ${s.iconButton}`}
            aria-label={tr('关闭版本操作')}
            onClick={() => moreDialog.current?.close()}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        {resume ? (
          <div className={s.dialogActions}>
            <Link className={s.button} href={`/builder?id=${resume.id}`} onNavigate={onNavigate}>
              {' '}
              {tr('打开排版编辑器 ↗')}{' '}
            </Link>
            <button
              className={s.button}
              disabled={busy}
              onClick={() => {
                moreDialog.current?.close();
                onNext();
              }}
            >
              {' '}
              {tr('选择目标岗位')} <ArrowRight size={15} aria-hidden="true" />
            </button>
            <p className={s.muted}>
              {tr('上方“排版”可直接调整当前文档。高级编辑器读取已保存内容。')}
            </p>
            <button
              className={`${s.button} ${s.danger}`}
              disabled={busy}
              onClick={() => {
                if (
                  window.confirm(tr('删除此简历及其诊断、快照和建议记录？其他独立简历版本会保留。'))
                ) {
                  moreDialog.current?.close();
                  void run(tr('删除简历及关联记录'), async () => {
                    await careerApi.deleteResume(resume.id);
                    await onDeleted();
                  });
                }
              }}
            >
              {' '}
              {tr('删除当前版本')}{' '}
            </button>
          </div>
        ) : (
          <p className={s.muted}>{tr('保存简历后，即可导出 PDF 或进入排版编辑器。')}</p>
        )}
      </dialog>
    </div>
  );
}

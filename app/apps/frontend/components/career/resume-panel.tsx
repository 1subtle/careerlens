'use client';

import { useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useTranslations } from '@/lib/i18n';
import { withLocalizedDefaultSections } from '@/lib/utils/section-helpers';
import type { ResumeData } from '@/components/dashboard/resume-component';
import { careerApi, type CareerResume } from '@/lib/api/career';
import type { RunAction } from './workspace';
import s from './workspace.module.css';

const ResumeForm = dynamic(
  () => import('@/components/builder/resume-form').then((m) => m.ResumeForm),
  { loading: () => <p>正在载入编辑器…</p> }
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
  busy: boolean;
  useAi: boolean;
  run: RunAction;
  onDirty: () => void;
  onSaved: (resume: CareerResume) => Promise<void>;
  onDeleted: () => Promise<void>;
  onNext: () => void;
}
export function ResumePanel({
  resume,
  busy,
  useAi,
  run,
  onDirty,
  onSaved,
  onDeleted,
  onNext,
}: Props) {
  const { t } = useTranslations();
  const fileInput = useRef<HTMLInputElement>(null);
  const [data, setData] = useState<ResumeData>(resume?.data ?? blank);
  const [title, setTitle] = useState(resume?.title ?? '我的简历');
  const [text, setText] = useState(resume?.source_text ?? '');
  const [mode, setMode] = useState('');
  const update = (value: ResumeData) => {
    setData(value);
    onDirty();
  };
  const importResult = (value: { data: ResumeData; source_text: string; mode: string }) => {
    update(value.data);
    setText(value.source_text);
    setMode(value.mode);
  };
  return (
    <div className={s.split}>
      <div>
        <details open={!resume} className={s.panel}>
          <summary>从已有材料导入</summary>
          <label className={s.field}>
            <span>粘贴简历原文</span>
            <textarea
              rows={9}
              maxLength={30000}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                onDirty();
              }}
              placeholder={
                '姓名\n教育背景\n学校、专业、学历与时间\n项目经历\n项目名称\n你具体完成了什么\n技能\nPython、SQL…'
              }
            />
          </label>
          <div className={s.actions}>
            <button
              className={`${s.button} ${s.primary}`}
              disabled={busy || !text.trim()}
              onClick={() =>
                void run('解析简历', async () =>
                  importResult(await careerApi.parseResume(text, useAi))
                )
              }
            >
              {useAi ? 'AI 解析到表单' : '规则解析到表单'}
            </button>
            <button className={s.button} disabled={busy} onClick={() => fileInput.current?.click()}>
              导入文件
            </button>
            <input
              ref={fileInput}
              aria-label="导入简历文件"
              type="file"
              accept=".pdf,.docx,.txt,.md"
              disabled={busy}
              style={{ display: 'none' }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file)
                  void run('提取文件内容', async () =>
                    importResult(await careerApi.parseFile(file))
                  );
                e.target.value = '';
              }}
            />
          </div>
          <p className={s.muted} style={{ marginTop: 16 }}>
            支持文字型 PDF、DOCX、TXT、Markdown，最大 5 MB。导入后请校对；文件原件不保存在服务器。
          </p>
        </details>
        {mode && (
          <p className={s.note} style={{ marginTop: 20 }}>
            {mode === 'ai' ? 'AI 解析' : '规则解析'}已填入表单。核对姓名、经历归属与日期后保存。
          </p>
        )}
        <section className={s.section}>
          <h2>结构化简历</h2>
          <label className={s.field}>
            <span>版本名称</span>
            <input
              maxLength={120}
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                onDirty();
              }}
            />
          </label>
          <fieldset disabled={busy}>
            <ResumeForm resumeData={withLocalizedDefaultSections(data, t)} onUpdate={update} />
          </fieldset>
        </section>
        <div className={s.actions} style={{ marginTop: 28 }}>
          <button
            className={`${s.button} ${s.primary}`}
            disabled={busy || !title.trim()}
            onClick={() =>
              void run('保存简历', async () =>
                onSaved(
                  await careerApi.saveResume(
                    { title, data, source_text: text, expected_hash: resume?.hash },
                    resume?.id
                  )
                )
              )
            }
          >
            保存简历
          </button>
          {resume && (
            <button className={s.button} disabled={busy} onClick={onNext}>
              下一步：录入目标岗位 →
            </button>
          )}
        </div>
      </div>
      <aside>
        <section className={s.panel}>
          <p className={s.eyebrow}>MATERIAL CHECK</p>
          <h2 style={{ marginTop: 16 }}>让经历具体起来</h2>
          <p className={s.muted}>
            写清任务、你的行动和实际产出。没有结果数据时，保留可以确认的事实。
          </p>
          <div className={s.section}>
            <p>
              <strong>{data.personalProjects?.length ?? 0}</strong> 项项目经历
            </p>
            <p>
              <strong>{data.workExperience?.length ?? 0}</strong> 段工作 / 实习
            </p>
            <p>
              <strong>{data.additional?.technicalSkills?.length ?? 0}</strong> 项技能自述
            </p>
          </div>
        </section>
        {resume && (
          <section className={s.section}>
            <h3>预览与导出</h3>
            <div className={s.actions}>
              <Link className={s.button} href={`/builder?id=${resume.id}`}>
                打开排版编辑器 ↗
              </Link>
              <button
                className={s.button}
                disabled={busy}
                onClick={() => void run('导出已保存的 PDF', () => careerApi.downloadPdf(resume.id))}
              >
                导出中文 PDF
              </button>
            </div>
            <p className={s.muted} style={{ marginTop: 16 }}>
              导出使用已保存内容。定向版与基础版独立保存。
            </p>
            <button
              className={`${s.button} ${s.danger}`}
              style={{ marginTop: 24 }}
              disabled={busy}
              onClick={() => {
                if (window.confirm('删除此简历及其诊断、快照和建议记录？其他独立简历版本会保留。'))
                  void run('删除简历及关联记录', async () => {
                    await careerApi.deleteResume(resume.id);
                    await onDeleted();
                  });
              }}
            >
              删除当前版本
            </button>
          </section>
        )}
        <details className={s.section}>
          <summary>快速预览当前编辑</summary>
          <div style={{ overflowX: 'auto', maxWidth: '100%', background: '#fff' }}>
            <Resume
              resumeData={data}
              locale="zh"
              sectionHeadings={{
                summary: '个人简介',
                experience: '工作经历',
                education: '教育背景',
                projects: '项目经历',
                skills: '技能',
                certifications: '证书',
                languages: '语言',
                awards: '奖项',
                links: '链接',
              }}
            />
          </div>
        </details>
      </aside>
    </div>
  );
}

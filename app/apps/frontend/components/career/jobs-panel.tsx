'use client';

import { useCareerText } from '@/lib/i18n/career';

import { useState } from 'react';
import { BookmarkPlus, Sparkles } from 'lucide-react';
import { careerApi, CareerApiError, type CareerJob, type Requirement } from '@/lib/api/career';
import type { RunAction } from './workspace';
import s from './workspace.module.css';

interface Props {
  jobs: CareerJob[];
  selected?: CareerJob;
  busy: boolean;
  useAi: boolean;
  run: RunAction;
  onDirty: () => void;
  onSelect: (id: string) => void;
  onSaved: (job: CareerJob) => Promise<void>;
  onDeleted: () => Promise<void>;
  onNext: () => void;
}
export function JobsPanel({
  jobs,
  selected,
  busy,
  useAi,
  run,
  onDirty,
  onSelect,
  onSaved,
  onDeleted,
  onNext,
}: Props) {
  const tr = useCareerText();
  const [version, setVersion] = useState(selected?.version);
  const [conflict, setConflict] = useState(false);
  const [latest, setLatest] = useState<CareerJob | null>(null);
  const [job, setJob] = useState({
    title: selected?.title ?? '',
    company: selected?.company ?? '',
    category: selected?.category ?? '',
    city: selected?.city ?? '',
    salary_text: selected?.salary_text ?? '',
    source_url: selected?.source_url ?? '',
    source_type: selected?.source_type ?? 'manual',
    source_name: selected?.source_name ?? '',
    source_updated_at: selected?.source_updated_at ?? null,
    external_id: selected?.external_id ?? '',
    published_at: selected?.published_at ?? '',
    text: selected?.content ?? '',
  });
  const [requirements, setRequirements] = useState<Requirement[] | undefined>(
    selected?.requirements
  );
  const update = (key: keyof typeof job, value: string) => {
    setJob((previous) => ({ ...previous, [key]: value }));
    if (key === 'text') setRequirements(undefined);
    onDirty();
  };
  const changeRequirement = (index: number, fields: Partial<Requirement>) => {
    setRequirements((items) =>
      items?.map((item, i) => (i === index ? { ...item, ...fields } : item))
    );
    onDirty();
  };
  return (
    <div>
      <section className={s.panel} aria-labelledby="recent-jobs-title">
        <h2 id="recent-jobs-title">{tr('最近使用的 JD')}</h2>
        <p className={s.muted}>
          {jobs.length
            ? tr('选择一份回填，继续编辑或诊断。')
            : tr('记住的 JD 会出现在这里，下次可直接使用。')}
        </p>
        <div className={s.jobList}>
          {jobs.map((item) => (
            <button
              key={item.job_id}
              disabled={busy}
              aria-pressed={selected?.job_id === item.job_id}
              onClick={() => onSelect(item.job_id)}
            >
              <strong>{item.title || tr('未命名岗位')}</strong>
              <span className={s.muted}>
                {[item.company, item.city].filter(Boolean).join(' · ') || tr('点击回填 JD')}
              </span>
            </button>
          ))}
        </div>
      </section>
      <section className={s.panel}>
        {selected && (
          <div className={s.actions} style={{ marginBottom: 24 }}>
            <span className={s.tag}>{tr('已记住这份 JD')}</span>
            <button className={s.button} disabled={busy} onClick={() => onSelect('new')}>
              {' '}
              {tr('粘贴另一份 JD')}{' '}
            </button>
          </div>
        )}
        <label className={s.field}>
          <span>{tr('岗位名称（必填）')}</span>
          <input
            value={job.title}
            maxLength={120}
            onChange={(e) => update('title', e.target.value)}
            placeholder={tr('例如：数据分析实习生')}
            required
          />
        </label>
        <label className={s.field}>
          <span>{tr('粘贴 JD 原文（必填）')}</span>
          <textarea
            rows={10}
            maxLength={300000}
            value={job.text}
            onChange={(e) => update('text', e.target.value)}
            placeholder={tr('把岗位职责、任职要求等完整内容粘贴到这里。')}
            required
          />
        </label>
      </section>
      <section className={s.panel} aria-labelledby="job-information-title">
        <h2 id="job-information-title">{tr('补充公司、地点与来源（选填）')}</h2>
        <div className={s.formGrid}>
          {(
            [
              ['company', tr('公司 / 机构')],
              ['category', tr('岗位类别')],
              ['city', tr('城市')],
              ['salary_text', tr('薪资原文')],
              ['source_url', tr('来源链接')],
            ] as const
          ).map(([key, label]) => (
            <label className={s.field} key={key}>
              <span>{label}</span>
              <input
                value={job[key]}
                type={key === 'source_url' ? 'url' : 'text'}
                maxLength={key === 'source_url' ? 2000 : 120}
                onChange={(e) => update(key, e.target.value)}
                placeholder={key === 'salary_text' ? tr('如 180-220元/天') : ''}
              />
            </label>
          ))}
          <label className={s.field}>
            <span>{tr('发布日期')}</span>
            <input
              type="date"
              value={job.published_at}
              onChange={(e) => update('published_at', e.target.value)}
            />
          </label>
          <label className={s.field}>
            <span>{tr('来源类型')}</span>
            <select value={job.source_type} onChange={(e) => update('source_type', e.target.value)}>
              <option value="manual">{tr('我找到的岗位')}</option>
              <option value="course">{tr('课程提供的岗位')}</option>
              {selected?.source_type === 'api' && (
                <option value="api">
                  {selected.source_name || tr('招聘官网')}
                  {tr('导入')}
                </option>
              )}
            </select>
          </label>
        </div>
        {job.source_updated_at && (
          <p className={s.muted}>
            {tr('来源更新时间：')}
            {job.source_updated_at}
          </p>
        )}
      </section>
      <section className={s.panel} aria-labelledby="job-requirements-title">
        <h2 id="job-requirements-title">{tr('提取与校对岗位要求')}</h2>
        <p className={s.muted}> {tr('记住 JD 时会自动提取要求，也可以在这里逐项校对。')} </p>
        <button
          className={s.button}
          disabled={busy || !job.text.trim()}
          onClick={() =>
            void run(tr('抽取岗位要求'), async () => {
              setRequirements((await careerApi.parseJob(job.text, useAi)).requirements);
              onDirty();
            })
          }
        >
          <Sparkles size={18} aria-hidden="true" />
          {useAi ? tr('AI 抽取岗位要求') : tr('规则抽取岗位要求')}
        </button>
        <div style={{ marginTop: 24 }}>
          {requirements === undefined ? (
            <p className={s.note} style={{ marginTop: 16 }}>
              {' '}
              {tr('提取后可修改要求和原文引用；修改 JD 后需重新提取。')}{' '}
            </p>
          ) : (
            <>
              {requirements.length === 0 && (
                <p className={s.note}>{tr('没有识别到有效要求，可以手动添加。')}</p>
              )}
              {requirements.map((item, i) => (
                <div className={s.requirement} key={item.id}>
                  <input
                    aria-label={tr('要求 {0} 名称', i + 1)}
                    value={item.name}
                    maxLength={100}
                    onChange={(e) => changeRequirement(i, { name: e.target.value })}
                  />
                  <select
                    aria-label={tr('要求 {0} 重要程度', i + 1)}
                    value={item.priority}
                    onChange={(e) =>
                      changeRequirement(i, { priority: e.target.value as Requirement['priority'] })
                    }
                  >
                    <option value="required">{tr('普通')}</option>
                    <option value="preferred">{tr('优先')}</option>
                  </select>
                  <button
                    className={s.button}
                    onClick={() => {
                      setRequirements((items) => items?.filter((_, index) => index !== i));
                      onDirty();
                    }}
                  >
                    {' '}
                    {tr('移除')}{' '}
                  </button>
                  <label className={`${s.field} ${s.full}`} style={{ marginBottom: 0 }}>
                    <span>{tr('JD 原文引用')}</span>
                    <input
                      aria-label={tr('要求 {0} 原文', i + 1)}
                      value={item.source_text}
                      maxLength={3000}
                      onChange={(e) => changeRequirement(i, { source_text: e.target.value })}
                    />
                  </label>
                </div>
              ))}
            </>
          )}
          <button
            className={s.button}
            style={{ marginTop: 20 }}
            disabled={busy || (requirements?.length ?? 0) >= 60}
            onClick={() => {
              setRequirements((items) => [
                ...(items ?? []),
                { id: crypto.randomUUID(), name: '', source_text: '', priority: 'required' },
              ]);
              onDirty();
            }}
          >
            {' '}
            {tr('手动添加一项要求')}{' '}
          </button>
        </div>
      </section>
      {selected && (
        <section className={s.panel} aria-labelledby="job-management-title">
          <h2 id="job-management-title">{tr('管理这份 JD')}</h2>
          <button
            className={`${s.button} ${s.danger}`}
            disabled={busy}
            onClick={() => {
              if (window.confirm(tr('删除这份 JD 及其关联诊断和建议？简历版本会保留。')))
                void run(tr('删除这份 JD'), async () => {
                  await careerApi.deleteJob(selected.job_id);
                  await onDeleted();
                });
            }}
          >
            {' '}
            {tr('删除这份 JD')}{' '}
          </button>
        </section>
      )}
      {selected && conflict && (
        <section className={s.panel} aria-label={tr('JD 版本冲突')}>
          <p role="alert">
            {' '}
            {tr('其他页面已保存了这份 JD。你的编辑仍在上方，请对照最新内容合并后再保存。')}{' '}
          </p>
          <button
            className={s.button}
            disabled={busy}
            onClick={() =>
              void run(tr('读取最新 JD'), async () =>
                setLatest(await careerApi.getJob(selected.job_id))
              )
            }
          >
            {' '}
            {tr('查看最新版本，保留当前编辑')}{' '}
          </button>
          {latest && (
            <>
              <h3>
                {tr('最新版本 ·')} {latest.title}
              </h3>
              <p className={s.muted}>
                {[latest.company, latest.category, latest.city, latest.salary_text]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
              <p className={s.jdText}>{latest.content}</p>
              <section aria-labelledby="latest-job-requirements-title">
                <h3 id="latest-job-requirements-title">{tr('最新来源与岗位要求')}</h3>
                <p>
                  {latest.source_name} {latest.source_url}
                </p>
                <p>
                  {' '}
                  {tr('发布')} {latest.published_at || tr('未填写')} {tr('· 更新')}{' '}
                  {latest.source_updated_at || tr('未填写')}
                </p>
                {latest.requirements?.map((item) => (
                  <p key={item.id}>
                    {item.name}（{item.priority === 'preferred' ? tr('优先') : tr('普通')}）：
                    {item.source_text}
                  </p>
                ))}
              </section>
              <button
                className={s.button}
                disabled={busy}
                onClick={() => {
                  setVersion(latest.version);
                  setConflict(false);
                  setLatest(null);
                }}
              >
                {' '}
                {tr('已合并到当前编辑，继续保存')}{' '}
              </button>
            </>
          )}
        </section>
      )}
      <div className={s.saveBar}>
        <button
          className={`${s.button} ${s.primary}`}
          disabled={busy || conflict || !job.title.trim() || !job.text.trim()}
          onClick={() =>
            void run(tr('记住这份 JD'), async () => {
              try {
                const saved = await careerApi.saveJob(
                  {
                    ...job,
                    published_at: job.published_at || null,
                    requirements,
                    ...(selected ? { expected_version: version } : {}),
                  },
                  selected?.job_id
                );
                setVersion(saved.version);
                setRequirements(saved.requirements);
                await onSaved(saved);
              } catch (error) {
                if (error instanceof CareerApiError && error.status === 409) {
                  setConflict(true);
                  setLatest(null);
                }
                throw error;
              }
            })
          }
        >
          <BookmarkPlus size={18} aria-hidden="true" /> {tr('记住这份 JD')}{' '}
        </button>
        {selected && (
          <button className={s.button} disabled={busy} onClick={onNext}>
            {' '}
            {tr('用这份 JD 诊断 →')}{' '}
          </button>
        )}
      </div>
    </div>
  );
}

'use client';

import { useState } from 'react';
import { careerApi, type CareerJob, type Requirement } from '@/lib/api/career';
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
  const [job, setJob] = useState({
    title: selected?.title ?? '',
    company: selected?.company ?? '',
    category: selected?.category ?? '数据分析',
    city: selected?.city ?? '',
    salary_text: selected?.salary_text ?? '',
    source_url: selected?.source_url ?? '',
    source_type: selected?.source_type ?? 'manual',
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
    <div className={s.split}>
      <div>
        <div className={s.actions} style={{ marginBottom: 24 }}>
          <button className={s.button} disabled={busy} onClick={() => onSelect('new')}>
            新增岗位
          </button>
          {selected && (
            <span className={s.tag}>
              {selected.source_type === 'synthetic' ? '虚构示例' : '已保存岗位'}
            </span>
          )}
        </div>
        <div className={s.formGrid}>
          {(
            [
              ['title', '岗位名称'],
              ['company', '公司 / 机构'],
              ['category', '岗位类别'],
              ['city', '城市'],
              ['salary_text', '薪资原文'],
              ['source_url', '来源链接'],
            ] as const
          ).map(([key, label]) => (
            <label className={s.field} key={key}>
              <span>{label}</span>
              <input
                value={job[key]}
                maxLength={key === 'source_url' ? 2000 : 120}
                onChange={(e) => update(key, e.target.value)}
                placeholder={
                  key === 'salary_text'
                    ? '如 180-220元/天'
                    : key === 'category'
                      ? '如 数据分析'
                      : ''
                }
              />
            </label>
          ))}
          <label className={s.field}>
            <span>发布日期（未知可留空）</span>
            <input
              type="date"
              value={job.published_at}
              onChange={(e) => update('published_at', e.target.value)}
            />
          </label>
          <label className={s.field}>
            <span>数据来源类型</span>
            <select value={job.source_type} onChange={(e) => update('source_type', e.target.value)}>
              <option value="manual">人工采集的岗位</option>
              <option value="course">课程提供的岗位</option>
              <option value="synthetic">虚构 / 合成示例</option>
            </select>
          </label>
        </div>
        <label className={s.field}>
          <span>完整 JD 原文</span>
          <textarea
            rows={10}
            maxLength={30000}
            value={job.text}
            onChange={(e) => update('text', e.target.value)}
            placeholder="粘贴岗位职责、技能要求、学历和到岗要求。保留原文以便校对引用。"
          />
        </label>
        <button
          className={s.button}
          disabled={busy || !job.text.trim()}
          onClick={() =>
            void run('抽取岗位要求', async () => {
              setRequirements((await careerApi.parseJob(job.text, useAi)).requirements);
              onDirty();
            })
          }
        >
          {useAi ? 'AI 抽取岗位要求' : '规则抽取岗位要求'}
        </button>
        <section className={s.section}>
          <h2>要求校对</h2>
          <p className={s.muted}>
            普通要求权重为 2，“优先 / 加分”权重为 1。每项要求保留一段 JD 原文作为依据。
          </p>
          {requirements === undefined ? (
            <p className={s.note} style={{ marginTop: 16 }}>
              先抽取要求再校对。直接保存时会按规则提取；修改 JD 后需重新校对。
            </p>
          ) : (
            <>
              {requirements.length === 0 && (
                <p className={s.note}>没有识别到有效要求，可以手动添加。</p>
              )}
              {requirements.map((item, i) => (
                <div className={s.requirement} key={item.id}>
                  <input
                    aria-label={`要求 ${i + 1} 名称`}
                    value={item.name}
                    maxLength={100}
                    onChange={(e) => changeRequirement(i, { name: e.target.value })}
                  />
                  <select
                    aria-label={`要求 ${i + 1} 重要程度`}
                    value={item.priority}
                    onChange={(e) =>
                      changeRequirement(i, { priority: e.target.value as Requirement['priority'] })
                    }
                  >
                    <option value="required">普通</option>
                    <option value="preferred">优先</option>
                  </select>
                  <button
                    className={s.button}
                    onClick={() => {
                      setRequirements((items) => items?.filter((_, index) => index !== i));
                      onDirty();
                    }}
                  >
                    移除
                  </button>
                  <label className={`${s.field} ${s.full}`} style={{ marginBottom: 0 }}>
                    <span>JD 原文引用</span>
                    <input
                      aria-label={`要求 ${i + 1} 原文`}
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
            手动添加一项要求
          </button>
        </section>
        <div className={s.actions} style={{ marginTop: 32 }}>
          <button
            className={`${s.button} ${s.primary}`}
            disabled={busy || !job.title.trim() || !job.text.trim()}
            onClick={() =>
              void run('保存岗位', async () => {
                const saved = await careerApi.saveJob(
                  { ...job, published_at: job.published_at || null, requirements },
                  selected?.job_id
                );
                setRequirements(saved.requirements);
                await onSaved(saved);
              })
            }
          >
            保存岗位与要求
          </button>
          {selected && (
            <button className={s.button} disabled={busy} onClick={onNext}>
              下一步：查看诊断 →
            </button>
          )}
          {selected && (
            <button
              className={`${s.button} ${s.danger}`}
              disabled={busy}
              onClick={() => {
                if (window.confirm('删除岗位及其关联诊断和建议？简历版本会保留。'))
                  void run('删除岗位', async () => {
                    await careerApi.deleteJob(selected.job_id);
                    await onDeleted();
                  });
              }}
            >
              删除岗位
            </button>
          )}
        </div>
      </div>
      <aside>
        <h3>岗位库 · {jobs.length}</h3>
        <div className={s.jobList}>
          {jobs.map((item) => (
            <button
              key={item.job_id}
              disabled={busy}
              aria-pressed={selected?.job_id === item.job_id}
              onClick={() => onSelect(item.job_id)}
            >
              <strong>{item.title || '未命名岗位'}</strong>
              <span className={s.muted}>
                {item.city || '城市未知'} · {item.category || '其他'}
                <br />
                {item.salary_text || '薪资未披露'}
              </span>
              {item.source_type === 'synthetic' && (
                <p>
                  <span className={s.tag}>虚构示例</span>
                </p>
              )}
            </button>
          ))}
        </div>
        <p className={s.muted} style={{ marginTop: 24 }}>
          同一机构的重复 JD 只计入一次市场样本。来源链接和日期用于复核。
        </p>
      </aside>
    </div>
  );
}

'use client';

import { useState } from 'react';
import {
  careerApi,
  saveJson,
  type CareerState,
  type Evidence,
  type EvidenceStatus,
  type Match,
  type MatchDetail,
  type Rewrite,
} from '@/lib/api/career';
import type { RunAction } from './workspace';
import s from './workspace.module.css';

const labels: Record<EvidenceStatus, string> = {
  supported: '有具体证据',
  mentioned: '仅有提及',
  pending: '待补充确认',
  gap: '本人确认缺口',
};
const conditionLabels: Record<string, string> = {
  met: '材料符合',
  unmet: '材料未满足',
  unknown: '需要确认',
  not_stated: 'JD 未明确',
};
const scoreText = (score: number | null) => (score === null ? '—' : score.toFixed(1));

interface Props {
  state: CareerState;
  resumeId: string;
  jobId: string;
  setResumeId: (id: string) => void;
  setJobId: (id: string) => void;
  busy: boolean;
  useAi: boolean;
  run: RunAction;
  refresh: () => Promise<void>;
  onResume: (id: string) => void;
}
export function MatchPanel({
  state,
  resumeId,
  jobId,
  setResumeId,
  setJobId,
  busy,
  useAi,
  run,
  refresh,
  onResume,
}: Props) {
  const [match, setMatch] = useState<Match | null>(null);
  const valid =
    state.resumes.some((r) => r.id === resumeId) && state.jobs.some((j) => j.job_id === jobId);
  return (
    <>
      <div className={s.toolbar}>
        <label className={s.field}>
          <span>选择已保存的简历</span>
          <select
            value={resumeId}
            disabled={busy}
            onChange={(e) => {
              setResumeId(e.target.value);
              setMatch(null);
            }}
          >
            <option value="">请选择</option>
            {state.resumes.map((r) => (
              <option key={r.id} value={r.id}>
                {r.title}
              </option>
            ))}
          </select>
        </label>
        <label className={s.field}>
          <span>选择目标岗位</span>
          <select
            value={jobId}
            disabled={busy}
            onChange={(e) => {
              setJobId(e.target.value);
              setMatch(null);
            }}
          >
            <option value="">请选择</option>
            {state.jobs.map((j) => (
              <option key={j.job_id} value={j.job_id}>
                {j.title || '未命名'} · {j.company}
              </option>
            ))}
          </select>
        </label>
        <button
          className={`${s.button} ${s.primary}`}
          disabled={busy || !valid}
          onClick={() =>
            void run('分析要求与证据', async () => {
              setMatch(await careerApi.match(resumeId, jobId));
              await refresh();
            })
          }
        >
          开始诊断
        </button>
      </div>
      <div className={s.actions} style={{ marginBottom: 24 }}>
        <label className={`${s.field} ${s.history}`} style={{ marginBottom: 0 }}>
          <span>历史诊断（保存当时的材料快照）</span>
          <select
            aria-label="历史诊断"
            value={match?.id ?? ''}
            disabled={busy}
            onChange={(e) => {
              const id = e.target.value;
              if (id)
                void run('读取历史诊断', async () => {
                  const value = await careerApi.getMatch(id);
                  setMatch(value);
                  setResumeId(value.resume_id);
                  setJobId(value.job_id);
                });
            }}
          >
            <option value="">选择历史记录</option>
            {state.matches.map((m) => (
              <option key={m.id} value={m.id}>
                {new Date(m.created_at).toLocaleString('zh-CN')} ·{' '}
                {state.jobs.find((j) => j.job_id === m.job_id)?.title} · {scoreText(m.score)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {!match ? (
        <div className={s.empty}>
          <h2>先诊断，再优化。</h2>
          <p>
            选择一份已保存简历与一个岗位。系统逐项列出原文证据、待确认内容及条件要求，便于你决定从哪里改起。
          </p>
        </div>
      ) : (
        <>
          {match.stale && (
            <p className={s.note}>
              这是一份历史快照，原简历或岗位已修改。可以回看原记录；采纳新建议前请重新诊断。
            </p>
          )}
          <div className={s.scoreRow}>
            <div>
              <p className={s.eyebrow}>
                {match.job.category || '目标岗位'} / {match.job.city || '城市未说明'}
              </p>
              <h2 style={{ marginTop: 12, marginBottom: 12 }}>{match.job.title || '岗位诊断'}</h2>
              <p className={s.muted}>
                {match.score === null
                  ? '信息不足：尚无有效岗位要求，请返回岗位页补充并校对。'
                  : '这个分数衡量当前简历材料对岗位要求的支持程度。待确认项表示材料证据不足，需要你核实。'}
              </p>
              <p className={s.muted}>
                快照：{new Date(match.created_at).toLocaleString('zh-CN')} · {match.rule_version}
              </p>
            </div>
            <div className={s.score}>
              {scoreText(match.score)}
              <small>材料覆盖度 / 100</small>
            </div>
          </div>
          <div className={s.actions} style={{ marginBottom: 20 }}>
            {Object.entries(labels).map(([key, label]) => (
              <span key={key} className={s.stateTag} data-state={key}>
                {label}
              </span>
            ))}
          </div>
          <div className={s.tableWrap}>
            <table className={s.table}>
              <thead>
                <tr>
                  <th>岗位要求 / 权重</th>
                  <th>证据与判断</th>
                  <th>贡献分</th>
                </tr>
              </thead>
              <tbody>
                {match.details.map((item) => (
                  <tr key={item.id}>
                    <td style={{ width: '23%' }}>
                      <strong>{item.name}</strong>
                      <p className={s.muted}>
                        {item.priority === 'preferred' ? '优先 / 加分' : '普通要求'} · 权重{' '}
                        {item.weight}
                      </p>
                      <details>
                        <summary>查看 JD 原文</summary>
                        <blockquote className={s.evidence}>{item.source_text}</blockquote>
                      </details>
                    </td>
                    <td>
                      <span className={s.stateTag} data-state={item.status}>
                        {labels[item.status]}
                      </span>
                      <p className={s.muted}>{item.reason}</p>
                      {item.evidence_ids.map((id) => {
                        const evidence = match.evidence.find((e) => e.id === id);
                        return evidence ? (
                          <blockquote key={id} className={s.evidence}>
                            <strong>{evidence.title}</strong>
                            <br />
                            {evidence.text}
                          </blockquote>
                        ) : null;
                      })}
                      <details>
                        <summary>核对 / 修正此项</summary>
                        <ReviewControl
                          key={`${match.id}:${item.id}`}
                          item={item}
                          evidence={match.evidence}
                          busy={busy}
                          onSave={(status, ids) =>
                            void run('保存核对结果', async () => {
                              setMatch(await careerApi.review(match.id, item.id, status, ids));
                              await refresh();
                            })
                          }
                        />
                      </details>
                    </td>
                    <td>
                      <strong>{item.contribution.toFixed(1)}</strong>
                      <p className={s.muted}>支持系数 {item.value}</p>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <details>
            <summary>评分口径与导出</summary>
            <p className={s.muted}>
              覆盖度 = 100 × Σ（权重 × 支持系数）/ Σ 权重。具体应用记 1，仅提及记
              0.5，待确认或本人确认缺口记
              0；最终总分统一保留一位小数。普通要求不会自动等同于硬性门槛。评分不表示实际能力或录用概率。
            </p>
            <button
              className={s.button}
              style={{ marginTop: 16 }}
              onClick={() => saveJson(match, `CareerLens-诊断-${match.id.slice(0, 8)}.json`)}
            >
              导出含证据的诊断 JSON
            </button>
          </details>
          <section className={s.section}>
            <h2>单独核对的条件</h2>
            <div className={s.conditions}>
              {match.conditions.map((item) => (
                <div className={s.condition} key={item.name}>
                  <h3>{item.name}</h3>
                  <span className={s.tag}>{conditionLabels[item.status] || item.status}</span>
                  <p>{item.requirement}</p>
                  <p className={s.muted}>{item.observed}</p>
                </div>
              ))}
            </div>
          </section>
          <RewritePanel
            key={match.id}
            match={match}
            busy={busy}
            useAi={useAi}
            run={run}
            refresh={refresh}
            onResume={onResume}
          />
        </>
      )}
    </>
  );
}

function ReviewControl({
  item,
  evidence,
  busy,
  onSave,
}: {
  item: MatchDetail;
  evidence: Evidence[];
  busy: boolean;
  onSave: (status: EvidenceStatus, ids: string[]) => void;
}) {
  const [status, setStatus] = useState(item.status);
  const [ids, setIds] = useState(item.evidence_ids);
  const needsEvidence = status === 'supported' || status === 'mentioned';
  return (
    <div className={s.review}>
      <label className={s.field}>
        <span>核对后的状态</span>
        <select value={status} onChange={(e) => setStatus(e.target.value as EvidenceStatus)}>
          {Object.entries(labels).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
      </label>
      {needsEvidence &&
        evidence.map((e) => (
          <label className={s.check} key={e.id}>
            <input
              type="checkbox"
              checked={ids.includes(e.id)}
              onChange={(event) =>
                setIds((previous) =>
                  event.target.checked ? [...previous, e.id] : previous.filter((id) => id !== e.id)
                )
              }
            />
            <span>
              {e.title}：{e.text}
            </span>
          </label>
        ))}
      <button
        className={s.button}
        disabled={busy || (needsEvidence && ids.length === 0)}
        onClick={() => onSave(status, ids)}
      >
        保存为新的诊断记录
      </button>
    </div>
  );
}

function RewritePanel({
  match,
  busy,
  useAi,
  run,
  refresh,
  onResume,
}: {
  match: Match;
  busy: boolean;
  useAi: boolean;
  run: RunAction;
  refresh: () => Promise<void>;
  onResume: (id: string) => void;
}) {
  const eligible = match.evidence.filter((e) => e.kind === 'experience' || e.kind === 'summary');
  const [sectionId, setSectionId] = useState(eligible[0]?.id ?? '');
  const [facts, setFacts] = useState('');
  const [factsConfirmed, setFactsConfirmed] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [draft, setDraft] = useState<Rewrite | null>(match.rewrites?.[0] ?? null);
  const [after, setAfter] = useState<Match | null>(null);
  const beforeText = match.evidence.find((e) => e.id === (draft?.section_id ?? sectionId))?.text;
  return (
    <section className={s.section}>
      <h2>把一段经历写清楚</h2>
      <p className={s.muted}>
        以具体情境、任务、行动和结果组织表达。补充事实须来自你自己的经历；缺失信息会以问题的形式保留。
      </p>
      <div className={s.split} style={{ marginTop: 24 }}>
        <div>
          <label className={s.field}>
            <span>选择需要优化的段落</span>
            <select value={sectionId} onChange={(e) => setSectionId(e.target.value)}>
              <option value="">请选择一段经历</option>
              {eligible.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.title} · {e.text.slice(0, 50)}
                </option>
              ))}
            </select>
          </label>
          <label className={s.field}>
            <span>补充真实事实（每行一项，可留空）</span>
            <textarea
              rows={4}
              value={facts}
              maxLength={8000}
              onChange={(e) => {
                setFacts(e.target.value);
                setFactsConfirmed(false);
              }}
              placeholder="例如：我负责清洗流程中的重复记录检查。请填写实际发生的行动、规模与结果。"
            />
          </label>
          {facts.trim() && (
            <label className={s.check} style={{ marginBottom: 20 }}>
              <input
                type="checkbox"
                checked={factsConfirmed}
                onChange={(e) => setFactsConfirmed(e.target.checked)}
              />
              我确认以上补充来自真实经历，数字和角色准确。
            </label>
          )}
          <button
            className={`${s.button} ${s.primary}`}
            disabled={busy || !sectionId || match.stale || (!!facts.trim() && !factsConfirmed)}
            onClick={() =>
              void run(useAi ? '生成 STAR 建议' : '整理事实草稿', async () => {
                setDraft(
                  await careerApi.rewrite(
                    match.id,
                    sectionId,
                    facts
                      .split('\n')
                      .map((x) => x.trim())
                      .filter(Boolean),
                    useAi
                  )
                );
                setConfirmed(false);
                setAfter(null);
              })
            }
          >
            {useAi ? '生成 STAR 定向建议' : '生成事实整理草稿'}
          </button>
        </div>
        <aside className={s.note}>
          <strong>{useAi ? 'AI 辅助改写' : '当前使用事实整理模式'}</strong>
          <p>
            {useAi
              ? '草稿包含逐句来源引用，并检查新增数字和技能。请核对完整含义后采纳。'
              : '把原文与补充事实整理在一起，方便验证版本流程。开启顶部 AI 辅助后可生成 STAR 改写。'}
          </p>
        </aside>
      </div>
      {!!match.rewrites?.length && (
        <label className={s.field} style={{ marginTop: 24 }}>
          <span>此诊断的历史建议</span>
          <select
            value={draft?.id ?? ''}
            onChange={(e) => {
              setDraft(match.rewrites?.find((r) => r.id === e.target.value) ?? null);
              setConfirmed(false);
              setAfter(null);
            }}
          >
            {draft && !match.rewrites.some((r) => r.id === draft.id) && (
              <option value={draft.id}>刚生成的建议</option>
            )}
            {match.rewrites.map((r) => (
              <option key={r.id} value={r.id}>
                {r.status === 'accepted' ? '已采纳' : r.status === 'rejected' ? '已拒绝' : '待审阅'}{' '}
                · {r.draft.slice(0, 55)}
              </option>
            ))}
          </select>
        </label>
      )}
      {draft && (
        <div className={s.section}>
          <div className={s.actions} style={{ marginBottom: 24 }}>
            <span className={s.tag}>{draft.mode === 'ai' ? 'AI 建议' : '事实整理'}</span>
            <span className={s.tag}>
              {draft.status === 'accepted'
                ? '已采纳'
                : draft.status === 'rejected'
                  ? '已拒绝'
                  : '待你审阅'}
            </span>
          </div>
          <div className={s.compare}>
            <div>
              <h3>原始段落</h3>
              <p className={s.compareText}>{beforeText}</p>
            </div>
            <div>
              <h3>建议正文</h3>
              <p className={s.compareText}>{draft.draft}</p>
            </div>
          </div>
          <p className={s.note} style={{ marginTop: 24 }}>
            {draft.reason}
          </p>
          {!!draft.missing_facts.length && (
            <div style={{ marginTop: 24 }}>
              <h3>可以继续补充的事实</h3>
              {draft.missing_facts.map((question) => (
                <p key={question} className={s.muted}>
                  — {question}
                </p>
              ))}
            </div>
          )}
          <details>
            <summary>逐句核对事实来源</summary>
            <ul className={s.sourceList}>
              {draft.claims.map((claim, i) => (
                <li key={i}>
                  <p>
                    <strong>{claim.text}</strong>
                  </p>
                  {claim.source_ids.map((id) => {
                    const source = draft.sources.find((item) => item.id === id);
                    return (
                      <p className={s.muted} key={id}>
                        {source?.type === 'user' ? '本人补充' : '简历原文'}：{source?.text}
                      </p>
                    );
                  })}
                </li>
              ))}
            </ul>
          </details>
          {draft.status === 'draft' && (
            <>
              <label className={s.check} style={{ margin: '20px 0' }}>
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                我已核对整段内容及引用，确认没有新增或夸大我的经历。
              </label>
              <div className={s.actions}>
                <button
                  className={`${s.button} ${s.primary}`}
                  disabled={busy || !confirmed || match.stale}
                  onClick={() =>
                    void run('采纳并创建定向版', async () => {
                      const result = await careerApi.apply(draft.id);
                      setDraft(result.rewrite);
                      await refresh();
                    })
                  }
                >
                  采纳并生成独立版本
                </button>
                <button
                  className={s.button}
                  disabled={busy}
                  onClick={() =>
                    void run('拒绝建议', async () => setDraft(await careerApi.reject(draft.id)))
                  }
                >
                  拒绝建议
                </button>
              </div>
            </>
          )}
          {draft.status === 'accepted' && draft.result_resume_id && (
            <>
              <div className={s.actions} style={{ marginTop: 24 }}>
                <button className={s.button} onClick={() => onResume(draft.result_resume_id!)}>
                  查看定向版简历 →
                </button>
                <button
                  className={s.button}
                  disabled={busy}
                  onClick={() =>
                    void run('同一岗位复评', async () => {
                      const original = await careerApi.getMatch(match.id);
                      if (original.stale)
                        throw new Error(
                          '原始材料或 JD 已改变，无法直接对比本次覆盖度。请重新诊断。'
                        );
                      setAfter(await careerApi.match(draft.result_resume_id!, match.job_id));
                      await refresh();
                    })
                  }
                >
                  比较修改前后的覆盖度
                </button>
                <button
                  className={s.button}
                  disabled={busy}
                  onClick={() =>
                    void run('导出定向版 PDF', () => careerApi.downloadPdf(draft.result_resume_id!))
                  }
                >
                  导出定向版 PDF
                </button>
              </div>
              {after && (
                <p className={s.note} style={{ marginTop: 20 }}>
                  同一 JD、同一规则：原版 {scoreText(match.score)} → 定向版 {scoreText(after.score)}
                  。表达改善后分数可能保持不变；新增支持分来自可以定位的材料证据。
                </p>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}

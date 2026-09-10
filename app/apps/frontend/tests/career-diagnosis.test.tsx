import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MatchPanel } from '@/components/career/match-panel';
import { RewriteComparison } from '@/components/career/rewrite-comparison';
import {
  careerApi,
  type CareerDirections,
  type CareerState,
  type Match,
  type Rewrite,
} from '@/lib/api/career';

const data = {
  personalInfo: { name: '林同学', title: '', email: '', phone: '', location: '' },
  summary: '访谈用户并整理数据。',
  education: [],
  workExperience: [],
  personalProjects: [],
  additional: { technicalSkills: [], languages: [], certificationsTraining: [], awards: [] },
};
const state: CareerState = {
  resumes: [
    {
      id: 'r1',
      title: '求职简历',
      data,
      hash: 'h1',
      is_master: true,
      parent_id: null,
      source_text: '',
      created_at: '',
      updated_at: '',
    },
  ],
  jobs: [
    {
      job_id: 'j1',
      version: 1,
      title: '用户研究员',
      company: '研究团队',
      content: '独立完成用户访谈。',
      created_at: '',
    },
  ],
  matches: [],
  model: { configured: true, provider: 'openai', model: 'test-model' },
  rule_version: 'career-1.1',
  semantic: { ready: true, model: 'e5', revision: 'v1' },
};
const evidence = [
  { id: 's1', kind: 'summary', title: '个人简介', text: data.summary, source_hash: 's-hash' },
];
const source = {
  mode: 'ai' as const,
  provider: 'openai',
  model: 'test-model',
  analyzed_at: '2026-09-08T09:00:00Z',
};
const references = {
  resume_refs: [{ evidence_id: 's1', quote: '访谈用户并整理数据。' }],
  jd_refs: [{ quote: '独立完成用户访谈。' }],
};
const match: Match = {
  id: 'm1',
  snapshot_id: 'snapshot1',
  resume_id: 'r1',
  resume_hash: 'h1',
  resume_data: data,
  job_id: 'j1',
  job: state.jobs[0],
  evidence,
  score: 50,
  details: [
    {
      id: 'q1',
      name: '用户访谈',
      source_text: state.jobs[0].content,
      priority: 'required',
      status: 'mentioned',
      weight: 1,
      value: 0.5,
      contribution: 50,
      evidence_ids: ['s1'],
      reason: '有访谈经历，独立负责范围待补充。',
    },
  ],
  conditions: [],
  rule_version: 'career-1.1',
  created_at: source.analyzed_at,
  ai_analysis: {
    ...source,
    fit_score: 78,
    summary: '访谈经验与岗位方向一致。',
    strengths: [{ title: '具备用户研究基础', detail: '已有访谈和数据整理实践。', ...references }],
    gaps: [],
    actions: [],
    score_note: '依据当前简历与岗位要求综合判断。',
  },
};
const directions: CareerDirections = {
  ...source,
  resume_id: 'r1',
  resume_hash: 'h1',
  evidence,
  summary: '适合从研究支持岗位切入。',
  directions: [
    {
      title: '用户研究方向',
      reason: '已有访谈与数据处理经验。',
      resume_refs: references.resume_refs,
      next_steps: ['补充访谈方法和产出。'],
    },
  ],
  saved_jobs: [
    {
      job_id: 'j1',
      title: '用户研究员',
      company: '研究团队',
      source_url: 'https://example.com/job',
      reason: '已有经历与访谈任务相关。',
      ...references,
    },
  ],
  scope_note: '',
};
const rewrite: Rewrite = {
  id: 'w1',
  match_id: 'm1',
  section_id: 's1',
  draft: '访谈用户，提炼需求并整理研究数据。',
  reason: '将研究动作与产出关系写得更清楚。',
  missing_facts: [],
  ...source,
  model: { provider: 'openai', model: 'rewrite-model', configured: true },
  status: 'draft',
  result_resume_id: null,
  claims: [{ text: '提炼需求并整理研究数据。', source_ids: ['s1'] }],
  sources: [{ id: 's1', text: data.summary, type: 'resume' }],
};
const run = async (_message: string, task: () => Promise<unknown>) => {
  await task();
};
const props = {
  state,
  resumeId: 'r1',
  jobId: 'j1',
  setResumeId: vi.fn(),
  setJobId: vi.fn(),
  busy: false,
  useAi: true,
  run,
  refresh: async () => {},
  onResume: vi.fn(),
};
afterEach(() => vi.restoreAllMocks());

describe('CareerLens diagnosis actions and sources', () => {
  it('shows sourced STAR gaps and returns to the same passage without losing supplied facts', async () => {
    vi.spyOn(careerApi, 'match').mockResolvedValue({
      ...match,
      rewrites: [
        {
          ...rewrite,
          star: [
            { stage: 'S', evidence: '', question: '这次访谈要了解什么问题？', source_ids: [] },
            { stage: 'T', evidence: '', question: '你负责哪一部分研究？', source_ids: [] },
            { stage: 'A', evidence: '访谈用户并整理数据。', question: '', source_ids: ['s1'] },
            { stage: 'R', evidence: '', question: '最终交付了什么材料？', source_ids: [] },
          ],
          keyword_suggestions: [{ keyword: '用户访谈', suggestion: '说明你实际采用的访谈方法。' }],
          quantification_suggestions: ['一共访谈了多少位用户？'],
          missing_facts: ['一共访谈了多少位用户？', '最终交付了什么材料？'],
        },
      ],
    });
    render(<MatchPanel {...props} />);
    fireEvent.click(screen.getByRole('button', { name: '分析目标 JD 匹配度' }));
    const guidance = await screen.findByRole('region', { name: 'STAR 与岗位表达建议' });
    expect(within(guidance).getAllByText('待补充')).toHaveLength(3);
    expect(within(guidance).getByText('已有依据')).toBeVisible();
    expect(within(guidance).getAllByText('最终交付了什么材料？')).toHaveLength(1);
    expect(within(guidance).getAllByText('一共访谈了多少位用户？')).toHaveLength(1);
    expect(within(guidance).getByText('说明你实际采用的访谈方法。')).toBeVisible();
    const facts = screen.getByLabelText('补充信息（每行一项，可留空）');
    fireEvent.change(facts, { target: { value: '访谈了5位用户。' } });
    fireEvent.click(screen.getByRole('button', { name: '补充这些信息' }));
    expect(facts).toHaveFocus();
    expect(facts).toHaveValue('访谈了5位用户。');
    expect(screen.getByLabelText('选择需要优化的段落')).toHaveValue('s1');
  });

  it('explains which resume to choose and prevents analysis of an unsaved draft', () => {
    const analyze = vi.spyOn(careerApi, 'match');
    render(<MatchPanel {...props} resumeId="new" />);
    expect(screen.getByLabelText('选择已保存的简历')).toHaveValue('');
    expect(screen.getByLabelText('选择已保存的简历')).toHaveAccessibleDescription(
      '请先选择本次要分析的简历。'
    );
    fireEvent.click(screen.getByRole('button', { name: '分析目标 JD 匹配度' }));
    expect(analyze).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '分析适合的岗位方向' })).toBeDisabled();
  });

  it('takes an empty workspace to resume creation before diagnosis', () => {
    const onResume = vi.fn();
    render(
      <MatchPanel {...props} state={{ ...state, resumes: [] }} resumeId="new" onResume={onResume} />
    );
    expect(screen.getByRole('status')).toHaveTextContent('请先保存一份简历，再进行诊断与优化。');
    fireEvent.click(screen.getByRole('button', { name: '创建第一份简历' }));
    expect(onResume).toHaveBeenCalledWith('new');
  });

  it('analyzes directions without a JD and shows saved-job recommendations separately', async () => {
    const analyze = vi.spyOn(careerApi, 'directions').mockResolvedValue(directions);
    const diagnose = vi.spyOn(careerApi, 'match').mockResolvedValue(match);
    const findJobs = vi.fn();
    const { container } = render(<MatchPanel {...props} jobId="" onFindJobs={findJobs} />);
    expect(container.querySelector('details summary')).toHaveTextContent('岗位方向分析历史');
    expect(screen.getByRole('heading', { name: '诊断选项' })).toBeVisible();
    expect(screen.getByRole('heading', { name: '多岗位横向比较' })).toBeVisible();
    expect(screen.getByLabelText('历史诊断')).toBeVisible();
    expect(screen.getByRole('button', { name: '分析目标 JD 匹配度' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '分析适合的岗位方向' }));
    await waitFor(() => expect(analyze).toHaveBeenCalledWith('r1', true));
    expect(await screen.findByRole('heading', { name: '适合的岗位方向' })).toBeVisible();
    expect(screen.getByRole('heading', { name: '已保存岗位推荐' })).toBeVisible();
    expect(screen.getByText('以下岗位来自已保存的 JD，招聘状态以原岗位页面为准。')).toBeVisible();
    expect(screen.getByText('补充访谈方法和产出。')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '查找相关实时岗位' }));
    expect(findJobs).toHaveBeenCalledWith('用户研究方向');
    fireEvent.click(screen.getByRole('button', { name: '推荐已保存岗位' }));
    await waitFor(() => expect(analyze).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: '分析此岗位匹配度' }));
    await waitFor(() => expect(diagnose).toHaveBeenCalledWith('r1', 'j1', true, true));
  });

  it('passes AI and semantic choices and exposes the evidence, model, time and rewrite changes', async () => {
    const diagnose = vi.spyOn(careerApi, 'match').mockResolvedValue(match);
    const revise = vi.spyOn(careerApi, 'rewrite').mockResolvedValue(rewrite);
    const { container } = render(<MatchPanel {...props} />);
    fireEvent.click(
      screen.getByRole('checkbox', { name: '查找语义相关的经历（辅助 JD 匹配与比较）' })
    );
    fireEvent.click(screen.getByRole('button', { name: '分析目标 JD 匹配度' }));
    await waitFor(() => expect(diagnose).toHaveBeenCalledWith('r1', 'j1', false, true));
    const analysis = await screen.findByRole('region', { name: 'AI 岗位匹配分析' });
    expect(analysis).toHaveTextContent('78.0');
    expect(analysis).toHaveTextContent('AI 岗位适合度');
    expect(analysis).toHaveTextContent('openai / test-model');
    expect(analysis.querySelector('time')).toHaveAttribute('datetime', source.analyzed_at);
    expect(within(analysis).getByText(data.summary)).toBeVisible();
    expect(within(analysis).getByText(state.jobs[0].content)).toBeVisible();
    expect(screen.getByText('材料覆盖度 / 100')).toBeVisible();
    expect(screen.getByRole('heading', { name: '核对 / 修正此项' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '生成 STAR 定向建议' }));
    await waitFor(() => expect(revise).toHaveBeenCalledWith('m1', 's1', [], true));
    expect(await screen.findByText(rewrite.reason)).toBeVisible();
    expect(screen.getByText('openai / rewrite-model')).toBeVisible();
    expect(screen.getByRole('region', { name: '改写前' }).querySelector('del')).not.toBeNull();
    expect(screen.getByRole('region', { name: '改写后' }).querySelector('ins')).not.toBeNull();
    expect(screen.getByRole('heading', { name: '修改建议的参考材料' })).toBeVisible();
    expect(screen.getByText(`简历原文：${data.summary}`)).toBeVisible();
    expect(container.querySelector('details summary')).toHaveTextContent('岗位方向分析历史');
  });

  it('respects an explicitly disabled AI switch and identifies rule results', async () => {
    const diagnose = vi
      .spyOn(careerApi, 'match')
      .mockResolvedValue({ ...match, ai_analysis: undefined });
    render(<MatchPanel {...props} useAi={false} />);
    expect(screen.getByRole('button', { name: '分析适合的岗位方向' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '推荐已保存岗位' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '分析目标 JD 匹配度' }));
    await waitFor(() => expect(diagnose).toHaveBeenCalledWith('r1', 'j1', true, false));
    expect(await screen.findByText('规则分析')).toBeVisible();
    expect(screen.queryByText('AI 岗位适合度')).not.toBeInTheDocument();
  });

  it('shows when a rewrite has no substantive change', () => {
    const { container } = render(
      <RewriteComparison before="完成用户访谈。" after={'完成用户访谈。\n'} />
    );
    expect(screen.getByText('本次正文与原文基本一致，尚无实质改写。')).toBeVisible();
    expect(container.querySelector('ins, del')).toBeNull();
  });

  it('identifies very small edits while keeping the changed text visible', () => {
    const before = '访谈用户并整理研究资料，'.repeat(8) + '完成研究。';
    const { container } = render(
      <RewriteComparison before={before} after={before.replace('完成研究。', '完成调研。')} />
    );
    expect(screen.getByText('本次改动较少，主要调整了局部文字。')).toBeVisible();
    expect(container.querySelector('del')).toHaveTextContent('研究');
    expect(container.querySelector('ins')).toHaveTextContent('调研');
  });

  it('sends AI intent in every diagnosis API payload', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response('{}', { status: 200 }));
    await careerApi.match('r1', 'j1', false, true);
    await careerApi.compare('r1', ['j1', 'j2'], true, true);
    await careerApi.directions('r1', true);
    expect(fetch.mock.calls.map((call) => JSON.parse(call[1]?.body as string))).toEqual([
      { resume_id: 'r1', job_id: 'j1', use_semantic: false, use_ai: true },
      { resume_id: 'r1', job_ids: ['j1', 'j2'], use_semantic: true, use_ai: true },
      { resume_id: 'r1', use_ai: true },
    ]);
  });
});

it('loads a saved direction analysis after its source resume has been deleted', async () => {
  vi.spyOn(careerApi, 'directionHistory').mockResolvedValue([
    {
      id: 'history-1',
      resume_id: 'deleted',
      resume_title: '历史简历',
      summary: '旧方向记录',
      created_at: source.analyzed_at,
    },
  ]);
  vi.spyOn(careerApi, 'getDirectionHistory').mockResolvedValue({
    ...directions,
    resume_id: 'deleted',
    history_id: 'history-1',
    created_at: source.analyzed_at,
  });
  const { container } = render(
    <MatchPanel {...props} state={{ ...state, resumes: [] }} resumeId="" />
  );
  const detail = container.querySelector('details')!;
  detail.open = true;
  fireEvent(detail, new Event('toggle'));
  fireEvent.click(await screen.findByRole('button', { name: '查看这次方向分析' }));
  expect(await screen.findByRole('heading', { name: '适合的岗位方向' })).toBeVisible();
  expect(screen.getByText('用户研究方向')).toBeVisible();
  expect(props.setResumeId).toHaveBeenCalledWith('');
});

vi.mock('@/lib/context/language-context', () => ({
  useLanguage: () => ({ uiLanguage: 'zh', accountProfile: null }),
}));

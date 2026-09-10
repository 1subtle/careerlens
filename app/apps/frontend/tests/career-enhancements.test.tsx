import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComparePanel } from '@/components/career/compare-panel';
import { MatchPanel } from '@/components/career/match-panel';
import { careerApi, type CareerState, type Match } from '@/lib/api/career';
import * as careerModule from '@/lib/api/career';

const data = {
  personalInfo: { name: '林同学', title: '', email: '', phone: '', location: '' },
  summary: '',
  education: [],
  workExperience: [],
  personalProjects: [],
  additional: { technicalSkills: [], languages: [], certificationsTraining: [], awards: [] },
};
const state: CareerState = {
  resumes: [
    {
      id: 'r1',
      title: '基础简历',
      data,
      hash: 'edit-hash',
      is_master: true,
      parent_id: null,
      source_text: '简历原文',
      created_at: '',
      updated_at: '',
    },
  ],
  jobs: Array.from({ length: 6 }, (_, i) => ({
    job_id: `j${i}`,
    version: 1,
    title: `岗位 ${i}`,
    company: '示例公司',
    city: '北京',
    content: '需求调研',
    created_at: '2026-09-07',
  })),
  matches: [],
  model: { configured: true, provider: 'mock', model: 'mock' },
  rule_version: 'career-1.1',
  semantic: { ready: true, model: 'e5', revision: 'v1' },
};
const match: Match = {
  id: 'm1',
  snapshot_id: 's1',
  resume_id: 'r1',
  resume_hash: 'snapshot-hash',
  resume_data: data,
  job_id: 'j0',
  job: state.jobs[0],
  evidence: [
    {
      id: 'p1',
      title: '问卷研究',
      text: '访谈用户并整理调研数据。',
      kind: 'experience',
      source_hash: 'e1',
    },
  ],
  details: [
    {
      id: 'q1',
      name: '需求调研',
      source_text: '需求调研',
      priority: 'required',
      status: 'pending',
      weight: 2,
      value: 0,
      contribution: 0,
      evidence_ids: [],
      reason: '需要核对',
      candidates: [{ evidence_id: 'p1', similarity: 0.9 }],
    },
  ],
  score: 0,
  conditions: [
    {
      name: '到岗与实习时长',
      requirement: '每周到岗 3 天',
      observed: '需要本人确认',
      status: 'unknown',
    },
  ],
  rule_version: 'career-1.1',
  created_at: '2026-09-07T10:00:00Z',
  retrieval: { mode: 'vector' },
};
const run = async (_message: string, task: () => Promise<unknown>) => {
  await task();
};
afterEach(() => vi.restoreAllMocks());

describe('CareerLens enhancements', () => {
  it('limits the comparison to five jobs and opens a saved result', async () => {
    const compare = vi.spyOn(careerApi, 'compare').mockResolvedValue({
      resume_id: 'r1',
      resume_hash: 'snapshot-hash',
      snapshot_id: 's1',
      rule_version: 'career-1.1',
      matches: [match, { ...match, id: 'm2', job_id: 'j1', job: state.jobs[1] }],
    });
    vi.spyOn(careerApi, 'getMatch').mockResolvedValue(match);
    const open = vi.fn();
    render(
      <ComparePanel
        state={state}
        resumeId="r1"
        busy={false}
        useSemantic
        useAi
        run={run}
        refresh={async () => {}}
        onOpen={open}
        reviewedMatch={null}
      />
    );
    fireEvent.click(screen.getByText('多岗位横向比较'));
    expect(screen.getByRole('button', { name: '比较所选岗位' })).toBeDisabled();
    const choices = screen.getAllByRole('checkbox');
    for (const choice of choices.slice(0, 5)) fireEvent.click(choice);
    expect(choices[5]).toBeDisabled();
    fireEvent.click(choices[4]);
    expect(choices[5]).not.toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '比较所选岗位' }));
    await waitFor(() =>
      expect(compare).toHaveBeenCalledWith('r1', ['j0', 'j1', 'j2', 'j3'], true, true)
    );
    expect(await screen.findByRole('table')).toHaveTextContent('待确认 1');
    fireEvent.click(screen.getAllByRole('button', { name: '查看证据' })[0]);
    await waitFor(() => expect(open).toHaveBeenCalledWith(match));
  });

  it('shows unscored candidates and persists a condition confirmation', async () => {
    vi.spyOn(careerApi, 'match').mockResolvedValue(match);
    const confirm = vi.spyOn(careerApi, 'confirmCondition').mockResolvedValue({
      ...match,
      id: 'm-confirmed',
      conditions: [
        {
          ...match.conditions[0],
          status: 'met',
          observed: '每周可到岗 4 天',
          confirmed_by: 'user',
        },
      ],
    });
    render(
      <MatchPanel
        state={state}
        resumeId="r1"
        jobId="j0"
        setResumeId={vi.fn()}
        setJobId={vi.fn()}
        busy={false}
        useAi={false}
        run={run}
        refresh={async () => {}}
        onResume={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: '分析目标 JD 匹配度' }));
    expect(await screen.findByText('语义检索找到 1 段待核对经历')).toBeInTheDocument();
    fireEvent.click(screen.getByText('填写 / 更新实际情况'));
    fireEvent.change(screen.getByLabelText('到岗与实习时长：确认状态'), {
      target: { value: 'met' },
    });
    fireEvent.change(screen.getByLabelText('到岗与实习时长：实际情况与依据'), {
      target: { value: '每周可到岗 4 天' },
    });
    fireEvent.click(screen.getByRole('button', { name: '确认并保存条件' }));
    await waitFor(() =>
      expect(confirm).toHaveBeenCalledWith('m1', '到岗与实习时长', 'met', '每周可到岗 4 天')
    );
    expect(await screen.findByText('已由本人确认并保存')).toBeInTheDocument();
  });

  it('keeps a reviewed comparison row when opening another job and exporting', async () => {
    const second: Match = { ...match, id: 'm2', job_id: 'j1', job: state.jobs[1] };
    const reviewed: Match = {
      ...match,
      id: 'm1-reviewed',
      created_at: '2026-09-07T10:01:00Z',
      score: 100,
      details: [
        {
          ...match.details[0],
          status: 'supported',
          value: 1,
          contribution: 100,
          evidence_ids: ['p1'],
        },
      ],
    };
    vi.spyOn(careerApi, 'compare').mockResolvedValue({
      resume_id: 'r1',
      resume_hash: match.resume_hash,
      snapshot_id: 's1',
      rule_version: match.rule_version,
      matches: [match, second],
    });
    const getMatch = vi
      .spyOn(careerApi, 'getMatch')
      .mockImplementation(async (id) =>
        id === reviewed.id ? reviewed : id === second.id ? second : match
      );
    const review = vi.spyOn(careerApi, 'review').mockResolvedValue(reviewed);
    const exported = vi.spyOn(careerModule, 'saveJson').mockImplementation(() => {});
    render(
      <MatchPanel
        state={state}
        resumeId="r1"
        jobId="j0"
        setResumeId={vi.fn()}
        setJobId={vi.fn()}
        busy={false}
        useAi={false}
        run={run}
        refresh={async () => {}}
        onResume={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole('checkbox', { name: /岗位 0/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /岗位 1/ }));
    fireEvent.click(screen.getByRole('button', { name: '比较所选岗位' }));
    const table = await screen.findByRole('region', { name: '多岗位比较结果' });
    fireEvent.click(within(table).getAllByRole('button', { name: '查看证据' })[0]);
    const status = await screen.findByLabelText('核对后的状态');
    fireEvent.change(status, { target: { value: 'supported' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /问卷研究/ }));
    fireEvent.click(screen.getByRole('button', { name: '保存为新的诊断记录' }));
    await waitFor(() => expect(review).toHaveBeenCalledWith('m1', 'q1', 'supported', ['p1']));
    await waitFor(() => expect(within(table).getByText('100.0')).toBeVisible());
    fireEvent.click(within(table).getAllByRole('button', { name: '查看证据' })[1]);
    await waitFor(() => expect(getMatch).toHaveBeenLastCalledWith('m2'));
    await waitFor(() => expect(screen.getByLabelText('核对后的状态')).toHaveValue('pending'));
    expect(within(table).getByText('100.0')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '导出比较结果' }));
    expect(exported).toHaveBeenCalledWith(
      expect.objectContaining({
        matches: [
          expect.objectContaining({ id: 'm1-reviewed', score: 100 }),
          expect.objectContaining({ id: 'm2' }),
        ],
      }),
      'CareerLens-多岗位比较.json'
    );
    fireEvent.click(within(table).getAllByRole('button', { name: '查看证据' })[0]);
    await waitFor(() => expect(getMatch).toHaveBeenLastCalledWith('m1-reviewed'));
  });

  it('sends the selected AI mode with the uploaded file', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ data, source_text: '原文', mode: 'ai' }), { status: 200 })
      );
    await careerApi.parseFile(new File(['原文'], 'resume.txt'), true);
    const body = fetchMock.mock.calls[0][1]?.body as FormData;
    expect(body.get('use_ai')).toBe('true');
    expect(body.get('file')).toBeInstanceOf(File);
  });
});

vi.mock('@/lib/context/language-context', () => ({
  useLanguage: () => ({ uiLanguage: 'zh', accountProfile: null }),
}));

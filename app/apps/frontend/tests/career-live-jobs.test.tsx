import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobsPanel } from '@/components/career/jobs-panel';
import { MarketPanel } from '@/components/career/market-panel';
import { careerApi, type CareerJob, type LiveJob, type LiveJobs } from '@/lib/api/career';

vi.mock('next/dynamic', () => ({
  default: () =>
    function Charts() {
      return <div data-testid="market-charts">本页统计图表</div>;
    },
}));

const completeJob: LiveJob = {
  job_id: 'live-1001',
  external_id: '1001',
  title: '数据分析实习生',
  company: 'Canonical',
  city: 'APAC',
  category: '数据分析',
  source_type: 'api',
  source_name: '国家大学生就业服务平台',
  source_url: 'https://www.ncss.cn/student/jobs/1001.html',
  source_updated_at: '2026-09-08',
  content: '岗位职责：分析业务指标。\n任职要求：熟悉 SQL，能够独立完成数据分析。',
  description_complete: true,
  created_at: '2026-09-08T08:00:00Z',
};
const incompleteJob: LiveJob = {
  ...completeJob,
  job_id: 'live-1002',
  external_id: '1002',
  title: '产品实习生',
  content: '仅取到岗位职责概要。',
  description_complete: false,
};
const liveResult: LiveJobs = {
  provider: 'ncss',
  source_name: '国家大学生就业服务平台',
  source_url: 'https://www.ncss.cn/student/jobs/index.html',
  total_kind: 'sample',
  coverage: '中国大陆 · 多雇主 · 高校毕业生就业',
  update_note: '同一查询缓存一小时，最多返回200条岗位。',
  cached: false,
  fetched_at: '2026-09-08T08:00:00Z',
  total: 32,
  page: 1,
  page_size: 10,
  jobs: [completeJob, incompleteJob],
  summary: {
    count: 1,
    demo_count: 0,
    salary_missing: 1,
    dataset_hash: 'live-sample',
    date: '2026-09-08',
    filters: { category: '', city: '', since: null, include_demo: false },
    job_ids: [completeJob.job_id],
    skills: [{ name: 'SQL', value: 1, job_ids: [completeJob.job_id] }],
    salaries: [],
    distribution: [],
  },
  warnings: [],
};
const run = async (_message: string, task: () => Promise<void>) => task();

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network request'));
});
afterEach(() => vi.restoreAllMocks());

describe('live jobs and remembered JD', () => {
  it('searches a recommended direction in the domestic source and respects the last public page', async () => {
    const liveJobs = vi.spyOn(careerApi, 'liveJobs').mockResolvedValue({
      ...liveResult,
      total: 100,
      total_kind: 'capped',
      has_more: false,
    });
    render(
      <MarketPanel
        jobs={[]}
        initialKeyword="数据分析"
        busy={false}
        useAi={true}
        run={run}
        onJob={vi.fn()}
      />
    );
    await screen.findByText(completeJob.title!);
    expect(screen.getByLabelText('想找什么岗位？')).toHaveValue('数据分析');
    expect(liveJobs).toHaveBeenCalledExactlyOnceWith('数据分析', 1, 'ncss', '');
    expect(screen.getByText('公开检索结果')).toHaveTextContent('100');
    expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled();
  });

  it('loads the first page and separates source totals from collapsed JD samples and charts', async () => {
    const liveJobs = vi.spyOn(careerApi, 'liveJobs').mockResolvedValue(liveResult);
    const remember = vi.spyOn(careerApi, 'rememberLiveJob');
    render(<MarketPanel jobs={[]} busy={false} useAi={false} run={run} onJob={vi.fn()} />);

    await screen.findByText(completeJob.title!);
    expect(liveJobs).toHaveBeenCalledWith('', 1, 'ncss', '');
    expect(screen.getByLabelText('招聘来源')).toHaveValue('ncss');
    expect(
      screen.getByText('国家大学生就业服务平台 · 中国大陆 · 多雇主 · 高校毕业生就业')
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '查看招聘来源 ↗' })).toHaveAttribute(
      'href',
      liveResult.source_url
    );
    expect(screen.getByText('本次返回岗位')).toHaveTextContent('32');
    expect(screen.getByText('本页完整 JD 样本')).toHaveTextContent('1');
    expect(screen.getByText(completeJob.title!).closest('details')).not.toHaveAttribute('open');
    expect(screen.getByText(incompleteJob.title!).closest('details')).not.toHaveAttribute('open');
    expect(
      screen.getByText('查看本页岗位的技能与薪资统计 · 1 份完整 JD').closest('details')
    ).not.toHaveAttribute('open');
    expect(screen.queryByTestId('market-charts')).not.toBeInTheDocument();
    expect(screen.queryByText(/统计仅覆盖本页完整 JD/)).not.toBeInTheDocument();
    expect(screen.queryByText(liveResult.update_note)).not.toBeInTheDocument();
    expect(remember).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('remembers the expanded complete JD and waits for workspace navigation', async () => {
    vi.spyOn(careerApi, 'liveJobs').mockResolvedValue(liveResult);
    const saved = { ...completeJob, job_id: 'saved-1001', version: 1 };
    const remember = vi.spyOn(careerApi, 'rememberLiveJob').mockResolvedValue(saved);
    let finishNavigation!: () => void;
    const navigation = new Promise<void>((resolve) => {
      finishNavigation = resolve;
    });
    const onJob = vi.fn(() => navigation);
    const completed = vi.fn();
    const trackedRun = async (_message: string, task: () => Promise<void>) => {
      await task();
      completed();
    };
    render(<MarketPanel jobs={[]} busy={false} useAi={false} run={trackedRun} onJob={onJob} />);

    const title = await screen.findByText(completeJob.title!);
    fireEvent.click(title.closest('summary')!);
    expect(title.closest('details')).toHaveAttribute('open');
    fireEvent.click(
      within(title.closest('details')!).getByRole('button', { name: '使用并记住这份 JD' })
    );
    await waitFor(() => expect(onJob).toHaveBeenCalledWith('saved-1001'));
    expect(remember).toHaveBeenCalledExactlyOnceWith('1001', 'ncss', '', '');
    expect(completed).not.toHaveBeenCalled();
    await act(async () => {
      finishNavigation();
      await navigation;
    });
    await waitFor(() => expect(completed).toHaveBeenCalledOnce());

    const incompleteTitle = screen.getByText(incompleteJob.title!);
    fireEvent.click(incompleteTitle.closest('summary')!);
    expect(
      within(incompleteTitle.closest('details')!).getByRole('button', { name: '使用并记住这份 JD' })
    ).toBeDisabled();
  });

  it('paginates the submitted query while preserving a different unsubmitted input', async () => {
    const liveJobs = vi
      .spyOn(careerApi, 'liveJobs')
      .mockImplementation(async (_query, page = 1) => ({
        ...liveResult,
        page,
      }));
    render(<MarketPanel jobs={[]} busy={false} useAi={false} run={run} onJob={vi.fn()} />);
    await screen.findByText(completeJob.title!);
    const input = screen.getByLabelText('想找什么岗位？');
    fireEvent.change(input, { target: { value: 'Python' } });
    fireEvent.click(screen.getByRole('button', { name: '查找岗位' }));
    await waitFor(() => expect(liveJobs).toHaveBeenNthCalledWith(2, 'Python', 1, 'ncss', ''));
    await waitFor(() => expect(screen.getByRole('button', { name: '下一页' })).toBeEnabled());

    fireEvent.change(input, { target: { value: 'Rust' } });
    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    await waitFor(() => expect(liveJobs).toHaveBeenNthCalledWith(3, 'Python', 2, 'ncss', ''));
    expect(input).toHaveValue('Rust');
    expect(liveJobs).not.toHaveBeenCalledWith('Rust', expect.anything());
  });

  it('keeps pagination and remembering tied to the submitted source and region', async () => {
    const liveJobs = vi
      .spyOn(careerApi, 'liveJobs')
      .mockImplementation(async (_query, page = 1, provider = 'ncss') => ({
        ...liveResult,
        page,
        provider,
      }));
    const remember = vi
      .spyOn(careerApi, 'rememberLiveJob')
      .mockResolvedValue({ ...completeJob, version: 1 });
    render(<MarketPanel jobs={[]} busy={false} useAi={false} run={run} onJob={vi.fn()} />);
    await screen.findByText(completeJob.title!);
    fireEvent.change(screen.getByLabelText('招聘来源'), { target: { value: 'jobicy' } });
    fireEvent.change(screen.getByLabelText('远程适用地区'), { target: { value: 'china' } });
    fireEvent.click(screen.getByRole('button', { name: '查找岗位' }));
    await waitFor(() => expect(liveJobs).toHaveBeenLastCalledWith('', 1, 'jobicy', 'china'));
    await waitFor(() => expect(screen.getByRole('button', { name: '下一页' })).toBeEnabled());
    fireEvent.change(screen.getByLabelText('招聘来源'), { target: { value: 'tencent' } });
    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    await waitFor(() => expect(liveJobs).toHaveBeenLastCalledWith('', 2, 'jobicy', 'china'));
    const title = screen.getByText(completeJob.title!);
    fireEvent.click(title.closest('summary')!);
    fireEvent.click(
      within(title.closest('details')!).getByRole('button', { name: '使用并记住这份 JD' })
    );
    await waitFor(() => expect(remember).toHaveBeenLastCalledWith('1001', 'jobicy', '', 'china'));
    fireEvent.click(screen.getByRole('button', { name: '查找岗位' }));
    await waitFor(() => expect(liveJobs).toHaveBeenLastCalledWith('', 1, 'tencent', ''));
  });

  it('counts multiple employers and does not confuse identical IDs from different sources', async () => {
    const another = {
      ...completeJob,
      external_id: '1003',
      job_id: 'jobicy-1003',
      company: 'ElevenLabs',
      title: 'Software Engineer',
    };
    vi.spyOn(careerApi, 'liveJobs').mockResolvedValue({
      ...liveResult,
      jobs: [completeJob, another],
    });
    render(
      <MarketPanel
        jobs={[{ ...completeJob, source_name: '腾讯招聘', version: 1 }]}
        busy={false}
        useAi={false}
        run={run}
        onJob={vi.fn()}
      />
    );
    const title = await screen.findByText(completeJob.title!);
    expect(screen.getByText('本页雇主')).toHaveTextContent('2');
    expect(title.closest('summary')).not.toHaveTextContent('已记住');
    expect(screen.getByText('Software Engineer')).toBeInTheDocument();
  });

  it('shows all JD information directly, saves the original text, and refills a remembered JD', async () => {
    const remembered: CareerJob = { ...completeJob, job_id: 'remembered', version: 1 };
    const saved = {
      ...remembered,
      job_id: 'new-jd',
      title: '测试工程师',
      content: '熟悉自动化测试。',
    };
    const save = vi
      .spyOn(careerApi, 'saveJob')
      .mockResolvedValueOnce(saved)
      .mockResolvedValue(remembered);
    const props = {
      jobs: [remembered],
      busy: false,
      useAi: false,
      run,
      onDirty: vi.fn(),
      onSelect: vi.fn(),
      onSaved: vi.fn(async () => {}),
      onDeleted: vi.fn(async () => {}),
      onNext: vi.fn(),
    };
    const { container, rerender } = render(<JobsPanel {...props} />);
    for (const label of ['补充公司、地点与来源（选填）', '提取与校对岗位要求', '最近使用的 JD']) {
      expect(screen.getByRole('heading', { name: label })).toBeVisible();
    }
    expect(container.querySelector('details')).toBeNull();
    expect(screen.getByLabelText('公司 / 机构')).toBeVisible();
    expect(screen.getByLabelText('来源类型')).toBeVisible();
    expect(screen.getByRole('button', { name: '规则抽取岗位要求' })).toBeVisible();
    expect(screen.getByRole('button', { name: '手动添加一项要求' })).toBeVisible();
    expect(screen.getByRole('button', { name: /数据分析实习生/ })).toBeVisible();
    expect(screen.getByRole('button', { name: '记住这份 JD' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('粘贴 JD 原文（必填）'), {
      target: { value: saved.content },
    });
    fireEvent.change(screen.getByLabelText('岗位名称（必填）'), { target: { value: saved.title } });
    fireEvent.click(screen.getByRole('button', { name: '记住这份 JD' }));
    await waitFor(() => expect(props.onSaved).toHaveBeenCalledWith(saved));
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        title: saved.title,
        text: saved.content,
        source_type: 'manual',
        source_name: '',
        source_updated_at: null,
        external_id: '',
      }),
      undefined
    );

    fireEvent.click(screen.getByRole('button', { name: /数据分析实习生/ }));
    expect(props.onSelect).toHaveBeenCalledWith('remembered');
    rerender(<JobsPanel key={remembered.job_id} {...props} selected={remembered} />);
    expect(screen.getByLabelText('粘贴 JD 原文（必填）')).toHaveValue(remembered.content);
    expect(screen.getByLabelText('岗位名称（必填）')).toHaveValue(remembered.title);
    expect(screen.getByLabelText('来源类型')).toHaveValue('api');
    expect(screen.getByRole('button', { name: '删除这份 JD' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '记住这份 JD' }));
    await waitFor(() =>
      expect(save).toHaveBeenLastCalledWith(
        expect.objectContaining({
          source_type: 'api',
          source_name: remembered.source_name,
          source_updated_at: remembered.source_updated_at,
          external_id: remembered.external_id,
        }),
        'remembered'
      )
    );
    fireEvent.click(screen.getByRole('button', { name: '用这份 JD 诊断 →' }));
    expect(props.onNext).toHaveBeenCalledOnce();
  });

  it('sends only complete descriptions to analysis and maps their content to text', async () => {
    const fetchMock = vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          summary: liveResult.summary,
          points: [],
          advice: '',
          mode: 'rules',
          job_ids: [completeJob.job_id],
        }),
        { status: 200 }
      )
    );
    await careerApi.analyzeLiveJobs([completeJob, incompleteJob], '需要哪些技能？', true);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/career/live/analyze');
    const body = JSON.parse(options?.body as string);
    expect(body).toEqual(expect.objectContaining({ question: '需要哪些技能？', use_ai: true }));
    expect(body.jobs).toHaveLength(1);
    expect(body.jobs[0]).toEqual(
      expect.objectContaining({ external_id: '1001', text: completeJob.content })
    );
    expect(body.jobs[0]).not.toHaveProperty('content');
    expect(body.jobs[0]).not.toHaveProperty('description_complete');
  });
});

it('retains edits on a JD conflict and retries only after reviewing the latest version', async () => {
  const { CareerApiError } = await import('@/lib/api/career');
  const saved: CareerJob = { ...completeJob, version: 1 };
  const newer: CareerJob = { ...saved, title: '另一页面的标题', version: 2 };
  const save = vi
    .spyOn(careerApi, 'saveJob')
    .mockRejectedValueOnce(new CareerApiError('JD 已更新', 409))
    .mockResolvedValueOnce({ ...saved, title: '我的编辑', version: 3 });
  vi.spyOn(careerApi, 'getJob').mockResolvedValue(newer);
  render(
    <JobsPanel
      jobs={[saved]}
      selected={saved}
      busy={false}
      useAi={false}
      run={async (_label, task) => {
        try {
          await task();
        } catch {
          /* workspace presents the error */
        }
      }}
      onDirty={vi.fn()}
      onSelect={vi.fn()}
      onSaved={async () => {}}
      onDeleted={async () => {}}
      onNext={vi.fn()}
    />
  );
  fireEvent.change(screen.getByLabelText('岗位名称（必填）'), { target: { value: '我的编辑' } });
  fireEvent.click(screen.getByRole('button', { name: '记住这份 JD' }));
  expect(await screen.findByRole('region', { name: 'JD 版本冲突' })).toBeVisible();
  expect(screen.getByLabelText('岗位名称（必填）')).toHaveValue('我的编辑');
  expect(screen.getByRole('button', { name: '记住这份 JD' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '查看最新版本，保留当前编辑' }));
  expect(await screen.findByRole('heading', { name: '最新来源与岗位要求' })).toBeVisible();
  fireEvent.click(await screen.findByRole('button', { name: '已合并到当前编辑，继续保存' }));
  fireEvent.click(screen.getByRole('button', { name: '记住这份 JD' }));
  await waitFor(() =>
    expect(save).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: '我的编辑', expected_version: 2 }),
      saved.job_id
    )
  );
});

vi.mock('@/lib/context/language-context', () => ({
  useLanguage: () => ({ uiLanguage: 'zh', accountProfile: null }),
}));

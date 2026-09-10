import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SavedMarketPanel } from '@/components/career/saved-market-panel';
import { MarketPanel } from '@/components/career/market-panel';
import {
  careerApi,
  type CareerJob,
  type MarketAnalysis,
  type MarketFilters,
  type MarketSummary,
} from '@/lib/api/career';

vi.mock('@/lib/context/language-context', () => ({
  useLanguage: () => ({ uiLanguage: 'zh', accountProfile: null }),
}));
vi.mock('next/dynamic', () => ({
  default: () =>
    function Charts({ summary }: { summary: MarketSummary }) {
      return <div data-testid="market-charts">图表样本 {summary.count}</div>;
    },
}));

const job: CareerJob = {
  job_id: 'saved-one',
  version: 1,
  title: '数据分析师',
  company: '样本公司',
  category: '数据分析',
  city: '上海',
  source_type: 'manual',
  content: '使用 SQL 分析业务指标。',
  published_at: '2026-09-01',
  created_at: '2026-09-10T02:00:00Z',
};
const other: CareerJob = {
  ...job,
  job_id: 'saved-two',
  category: '产品',
  city: '北京',
  title: '产品经理',
  content: '规划产品。',
  published_at: undefined,
};
const all: MarketFilters = { category: '', city: '', since: null, include_demo: false };
const summary: MarketSummary = {
  count: 1,
  demo_count: 0,
  salary_missing: 1,
  dataset_hash: 'sample',
  date: '2026-09-10',
  filters: all,
  job_ids: [job.job_id],
  skills: [{ name: 'SQL', value: 1, job_ids: [job.job_id] }],
  salaries: [],
  distribution: [
    { category: '数据分析', count: 1, skills: [{ name: 'SQL', count: 1, percent: 100 }] },
  ],
  coverage: {
    sample_count: 2,
    published_count: 1,
    published_missing: 1,
    published_min: '2026-09-01',
    published_max: '2026-09-01',
    date_basis: 'published_at',
    date_excluded_count: 0,
    demo_excluded_count: 0,
    duplicates_removed: 0,
    unknown_category_count: 0,
  },
};
const result: MarketAnalysis = {
  summary,
  points: ['SQL 出现在 1 个岗位中。'],
  advice: '准备一个有数据依据的分析项目。',
  mode: 'ai',
  job_ids: summary.job_ids,
};
const run = async (_label: string, task: () => Promise<void>) => {
  try {
    await task();
  } catch {
    /* Workspace displays request errors. */
  }
};
const props = {
  jobs: [job, other],
  busy: false,
  useAi: true,
  run,
  onSearch: vi.fn(),
  onSaved: vi.fn(async () => {}),
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-10T04:00:00Z'));
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected request'));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('saved market analysis', () => {
  it('opens from live search without sending saved statistics until submitted', async () => {
    vi.spyOn(careerApi, 'liveJobs').mockRejectedValue(new Error('来源暂不可用'));
    const market = vi.spyOn(careerApi, 'market').mockResolvedValue(summary);
    render(<MarketPanel {...props} onJob={vi.fn()} />);
    await screen.findByText('来源暂不可用');
    fireEvent.click(screen.getByRole('button', { name: '已保存岗位分析' }));
    expect(screen.getByRole('button', { name: '已保存岗位分析' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(screen.getByLabelText('发布时间范围')).toHaveValue('all');
    expect(market).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '更新岗位统计' }));
    await screen.findByText('当前范围 JD 样本');
    expect(market).toHaveBeenCalledExactlyOnceWith(all);
    expect(screen.getByText('日期筛选前 2 份 · 日期未知 1 份 · 本次按日期排除 0 份')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '实时招聘搜索' }));
    expect(screen.getByRole('button', { name: '查找岗位' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '已保存岗位分析' }));
    expect(screen.getByText('当前范围 JD 样本')).toBeVisible();
    expect(market).toHaveBeenCalledOnce();
  });

  it('submits category, city and inclusive periods, and prevents analysis of unsubmitted filters', async () => {
    const market = vi
      .spyOn(careerApi, 'market')
      .mockImplementation(async (filters) => ({ ...summary, filters }));
    const analyze = vi
      .spyOn(careerApi, 'analyze')
      .mockImplementation(async (filters) => ({ ...result, summary: { ...summary, filters } }));
    render(<SavedMarketPanel {...props} />);
    fireEvent.change(screen.getByLabelText('岗位类别'), { target: { value: '数据分析' } });
    fireEvent.change(screen.getByLabelText('城市'), { target: { value: '上海' } });
    fireEvent.change(screen.getByLabelText('发布时间范围'), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: '更新岗位统计' }));
    await screen.findByText('当前范围 JD 样本');
    expect(market).toHaveBeenLastCalledWith({
      ...all,
      category: '数据分析',
      city: '上海',
      since: '2026-08-12',
    });
    fireEvent.change(screen.getByLabelText('发布时间范围'), { target: { value: '90' } });
    expect(screen.getByRole('button', { name: 'AI 解读当前样本' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('下方保留上次统计');
    fireEvent.click(screen.getByRole('button', { name: '更新岗位统计' }));
    await waitFor(() =>
      expect(market).toHaveBeenLastCalledWith({
        ...all,
        category: '数据分析',
        city: '上海',
        since: '2026-06-13',
      })
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'AI 解读当前样本' })).toBeEnabled()
    );
    fireEvent.change(screen.getByLabelText('发布时间范围'), { target: { value: 'custom' } });
    fireEvent.change(screen.getByLabelText('起始发布日期'), { target: { value: '2026-09-01' } });
    fireEvent.click(screen.getByRole('button', { name: '更新岗位统计' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'AI 解读当前样本' })).toBeEnabled()
    );
    fireEvent.change(screen.getByLabelText('想了解什么'), {
      target: { value: '北京的产品岗位有何启发？' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'AI 解读当前样本' }));
    await screen.findByText(result.advice);
    expect(analyze).toHaveBeenCalledExactlyOnceWith(
      { ...all, category: '数据分析', city: '上海', since: '2026-09-01' },
      '北京的产品岗位有何启发？',
      true
    );
  });

  it('retains charts on an analysis failure and offers a working retry', async () => {
    vi.spyOn(careerApi, 'market').mockResolvedValue(summary);
    const analyze = vi
      .spyOn(careerApi, 'analyze')
      .mockRejectedValueOnce(new Error('市场解读暂未完成，图表统计仍可查看。'))
      .mockResolvedValueOnce(result);
    render(<SavedMarketPanel {...props} />);
    fireEvent.click(screen.getByRole('button', { name: '更新岗位统计' }));
    await screen.findByTestId('market-charts');
    fireEvent.click(screen.getByRole('button', { name: 'AI 解读当前样本' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('图表统计仍可查看');
    expect(screen.getByTestId('market-charts')).toHaveTextContent('图表样本 1');
    fireEvent.click(screen.getByRole('button', { name: 'AI 解读当前样本' }));
    await screen.findByText(result.advice);
    expect(analyze).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('recovers an empty date range by requesting all saved jobs', async () => {
    const market = vi.spyOn(careerApi, 'market').mockImplementation(async (filters) => ({
      ...summary,
      count: filters.since ? 0 : 1,
      filters,
    }));
    render(<SavedMarketPanel {...props} />);
    fireEvent.change(screen.getByLabelText('发布时间范围'), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: '更新岗位统计' }));
    fireEvent.click(await screen.findByRole('button', { name: '查看全部已保存岗位' }));
    await screen.findByTestId('market-charts');
    expect(screen.getByLabelText('发布时间范围')).toHaveValue('all');
    expect(market).toHaveBeenLastCalledWith(all);
  });

  it('guides an empty library to live search and excludes demo jobs from filter choices', () => {
    const onSearch = vi.fn();
    render(
      <SavedMarketPanel
        {...props}
        jobs={[{ ...job, source_type: 'synthetic' }]}
        onSearch={onSearch}
      />
    );
    expect(screen.getByText(/还没有已保存的岗位/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '前往实时招聘搜索' }));
    expect(onSearch).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: '更新岗位统计' })).not.toBeInTheDocument();
  });

  it('shows only the saved history selection even when its audit snapshot contains other jobs', async () => {
    vi.spyOn(careerApi, 'liveJobs').mockRejectedValue(new Error('来源暂不可用'));
    vi.spyOn(careerApi, 'marketHistory').mockResolvedValue([
      {
        id: 'history-one',
        source: 'saved',
        created_at: '2026-09-10T04:00:00Z',
        question: '上海数据岗位要求',
        count: 1,
        mode: 'ai',
      },
    ]);
    vi.spyOn(careerApi, 'getMarketHistory').mockResolvedValue({
      ...result,
      history_id: 'history-one',
      input_snapshot: {
        jobs: [job, other],
        filters: all,
        question: '上海数据岗位要求',
        use_ai: true,
      },
    });
    render(<MarketPanel {...props} onJob={vi.fn()} />);
    fireEvent.click(screen.getByText('岗位统计与解读历史'));
    fireEvent.click(await screen.findByRole('button', { name: '查看这次统计' }));
    const history = await screen.findByRole('region', { name: '岗位统计历史详情' });
    fireEvent.click(within(history).getByText('查看保存时的岗位样本'));
    expect(within(history).getByText('数据分析师 · 样本公司')).toBeVisible();
    expect(within(history).queryByText('产品经理 · 样本公司')).not.toBeInTheDocument();
  });
});

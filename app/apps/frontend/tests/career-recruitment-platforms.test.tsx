import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarketPanel } from '@/components/career/market-panel';
import { careerApi, type LiveJobs } from '@/lib/api/career';

vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('@/lib/context/language-context', () => ({
  useLanguage: () => ({ uiLanguage: 'zh', accountProfile: null }),
}));

const result: LiveJobs = {
  provider: 'ncss',
  source_name: '国家大学生就业服务平台',
  source_url: 'https://www.ncss.cn/student/jobs/index.html',
  fetched_at: '2026-09-10T09:00:00Z',
  total: 0,
  total_kind: 'sample',
  coverage: '中国大陆',
  update_note: '',
  cached: false,
  page: 1,
  page_size: 10,
  jobs: [],
  summary: {
    count: 0,
    demo_count: 0,
    salary_missing: 0,
    dataset_hash: 'empty',
    date: '2026-09-10',
    filters: { category: '', city: '', since: null, include_demo: false },
    job_ids: [],
    skills: [],
    salaries: [],
    distribution: [],
  },
  warnings: [],
};

function panel(keyword = '') {
  return render(
    <MarketPanel
      jobs={[]}
      initialKeyword={keyword}
      busy={false}
      useAi={false}
      run={async (_message, task) => task()}
      onJob={vi.fn()}
    />
  );
}

beforeEach(() => {
  vi.spyOn(careerApi, 'liveJobs').mockResolvedValue(result);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('external recruitment platforms', () => {
  it('keeps five official external entries separate from fetched jobs and providers', async () => {
    const remember = vi.spyOn(careerApi, 'rememberLiveJob');
    panel();
    await screen.findByText('换个关键词，再找找。');
    const region = within(screen.getByRole('region', { name: '更多国内招聘平台' }));
    const expected = [
      ['BOSS直聘', 'https://www.zhipin.com/web/geek/job'],
      ['智联招聘', 'https://www.zhaopin.com/sou'],
      ['前程无忧', 'https://we.51job.com/pc/search'],
      ['猎聘', 'https://www.liepin.com/zhaopin/?init=1'],
      ['实习僧', 'https://www.shixiseng.com/interns'],
    ];
    expect(region.getAllByRole('link')).toHaveLength(5);
    for (const [name, url] of expected) {
      const link = region.getByRole('link', { name: `在${name}搜索（新窗口）` });
      expect(link).toHaveAttribute('href', url);
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    }
    expect(region.getByText('外部搜索入口 · 不计入本页统计')).toBeInTheDocument();
    expect(screen.getByText('本页完整 JD 样本')).toHaveTextContent('0');
    expect(within(screen.getByLabelText('招聘来源')).getAllByRole('option')).toHaveLength(3);
    expect(remember).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: '复制关键词' })).not.toBeInTheDocument();
  });

  it('encodes the current keyword only in the verified BOSS search parameter', async () => {
    panel('数据分析');
    await screen.findByText('换个关键词，再找找。');
    const keyword = 'C++ & 数据/分析?city=上海#职位';
    fireEvent.change(screen.getByLabelText('想找什么岗位？'), {
      target: { value: ` ${keyword} ` },
    });
    const link = screen.getByRole('link', { name: '在BOSS直聘搜索（新窗口）' });
    const url = new URL(link.getAttribute('href')!);
    expect(url.origin).toBe('https://www.zhipin.com');
    expect(url.pathname).toBe('/web/geek/job');
    expect([...url.searchParams]).toEqual([['query', keyword]]);
    expect(url.hash).toBe('');
    expect(screen.getByRole('link', { name: '在智联招聘搜索（新窗口）' })).toHaveAttribute(
      'href',
      'https://www.zhaopin.com/sou'
    );
    expect(careerApi.liveJobs).toHaveBeenCalledExactlyOnceWith('数据分析', 1, 'ncss', '');
  });

  it('copies the current search term and resets confirmation when the term changes', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    panel(' 数据分析 ');
    fireEvent.click(screen.getByRole('button', { name: '复制关键词' }));
    await screen.findByRole('button', { name: '关键词已复制' });
    expect(writeText).toHaveBeenCalledExactlyOnceWith('数据分析');
    writeText.mockRejectedValueOnce(new Error('denied'));
    fireEvent.click(screen.getByRole('button', { name: '关键词已复制' }));
    await screen.findByRole('status');
    expect(screen.queryByRole('button', { name: '关键词已复制' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('想找什么岗位？'), { target: { value: '产品经理' } });
    expect(screen.getByRole('button', { name: '复制关键词' })).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(careerApi.liveJobs).toHaveBeenCalledTimes(1);
  });

  it('keeps official entries available after a source failure and handles clipboard refusal', async () => {
    vi.mocked(careerApi.liveJobs).mockRejectedValue(new Error('上游暂不可用'));
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });
    panel('Python');
    await screen.findByRole('alert');
    expect(
      within(screen.getByRole('region', { name: '更多国内招聘平台' })).getAllByRole('link')
    ).toHaveLength(5);
    fireEvent.click(screen.getByRole('button', { name: '复制关键词' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('无法自动复制'));
    expect(screen.queryByRole('button', { name: '关键词已复制' })).not.toBeInTheDocument();
  });
});

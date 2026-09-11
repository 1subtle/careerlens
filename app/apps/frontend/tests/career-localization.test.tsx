import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResumePanel } from '@/components/career/resume-panel';
import { JobsPanel } from '@/components/career/jobs-panel';
import { MatchPanel } from '@/components/career/match-panel';
import { MarketPanel } from '@/components/career/market-panel';
import { AnalysisSource } from '@/components/career/analysis-results';
import { careerApi, type CareerJob, type CareerState } from '@/lib/api/career';

const { language } = vi.hoisted(() => ({
  language: { uiLanguage: 'en', accountProfile: { timezone: 'UTC' } },
}));
vi.mock('@/lib/context/language-context', () => ({ useLanguage: () => language }));
vi.mock('next/dynamic', () => ({ default: () => () => <p>Editor contents</p> }));
const noop = vi.fn();
const common = {
  busy: false,
  useAi: true,
  run: vi.fn(),
  onDirty: noop,
  onNext: noop,
  onSaved: vi.fn(),
  onDeleted: vi.fn(),
};
const job: CareerJob = {
  job_id: 'job',
  version: 1,
  title: '数据分析实习生',
  company: '真实公司',
  city: '北京',
  category: '',
  salary_text: '',
  source_type: 'manual',
  source_name: '',
  source_url: '',
  published_at: '',
  created_at: '',
  content: '中文岗位原文：熟悉 SQL',
  requirements: [],
};
const state: CareerState = {
  resumes: [
    {
      id: 'resume',
      title: '求职简历',
      data: {
        personalInfo: { name: '', title: '', email: '', phone: '', location: '' },
        summary: '',
        education: [],
        workExperience: [],
        personalProjects: [],
        additional: {
          technicalSkills: [],
          languages: [],
          certificationsTraining: [],
          awards: [],
        },
      },
      hash: 'resume-hash',
      is_master: true,
      parent_id: null,
      source_text: '',
      created_at: '',
      updated_at: '',
    },
  ],
  jobs: [job],
  matches: [],
  model: { configured: true, model: 'test', provider: 'test' },
  rule_version: 'test',
};
afterEach(() => {
  vi.restoreAllMocks();
  language.uiLanguage = 'en';
  language.accountProfile.timezone = 'UTC';
});

describe('CareerLens interface translations', () => {
  it('translates resume controls and layout labels', () => {
    render(<ResumePanel {...common} />);
    expect(screen.getByRole('button', { name: 'Save resume' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Import' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Export PDF' })).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Version name' })).toBeVisible();
  });

  it('changes job controls immediately while preserving saved content and unsaved edits', () => {
    const view = render(<JobsPanel {...common} jobs={[job]} selected={job} onSelect={noop} />);
    const title = screen.getByRole('textbox', { name: 'Job title (required)' });
    expect(title).toHaveValue('数据分析实习生');
    const description = screen.getByRole('textbox', {
      name: 'Full job description (required)',
    });
    expect(description).toHaveValue(job.content);
    expect(description).toHaveAttribute('maxlength', '300000');
    fireEvent.change(title, { target: { value: '我编辑的岗位名称' } });
    language.uiLanguage = 'zh';
    view.rerender(<JobsPanel {...common} jobs={[job]} selected={job} onSelect={noop} />);
    expect(screen.getByRole('textbox', { name: '岗位名称（必填）' })).toHaveValue(
      '我编辑的岗位名称'
    );
    expect(screen.getByRole('button', { name: '记住这份 JD' })).toBeVisible();
  });

  it('translates matching, comparison and history controls without translating saved job titles', () => {
    render(
      <MatchPanel
        {...common}
        state={state}
        resumeId="resume"
        jobId="job"
        setResumeId={noop}
        setJobId={noop}
        refresh={vi.fn()}
        onResume={noop}
      />
    );
    expect(screen.getByRole('button', { name: 'Analyze target job match' })).toBeVisible();
    expect(screen.getByText('Career direction history')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Compare jobs' })).toBeVisible();
    expect(screen.getByRole('combobox', { name: 'Analysis history' })).toBeVisible();
    expect(screen.getByRole('option', { name: /数据分析实习生/ })).toBeInTheDocument();
  });

  it('translates live-job search, sources and history', async () => {
    vi.spyOn(careerApi, 'liveJobs').mockRejectedValue(new Error('Search unavailable'));
    render(<MarketPanel {...common} jobs={[]} onJob={noop} />);
    await screen.findByText(/Search unavailable/);
    expect(screen.getByRole('button', { name: 'Find jobs' })).toBeVisible();
    expect(screen.getByRole('option', { name: 'Tencent Careers' })).toBeInTheDocument();
    expect(screen.getByText('Job statistics and analysis history')).toBeVisible();
  });

  it('keeps saved analyses visible when the browser cannot format a server timezone', () => {
    language.accountProfile.timezone = 'Factory';
    render(<AnalysisSource mode="rules" analyzed_at="2026-09-10T12:00:00Z" />);
    expect(
      screen.getByText(
        new Date('2026-09-10T12:00:00Z').toLocaleString('en', {
          timeZone: 'Asia/Shanghai',
          hour12: false,
        })
      )
    ).toBeVisible();
  });

  it('formats history timestamps in the account timezone', () => {
    render(<AnalysisSource mode="rules" analyzed_at="2026-09-10T12:00:00Z" />);
    expect(screen.getByText('Rule-based analysis')).toBeVisible();
    expect(
      screen.getByText(
        new Date('2026-09-10T12:00:00Z').toLocaleString('en', { timeZone: 'UTC', hour12: false })
      )
    ).toBeVisible();
  });
});

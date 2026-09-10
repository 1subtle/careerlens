import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CareerWorkspace from '@/components/career/workspace';
import { careerApi, type CareerState } from '@/lib/api/career';
import { authApi } from '@/lib/api/auth';
import { AuthProvider } from '@/components/auth/auth-provider';
import type { PropsWithChildren } from 'react';

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: navigate, push: navigate, refresh: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({
    children,
    href,
    onNavigate,
  }: PropsWithChildren<{
    href: string;
    onNavigate?: (event: { preventDefault: () => void }) => void;
  }>) => (
    <a
      href={href}
      onClick={(event) => {
        onNavigate?.(event);
        if (!event.defaultPrevented) navigate(href);
        event.preventDefault();
      }}
    >
      {children}
    </a>
  ),
}));

vi.mock('@/components/career/resume-panel', () => ({
  ResumePanel: ({
    active,
    useAi,
    onDirty,
    onSaved,
    resume,
  }: {
    active: boolean;
    useAi: boolean;
    onDirty: () => void;
    onSaved: (resume: CareerState['resumes'][number]) => Promise<void>;
    resume: CareerState['resumes'][number];
  }) => (
    <>
      <p>简历解析：{useAi ? 'AI' : '规则'}</p>
      <input aria-label="简历经历" onChange={onDirty} data-active={active} />
      <button onClick={() => void onSaved({ ...resume, hash: 'saved-hash' })}>保存测试文档</button>
    </>
  ),
}));
vi.mock('@/components/career/jobs-panel', () => ({
  JobsPanel: ({
    jobs,
    useAi,
    onDirty,
    onSelect,
  }: {
    jobs: CareerState['jobs'];
    useAi: boolean;
    onDirty: () => void;
    onSelect: (id: string) => void;
  }) => (
    <>
      <p>岗位提取：{useAi ? 'AI' : '规则'}</p>
      <input aria-label="岗位内容" onChange={onDirty} />
      {jobs.map((job) => (
        <button key={job.job_id} onClick={() => onSelect(job.job_id)}>
          {job.title}
        </button>
      ))}
    </>
  ),
}));
vi.mock('@/components/career/match-panel', () => ({ MatchPanel: () => null }));
vi.mock('@/components/career/market-panel', () => ({ MarketPanel: () => null }));
vi.mock('@/components/account/billing-panels', () => ({
  WalletPanel: () => <p>账户钱包内容</p>,
  OrdersPanel: () => <p>账户充值账单内容</p>,
  UsagePanel: () => <p>账户消费日志内容</p>,
}));

const resumeData = {
  personalInfo: { name: 'Example', title: '', email: '', phone: '', location: '' },
  summary: '',
  education: [],
  workExperience: [],
  personalProjects: [],
  additional: { technicalSkills: [], languages: [], certificationsTraining: [], awards: [] },
};
const state: CareerState = {
  resumes: [
    {
      id: 'demo',
      title: '虚构示例 · 林同学',
      is_master: true,
      data: resumeData,
      hash: 'h1',
      parent_id: null,
      source_text: '',
      created_at: '2026-09-01',
      updated_at: '2026-09-01',
    },
    {
      id: 'personal',
      title: '我的产品简历',
      is_master: false,
      data: resumeData,
      hash: 'h2',
      parent_id: null,
      source_text: '',
      created_at: '2026-09-08',
      updated_at: '2026-09-08',
    },
  ],
  jobs: [],
  matches: [],
  model: { configured: true, provider: 'test', model: 'test' },
  rule_version: 'test',
};

afterEach(() => {
  vi.restoreAllMocks();
  navigate.mockClear();
});

describe('CareerLens workspace defaults', () => {
  it.each([20, 0])(
    'shows %i hosted credits and keeps rule-based editing available',
    async (credits) => {
      vi.spyOn(careerApi, 'state').mockResolvedValue(state);
      vi.spyOn(authApi, 'session').mockResolvedValue({
        mode: 'hosted',
        user: { id: 'one', email: 'one@example.com', credits },
        email_login_available: true,
        github_url: null,
      });
      render(
        <AuthProvider>
          <CareerWorkspace />
        </AuthProvider>
      );
      expect(await screen.findByText(`积分余额 ${credits}`)).toHaveAttribute('role', 'status');
      expect(screen.getByRole('button', { name: '个人中心' })).toBeVisible();
      expect(screen.queryByRole('link', { name: '配置模型' })).not.toBeInTheDocument();
      if (credits === 0) {
        expect(
          screen.getByText('积分余额已用完。关闭 AI 辅助后，仍可编辑简历、核对材料并导出。')
        ).toBeVisible();
      } else {
        expect(
          screen.queryByText('每次 AI 生成消耗 1 积分，失败自动退回。')
        ).not.toBeInTheDocument();
      }
      fireEvent.click(screen.getByRole('switch', { name: 'AI 辅助' }));
      expect(screen.getByText('简历解析：规则')).toBeVisible();
      fireEvent.click(screen.getByRole('button', { name: '诊断与优化' }));
      if (credits > 0) {
        expect(screen.getByText('每次 AI 生成消耗 1 积分，失败自动退回。')).toBeVisible();
      }
    }
  );

  it('does not clear the unsaved state when starting an already open new document', async () => {
    vi.spyOn(careerApi, 'state').mockResolvedValue(state);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<CareerWorkspace />);
    await screen.findByRole('textbox', { name: '简历经历' });
    fireEvent.click(screen.getByRole('button', { name: '新建空白简历' }));
    const input = screen.getByRole('textbox', { name: '简历经历' });
    fireEvent.change(input, { target: { value: '新简历尚未保存' } });
    expect(screen.getByRole('button', { name: '新建空白简历' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '新建空白简历' }));
    expect(screen.getByText('有未保存的编辑')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '目标岗位' }));
    expect(confirm).toHaveBeenCalledOnce();
    expect(input).toHaveValue('新简历尚未保存');
  });

  it('keeps hosted account deep links out of local mode', async () => {
    vi.spyOn(careerApi, 'state').mockResolvedValue(state);
    vi.spyOn(authApi, 'session').mockResolvedValue({
      mode: 'local',
      user: null,
      email_login_available: false,
      github_url: null,
    });
    render(
      <AuthProvider>
        <CareerWorkspace initialAccountSection="wallet" />
      </AuthProvider>
    );
    expect(await screen.findByRole('textbox', { name: '简历经历' })).toBeVisible();
    expect(screen.queryByRole('navigation', { name: '个人中心栏目' })).not.toBeInTheDocument();
    expect(screen.queryByText('账户钱包内容')).not.toBeInTheDocument();
  });

  it('keeps the document mounted after saving and ignores navigation to the current document', async () => {
    const getState = vi.spyOn(careerApi, 'state').mockResolvedValue(state);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<CareerWorkspace />);
    const input = await screen.findByRole('textbox', { name: '简历经历' });
    fireEvent.change(input, { target: { value: '继续编辑的经历' } });
    fireEvent.click(screen.getByRole('button', { name: '我的简历' }));
    fireEvent.click(screen.getByRole('button', { name: '我的产品简历' }));
    expect(confirm).not.toHaveBeenCalled();
    expect(screen.getByText('有未保存的编辑')).toBeInTheDocument();
    getState.mockResolvedValue({
      ...state,
      resumes: state.resumes.map((resume) =>
        resume.id === 'personal' ? { ...resume, hash: 'saved-hash' } : resume
      ),
    });
    fireEvent.click(screen.getByRole('button', { name: '保存测试文档' }));
    await waitFor(() => expect(getState).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('textbox', { name: '简历经历' })).toBe(input);
    expect(input).toHaveValue('继续编辑的经历');
    expect(screen.getByRole('button', { name: '我的产品简历' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });

  it('keeps guarding a job draft when the selected JD is clicked again', async () => {
    vi.spyOn(careerApi, 'state').mockResolvedValue({
      ...state,
      jobs: [
        {
          job_id: 'selected-job',
          version: 1,
          title: '数据分析实习生',
          content: '分析业务数据。',
          created_at: '2026-09-10',
        },
      ],
    });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<CareerWorkspace />);
    await screen.findByRole('textbox', { name: '简历经历' });
    fireEvent.click(screen.getByRole('button', { name: '目标岗位' }));
    const selectedJob = screen.getByRole('button', { name: '数据分析实习生' });
    fireEvent.click(selectedJob);
    const draft = screen.getByRole('textbox', { name: '岗位内容' });
    fireEvent.change(draft, { target: { value: '尚未保存的岗位补充内容' } });
    fireEvent.click(screen.getByRole('button', { name: '数据分析实习生' }));
    expect(confirm).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: '岗位内容' })).toBe(draft);
    expect(screen.getByText('有未保存的编辑')).toBeVisible();

    confirm.mockReturnValue(false);
    fireEvent.click(screen.getByRole('button', { name: '我的简历' }));
    expect(confirm).toHaveBeenCalledOnce();
    expect(draft).toBeVisible();
    expect(draft).toHaveValue('尚未保存的岗位补充内容');
  });

  it.each(['配置模型', '配置模型后开始使用'])(
    'protects unsaved edits before following %s',
    async (linkName) => {
      vi.spyOn(careerApi, 'state').mockResolvedValue({
        ...state,
        model: { ...state.model, configured: false },
      });
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
      render(<CareerWorkspace />);
      const input = await screen.findByRole('textbox', { name: '简历经历' });
      fireEvent.change(input, { target: { value: '尚未保存的项目经历' } });
      fireEvent.click(screen.getByRole('link', { name: linkName }));
      expect(confirm).toHaveBeenCalledOnce();
      expect(navigate).not.toHaveBeenCalled();
      expect(input).toHaveValue('尚未保存的项目经历');
      expect(screen.getByText('有未保存的编辑')).toBeInTheDocument();

      confirm.mockReturnValue(true);
      fireEvent.click(screen.getByRole('link', { name: linkName }));
      expect(navigate).toHaveBeenCalledWith('/settings');
    }
  );

  it('starts with AI and a personal resume, and preserves an explicit AI choice across navigation', async () => {
    vi.spyOn(careerApi, 'state').mockResolvedValue(state);
    render(<CareerWorkspace />);
    expect(await screen.findByText('简历解析：AI')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'AI 辅助' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('combobox', { name: '选择简历版本' })).toHaveValue('personal');
    fireEvent.click(screen.getByRole('switch', { name: 'AI 辅助' }));
    expect(screen.getByText('简历解析：规则')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '目标岗位' }));
    expect(screen.getByText('岗位提取：规则')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch', { name: 'AI 辅助' }));
    expect(screen.getByText('岗位提取：AI')).toBeInTheDocument();
  });

  it('opens personal center as the fifth workspace tab and preserves the mounted draft, selection and AI choice', async () => {
    vi.spyOn(careerApi, 'state').mockResolvedValue(state);
    vi.spyOn(authApi, 'session').mockResolvedValue({
      mode: 'hosted',
      user: { id: 'one', email: 'one@example.com', credits: 20 },
      email_login_available: true,
      github_url: null,
    });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(
      <AuthProvider>
        <CareerWorkspace />
      </AuthProvider>
    );
    await screen.findByText('积分余额 20');
    await screen.findByRole('textbox', { name: '简历经历' });
    fireEvent.change(screen.getByRole('combobox', { name: '选择简历版本' }), {
      target: { value: 'demo' },
    });
    const input = screen.getByRole('textbox', { name: '简历经历' });
    fireEvent.change(input, { target: { value: '去个人中心之前的未保存经历' } });
    fireEvent.click(screen.getByRole('switch', { name: 'AI 辅助' }));
    const navigation = within(screen.getByRole('navigation', { name: '工作区导航' }));
    const buttons = navigation.getAllByRole('button');
    expect(buttons).toHaveLength(5);
    expect(buttons[4]).toHaveAccessibleName('个人中心');
    fireEvent.click(buttons[4]);
    expect(await screen.findByText('账户钱包内容')).toBeVisible();
    expect(buttons[4]).toHaveAttribute('aria-current', 'page');
    expect(input).toBeInTheDocument();
    expect(input).not.toBeVisible();
    expect(input).toHaveAttribute('data-active', 'false');
    expect(confirm).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();

    const accountNavigation = within(screen.getByRole('navigation', { name: '个人中心栏目' }));
    expect(accountNavigation.getAllByRole('button')).toHaveLength(6);
    expect(accountNavigation.queryAllByRole('link')).toHaveLength(0);
    expect(accountNavigation.getByRole('button', { name: '钱包管理' })).toHaveAttribute(
      'aria-current',
      'page'
    );
    fireEvent.click(accountNavigation.getByRole('button', { name: '充值账单' }));
    expect(await screen.findByText('账户充值账单内容')).toBeVisible();
    expect(accountNavigation.getByRole('button', { name: '充值账单' })).toHaveAttribute(
      'aria-current',
      'page'
    );
    fireEvent.click(navigation.getByRole('button', { name: '我的简历' }));
    expect(screen.getByRole('textbox', { name: '简历经历' })).toBe(input);
    expect(input).toHaveAttribute('data-active', 'true');
    expect(input).toHaveValue('去个人中心之前的未保存经历');
    expect(screen.getByRole('combobox', { name: '选择简历版本' })).toHaveValue('demo');
    expect(screen.getByRole('switch', { name: 'AI 辅助' })).toHaveAttribute(
      'aria-checked',
      'false'
    );
    expect(screen.getByText('有未保存的编辑')).toBeVisible();
    expect(confirm).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('keeps personal center available when the career workspace cannot load', async () => {
    vi.spyOn(careerApi, 'state').mockRejectedValue(new Error('Workspace unavailable'));
    vi.spyOn(authApi, 'session').mockResolvedValue({
      mode: 'hosted',
      user: { id: 'one', email: 'one@example.com', credits: 20 },
      email_login_available: true,
      github_url: null,
    });
    render(
      <AuthProvider>
        <CareerWorkspace initialAccountSection="wallet" />
      </AuthProvider>
    );
    await screen.findByText('积分余额 20');
    expect(await screen.findByText('账户钱包内容')).toBeVisible();
    expect(screen.getByRole('navigation', { name: '个人中心栏目' })).toBeVisible();
    const navigation = within(screen.getByRole('navigation', { name: '工作区导航' }));
    fireEvent.click(navigation.getByRole('button', { name: '我的简历' }));
    expect(await screen.findByRole('button', { name: '重试连接' })).toBeVisible();
    fireEvent.click(navigation.getByRole('button', { name: '个人中心' }));
    expect(screen.getByText('账户钱包内容')).toBeVisible();
  });

  it('protects unsaved account preferences when returning through the main workspace navigation', async () => {
    vi.spyOn(careerApi, 'state').mockResolvedValue(state);
    vi.spyOn(authApi, 'session').mockResolvedValue({
      mode: 'hosted',
      user: { id: 'one', email: 'one@example.com', credits: 20 },
      email_login_available: true,
      github_url: null,
    });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(
      <AuthProvider>
        <CareerWorkspace initialAccountSection="settings" />
      </AuthProvider>
    );
    const nickname = await screen.findByLabelText(/昵称/);
    fireEvent.change(nickname, { target: { value: '尚未保存的账户称呼' } });
    const navigation = within(screen.getByRole('navigation', { name: '工作区导航' }));
    fireEvent.click(navigation.getByRole('button', { name: '我的简历' }));
    expect(confirm).toHaveBeenCalledOnce();
    expect(nickname).toBeVisible();
    expect(nickname).toHaveValue('尚未保存的账户称呼');
    expect(navigation.getByRole('button', { name: '个人中心' })).toHaveAttribute(
      'aria-current',
      'page'
    );
    expect(navigate).not.toHaveBeenCalled();
  });

  it('keeps guarding account edits when a second confirmation cancels a workspace change', async () => {
    vi.spyOn(careerApi, 'state').mockResolvedValue(state);
    vi.spyOn(authApi, 'session').mockResolvedValue({
      mode: 'hosted',
      user: { id: 'one', email: 'one@example.com', credits: 20 },
      email_login_available: true,
      github_url: null,
    });
    const confirm = vi
      .spyOn(window, 'confirm')
      .mockReturnValue(false)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    render(
      <AuthProvider>
        <CareerWorkspace />
      </AuthProvider>
    );
    await screen.findByText('积分余额 20');
    const resume = await screen.findByRole('textbox', { name: '简历经历' });
    fireEvent.change(resume, { target: { value: '简历草稿需要继续保留' } });
    const navigation = within(screen.getByRole('navigation', { name: '工作区导航' }));
    fireEvent.click(navigation.getByRole('button', { name: '个人中心' }));
    fireEvent.click(screen.getByRole('button', { name: '个人设置' }));
    const nickname = await screen.findByLabelText(/昵称/);
    fireEvent.change(nickname, { target: { value: '账户草稿需要继续保留' } });

    fireEvent.click(navigation.getByRole('button', { name: '目标岗位' }));
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(nickname).toBeVisible();
    expect(nickname).toHaveValue('账户草稿需要继续保留');
    fireEvent.click(navigation.getByRole('button', { name: '我的简历' }));
    expect(confirm).toHaveBeenCalledTimes(3);
    expect(nickname).toBeVisible();
    expect(nickname).toHaveValue('账户草稿需要继续保留');
    expect(resume).toHaveValue('简历草稿需要继续保留');
  });
});

vi.mock('@/lib/context/language-context', () => ({
  useLanguage: () => ({
    uiLanguage: 'zh',
    accountProfile: {
      id: 'one',
      email: 'one@example.com',
      created_at: 1,
      display_name: '',
      ui_language: 'zh',
      content_language: 'zh',
      timezone: 'Asia/Shanghai',
    },
    preferencesError: '',
    reloadProfile: vi.fn(),
    applyProfile: vi.fn(),
  }),
}));

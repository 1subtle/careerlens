import { lazy, Suspense, type ComponentType, type PropsWithChildren } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ResumePanel } from '@/components/career/resume-panel';
import { careerApi, type CareerResume } from '@/lib/api/career';
import type { ResumeData } from '@/components/dashboard/resume-component';
import { CAREER_LAYOUT_DEFAULTS } from '@/lib/utils/career-layout';

vi.mock('@/components/preview/paginated-preview', () => ({
  PaginatedPreview: () => <div>纸张预览</div>,
}));

vi.mock('@/lib/i18n', () => ({ useTranslations: () => ({ t: (key: string) => key }) }));
vi.mock('next/dynamic', () => ({
  default: (load: () => Promise<ComponentType | { default: ComponentType }>) => {
    const Component = lazy(async () => {
      const loaded = await load();
      return { default: typeof loaded === 'function' ? loaded : loaded.default };
    });
    return function Dynamic(props: Record<string, unknown>) {
      return (
        <Suspense fallback={<p>载入中</p>}>
          <Component {...props} />
        </Suspense>
      );
    };
  },
}));
vi.mock('@/components/dashboard/resume-component', () => ({
  default: ({ resumeData }: { resumeData: ResumeData }) => (
    <div data-testid="resume-preview-content">
      {resumeData.personalInfo?.name} {resumeData.summary}
    </div>
  ),
}));
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    onNavigate,
    ...props
  }: PropsWithChildren<{
    href: string;
    onNavigate?: (event: { preventDefault: () => void }) => void;
  }>) => (
    <a
      {...props}
      href={href}
      onClick={(event) => {
        event.preventDefault();
        onNavigate?.(event);
      }}
    >
      {children}
    </a>
  ),
}));

const data: ResumeData = {
  personalInfo: { name: '林同学', title: '数据分析', email: '', phone: '', location: '上海' },
  summary: '分析用户行为并验证产品假设。',
  education: [
    { id: 1, institution: '示例大学', degree: '本科', years: '2022–2026', description: '' },
  ],
  workExperience: [],
  personalProjects: [],
  additional: {
    technicalSkills: ['Python'],
    languages: [],
    certificationsTraining: [],
    awards: [],
  },
};
const resume: CareerResume = {
  id: 'resume-panel-test',
  title: '数据分析版本',
  data,
  hash: 'saved-hash',
  revision: 'saved-revision',
  is_master: true,
  parent_id: null,
  source_text: '原始经历',
  created_at: '',
  updated_at: '',
};
const run = async (_message: string, task: () => Promise<void>) => task();
const callbacks = () => ({
  busy: false,
  useAi: true,
  run,
  onDirty: vi.fn(),
  onSaved: vi.fn(async () => {}),
  onDeleted: vi.fn(async () => {}),
  onNext: vi.fn(),
  onNavigate: vi.fn(),
});

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network request'));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    }
  );
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('CareerLens document panel', () => {
  it('opens existing content directly as continuous editable chapters', async () => {
    const { container } = render(<ResumePanel resume={resume} {...callbacks()} />);
    expect(await screen.findByDisplayValue('林同学')).toBeVisible();
    expect(screen.getByDisplayValue('示例大学')).toBeVisible();
    expect(screen.getByDisplayValue(data.summary!)).toBeVisible();
    expect(container.querySelector('details')).toBeNull();
    expect(screen.queryByRole('region', { name: '导入简历' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('resume-preview-content')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'resume.sections.education' })).toHaveAttribute(
      'href',
      '#resume-section-education'
    );
    expect(container.querySelector('#resume-section-education')).toBeInTheDocument();
  });

  it('opens a new blank document without an import screen', async () => {
    render(<ResumePanel {...callbacks()} />);
    expect(await screen.findByLabelText('resume.personalInfo.name')).toHaveValue('');
    expect(screen.getByRole('textbox', { name: '版本名称' })).toHaveValue('我的简历');
    expect(screen.getByRole('button', { name: '导出 PDF' })).toBeDisabled();
    expect(screen.queryByRole('region', { name: '导入简历' })).not.toBeInTheDocument();
  });

  it('locks all document editing and the save shortcut while an operation is running', async () => {
    const save = vi.spyOn(careerApi, 'saveResume');
    render(<ResumePanel resume={resume} {...callbacks()} busy />);
    const name = await screen.findByDisplayValue('林同学');
    expect(name).toBeDisabled();
    expect(name.closest('fieldset')).toHaveAttribute('inert');
    expect(screen.getByRole('button', { name: '保存简历' })).toBeDisabled();
    fireEvent.keyDown(window, { key: 's', metaKey: true });
    expect(save).not.toHaveBeenCalled();
  });

  it('suspends the save shortcut while personal center is open and restores it with the draft', async () => {
    const props = callbacks();
    const save = vi.spyOn(careerApi, 'saveResume').mockResolvedValue(resume);
    const { rerender } = render(<ResumePanel resume={resume} {...props} active />);
    const name = await screen.findByDisplayValue('林同学');
    fireEvent.change(name, { target: { value: '保留的简历草稿' } });

    rerender(<ResumePanel resume={resume} {...props} active={false} />);
    fireEvent.keyDown(window, { key: 's', metaKey: true });
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    expect(save).not.toHaveBeenCalled();

    rerender(<ResumePanel resume={resume} {...props} active />);
    expect(screen.getByDisplayValue('保留的简历草稿')).toBe(name);
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    await waitFor(() => expect(props.onSaved).toHaveBeenCalledOnce());
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          personalInfo: expect.objectContaining({ name: '保留的简历草稿' }),
        }),
      }),
      resume.id
    );
  });

  it('previews current edits and preserves them through view changes', async () => {
    const props = callbacks();
    render(<ResumePanel resume={resume} {...props} />);
    const longText = '尚未保存的新项目成果。'.repeat(100);
    fireEvent.change(await screen.findByDisplayValue(data.summary!), {
      target: { value: longText },
    });
    fireEvent.click(screen.getByRole('button', { name: '预览' }));
    expect(await screen.findByTestId('resume-preview-content')).toHaveTextContent(longText);
    expect(screen.queryByDisplayValue('林同学')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '导入' }));
    expect(screen.getByRole('textbox', { name: '简历原文' })).toHaveValue('原始经历');
    expect(screen.getByRole('textbox', { name: '简历原文' })).toHaveAttribute(
      'maxlength',
      '300000'
    );
    fireEvent.click(screen.getByRole('button', { name: '返回文档' }));
    expect(await screen.findByDisplayValue(longText)).toBeVisible();
    expect(props.onDirty).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('saves the edited document and uses a refreshed hash without resetting the view', async () => {
    const props = callbacks();
    const save = vi
      .spyOn(careerApi, 'saveResume')
      .mockResolvedValue({ ...resume, hash: 'next-hash', revision: 'next-revision' });
    const { rerender } = render(<ResumePanel resume={resume} {...props} />);
    const nameField = await screen.findByDisplayValue('林同学');
    fireEvent.change(nameField, { target: { value: '林小夏' } });
    fireEvent.change(screen.getByRole('textbox', { name: '版本名称' }), {
      target: { value: '分析岗位定向版' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存简历' }));
    await waitFor(() => expect(props.onSaved).toHaveBeenCalledOnce());
    expect(save).toHaveBeenLastCalledWith(
      expect.objectContaining({
        title: '分析岗位定向版',
        source_text: '原始经历',
        expected_hash: 'saved-hash',
        expected_revision: 'saved-revision',
        data: expect.objectContaining({
          personalInfo: expect.objectContaining({ name: '林小夏' }),
          education: data.education,
        }),
      }),
      resume.id
    );
    rerender(
      <ResumePanel
        resume={{ ...resume, hash: 'next-hash', revision: 'next-revision' }}
        {...props}
      />
    );
    expect(screen.getByDisplayValue('林小夏')).toBe(nameField);
    fireEvent.click(screen.getByRole('button', { name: '预览' }));
    expect(await screen.findByTestId('resume-preview-content')).toHaveTextContent('林小夏');
    rerender(
      <ResumePanel
        resume={{ ...resume, hash: 'next-hash', revision: 'next-revision' }}
        {...props}
      />
    );
    expect(screen.getByRole('button', { name: '预览' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('resume-preview-content')).toHaveTextContent('林小夏');
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls[1][0]).toMatchObject({
      title: '分析岗位定向版',
      expected_hash: 'next-hash',
      expected_revision: 'next-revision',
    });
    fireEvent.keyDown(window, { key: 's', metaKey: true, repeat: true });
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('parses pasted text with the selected AI setting then returns to editing', async () => {
    const parsed = { ...data, personalInfo: { ...data.personalInfo!, name: '新导入同学' } };
    const parse = vi
      .spyOn(careerApi, 'parseResume')
      .mockResolvedValue({ data: parsed, source_text: '新的原文', mode: 'ai' });
    render(<ResumePanel resume={resume} {...callbacks()} />);
    fireEvent.click(screen.getByRole('button', { name: '导入' }));
    fireEvent.change(screen.getByRole('textbox', { name: '简历原文' }), {
      target: { value: '新的原文' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'AI 解析到文档' }));
    expect(await screen.findByDisplayValue('新导入同学')).toBeVisible();
    expect(parse).toHaveBeenCalledWith('新的原文', true);
    expect(screen.queryByRole('region', { name: '导入简历' })).not.toBeInTheDocument();
  });

  it('imports files with the selected mode and retains parser warnings', async () => {
    const parse = vi.spyOn(careerApi, 'parseFile').mockResolvedValue({
      data,
      source_text: '文件经历',
      mode: 'rule',
      warning: '请核对提取的段落。',
    });
    render(<ResumePanel {...callbacks()} useAi={false} />);
    const file = new File(['synthetic resume'], 'resume.txt');
    fireEvent.change(screen.getByLabelText('导入简历文件'), { target: { files: [file] } });
    expect(await screen.findByDisplayValue('林同学')).toBeVisible();
    expect(parse).toHaveBeenCalledWith(file, false);
    expect(screen.getByRole('alert')).toHaveTextContent('请核对提取的段落。');
  });

  it('keeps export, guarded layout navigation and confirmed deletion available', async () => {
    const props = callbacks();
    const download = vi.spyOn(careerApi, 'downloadPdf').mockResolvedValue(undefined);
    vi.spyOn(careerApi, 'saveResume').mockResolvedValue(resume);
    const remove = vi.spyOn(careerApi, 'deleteResume').mockResolvedValue(undefined);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<ResumePanel resume={resume} {...props} />);
    fireEvent.click(screen.getByRole('button', { name: '导出 PDF' }));
    await waitFor(() => expect(download).toHaveBeenCalledWith(resume.id, CAREER_LAYOUT_DEFAULTS));
    fireEvent.click(screen.getByRole('button', { name: '更多版本操作' }));
    expect(screen.getByRole('dialog', { name: '更多版本操作' })).toBeVisible();
    fireEvent.click(screen.getByRole('link', { name: '打开排版编辑器 ↗' }));
    expect(props.onNavigate).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: '删除当前版本' }));
    expect(remove).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: '删除当前版本' }));
    await waitFor(() => expect(props.onDeleted).toHaveBeenCalledOnce());
    expect(remove).toHaveBeenCalledWith(resume.id);
  });

  it('saves current edits and per-resume layout before exporting an editable Word document', async () => {
    const props = callbacks();
    const save = vi.spyOn(careerApi, 'saveResume').mockResolvedValue(resume);
    const word = vi.spyOn(careerApi, 'downloadWord').mockResolvedValue(undefined);
    render(<ResumePanel resume={resume} {...props} />);
    fireEvent.change(await screen.findByDisplayValue(data.summary!), {
      target: { value: '本次修改的经历' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^模板与排版$/ }));
    fireEvent.click(await screen.findByRole('button', { name: /校招清晰.*院校学历置顶/ }));
    expect(screen.queryByRole('group', { name: '选择简历模板' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('正文字体'), { target: { value: 'serif' } });
    fireEvent.change(await screen.findByLabelText('字号'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: '收起上方工具栏' }));
    expect(screen.getByRole('button', { name: '展开上方工具栏' })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
    expect(screen.getByText('纸张预览')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByRole('button', { name: '收起上方工具栏' })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    expect(screen.getByLabelText('正文字体')).toHaveValue('serif');
    expect(screen.getByLabelText('字号')).toHaveValue('5');
    fireEvent.click(screen.getByRole('button', { name: '更多排版' }));
    fireEvent.change(screen.getByLabelText('上边距 · mm'), { target: { value: '18' } });
    fireEvent.click(screen.getByRole('button', { name: '导出 Word' }));
    await waitFor(() => expect(word).toHaveBeenCalledWith(resume.id));
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ summary: '本次修改的经历' }),
        expected_revision: 'saved-revision',
        template_settings: expect.objectContaining({
          template: 'campus',
          fontSize: expect.objectContaining({ base: 5, bodyFont: 'serif' }),
          margins: expect.objectContaining({ top: 18 }),
        }),
      }),
      resume.id
    );
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(word.mock.invocationCallOrder[0]);
    expect(props.onSaved).toHaveBeenCalledWith(resume);
  });

  it.each(['PDF', 'Word'] as const)(
    'keeps local edits when a stale revision blocks %s export',
    async (format) => {
      const props = callbacks();
      const conflict = new Error('简历已在其他页面修改，请重新载入后保存。');
      const save = vi.spyOn(careerApi, 'saveResume').mockRejectedValue(conflict);
      const pdf = vi.spyOn(careerApi, 'downloadPdf').mockResolvedValue(undefined);
      const word = vi.spyOn(careerApi, 'downloadWord').mockResolvedValue(undefined);
      const errors: unknown[] = [];
      render(
        <ResumePanel
          resume={resume}
          {...props}
          run={async (_message, task) => {
            try {
              await task();
            } catch (error) {
              errors.push(error);
            }
          }}
        />
      );
      fireEvent.change(await screen.findByDisplayValue(data.summary!), {
        target: { value: '旧窗口的未保存编辑' },
      });
      fireEvent.click(screen.getByRole('button', { name: `导出 ${format}` }));
      await waitFor(() => expect(errors).toEqual([conflict]));
      expect(save).toHaveBeenCalledWith(
        expect.objectContaining({ expected_revision: 'saved-revision' }),
        resume.id
      );
      expect(pdf).not.toHaveBeenCalled();
      expect(word).not.toHaveBeenCalled();
      expect(props.onSaved).not.toHaveBeenCalled();
      expect(screen.getByDisplayValue('旧窗口的未保存编辑')).toBeVisible();
    }
  );
});

vi.mock('@/lib/context/language-context', () => ({
  useLanguage: () => ({ uiLanguage: 'zh', accountProfile: null }),
}));

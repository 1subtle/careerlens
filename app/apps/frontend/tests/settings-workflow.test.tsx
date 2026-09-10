import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SettingsPage from '@/app/(default)/settings/page';
import { PROVIDER_INFO } from '@/lib/api/config';

const mocks = vi.hoisted(() => ({
  t: (key: string) => key,
  refreshStatus: vi.fn(async () => {}),
  fetchLlmConfig: vi.fn(),
  fetchFeatureConfig: vi.fn(),
  fetchPromptConfig: vi.fn(),
  fetchFeaturePrompts: vi.fn(),
  fetchApiKeyStatus: vi.fn(),
  updateLlmConfig: vi.fn(),
  updateApiKeys: vi.fn(),
  testLlmConnection: vi.fn(),
  updateFeaturePrompts: vi.fn(),
  resetDatabase: vi.fn(),
}));

afterEach(() => vi.restoreAllMocks());

vi.mock('@/lib/api/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/config')>()),
  ...mocks,
}));
vi.mock('@/lib/i18n', () => ({ useTranslations: () => ({ t: mocks.t }) }));
vi.mock('@/lib/context/language-context', () => ({
  useLanguage: () => ({
    contentLanguage: 'zh',
    uiLanguage: 'zh',
    setContentLanguage: vi.fn(),
    setUiLanguage: vi.fn(),
    languageNames: { zh: '中文', en: 'English' },
    supportedLanguages: ['zh', 'en'],
    isLoading: false,
  }),
}));
vi.mock('@/lib/context/status-cache', () => ({
  useStatusCache: () => ({
    status: {
      status: 'ready',
      llm_configured: true,
      llm_healthy: true,
      has_master_resume: false,
      database_stats: { total_resumes: 0, total_jobs: 0, total_improvements: 0 },
    },
    isLoading: false,
    lastFetched: null,
    refreshStatus: mocks.refreshStatus,
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchLlmConfig.mockResolvedValue({
    provider: 'deepseek',
    model: 'deepseek-test',
    api_key: '',
    api_base: null,
    reasoning_effort: null,
  });
  mocks.fetchApiKeyStatus.mockResolvedValue({
    providers: [{ provider: 'deepseek', configured: true, masked_key: '****demo' }],
  });
  mocks.fetchFeatureConfig.mockResolvedValue({
    enable_cover_letter: false,
    enable_outreach_message: false,
    enable_interview_prep: false,
  });
  mocks.fetchPromptConfig.mockResolvedValue({ default_prompt_id: 'keywords', prompt_options: [] });
  mocks.fetchFeaturePrompts.mockResolvedValue({
    cover_letter_prompt: '',
    outreach_message_prompt: '',
    cover_letter_default: '',
    outreach_message_default: '',
  });
  mocks.updateLlmConfig.mockResolvedValue({});
  mocks.resetDatabase.mockResolvedValue({});
});

describe('CareerLens settings workflow', () => {
  it('loads the configured model in a compact selector and saves without replacing its key', async () => {
    render(<SettingsPage />);
    await screen.findByDisplayValue('deepseek-test');

    const provider = screen.getByRole('combobox', { name: 'AI 服务商' });
    expect(provider).toHaveValue('deepseek');
    expect(within(provider).getAllByRole('option')).toHaveLength(9);
    expect(screen.getByText('工作台 AI 已连接')).toBeInTheDocument();
    expect(screen.getByText('AI 模型设置').closest('section')).toBeVisible();
    expect(screen.getByText('接口与高级设置').closest('details')).not.toHaveAttribute('open');
    expect(screen.getByText('settings.dangerZone').closest('details')).not.toHaveAttribute('open');

    fireEvent.click(screen.getByRole('button', { name: '保存设置' }));
    await waitFor(() =>
      expect(mocks.updateLlmConfig).toHaveBeenCalledWith({
        provider: 'deepseek',
        model: 'deepseek-test',
        api_base: null,
        reasoning_effort: '',
      })
    );
    expect(mocks.updateApiKeys).not.toHaveBeenCalled();
  });

  it('opens required endpoint settings on provider change and tests the current form', async () => {
    mocks.testLlmConnection.mockResolvedValue({
      healthy: true,
      provider: 'azure_foundry',
      model: PROVIDER_INFO.azure_foundry.defaultModel,
    });
    render(<SettingsPage />);
    await screen.findByDisplayValue('deepseek-test');

    fireEvent.change(screen.getByRole('combobox', { name: 'AI 服务商' }), {
      target: { value: 'azure_foundry' },
    });
    expect(screen.getByLabelText('settings.llmConfiguration.modelLabel')).toHaveValue(
      PROVIDER_INFO.azure_foundry.defaultModel
    );
    expect(screen.getByText('接口与高级设置').closest('details')).toHaveAttribute('open');
    fireEvent.change(screen.getByLabelText(/azureBaseUrlLabel/), {
      target: { value: 'https://example.test/models' },
    });
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }));
    await waitFor(() =>
      expect(mocks.testLlmConnection).toHaveBeenCalledWith({
        provider: 'azure_foundry',
        model: PROVIDER_INFO.azure_foundry.defaultModel,
        api_base: 'https://example.test/models',
        reasoning_effort: '',
      })
    );
    expect(mocks.updateLlmConfig).not.toHaveBeenCalled();
  });

  it('keeps database reset behind the collapsed group and an explicit confirmation', async () => {
    render(<SettingsPage />);
    await screen.findByDisplayValue('deepseek-test');

    fireEvent.click(screen.getByText('settings.dangerZone'));
    fireEvent.click(screen.getByRole('button', { name: 'settings.resetDatabase' }));
    const dialog = screen.getByRole('dialog', { name: 'confirmations.resetDatabase' });
    expect(mocks.resetDatabase).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'common.reset' }));
    await waitFor(() => expect(mocks.resetDatabase).toHaveBeenCalledOnce());
  });

  it('protects unsaved model changes on return and reload, then clears the guard after saving', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<SettingsPage />);
    await screen.findByDisplayValue('deepseek-test');

    fireEvent.change(screen.getByLabelText('settings.llmConfiguration.modelLabel'), {
      target: { value: 'updated-model' },
    });
    expect(screen.getByText('有未保存的修改')).toBeInTheDocument();
    expect(fireEvent.click(screen.getByRole('link', { name: '返回工作台' }))).toBe(false);
    expect(confirm).toHaveBeenCalledOnce();
    expect(window.dispatchEvent(new Event('beforeunload', { cancelable: true }))).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: '保存设置' }));
    await waitFor(() => expect(screen.queryByText('有未保存的修改')).not.toBeInTheDocument());
    expect(window.dispatchEvent(new Event('beforeunload', { cancelable: true }))).toBe(true);
  });

  it('keeps the other prompt draft when saving one custom prompt', async () => {
    mocks.fetchFeatureConfig.mockResolvedValue({
      enable_cover_letter: true,
      enable_outreach_message: true,
      enable_interview_prep: false,
    });
    mocks.updateFeaturePrompts.mockResolvedValue({
      cover_letter_prompt: 'Saved cover letter prompt',
      outreach_message_prompt: '',
    });
    render(<SettingsPage />);
    await screen.findByDisplayValue('deepseek-test');

    const cover = document.getElementById('coverLetterPrompt')!;
    const outreach = document.getElementById('outreachPrompt')!;
    fireEvent.change(cover, { target: { value: 'Saved cover letter prompt' } });
    fireEvent.change(outreach, { target: { value: 'Unfinished outreach draft' } });
    const editor = cover.closest('details')!;
    fireEvent.click(editor.querySelector('summary')!);
    fireEvent.click(within(editor).getByRole('button', { name: 'common.save' }));
    await waitFor(() => expect(mocks.updateFeaturePrompts).toHaveBeenCalledOnce());
    expect(outreach).toHaveValue('Unfinished outreach draft');
    expect(screen.getByText('有未保存的修改')).toBeInTheDocument();
  });
});

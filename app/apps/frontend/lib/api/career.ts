import type { ResumeData } from '@/components/dashboard/resume-component';
import { apiFetch, apiPost, apiPut, apiDelete } from './client';
import { downloadResumePdf } from './resume';
import type { TemplateSettings } from '@/lib/types/template-settings';

export interface CareerResume {
  id: string;
  title: string;
  data: ResumeData;
  hash: string;
  revision?: string;
  is_master: boolean;
  parent_id: string | null;
  source_text: string;
  created_at: string;
  updated_at: string;
  template_settings?: TemplateSettings | null;
}
export interface Requirement {
  id: string;
  name: string;
  source_text: string;
  priority: 'required' | 'preferred';
}
export interface CareerJob {
  job_id: string;
  version: number;
  title?: string;
  company?: string;
  category?: string;
  city?: string;
  salary_text?: string;
  source_url?: string;
  source_type?: 'manual' | 'course' | 'synthetic' | 'api';
  source_name?: string;
  source_updated_at?: string | null;
  external_id?: string;
  published_at?: string | null;
  content: string;
  requirements?: Requirement[];
  created_at: string;
}
export interface Evidence {
  id: string;
  title: string;
  text: string;
  kind: string;
  source_hash: string;
}
export type EvidenceStatus = 'supported' | 'mentioned' | 'pending' | 'gap';
export interface MatchDetail extends Requirement {
  confirmed_by?: 'user';
  status: EvidenceStatus;
  weight: number;
  value: number;
  contribution: number;
  evidence_ids: string[];
  reason: string;
  candidates?: { evidence_id: string; similarity: number }[];
}
export interface Condition {
  name: string;
  requirement: string;
  observed: string;
  status: string;
  confirmed_by?: string;
}
export interface ResumeReference {
  evidence_id: string;
  quote: string;
}
export interface AnalysisFinding {
  title: string;
  detail: string;
  resume_refs: ResumeReference[];
  jd_refs: { quote: string }[];
}
export interface AiMatchAnalysis {
  mode: 'ai';
  provider: string;
  model: string;
  analyzed_at: string;
  fit_score: number;
  summary: string;
  strengths: AnalysisFinding[];
  gaps: AnalysisFinding[];
  actions: AnalysisFinding[];
  score_note: string;
  requirement_matches?: {
    requirement_id: string;
    status: 'matched' | 'partial' | 'missing';
    reason: string;
    resume_refs: ResumeReference[];
    suggestion: string;
  }[];
}
export interface CareerDirections {
  history_id?: string;
  created_at?: string;
  input_hash?: string;
  input_snapshot?: { resume: CareerResume; jobs: CareerJob[]; use_ai: boolean };
  mode: 'ai';
  provider: string;
  model: string;
  analyzed_at: string;
  resume_id: string;
  resume_hash: string;
  evidence: Evidence[];
  summary: string;
  directions: {
    title: string;
    reason: string;
    resume_refs: ResumeReference[];
    next_steps: string[];
  }[];
  saved_jobs: {
    job_id: string;
    title: string;
    company: string;
    source_url: string;
    reason: string;
    resume_refs: ResumeReference[];
    jd_refs: { quote: string }[];
  }[];
  scope_note: string;
}
export interface Rewrite {
  id: string;
  match_id: string;
  section_id: string;
  draft: string;
  reason: string;
  missing_facts: string[];
  star?: {
    stage: 'S' | 'T' | 'A' | 'R';
    evidence: string;
    question: string;
    source_ids: string[];
  }[];
  keyword_suggestions?: { keyword: string; suggestion: string }[];
  quantification_suggestions?: string[];
  mode: string;
  provider?: string;
  model?: string | { provider: string; model: string; configured?: boolean } | null;
  analyzed_at?: string;
  improvement?: { status: 'improved' | 'unchanged' | 'rules'; summary: string; retried: boolean };
  status: string;
  result_resume_id: string | null;
  claims: { text: string; source_ids: string[] }[];
  sources: { id: string; text: string; type: string }[];
  changes?: { text: string; type: 'expression' | 'user_fact'; source_ids: string[] }[];
  fact_check?: { status: string };
}
export interface Match {
  id: string;
  snapshot_id: string;
  resume_id: string;
  resume_hash: string;
  resume_data: ResumeData;
  job_id: string;
  job: CareerJob;
  evidence: Evidence[];
  details: MatchDetail[];
  score: number | null;
  ai_analysis?: AiMatchAnalysis;
  conditions: Condition[];
  retrieval?: { mode: string; model?: string; revision?: string; message?: string };
  rule_version: string;
  created_at: string;
  stale?: boolean;
  rewrites?: Rewrite[];
}
export interface CareerState {
  resumes: CareerResume[];
  jobs: CareerJob[];
  matches: { id: string; score: number | null; job_id: string; created_at: string }[];
  model: { provider: string; model: string; configured: boolean };
  rule_version: string;
  semantic?: { ready: boolean; model: string; revision: string };
}
export interface Comparison {
  resume_id: string;
  resume_hash: string;
  snapshot_id: string;
  rule_version: string;
  matches: Match[];
}
export interface MarketFilters {
  category: string;
  city: string;
  since: string | null;
  include_demo: boolean;
}
export interface MarketSummary {
  history_id?: string;
  created_at?: string;
  count: number;
  demo_count: number;
  salary_missing: number;
  dataset_hash: string;
  date: string;
  filters: MarketFilters;
  job_ids: string[];
  coverage?: {
    sample_count: number;
    published_count: number;
    published_missing: number;
    published_min: string | null;
    published_max: string | null;
    date_basis: 'published_at';
    date_excluded_count: number;
    demo_excluded_count: number;
    duplicates_removed: number;
    unknown_category_count: number;
  };
  skills: { name: string; value: number; job_ids: string[] }[];
  salaries: {
    job_id: string;
    title: string;
    category: string;
    raw: string;
    currency: string;
    period: string;
    min: number;
    max: number;
    mid: number;
  }[];
  distribution: {
    category: string;
    count: number;
    skills: { name: string; count: number; percent: number }[];
  }[];
}
export interface MarketAnalysis {
  history_id?: string;
  created_at?: string;
  source?: 'saved' | 'live';
  input_hash?: string;
  input_snapshot?: { jobs: CareerJob[]; filters: MarketFilters; question: string; use_ai: boolean };
  summary: MarketSummary;
  points: string[];
  advice: string;
  mode: string;
  job_ids: string[];
}
export interface DirectionHistoryItem {
  id: string;
  resume_id: string;
  resume_title: string;
  summary: string;
  created_at: string;
}
export interface MarketHistoryItem {
  id: string;
  source: 'saved' | 'live';
  created_at: string;
  question: string;
  count: number;
  mode: string;
}
export interface LiveJob extends Omit<CareerJob, 'version'> {
  version?: number;
  external_id: string;
  description_complete: boolean;
  salary_display?: string;
  remote_scope?: string;
}
export type RecruitmentProvider = 'ncss' | 'jobicy' | 'tencent';
export interface LiveJobs {
  provider: RecruitmentProvider;
  source_name: string;
  source_url: string;
  fetched_at: string;
  total: number;
  total_kind: 'sample' | 'platform' | 'capped';
  has_more?: boolean;
  coverage: string;
  update_note: string;
  cached: boolean;
  page: number;
  page_size: number;
  jobs: LiveJob[];
  summary: MarketSummary;
  warnings: string[];
}

export class CareerApiError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
  }
}

async function json<T>(request: Promise<Response>): Promise<T> {
  const response = await request;
  const body = await response.json();
  if (!response.ok) {
    const message =
      typeof body.detail === 'string'
        ? body.detail
        : Array.isArray(body.detail)
          ? body.detail.map((item: { msg: string }) => item.msg).join('；')
          : '请求未完成，请重试。';
    throw new CareerApiError(message, response.status);
  }
  return body as T;
}

const path = '/career';
export const careerApi = {
  state: () => json<CareerState>(apiFetch(`${path}/state`)),
  demo: () => json<CareerState>(apiPost(`${path}/demo`, {})),
  parseResume: (text: string, use_ai: boolean) =>
    json<{ data: ResumeData; source_text: string; mode: string }>(
      apiPost(`${path}/resumes/parse`, { text, use_ai })
    ),
  parseFile: (file: File, use_ai = false) => {
    const body = new FormData();
    body.append('file', file);
    body.append('use_ai', String(use_ai));
    return json<{ data: ResumeData; source_text: string; mode: string; warning?: string }>(
      apiFetch(`${path}/resumes/file`, { method: 'POST', body })
    );
  },
  saveResume: (
    data: {
      title: string;
      data: ResumeData;
      source_text: string;
      expected_hash?: string;
      expected_revision?: string;
      template_settings?: TemplateSettings;
    },
    id?: string
  ) =>
    json<CareerResume>(
      id ? apiPut(`${path}/resumes/${id}`, data) : apiPost(`${path}/resumes`, data)
    ),
  deleteResume: (id: string) => json(apiDelete(`${path}/resumes/${id}`)),
  parseJob: (text: string, use_ai: boolean) =>
    json<{ requirements: Requirement[] }>(apiPost(`${path}/jobs/parse`, { text, use_ai })),
  saveJob: (
    data: Omit<CareerJob, 'job_id' | 'created_at' | 'content' | 'version'> & {
      text: string;
      expected_version?: number;
    },
    id?: string
  ) => json<CareerJob>(id ? apiPut(`${path}/jobs/${id}`, data) : apiPost(`${path}/jobs`, data)),
  getJob: (id: string) => json<CareerJob>(apiFetch(`${path}/jobs/${id}`)),
  deleteJob: (id: string) => json(apiDelete(`${path}/jobs/${id}`)),
  match: (resume_id: string, job_id: string, use_semantic = false, use_ai = false) =>
    json<Match>(apiPost(`${path}/matches`, { resume_id, job_id, use_semantic, use_ai })),
  compare: (resume_id: string, job_ids: string[], use_semantic: boolean, use_ai = false) =>
    json<Comparison>(
      apiPost(`${path}/matches/compare`, { resume_id, job_ids, use_semantic, use_ai })
    ),
  directions: (resume_id: string, use_ai: boolean) =>
    json<CareerDirections>(apiPost(`${path}/directions`, { resume_id, use_ai })),
  directionHistory: () => json<DirectionHistoryItem[]>(apiFetch(`${path}/directions/history`)),
  getDirectionHistory: (id: string) =>
    json<CareerDirections>(apiFetch(`${path}/directions/history/${id}`)),
  deleteDirectionHistory: (id: string) => json(apiDelete(`${path}/directions/history/${id}`)),
  getMatch: (id: string) => json<Match>(apiFetch(`${path}/matches/${id}`)),
  review: (id: string, requirement_id: string, status: EvidenceStatus, evidence_ids: string[]) =>
    json<Match>(apiPost(`${path}/matches/${id}/review`, { requirement_id, status, evidence_ids })),
  confirmCondition: (id: string, name: string, status: string, observed: string) =>
    json<Match>(apiPost(`${path}/matches/${id}/conditions`, { name, status, observed })),
  rewrite: (match_id: string, section_id: string, facts: string[], use_ai: boolean) =>
    json<Rewrite>(apiPost(`${path}/rewrites`, { match_id, section_id, facts, use_ai })),
  apply: (id: string) =>
    json<{ resume: CareerResume; rewrite: Rewrite }>(
      apiPost(`${path}/rewrites/${id}/apply`, { confirmed: true })
    ),
  reject: (id: string) => json<Rewrite>(apiPost(`${path}/rewrites/${id}/reject`, {})),
  market: (filters: MarketFilters) =>
    json<MarketSummary>(apiPost(`${path}/market/summary`, filters)),
  analyze: (filters: MarketFilters, question: string, use_ai: boolean) =>
    json<MarketAnalysis>(apiPost(`${path}/market/analyze`, { ...filters, question, use_ai })),
  marketHistory: () => json<MarketHistoryItem[]>(apiFetch(`${path}/market/history`)),
  getMarketHistory: (id: string) => json<MarketAnalysis>(apiFetch(`${path}/market/history/${id}`)),
  deleteMarketHistory: (id: string) => json(apiDelete(`${path}/market/history/${id}`)),
  liveJobs: (keyword: string, page = 1, provider: RecruitmentProvider = 'ncss', geo = '') =>
    json<LiveJobs>(
      apiFetch(
        `${path}/live/jobs?${new URLSearchParams({ keyword, page: String(page), provider, geo })}`
      )
    ),
  rememberLiveJob: (id: string, provider: RecruitmentProvider = 'ncss', keyword = '', geo = '') =>
    json<CareerJob>(
      apiPost(
        `${path}/live/jobs/${encodeURIComponent(id)}/remember?${new URLSearchParams({ provider, keyword, geo })}`,
        {}
      )
    ),
  analyzeLiveJobs: (jobs: LiveJob[], question: string, use_ai: boolean) =>
    json<MarketAnalysis>(
      apiPost(`${path}/live/analyze`, {
        jobs: jobs
          .filter((job) => job.description_complete)
          .map((job) => ({
            title: job.title,
            company: job.company,
            category: job.category,
            city: job.city,
            salary_text: job.salary_text,
            source_url: job.source_url,
            source_type: job.source_type,
            source_name: job.source_name,
            source_updated_at: job.source_updated_at,
            external_id: job.external_id,
            published_at: job.published_at,
            requirements: job.requirements,
            text: job.content,
          })),
        question,
        use_ai,
      })
    ),
  downloadPdf: async (id: string, settings?: TemplateSettings) => {
    saveBlob(await downloadResumePdf(id, settings, 'zh'), `CareerLens-${id.slice(0, 8)}.pdf`);
  },
  downloadWord: async (id: string) => {
    const response = await apiFetch(`/resumes/${encodeURIComponent(id)}/docx`);
    if (!response.ok) {
      const body = await response.json();
      throw new Error(body.detail || 'Word 导出失败，请重试。');
    }
    saveBlob(await response.blob(), `CareerLens-${id.slice(0, 8)}.docx`);
  },
};

export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function saveJson(data: unknown, filename: string): void {
  saveBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), filename);
}

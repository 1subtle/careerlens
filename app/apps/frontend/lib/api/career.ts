import type { ResumeData } from '@/components/dashboard/resume-component';
import { apiFetch, apiPost, apiPut, apiDelete } from './client';

export interface CareerResume {
  id: string;
  title: string;
  data: ResumeData;
  hash: string;
  is_master: boolean;
  parent_id: string | null;
  source_text: string;
  created_at: string;
  updated_at: string;
}
export interface Requirement {
  id: string;
  name: string;
  source_text: string;
  priority: 'required' | 'preferred';
}
export interface CareerJob {
  job_id: string;
  title?: string;
  company?: string;
  category?: string;
  city?: string;
  salary_text?: string;
  source_url?: string;
  source_type?: 'manual' | 'course' | 'synthetic';
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
  status: EvidenceStatus;
  weight: number;
  value: number;
  contribution: number;
  evidence_ids: string[];
  reason: string;
}
export interface Rewrite {
  id: string;
  match_id: string;
  section_id: string;
  draft: string;
  reason: string;
  missing_facts: string[];
  mode: string;
  status: string;
  result_resume_id: string | null;
  claims: { text: string; source_ids: string[] }[];
  sources: { id: string; text: string; type: string }[];
}
export interface Match {
  id: string;
  resume_id: string;
  resume_hash: string;
  resume_data: ResumeData;
  job_id: string;
  job: CareerJob;
  evidence: Evidence[];
  details: MatchDetail[];
  score: number | null;
  conditions: { name: string; requirement: string; observed: string; status: string }[];
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
}
export interface MarketFilters {
  category: string;
  city: string;
  since: string | null;
  include_demo: boolean;
}
export interface MarketSummary {
  count: number;
  demo_count: number;
  salary_missing: number;
  dataset_hash: string;
  date: string;
  filters: MarketFilters;
  job_ids: string[];
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
  summary: MarketSummary;
  points: string[];
  advice: string;
  mode: string;
  job_ids: string[];
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
    throw new Error(message);
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
  parseFile: (file: File) => {
    const body = new FormData();
    body.append('file', file);
    return json<{ data: ResumeData; source_text: string; mode: string }>(
      apiFetch(`${path}/resumes/file`, { method: 'POST', body })
    );
  },
  saveResume: (
    data: { title: string; data: ResumeData; source_text: string; expected_hash?: string },
    id?: string
  ) =>
    json<CareerResume>(
      id ? apiPut(`${path}/resumes/${id}`, data) : apiPost(`${path}/resumes`, data)
    ),
  deleteResume: (id: string) => json(apiDelete(`${path}/resumes/${id}`)),
  parseJob: (text: string, use_ai: boolean) =>
    json<{ requirements: Requirement[] }>(apiPost(`${path}/jobs/parse`, { text, use_ai })),
  saveJob: (
    data: Omit<CareerJob, 'job_id' | 'created_at' | 'content'> & { text: string },
    id?: string
  ) => json<CareerJob>(id ? apiPut(`${path}/jobs/${id}`, data) : apiPost(`${path}/jobs`, data)),
  deleteJob: (id: string) => json(apiDelete(`${path}/jobs/${id}`)),
  match: (resume_id: string, job_id: string) =>
    json<Match>(apiPost(`${path}/matches`, { resume_id, job_id })),
  getMatch: (id: string) => json<Match>(apiFetch(`${path}/matches/${id}`)),
  review: (id: string, requirement_id: string, status: EvidenceStatus, evidence_ids: string[]) =>
    json<Match>(apiPost(`${path}/matches/${id}/review`, { requirement_id, status, evidence_ids })),
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
  downloadPdf: async (id: string) => {
    const response = await apiFetch(`/resumes/${id}/pdf?template=swiss-single&pageSize=A4&lang=zh`);
    if (!response.ok) {
      const body = await response.json();
      throw new Error(body.detail || 'PDF 导出失败，请重试。');
    }
    saveBlob(await response.blob(), `CareerLens-${id.slice(0, 8)}.pdf`);
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

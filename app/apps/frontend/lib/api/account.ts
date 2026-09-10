import { apiFetch, apiPost } from './client';
import type { Locale } from '@/i18n/config';

export interface AccountProfile {
  id: string;
  email: string;
  created_at: number;
  display_name: string;
  ui_language: Locale;
  content_language: Locale;
  timezone: string;
}

export type AccountProfileUpdate = Partial<
  Pick<AccountProfile, 'display_name' | 'ui_language' | 'content_language' | 'timezone'>
>;

export interface AccountSession {
  id: string;
  created_at: number | null;
  expires_at: number;
  current: boolean;
  user_agent: string;
}

async function checked(request: Promise<Response>): Promise<Response> {
  const response = await request;
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(
      typeof body.detail === 'string' ? body.detail : 'Account request failed. Please retry.'
    );
  }
  return response;
}

async function result<T>(request: Promise<Response>): Promise<T> {
  return (await checked(request)).json() as Promise<T>;
}

export const accountApi = {
  profile: () => result<AccountProfile>(apiFetch('/account/profile')),
  updateProfile: (update: AccountProfileUpdate) =>
    result<AccountProfile>(
      apiFetch('/account/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(update),
      })
    ),
  sessions: () => result<{ items: AccountSession[] }>(apiFetch('/account/sessions')),
  revokeSession: async (id: string) => {
    await checked(apiFetch(`/account/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }));
  },
  revokeOthers: () => result<{ revoked: number }>(apiPost('/account/sessions/revoke-others', {})),
  exportData: async () => (await checked(apiFetch('/account/export'))).blob(),
};

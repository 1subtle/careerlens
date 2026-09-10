import { apiFetch, apiPost } from './client';

export interface AuthSession {
  mode: 'local' | 'hosted';
  user: { id: string; email: string; credits: number } | null;
  email_login_available: boolean;
  github_url: string | null;
}
export interface EmailChallenge {
  challenge_id: string;
  email: string;
  retry_after_seconds: number;
  expires_in_seconds: number;
}

export class AuthError extends Error {
  constructor(
    message: string,
    public retryAfter = 0
  ) {
    super(message);
  }
}
async function result<T>(request: Promise<Response>): Promise<T> {
  const response = await request;
  const body = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new AuthError(
      typeof body?.detail === 'string' ? body.detail : '请求未完成，请重试。',
      Number(response.headers.get('Retry-After')) || 0
    );
  return body as T;
}
async function sessionResult(request: Promise<Response>): Promise<AuthSession> {
  const value = await result<AuthSession>(request);
  if (
    !value ||
    !['local', 'hosted'].includes(value.mode) ||
    typeof value.email_login_available !== 'boolean' ||
    !(value.github_url === null || typeof value.github_url === 'string') ||
    !(
      value.user === null ||
      (typeof value.user?.id === 'string' &&
        !!value.user.id &&
        typeof value.user.email === 'string' &&
        Number.isSafeInteger(value.user.credits) &&
        value.user.credits >= 0)
    )
  )
    throw new AuthError('登录服务返回异常，请重试。');
  return value;
}
export const authApi = {
  session: () => sessionResult(apiFetch('/auth/session')),
  start: (email: string) => result<EmailChallenge>(apiPost('/auth/email/start', { email })),
  verify: (email: string, code: string, challenge_id: string) =>
    sessionResult(apiPost('/auth/email/verify', { email, code, challenge_id })),
  logout: () => result<unknown>(apiPost('/auth/logout', {})),
};

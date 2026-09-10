import { afterEach, expect, it, vi } from 'vitest';
import { printSessionHeaders } from '@/app/print/session-headers';

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
  }),
}));
afterEach(() => jar.clear());

it('forwards only the hosted session cookie, with the secure name taking precedence', async () => {
  jar.set('analytics', 'private-unrelated');
  jar.set('__Host-careerlens_session', 'secure-session');
  jar.set('careerlens_session', 'development-session');
  expect(await printSessionHeaders()).toEqual({
    Cookie: '__Host-careerlens_session=secure-session',
  });
});

it('supports loopback development sessions and omits credentials for anonymous requests', async () => {
  expect(await printSessionHeaders()).toEqual({});
  jar.set('analytics', 'private-unrelated');
  expect(await printSessionHeaders()).toEqual({});
  jar.set('careerlens_session', 'development-session');
  expect(await printSessionHeaders()).toEqual({ Cookie: 'careerlens_session=development-session' });
});

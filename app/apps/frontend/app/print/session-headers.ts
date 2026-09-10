import { cookies } from 'next/headers';

export async function printSessionHeaders(): Promise<HeadersInit> {
  const cookieJar = await cookies();
  const session = cookieJar.get('__Host-careerlens_session') ?? cookieJar.get('careerlens_session');
  return session ? { Cookie: `${session.name}=${session.value}` } : {};
}

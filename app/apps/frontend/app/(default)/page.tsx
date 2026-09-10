import CareerWorkspace from '@/components/career/workspace';
import { isAccountSection } from '@/lib/account-sections';
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ account?: string | string[] }>;
}) {
  const { account } = await searchParams;
  return (
    <CareerWorkspace initialAccountSection={isAccountSection(account) ? account : undefined} />
  );
}

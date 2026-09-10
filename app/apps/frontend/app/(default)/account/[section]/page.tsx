import { notFound, redirect } from 'next/navigation';
import { isAccountSection } from '@/lib/account-sections';
export default async function AccountSectionPage({
  params,
}: {
  params: Promise<{ section: string }>;
}) {
  const { section } = await params;
  if (!isAccountSection(section)) notFound();
  redirect(`/?account=${section}`);
}

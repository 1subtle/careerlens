'use client';
import CareerWorkspace from '@/components/career/workspace';
import type { AccountSection } from '@/lib/account-sections';
export function AccountPage({ section = 'wallet' }: { section?: AccountSection }) {
  return <CareerWorkspace initialAccountSection={section} />;
}

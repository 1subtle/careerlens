export const accountSections = [
  'wallet',
  'orders',
  'usage',
  'settings',
  'security',
  'data',
] as const;
export type AccountSection = (typeof accountSections)[number];
export function isAccountSection(value: unknown): value is AccountSection {
  return typeof value === 'string' && accountSections.includes(value as AccountSection);
}

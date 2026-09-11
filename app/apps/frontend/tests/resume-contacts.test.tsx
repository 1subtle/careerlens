import { render, screen, within } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import Resume, { type ResumeData } from '@/components/dashboard/resume-component';
import { CAREER_LAYOUT_DEFAULTS } from '@/lib/utils/career-layout';
import { getSortedSections, DEFAULT_SECTION_META } from '@/lib/utils/section-helpers';

const data: ResumeData = {
  personalInfo: {
    name: '测试同学',
    title: 'AI 产品实习生',
    email: 'research@example.com',
    phone: '13800000000',
    location: '北京',
    website: 'example.com/portfolio',
  },
  education: [
    { id: 1, institution: '本科院校', degree: '本科 · 信息管理', years: '2019–2023' },
    { id: 2, institution: '在读院校', degree: '硕士 · 计算机科学', years: '2024–至今' },
  ],
};
describe('contact labels shared by all selectable templates', () => {
  it.each([
    'swiss-single',
    'clean',
    'modern',
    'latex',
    'vivid',
    'campus',
    'ledger',
    'timeline',
    'fresh',
    'sidebar',
  ] as const)('%s keeps labeled links and does not duplicate contacts', (template) => {
    const { container } = render(
      <Resume resumeData={data} settings={{ ...CAREER_LAYOUT_DEFAULTS, template }} locale="zh" />
    );
    const header = within(container.querySelector('header')!);
    expect(header.getByText('在读院校')).toBeVisible();
    expect(header.getByText('硕士 · 计算机科学')).toBeVisible();
    expect(header.queryByText('本科院校')).not.toBeInTheDocument();
    for (const label of ['邮箱', '电话', '所在地', '个人网站'])
      expect(screen.getByText(label)).toBeVisible();
    expect(screen.getByRole('link', { name: 'research@example.com' })).toHaveAttribute(
      'href',
      'mailto:research@example.com'
    );
    expect(screen.getByRole('link', { name: '13800000000' })).toHaveAttribute(
      'href',
      'tel:13800000000'
    );
    expect(screen.getByRole('link', { name: 'example.com/portfolio' })).toHaveAttribute(
      'href',
      'https://example.com/portfolio'
    );
  });
  it('puts education before experience and retains a custom section order', () => {
    expect(
      getSortedSections(data)
        .map((section) => section.key)
        .slice(0, 3)
    ).toEqual(['personalInfo', 'education', 'summary']);
    const custom = DEFAULT_SECTION_META.map((section) => ({
      ...section,
      order: section.key === 'workExperience' ? 1 : section.key === 'education' ? 3 : section.order,
    }));
    expect(getSortedSections({ ...data, sectionMeta: custom })[1].key).toBe('workExperience');
  });
});

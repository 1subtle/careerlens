import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ResumeForm } from '@/components/builder/resume-form';
import type { ResumeData } from '@/components/dashboard/resume-component';

vi.mock('@/lib/i18n', () => ({
  useTranslations: () => ({ t: (key: string) => key }),
}));

const initial: ResumeData = {
  personalInfo: { name: '林同学', title: '', email: '', phone: '', location: '' },
  summary: '研究用户行为。',
  education: [
    { id: 1, institution: '示例大学', degree: '本科', years: '2022–2026', description: '' },
  ],
  workExperience: [],
  personalProjects: [],
  additional: {
    technicalSkills: ['Python'],
    languages: [],
    certificationsTraining: [],
    awards: [],
  },
};

describe('CareerLens resume chapters', () => {
  it('opens the initial chapter and preserves other chapters while editing a collapsed form', () => {
    const update = vi.fn();
    function Editor() {
      const [data, setData] = useState(initial);
      return (
        <ResumeForm
          resumeData={data}
          collapsible
          initiallyOpenSection="personalInfo"
          onUpdate={(next) => {
            setData(next);
            update(next);
          }}
        />
      );
    }
    render(<Editor />);
    expect(
      screen.getByText('Personal Info', { selector: 'summary span' }).closest('details')
    ).toHaveAttribute('open');
    const education = screen
      .getByText('Education', { selector: 'summary span' })
      .closest('details')!;
    expect(education).not.toHaveAttribute('open');
    expect(education.querySelector('summary')).toHaveTextContent('1 项');
    fireEvent.change(screen.getByDisplayValue('林同学'), { target: { value: '林小夏' } });
    fireEvent.click(education.querySelector('summary')!);
    expect(education).toHaveAttribute('open');
    fireEvent.change(screen.getByDisplayValue('示例大学'), { target: { value: '未来大学' } });
    expect(update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        personalInfo: expect.objectContaining({ name: '林小夏' }),
        education: [expect.objectContaining({ institution: '未来大学' })],
        summary: initial.summary,
        additional: initial.additional,
      })
    );
  });

  it('keeps existing builder forms expanded when the opt-in flag is absent', () => {
    const { container } = render(<ResumeForm resumeData={initial} onUpdate={vi.fn()} />);
    expect(container.querySelector('details')).toBeNull();
    expect(screen.getByDisplayValue('林同学')).toBeVisible();
    expect(screen.getByDisplayValue('示例大学')).toBeVisible();
  });
});

import { useRef, useState } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ResumeForm } from '@/components/builder/resume-form';
import type { ResumeData } from '@/components/dashboard/resume-component';
import { DEFAULT_SECTION_META } from '@/lib/utils/section-helpers';
import { useAutoSizeTextareas } from '@/hooks/use-autosize-textareas';

vi.mock('@/lib/i18n', () => ({ useTranslations: () => ({ t: (key: string) => key }) }));
let resizeCallbacks: ResizeObserverCallback[];
const disconnect = vi.fn();
beforeEach(() => {
  resizeCallbacks = [];
  disconnect.mockClear();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }
      observe() {}
      unobserve() {}
      disconnect = disconnect;
    }
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const initial: ResumeData = {
  personalInfo: { name: '林同学', title: '', email: '', phone: '', location: '' },
  summary: '研究用户行为。',
  education: [
    {
      id: 1,
      institution: '示例大学',
      degree: '本科',
      years: '2022–2026',
      description: '教育经历原文',
    },
  ],
  workExperience: [],
  personalProjects: [],
  additional: {
    technicalSkills: ['Python'],
    languages: [],
    certificationsTraining: [],
    awards: ['研究奖项'],
  },
  sectionMeta: [
    ...DEFAULT_SECTION_META,
    {
      id: 'custom-list',
      key: 'customList',
      displayName: '自定义清单',
      sectionType: 'stringList',
      isDefault: false,
      isVisible: true,
      order: 6,
    },
  ],
  customSections: { customList: { sectionType: 'stringList', strings: ['原有条目'] } },
};

describe('continuous resume document', () => {
  it('shows every chapter once and retains values, metadata and custom lines while editing', () => {
    const save = vi.fn();
    function Editor() {
      const [value, setValue] = useState(initial);
      return (
        <ResumeForm
          documentMode
          collapsible
          resumeData={value}
          onUpdate={(next) => {
            setValue(next);
            save(next);
          }}
        />
      );
    }
    const { container } = render(<Editor />);
    expect(container.querySelector('details')).toBeNull();
    expect(container.querySelectorAll('[id^="resume-section-"]')).toHaveLength(7);
    expect(screen.getAllByRole('heading', { name: 'Education' })).toHaveLength(1);
    expect(screen.queryByText('builder.additionalForm.instructions')).not.toBeInTheDocument();
    fireEvent.change(screen.getByDisplayValue('林同学'), { target: { value: '林小夏' } });
    fireEvent.change(screen.getByDisplayValue('研究奖项'), {
      target: { value: '研究奖项\n第二项荣誉' },
    });
    fireEvent.change(screen.getByDisplayValue('原有条目'), {
      target: { value: '原有条目\n\n新条目' },
    });
    const education = container.querySelector('#resume-section-education') as HTMLElement;
    fireEvent.click(
      within(education).getAllByRole('button', { name: 'builder.sectionHeader.hideSection' })[0]
    );
    fireEvent.click(
      within(education).getByRole('button', { name: 'builder.sectionHeader.moveUp' })
    );
    const saved = save.mock.lastCall![0] as ResumeData;
    expect(saved.personalInfo?.name).toBe('林小夏');
    expect(saved.summary).toBe(initial.summary);
    expect(saved.education).toEqual(initial.education);
    expect(saved.additional?.awards).toEqual(['研究奖项', '第二项荣誉']);
    expect(saved.customSections?.customList.strings).toEqual(['原有条目', '', '新条目']);
    expect(saved.sectionMeta?.find((section) => section.id === 'education')).toMatchObject({
      isVisible: false,
      order: 2,
    });
    expect(screen.getByDisplayValue('教育经历原文')).toBeVisible();
  });

  it('fits long initial and edited text, refits on width changes, and disconnects on unmount', () => {
    let lineLength = 20;
    vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockImplementation(function (this: Element) {
      return this instanceof HTMLTextAreaElement
        ? Math.ceil(this.value.length / lineLength) * 24 + 16
        : 0;
    });
    function LongText({ initialValue }: { initialValue: string }) {
      const [value, setValue] = useState(initialValue);
      const ref = useRef<HTMLDivElement>(null);
      useAutoSizeTextareas(ref, value);
      return (
        <div ref={ref}>
          <textarea
            aria-label="经历"
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        </div>
      );
    }
    const { unmount } = render(<LongText initialValue={'长段经历'.repeat(50)} />);
    const field = screen.getByLabelText('经历') as HTMLTextAreaElement;
    expect(field.style.height).toBe(`${field.scrollHeight}px`);
    expect(field.style.overflowY).toBe('hidden');
    fireEvent.change(field, { target: { value: '更长的内容'.repeat(100) } });
    const fullWidthHeight = parseInt(field.style.height);
    expect(fullWidthHeight).toBe(field.scrollHeight);
    lineLength = 10;
    act(() =>
      resizeCallbacks[0](
        [{ contentRect: { width: 320 } } as ResizeObserverEntry],
        {} as ResizeObserver
      )
    );
    expect(parseInt(field.style.height)).toBeGreaterThan(fullWidthHeight);
    expect(field.style.height).toBe(`${field.scrollHeight}px`);
    fireEvent.change(field, { target: { value: '简短经历' } });
    expect(parseInt(field.style.height)).toBeLessThan(fullWidthHeight);
    unmount();
    expect(disconnect).toHaveBeenCalledOnce();
  });
});

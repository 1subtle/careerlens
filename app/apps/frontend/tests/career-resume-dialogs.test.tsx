import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Editor } from '@tiptap/react';
import { LinkDialog } from '@/components/ui/link-dialog';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { AddSectionButton } from '@/components/builder/add-section-dialog';
import documentStyles from '@/components/builder/resume-document.module.css';

vi.mock('@/lib/i18n', () => ({ useTranslations: () => ({ t: (key: string) => key }) }));

describe('resume document modal boundaries', () => {
  it('keeps the complete link dialog outside document styles and applies the link', () => {
    const chain = {
      focus: vi.fn().mockReturnThis(),
      extendMarkRange: vi.fn().mockReturnThis(),
      setLink: vi.fn().mockReturnThis(),
      run: vi.fn(),
    };
    const editor = {
      state: { selection: { from: 1, to: 3 }, doc: { textBetween: () => '项目案例' } },
      getAttributes: () => ({}),
      isActive: () => false,
      chain: () => chain,
    } as unknown as Editor;
    const close = vi.fn();
    const { container } = render(
      <div className={documentStyles.document}>
        <LinkDialog editor={editor} onClose={close} />
      </div>
    );
    const url = screen.getByLabelText('URL');
    expect(container.querySelector('input')).toBeNull();
    expect(url.closest(`.${documentStyles.document}`)).toBeNull();
    expect(url.closest('.fixed')?.closest('body')).toBe(document.body);
    fireEvent.change(url, { target: { value: 'example.com/case' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add Link' }));
    expect(chain.setLink).toHaveBeenCalledWith({
      href: 'https://example.com/case',
      target: '_blank',
      rel: 'noopener noreferrer',
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it('keeps adding a custom section outside the document presentation rules', () => {
    const add = vi.fn();
    render(
      <div className={documentStyles.document}>
        <AddSectionButton onAdd={add} />
      </div>
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'builder.customSections.addCustomSectionButton' })
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog.closest(`.${documentStyles.document}`)).toBeNull();
    fireEvent.change(screen.getByPlaceholderText('builder.customSections.sectionNamePlaceholder'), {
      target: { value: '补充经历' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'builder.addSection' }));
    expect(add).toHaveBeenCalledWith('补充经历', 'text');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps deletion confirmation outside the document and calls its original action', () => {
    const remove = vi.fn();
    render(
      <div className={documentStyles.document}>
        <ConfirmDialog
          open
          onOpenChange={vi.fn()}
          title="删除章节"
          description="删除这一章节"
          confirmLabel="确认删除"
          onConfirm={remove}
        />
      </div>
    );
    expect(screen.getByRole('dialog').closest(`.${documentStyles.document}`)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
    expect(remove).toHaveBeenCalledOnce();
  });
});

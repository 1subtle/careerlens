import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Resume, { type PersonalInfo } from '@/components/dashboard/resume-component';
import { PersonalInfoForm } from '@/components/builder/forms/personal-info-form';
import { ResumePhotoEditor } from '@/components/builder/forms/resume-photo-editor';
import type { TemplateType } from '@/lib/types/template-settings';
import * as photoUtils from '@/lib/utils/resume-photo';

vi.mock('@/lib/i18n', () => ({ useTranslations: () => ({ t: (key: string) => key }) }));
const PHOTO = 'data:image/jpeg;base64,/9j/2Q==';
const REPLACEMENT = 'data:image/png;base64,iVBORw0KGgo=';
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('optional resume photo', () => {
  it('uploads, replaces and removes a photo without overwriting text edited during processing', async () => {
    let resolve: (value: string) => void = () => {};
    const prepare = vi.spyOn(photoUtils, 'prepareResumePhoto').mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    function Form() {
      const [data, setData] = useState<PersonalInfo>({ name: '原姓名', email: 'me@example.com' });
      return <PersonalInfoForm data={data} onChange={setData} documentMode />;
    }
    render(<Form />);
    expect(screen.queryByRole('img', { name: '当前简历照片' })).not.toBeInTheDocument();
    const upload = screen.getByLabelText('选择简历照片');
    const file = new File(['photo'], 'portrait.jpg', { type: 'image/jpeg' });
    fireEvent.change(upload, { target: { files: [file] } });
    expect(screen.getByRole('button', { name: '正在处理照片…' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('resume.personalInfo.name'), {
      target: { value: '刚修改的姓名' },
    });
    await act(async () => {
      resolve(PHOTO);
    });
    expect(await screen.findByRole('img', { name: '当前简历照片' })).toHaveAttribute('src', PHOTO);
    expect(screen.getByLabelText('resume.personalInfo.name')).toHaveValue('刚修改的姓名');
    expect(screen.getByLabelText('resume.personalInfo.email')).toHaveValue('me@example.com');
    prepare.mockRejectedValueOnce(new Error('照片无法读取，请换一张图片。'));
    fireEvent.change(upload, { target: { files: [file] } });
    expect(await screen.findByRole('alert')).toHaveTextContent('照片无法读取');
    expect(screen.getByRole('img', { name: '当前简历照片' })).toHaveAttribute('src', PHOTO);
    prepare.mockResolvedValueOnce(REPLACEMENT);
    fireEvent.change(upload, { target: { files: [file] } });
    await waitFor(() =>
      expect(screen.getByRole('img', { name: '当前简历照片' })).toHaveAttribute('src', REPLACEMENT)
    );
    fireEvent.click(screen.getByRole('button', { name: '移除照片' }));
    expect(screen.queryByRole('img', { name: '当前简历照片' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '上传照片' })).toBeEnabled();
    expect(screen.getByLabelText('resume.personalInfo.name')).toHaveValue('刚修改的姓名');
  });

  it('discards a pending upload when its resume editor unmounts', async () => {
    let resolve: (value: string) => void = () => {};
    vi.spyOn(photoUtils, 'prepareResumePhoto').mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    const change = vi.fn();
    const { unmount } = render(<ResumePhotoEditor onChange={change} />);
    fireEvent.change(screen.getByLabelText('选择简历照片'), {
      target: { files: [new File(['x'], 'photo.jpg')] },
    });
    unmount();
    await act(async () => {
      resolve(PHOTO);
    });
    expect(change).not.toHaveBeenCalled();
  });

  it.each<TemplateType>([
    'swiss-single',
    'swiss-two-column',
    'modern',
    'modern-two-column',
    'latex',
    'clean',
    'vivid',
  ])('renders a local photo in the %s header only when provided', (template) => {
    const data = { personalInfo: { name: '林同学', email: 'me@example.com', photo: PHOTO } };
    const { rerender } = render(<Resume resumeData={data} template={template} />);
    const image = screen.getByRole('img', { name: '简历照片' });
    expect(image).toHaveAttribute('src', PHOTO);
    expect(image.closest('[class*="resume-header"]')).not.toBeNull();
    rerender(
      <Resume
        resumeData={{ personalInfo: { ...data.personalInfo, photo: null } }}
        template={template}
      />
    );
    expect(screen.queryByRole('img', { name: '简历照片' })).not.toBeInTheDocument();
    expect(screen.getByText('me@example.com')).toBeVisible();
    rerender(
      <Resume
        resumeData={{
          personalInfo: { ...data.personalInfo, photo: 'https://example.com/photo.jpg' },
        }}
        template={template}
      />
    );
    expect(screen.queryByRole('img', { name: '简历照片' })).not.toBeInTheDocument();
  });

  it('rejects unsupported and oversized source files before decoding', async () => {
    await expect(
      photoUtils.prepareResumePhoto(new File(['<svg/>'], 'photo.svg', { type: 'image/svg+xml' }))
    ).rejects.toThrow('PNG 或 JPG');
    const large = new File(['photo'], 'large.jpg', { type: 'image/jpeg' });
    Object.defineProperty(large, 'size', { value: 10 * 1024 * 1024 + 1 });
    await expect(photoUtils.prepareResumePhoto(large)).rejects.toThrow('10 MB');
  });

  it('center-crops locally to 360 × 480, fills white and releases the temporary URL', async () => {
    const drawImage = vi.fn();
    const fillRect = vi.fn();
    const context = { drawImage, fillRect, fillStyle: '' };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      context as unknown as CanvasRenderingContext2D
    );
    const encode = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(PHOTO);
    const release = vi.fn();
    vi.stubGlobal(
      'URL',
      class extends URL {
        static createObjectURL = vi.fn(() => 'blob:local-photo');
        static revokeObjectURL = release;
      }
    );
    vi.stubGlobal(
      'Image',
      class {
        naturalWidth = 1200;
        naturalHeight = 800;
        onload: (() => void) | null = null;
        set src(_value: string) {
          queueMicrotask(() => this.onload?.());
        }
      }
    );
    const file = new File(['photo'], 'photo.jpg', { type: 'image/jpeg' });
    vi.spyOn(file, 'slice').mockReturnValue({
      arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 0xff]).buffer,
    } as Blob);
    await expect(photoUtils.prepareResumePhoto(file)).resolves.toBe(PHOTO);
    expect(context.fillStyle).toBe('#ffffff');
    expect(fillRect).toHaveBeenCalledWith(0, 0, 360, 480);
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 300, 0, 600, 800, 0, 0, 360, 480);
    expect(encode).toHaveBeenCalledWith('image/jpeg', 0.88);
    expect(release).toHaveBeenCalledWith('blob:local-photo');
  });
});

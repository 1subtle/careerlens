'use client';

import { useEffect, useId, useRef, useState } from 'react';
import Image from 'next/image';
import { isResumePhoto, prepareResumePhoto } from '@/lib/utils/resume-photo';
import s from './resume-photo-editor.module.css';

export function ResumePhotoEditor({
  photo,
  onChange,
}: {
  photo?: string | null;
  onChange: (photo: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const onPhotoChange = useRef(onChange);
  const request = useRef(0);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState('');
  const id = useId();
  useEffect(() => {
    onPhotoChange.current = onChange;
  }, [onChange]);
  useEffect(
    () => () => {
      request.current++;
    },
    []
  );
  const currentPhoto = isResumePhoto(photo) ? photo : undefined;
  return (
    <div className={s.editor}>
      {currentPhoto && (
        <Image
          className={s.preview}
          src={currentPhoto}
          alt="当前简历照片"
          width={72}
          height={96}
          unoptimized
        />
      )}
      <div className={s.controls}>
        <h4>简历照片（可选）</h4>
        <input
          ref={input}
          id={id}
          type="file"
          accept="image/png,image/jpeg"
          aria-label="选择简历照片"
          aria-describedby={`${id}-hint`}
          hidden
          disabled={processing}
          onChange={async (event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (!file) return;
            const token = ++request.current;
            setProcessing(true);
            setError('');
            try {
              const value = await prepareResumePhoto(file);
              if (token === request.current) onPhotoChange.current(value);
            } catch (cause) {
              if (token === request.current)
                setError(cause instanceof Error ? cause.message : '照片处理失败，请重试。');
            } finally {
              if (token === request.current) setProcessing(false);
            }
          }}
        />
        <div className={s.actions}>
          <button type="button" disabled={processing} onClick={() => input.current?.click()}>
            {processing ? '正在处理照片…' : currentPhoto ? '更换照片' : '上传照片'}
          </button>
          {currentPhoto && (
            <button
              type="button"
              disabled={processing}
              onClick={() => {
                setError('');
                onChange('');
              }}
            >
              移除照片
            </button>
          )}
        </div>
        <p id={`${id}-hint`}>PNG / JPG，最大 10 MB，自动裁为 3:4 竖幅。</p>
        {error && (
          <p className={s.error} role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

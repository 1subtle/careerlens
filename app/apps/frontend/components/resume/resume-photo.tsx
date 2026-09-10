import Image from 'next/image';
import { isResumePhoto } from '@/lib/utils/resume-photo';
import styles from './styles/_base.module.css';

export function ResumePhoto({ photo }: { photo?: string | null }) {
  if (!isResumePhoto(photo)) return null;
  return (
    <Image
      src={photo}
      alt="简历照片"
      width={360}
      height={480}
      unoptimized
      loading="eager"
      className={styles['resume-photo']}
    />
  );
}

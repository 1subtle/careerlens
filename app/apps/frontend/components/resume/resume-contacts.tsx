import {
  Mail,
  Phone,
  MapPin,
  Globe,
  Linkedin,
  Github,
  GraduationCap,
  BookOpen,
} from 'lucide-react';
import type { ResumeData } from '@/components/dashboard/resume-component';
import styles from './styles/contacts.module.css';

/** Shared by preview and print: each contact keeps its label and may wrap safely. */
export function ResumeContacts({
  personalInfo,
  education = [],
  locale = 'en',
  showContactIcons = false,
}: {
  personalInfo: ResumeData['personalInfo'];
  education?: ResumeData['education'];
  locale?: string;
  showContactIcons?: boolean;
}) {
  if (!personalInfo) return null;
  const zh = locale.toLowerCase().startsWith('zh');
  const primaryEducation = [...education].sort((a, b) => {
    const rank = (years = '') =>
      /至今|在读|present|current/i.test(years)
        ? 9999
        : Math.max(0, ...(years.match(/(?:19|20)\d{2}/g) ?? []).map(Number));
    return rank(b.years) - rank(a.years);
  })[0];
  const contacts = [
    {
      label: zh ? '院校' : 'School',
      value: primaryEducation?.institution,
      prefix: '',
      icon: GraduationCap,
    },
    {
      label: zh ? '学历 / 专业' : 'Degree',
      value: primaryEducation?.degree,
      prefix: '',
      icon: BookOpen,
    },
    { label: zh ? '邮箱' : 'Email', value: personalInfo.email, prefix: 'mailto:', icon: Mail },
    { label: zh ? '电话' : 'Phone', value: personalInfo.phone, prefix: 'tel:', icon: Phone },
    { label: zh ? '所在地' : 'Location', value: personalInfo.location, prefix: '', icon: MapPin },
    { label: zh ? '个人网站' : 'Website', value: personalInfo.website, prefix: 'web', icon: Globe },
    { label: 'LinkedIn', value: personalInfo.linkedin, prefix: 'web', icon: Linkedin },
    { label: 'GitHub', value: personalInfo.github, prefix: 'web', icon: Github },
  ].filter((item) => item.value?.trim());
  if (!contacts.length) return null;
  return (
    <div className={styles.contacts} data-resume-contacts>
      {contacts.map(({ label, value, prefix, icon: Icon }) => {
        const href =
          prefix === 'web'
            ? /^https?:\/\//i.test(value!)
              ? value!
              : `https://${value!.replace(/^\/\//, '')}`
            : prefix
              ? prefix + value
              : undefined;
        const display =
          prefix === 'web' ? value!.replace(/^https?:\/\//i, '').replace(/\/$/, '') : value;
        return (
          <div key={label} className={styles.contact}>
            <span className={styles.label}>
              {showContactIcons && <Icon size={12} aria-hidden="true" />}
              {label}
            </span>
            {href ? (
              <a href={href} className={styles.value} target="_blank" rel="noopener noreferrer">
                {display}
              </a>
            ) : (
              <span className={styles.value}>{display}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

'use client';

import { useCareerText } from '@/lib/i18n/career';
import { useLanguage } from '@/lib/context/language-context';
import { useAuth } from './auth-provider';

import Link from 'next/link';
import Image from 'next/image';
import type { AuthSession } from '@/lib/api/auth';
import s from './auth.module.css';

export function PublicHeader({ back = false }: { back?: boolean }) {
  const tr = useCareerText();
  const { uiLanguage, setUiLanguage } = useLanguage();
  const auth = useAuth();
  return (
    <header className={s.header}>
      <Link href="/" className={s.brand}>
        <Image src="/illustrations/careerlens-icon.webp" alt="" width={44} height={44} priority />
        CareerLens
      </Link>
      <div className={s.headerActions}>
        {!auth?.session?.user && (
          <button
            type="button"
            className={s.languageButton}
            aria-label={uiLanguage === 'zh' ? 'Switch to English' : '切换为中文'}
            onClick={() => void setUiLanguage(uiLanguage === 'zh' ? 'en' : 'zh')}
          >
            {uiLanguage === 'zh' ? 'English' : '中文'}
          </button>
        )}
        <Link href={back ? '/' : '/login'}>{back ? tr('返回首页') : tr('邮箱登录')}</Link>
      </div>
    </header>
  );
}
export function PublicSite({ session, notice }: { session: AuthSession; notice?: string }) {
  const tr = useCareerText();
  const github =
    session.github_url && /^https:\/\//i.test(session.github_url) ? session.github_url : null;
  return (
    <div className={s.page}>
      <PublicHeader />
      <main>
        <section className={s.hero}>
          <div>
            <span className={s.badge}>{tr('从真实经历出发')}</span>
            <h1>{tr('看清经历，找到更合适的下一步。')}</h1>
            <p>{tr('整理简历，发现岗位方向，核对每一条匹配理由。让你的经历，回应岗位的期待。')}</p>
            {notice && (
              <p className={s.notice} role="status">
                {tr(notice)}
              </p>
            )}
            <div className={s.actions}>
              <Link href="/login" className={`${s.button} ${s.primary}`}>
                {' '}
                {tr('在线使用')}{' '}
              </Link>
              {github && (
                <a className={s.button} href={github} target="_blank" rel="noopener noreferrer">
                  {' '}
                  {tr('本地部署')}{' '}
                </a>
              )}
            </div>
            <p className={s.signupHint}>{tr('邮箱注册即送 20 免费积分。')}</p>
          </div>
          <Image src="/illustrations/career-guide.webp" alt="" width={270} height={220} priority />
        </section>
        <div className={s.features}>
          <section>
            <h2>{tr('把经历写清楚')}</h2>
            <p>{tr('导入或编辑简历，整理真实亮点，按需排版并导出。')}</p>
          </section>
          <section>
            <h2>{tr('找到适合的方向')}</h2>
            <p>{tr('结合简历与目标 JD，查看匹配理由、原文证据和改进建议。')}</p>
          </section>
          <section>
            <h2>{tr('发现下一份机会')}</h2>
            <p>{tr('搜索招聘岗位，保存感兴趣的 JD，让每次准备都有目标。')}</p>
          </section>
        </div>
      </main>
    </div>
  );
}

'use client';

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import type { AuthSession } from '@/lib/api/auth';
import { useCareerText } from '@/lib/i18n/career';
import { useLanguage } from '@/lib/context/language-context';
import { useAuth } from './auth-provider';
import s from './auth.module.css';

const demoTabs = ['填写经历', '对照岗位', '确认优化'] as const;
const processEvidencePattern =
  /访谈|反馈|流程|表单|说明|\b(?:interview(?:ed|ing|s)?|feedback|process(?:es)?|forms?|instructions?)\b/i;
const sqlEvidencePattern = /\bsql\b/i;

const capabilities = [
  {
    title: '每条判断都有出处',
    body: '匹配理由同时指向简历经历与岗位原文，你可以逐条核对，而不是接受一个孤立分数。',
  },
  {
    title: '先比较，再投入时间',
    body: '把多个岗位的适合度、材料覆盖度与任职条件放在一起，先判断准备优先级。',
  },
  {
    title: '建议不会直接覆盖原文',
    body: '每次优化都保留原文、依据和建议稿，确认后才生成新版本。',
  },
  {
    title: '方向、岗位与材料连在一起',
    body: '从方向分析到实时岗位，再回到简历准备，使用同一份真实经历继续推进。',
  },
] as const;

const processSteps = [
  {
    title: '整理真实经历',
    body: '导入或编辑简历，补齐项目背景、行动与结果，先建立可信的主简历。',
  },
  {
    title: '带着目标岗位核对',
    body: '保存 JD 并提取要求，查看每项要求对应的简历证据与待确认信息。',
  },
  {
    title: '审阅后生成新版本',
    body: '对照原文与建议稿，确认需要采用的修改，再排版并导出。',
  },
] as const;

function stopTextareaEnter(event: KeyboardEvent<HTMLTextAreaElement>) {
  if (event.key === 'Enter') event.stopPropagation();
}

export function PublicHeader({ back = false, home = false }: { back?: boolean; home?: boolean }) {
  const tr = useCareerText();
  const { uiLanguage, setUiLanguage } = useLanguage();
  const auth = useAuth();
  return (
    <header className={s.header}>
      <Link href="/" className={s.brand}>
        <Image src="/illustrations/careerlens-icon.webp" alt="" width={44} height={44} priority />
        CareerLens
      </Link>
      {home && (
        <nav className={s.homeNav} aria-label={tr('首页导航')}>
          <a href="#demo">{tr('产品演示')}</a>
          <a href="#features">{tr('功能亮点')}</a>
          <a href="#process">{tr('使用流程')}</a>
        </nav>
      )}
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

function CareerDemo() {
  const tr = useCareerText();
  const [activeStep, setActiveStep] = useState(0);
  const [compactTabs, setCompactTabs] = useState(false);
  const [experienceByLanguage, setExperienceByLanguage] = useState<Record<string, string>>({});
  const [revisionByLanguage, setRevisionByLanguage] = useState<Record<string, string>>({});
  const [choice, setChoice] = useState<'original' | 'revision'>('revision');
  const [confirmed, setConfirmed] = useState(false);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const language = tr.language;
  const experience =
    experienceByLanguage[language] ??
    tr('负责校园活动报名流程，访谈参与者后重写说明并调整表单字段，减少了重复咨询和无效提交。');
  const normalizedExperience = experience.trim().replace(/\s+/g, ' ');
  const hasProcessEvidence = processEvidencePattern.test(normalizedExperience);
  const hasSqlEvidence = sqlEvidencePattern.test(normalizedExperience);
  const suggestedRevision = normalizedExperience
    ? tr('面向产品运营实习生岗位整理：{0}', normalizedExperience)
    : tr('请先填写经历，再查看演示整理稿。');
  const revision = revisionByLanguage[language] ?? suggestedRevision;
  const revisionReason = hasProcessEvidence
    ? hasSqlEvidence
      ? tr('演示规则识别到用户反馈、流程改进和 SQL 分析证据。')
      : tr('演示规则识别到用户反馈与流程改进证据；尚未识别到 SQL 分析证据。')
    : hasSqlEvidence
      ? tr('演示规则识别到 SQL 分析证据；尚未识别到用户反馈与流程改进证据。')
      : tr('演示规则尚未识别到用户反馈、流程改进或 SQL 分析证据。');

  useEffect(() => {
    if (!window.matchMedia) return;
    const query = window.matchMedia('(max-width: 767px)');
    const update = () => setCompactTabs(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  function moveToStep(nextStep: number, focus = false) {
    setActiveStep(nextStep);
    setConfirmed(false);
    if (focus) tabRefs.current[nextStep]?.focus();
  }

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let nextStep: number | null = null;
    const nextKey = compactTabs ? 'ArrowRight' : 'ArrowDown';
    const previousKey = compactTabs ? 'ArrowLeft' : 'ArrowUp';
    if (event.key === nextKey) {
      nextStep = (index + 1) % demoTabs.length;
    } else if (event.key === previousKey) {
      nextStep = (index - 1 + demoTabs.length) % demoTabs.length;
    } else if (event.key === 'Home') {
      nextStep = 0;
    } else if (event.key === 'End') {
      nextStep = demoTabs.length - 1;
    }
    if (nextStep === null) return;
    event.preventDefault();
    moveToStep(nextStep, true);
  }

  return (
    <div className={s.demoFrame}>
      <div className={s.demoTabs}>
        <span className={s.demoDataLabel}>{tr('演示数据')}</span>
        <div
          className={s.demoTabList}
          role="tablist"
          aria-label={tr('产品演示')}
          aria-orientation={compactTabs ? 'horizontal' : 'vertical'}
        >
          {demoTabs.map((label, index) => (
            <button
              key={label}
              ref={(node) => {
                tabRefs.current[index] = node;
              }}
              id={`demo-tab-${index}`}
              type="button"
              role="tab"
              aria-selected={activeStep === index}
              aria-controls={`demo-panel-${index}`}
              tabIndex={activeStep === index ? 0 : -1}
              onClick={() => moveToStep(index)}
              onKeyDown={(event) => handleTabKeyDown(event, index)}
            >
              <span aria-hidden="true">0{index + 1}</span>
              {tr(label)}
            </button>
          ))}
        </div>
      </div>

      <div
        className={s.demoPanel}
        id="demo-panel-0"
        role="tabpanel"
        aria-labelledby="demo-tab-0"
        hidden={activeStep !== 0}
      >
        <h3>{tr('填写一段真实经历')}</h3>
        <form
          className={s.demoForm}
          onSubmit={(event) => {
            event.preventDefault();
            moveToStep(1, true);
          }}
        >
          <label htmlFor="demo-experience">{tr('演示经历')}</label>
          <textarea
            id="demo-experience"
            rows={5}
            required
            value={experience}
            aria-describedby="demo-experience-help"
            onKeyDown={stopTextareaEnter}
            onChange={(event) => {
              setRevisionByLanguage({});
              setConfirmed(false);
              setExperienceByLanguage((current) => ({
                ...current,
                [language]: event.target.value,
              }));
            }}
          />
          <p id="demo-experience-help">{tr('你可以直接修改这段演示文字。')}</p>
          <button className={`${s.button} ${s.primary}`} type="submit">
            {tr('查看岗位对照')}
          </button>
        </form>
      </div>

      <div
        className={s.demoPanel}
        id="demo-panel-1"
        role="tabpanel"
        aria-labelledby="demo-tab-1"
        hidden={activeStep !== 1}
      >
        <h3>{tr('核对岗位要求与经历证据')}</h3>
        <dl className={s.demoTarget}>
          <div>
            <dt>{tr('演示目标岗位')}</dt>
            <dd>{tr('产品运营实习生（演示）')}</dd>
          </div>
        </dl>
        <p className={s.demoRuleNote}>{tr('本演示使用固定关键词规则，不调用 AI。')}</p>
        <ul className={s.evidenceList}>
          <li>
            <strong>{tr('梳理用户反馈并改进流程')}</strong>
            <span className={hasProcessEvidence ? s.supported : s.pending}>
              {tr(hasProcessEvidence ? '经历中有直接证据' : '经历中尚未提供证据')}
            </span>
          </li>
          <li>
            <strong>{tr('使用 SQL 分析业务数据')}</strong>
            <span className={hasSqlEvidence ? s.supported : s.pending}>
              {tr(hasSqlEvidence ? '经历中有直接证据' : '经历中尚未提供证据')}
            </span>
          </li>
        </ul>
        <button
          className={`${s.button} ${s.primary}`}
          type="button"
          onClick={() => moveToStep(2, true)}
        >
          {tr('查看优化建议')}
        </button>
      </div>

      <div
        className={s.demoPanel}
        id="demo-panel-2"
        role="tabpanel"
        aria-labelledby="demo-tab-2"
        hidden={activeStep !== 2}
      >
        <h3>{tr('审阅后再决定是否采用')}</h3>
        <div className={s.originalExperience}>
          <span>{tr('原始经历')}</span>
          <p>{experience}</p>
        </div>
        <label htmlFor="demo-revision">{tr('演示整理稿')}</label>
        <textarea
          id="demo-revision"
          rows={4}
          value={revision}
          onKeyDown={stopTextareaEnter}
          onChange={(event) => {
            setConfirmed(false);
            setRevisionByLanguage((current) => ({
              ...current,
              [language]: event.target.value,
            }));
          }}
        />
        <p className={s.revisionReason}>{revisionReason}</p>
        <fieldset className={s.demoChoices}>
          <legend>{tr('选择处理方式')}</legend>
          <label>
            <input
              type="radio"
              name="demo-choice"
              checked={choice === 'original'}
              onChange={() => {
                setChoice('original');
                setConfirmed(false);
              }}
            />
            {tr('保留原文')}
          </label>
          <label>
            <input
              type="radio"
              name="demo-choice"
              checked={choice === 'revision'}
              onChange={() => {
                setChoice('revision');
                setConfirmed(false);
              }}
            />
            {tr('采用演示整理稿')}
          </label>
        </fieldset>
        <button
          className={`${s.button} ${s.primary}`}
          type="button"
          onClick={() => setConfirmed(true)}
        >
          {tr('确认演示选择')}
        </button>
        {confirmed && (
          <p className={s.demoConfirmation} role="status">
            {tr(
              choice === 'original'
                ? '已选择保留原文。演示不会保存任何内容。'
                : '已选择采用演示整理稿。演示不会保存任何内容。'
            )}
          </p>
        )}
      </div>
    </div>
  );
}

export function PublicSite({ session, notice }: { session: AuthSession; notice?: string }) {
  const tr = useCareerText();
  const github =
    session.github_url && /^https:\/\//i.test(session.github_url) ? session.github_url : null;
  return (
    <div className={`${s.page} ${s.landingPage}`}>
      <PublicHeader home />
      <main>
        <section className={s.hero} aria-labelledby="landing-title">
          <div className={s.heroCopy}>
            <span className={s.badge}>{tr('从真实经历出发')}</span>
            <h1 id="landing-title">{tr('看清经历，找到更合适的下一步。')}</h1>
            <p>{tr('整理简历，核对岗位依据，让真实经历回应岗位期待。')}</p>
            {notice && (
              <p className={s.notice} role="status">
                {tr(notice)}
              </p>
            )}
            <div className={s.actions}>
              <Link href="/login" className={`${s.button} ${s.primary}`}>
                {tr('在线使用')}
              </Link>
              <a className={s.button} href="#demo">
                {tr('产品演示')}
              </a>
              {github && (
                <a className={s.textLink} href={github} target="_blank" rel="noopener noreferrer">
                  {tr('本地部署')}
                </a>
              )}
            </div>
          </div>
          <div className={s.heroIllustrationFrame}>
            <Image
              className={s.heroIllustration}
              src="/illustrations/career-guide.webp"
              alt=""
              width={432}
              height={352}
              priority
            />
          </div>
        </section>

        <section className={s.landingSection} id="demo" aria-labelledby="demo-title">
          <div className={s.sectionHeader}>
            <h2 id="demo-title">{tr('先试一次，不用上传真实简历。')}</h2>
            <p>{tr('这里使用明确标注的演示数据。内容可编辑，操作不会保存。')}</p>
          </div>
          <CareerDemo />
        </section>

        <section className={s.landingSection} id="features" aria-labelledby="features-title">
          <div className={s.sectionHeader}>
            <h2 id="features-title">{tr('能力不靠口号，落在每一次核对里。')}</h2>
            <p>{tr('CareerLens 把经历、岗位要求和修改决定放在同一条可追溯的工作流中。')}</p>
          </div>
          <div className={s.features}>
            {capabilities.map((capability, index) => (
              <section
                key={capability.title}
                className={index === 0 ? s.capabilityLead : s.capabilityItem}
              >
                <h3>{tr(capability.title)}</h3>
                <p>{tr(capability.body)}</p>
                {index === 0 && (
                  <Image
                    src="/illustrations/opportunity-discovery.webp"
                    alt=""
                    width={384}
                    height={313}
                  />
                )}
              </section>
            ))}
          </div>
        </section>

        <section className={s.landingSection} id="process" aria-labelledby="process-title">
          <div className={s.sectionHeader}>
            <h2 id="process-title">{tr('从材料到新版本，只走三步。')}</h2>
          </div>
          <ol className={s.processList}>
            {processSteps.map((step, index) => (
              <li key={step.title}>
                <span className={s.processIndex} aria-hidden="true">
                  0{index + 1}
                </span>
                <h3>{tr(step.title)}</h3>
                <p>{tr(step.body)}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className={s.closingCta} aria-labelledby="closing-title">
          <div>
            <h2 id="closing-title">{tr('下一步，从一份真实经历开始。')}</h2>
            <p>{tr('邮箱注册即送 20 免费积分。')}</p>
          </div>
          <div className={s.actions}>
            <Link href="/login" className={`${s.button} ${s.primary}`}>
              {tr('在线使用')}
            </Link>
            {github && (
              <a className={s.button} href={github} target="_blank" rel="noopener noreferrer">
                {tr('本地部署')}
              </a>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}

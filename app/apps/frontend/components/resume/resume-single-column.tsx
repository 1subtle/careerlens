import React from 'react';
import { ResumeContacts } from './resume-contacts';
import { ResumePhoto } from './resume-photo';
import { Github, ExternalLink } from 'lucide-react';
import type {
  ResumeData,
  SectionMeta,
  AdditionalSectionLabels,
} from '@/components/dashboard/resume-component';
import { getSortedSections } from '@/lib/utils/section-helpers';
import { formatDateRange } from '@/lib/utils';
import { DynamicResumeSection } from './dynamic-resume-section';
import { DescriptionList } from './description-list';
import baseStyles from './styles/_base.module.css';
import styles from './styles/swiss-single.module.css';
import variants from './styles/reference-templates.module.css';

interface ResumeSingleColumnProps {
  data: ResumeData;
  showContactIcons?: boolean;
  locale?: string;
  additionalSectionLabels?: Partial<AdditionalSectionLabels>;
  variant?: 'campus' | 'ledger' | 'timeline' | 'fresh' | 'sidebar';
}

/**
 * Swiss Single-Column Resume Template
 *
 * Traditional full-width layout with sections stacked vertically.
 * Best for detailed experience descriptions and maximum content density.
 *
 * Section order: Determined by sectionMeta ordering
 */
export const ResumeSingleColumn: React.FC<ResumeSingleColumnProps> = ({
  data,
  showContactIcons = false,
  locale,
  additionalSectionLabels,
  variant,
}) => {
  const { personalInfo, summary, workExperience, education, personalProjects, additional } = data;

  // Get sorted visible sections
  const sortedSections = getSortedSections(data);

  // Render a section based on its key
  const renderSection = (section: SectionMeta) => {
    switch (section.key) {
      case 'personalInfo':
        // Personal info is the header - handled separately
        return null;

      case 'summary':
        if (!summary) return null;
        return (
          <div key={section.id} className={baseStyles['resume-section']}>
            <h3 className={baseStyles['resume-section-title']}>{section.displayName}</h3>
            <p className={`text-justify ${baseStyles['resume-text']}`}>{summary}</p>
          </div>
        );

      case 'workExperience':
        if (!workExperience || workExperience.length === 0) return null;
        return (
          <div key={section.id} className={baseStyles['resume-section']}>
            <h3 className={baseStyles['resume-section-title']}>{section.displayName}</h3>
            <div className={baseStyles['resume-items']}>
              {workExperience.map((exp) => (
                <div key={exp.id} className={baseStyles['resume-item']}>
                  <div
                    className={`flex justify-between items-baseline ${baseStyles['resume-row-tight']}`}
                  >
                    <h4 className={baseStyles['resume-item-title']}>{exp.title}</h4>
                    <span className={`${baseStyles['resume-date']} ml-4`}>
                      {formatDateRange(exp.years)}
                    </span>
                  </div>
                  <div
                    className={`flex justify-between items-center ${baseStyles['resume-row']} ${baseStyles['resume-item-subtitle']}`}
                  >
                    <span>{exp.company}</span>
                    {exp.location && <span>{exp.location}</span>}
                  </div>
                  <DescriptionList items={exp.description} styles={exp.descriptionStyles} />
                </div>
              ))}
            </div>
          </div>
        );

      case 'personalProjects':
        if (!personalProjects || personalProjects.length === 0) return null;
        return (
          <div key={section.id} className={baseStyles['resume-section']}>
            <h3 className={baseStyles['resume-section-title']}>{section.displayName}</h3>
            <div className={baseStyles['resume-items']}>
              {personalProjects.map((project) => (
                <div key={project.id} className={baseStyles['resume-item']}>
                  <div
                    className={`flex justify-between items-baseline ${baseStyles['resume-row-tight']}`}
                  >
                    <div className="flex items-baseline gap-2">
                      <h4 className={baseStyles['resume-item-title']}>{project.name}</h4>
                      {(project.github || project.website) && (
                        <span className="flex gap-1.5">
                          {project.github && (
                            <a
                              href={
                                project.github.startsWith('http')
                                  ? project.github
                                  : `https://${project.github}`
                              }
                              target="_blank"
                              rel="noopener noreferrer"
                              className={baseStyles['resume-link-pill']}
                            >
                              <Github size={10} />
                              {project.github
                                .replace(/^https?:\/\//, '')
                                .replace(/^www\./, '')
                                .replace(/\/$/, '')}
                            </a>
                          )}
                          {project.website && (
                            <a
                              href={
                                project.website.startsWith('http')
                                  ? project.website
                                  : `https://${project.website}`
                              }
                              target="_blank"
                              rel="noopener noreferrer"
                              className={baseStyles['resume-link-pill']}
                            >
                              <ExternalLink size={10} />
                              {project.website
                                .replace(/^https?:\/\//, '')
                                .replace(/^www\./, '')
                                .replace(/\/$/, '')}
                            </a>
                          )}
                        </span>
                      )}
                    </div>
                    {project.years && (
                      <span className={`${baseStyles['resume-date']} ml-4`}>
                        {formatDateRange(project.years)}
                      </span>
                    )}
                  </div>
                  {project.role && (
                    <div
                      className={`${baseStyles['resume-row']} ${baseStyles['resume-item-subtitle']}`}
                    >
                      <span>{project.role}</span>
                    </div>
                  )}
                  <DescriptionList items={project.description} styles={project.descriptionStyles} />
                </div>
              ))}
            </div>
          </div>
        );

      case 'education':
        if (!education || education.length === 0) return null;
        return (
          <div key={section.id} className={baseStyles['resume-section']}>
            <h3 className={baseStyles['resume-section-title']}>{section.displayName}</h3>
            <div className={baseStyles['resume-items']}>
              {education.map((edu) => (
                <div key={edu.id} className={baseStyles['resume-item']}>
                  <div
                    className={`flex justify-between items-baseline ${baseStyles['resume-row-tight']}`}
                  >
                    <h4 className={baseStyles['resume-item-title']}>{edu.institution}</h4>
                    <span className={`${baseStyles['resume-date']} ml-4`}>
                      {formatDateRange(edu.years)}
                    </span>
                  </div>
                  <div
                    className={`flex justify-between ${baseStyles['resume-item-subtitle']} ${baseStyles['resume-row-tight']}`}
                  >
                    <span>{edu.degree}</span>
                  </div>
                  {edu.description && (
                    <p className={baseStyles['resume-text-sm']}>{edu.description}</p>
                  )}
                </div>
              ))}
            </div>
          </div>
        );

      case 'additional':
        if (!additional) return null;
        return (
          <AdditionalSection
            key={section.id}
            additional={additional}
            displayName={section.displayName}
            labels={additionalSectionLabels}
          />
        );

      default:
        // Custom section - render using DynamicResumeSection
        if (!section.isDefault) {
          return <DynamicResumeSection key={section.id} sectionMeta={section} resumeData={data} />;
        }
        return null;
    }
  };

  return (
    <div className={`${styles.container} ${variant ? variants[variant] : ''}`}>
      {/* Header Section - Centered Layout (always first) */}
      {personalInfo && (
        <header
          data-resume-header
          className={`text-center ${baseStyles['resume-header']} border-b`}
          style={variant ? undefined : { borderColor: 'var(--resume-border-primary)' }}
        >
          <ResumePhoto photo={personalInfo?.photo} />
          {/* Name - Centered */}
          {personalInfo.name && (
            <h1 className={`${baseStyles['resume-name']} tracking-tight uppercase mb-1`}>
              {personalInfo.name}
            </h1>
          )}

          {/* Title - Centered, below name */}
          {personalInfo.title && (
            <h2
              className={`${baseStyles['resume-title']} ${baseStyles['resume-meta']} tracking-wide uppercase mb-3`}
            >
              {personalInfo.title}
            </h2>
          )}

          <ResumeContacts
            personalInfo={personalInfo}
            education={
              sortedSections.some((section) => section.key === 'education') ? education : []
            }
            locale={locale}
            showContactIcons={showContactIcons}
          />
        </header>
      )}

      {/* Render sections in order based on sectionMeta */}
      <div data-resume-body>
        {sortedSections
          .filter((section) => section.key !== 'personalInfo')
          .map((section) => renderSection(section))}
      </div>
    </div>
  );
};

/**
 * Additional info section (skills, languages, certifications, awards)
 */
const AdditionalSection: React.FC<{
  additional: ResumeData['additional'];
  displayName?: string;
  labels?: Partial<AdditionalSectionLabels>;
}> = ({ additional, displayName = 'Skills & Awards', labels }) => {
  if (!additional) return null;

  const {
    technicalSkills: rawTechnicalSkills = [],
    languages: rawLanguages = [],
    certificationsTraining: rawCertificationsTraining = [],
    awards: rawAwards = [],
  } = additional;

  // Drop blank/whitespace-only entries so empty lines (e.g. from editing in the
  // builder) never render in the resume or PDF (issue #763).
  const technicalSkills = rawTechnicalSkills.filter(
    (item): item is string => typeof item === 'string' && item.trim() !== ''
  );
  const languages = rawLanguages.filter(
    (item): item is string => typeof item === 'string' && item.trim() !== ''
  );
  const certificationsTraining = rawCertificationsTraining.filter(
    (item): item is string => typeof item === 'string' && item.trim() !== ''
  );
  const awards = rawAwards.filter(
    (item): item is string => typeof item === 'string' && item.trim() !== ''
  );

  const mergedLabels: AdditionalSectionLabels = {
    technicalSkills: labels?.technicalSkills ?? 'Technical Skills:',
    languages: labels?.languages ?? 'Languages:',
    certifications: labels?.certifications ?? 'Certifications:',
    awards: labels?.awards ?? 'Awards:',
  };

  const hasContent =
    technicalSkills.length > 0 ||
    languages.length > 0 ||
    certificationsTraining.length > 0 ||
    awards.length > 0;

  if (!hasContent) return null;

  return (
    <div className={baseStyles['resume-section']}>
      <h3 className={baseStyles['resume-section-title']}>{displayName}</h3>
      <div className={`${baseStyles['resume-stack']} ${baseStyles['resume-text-sm']}`}>
        {technicalSkills.length > 0 && (
          <div className="flex">
            <span className="font-bold w-32 shrink-0">{mergedLabels.technicalSkills}</span>
            <span>{technicalSkills.join(', ')}</span>
          </div>
        )}
        {languages.length > 0 && (
          <div className="flex">
            <span className="font-bold w-32 shrink-0">{mergedLabels.languages}</span>
            <span>{languages.join(', ')}</span>
          </div>
        )}
        {certificationsTraining.length > 0 && (
          <div className="flex">
            <span className="font-bold w-32 shrink-0">{mergedLabels.certifications}</span>
            <span>{certificationsTraining.join(', ')}</span>
          </div>
        )}
        {awards.length > 0 && (
          <div className="flex">
            <span className="font-bold w-32 shrink-0">{mergedLabels.awards}</span>
            <span>{awards.join(', ')}</span>
          </div>
        )}
      </div>
    </div>
  );
};

export default ResumeSingleColumn;

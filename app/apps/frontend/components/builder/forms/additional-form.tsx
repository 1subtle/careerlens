'use client';

import React from 'react';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { AdditionalInfo } from '@/components/dashboard/resume-component';
import { useTranslations } from '@/lib/i18n';
import documentStyles from '../resume-document.module.css';

interface AdditionalFormProps {
  data: AdditionalInfo;
  onChange: (data: AdditionalInfo) => void;
  documentMode?: boolean;
}

export const AdditionalForm: React.FC<AdditionalFormProps> = ({
  data,
  onChange,
  documentMode = false,
}) => {
  const { t } = useTranslations();

  // Helper to handle array conversions (text -> string[])
  const handleArrayChange = (field: keyof AdditionalInfo, value: string) => {
    // Split by newlines only. Blank/whitespace lines are preserved while editing
    // so pressing Enter creates a new line (issue #763); consumers filter empty
    // entries at render time, and the backend drops them on save.
    const items = value.split('\n');
    onChange({
      ...data,
      [field]: items,
    });
  };

  const formatArray = (arr?: string[]) => {
    return arr?.join('\n') || '';
  };

  // Explicitly allow Enter key to create newlines (prevent form submission interference)
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter') {
      // Allow default behavior (newline insertion)
      e.stopPropagation();
    }
  };

  return (
    <div className="space-y-6">
      {!documentMode && (
        <p className="font-mono text-xs uppercase tracking-wider text-blue-700">
          {t('builder.additionalForm.instructions')}
        </p>
      )}

      <div
        className={
          documentMode ? documentStyles.additionalFields : 'grid grid-cols-1 md:grid-cols-2 gap-6'
        }
      >
        <div className="space-y-2">
          <Label
            htmlFor="technicalSkills"
            className="font-mono text-xs uppercase tracking-wider text-steel-grey"
          >
            {t('resume.additional.technicalSkills')}
          </Label>
          <Textarea
            rows={documentMode ? 1 : undefined}
            id="technicalSkills"
            value={formatArray(data.technicalSkills)}
            onChange={(e) => handleArrayChange('technicalSkills', e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('builder.additionalForm.placeholders.technicalSkills')}
            className="min-h-[120px] text-black rounded-none border-black bg-white focus-visible:ring-0 focus-visible:ring-offset-0 focus-visible:border-blue-700"
          />
        </div>
        <div className="space-y-2">
          <Label
            htmlFor="languages"
            className="font-mono text-xs uppercase tracking-wider text-steel-grey"
          >
            {t('resume.sections.languages')}
          </Label>
          <Textarea
            rows={documentMode ? 1 : undefined}
            id="languages"
            value={formatArray(data.languages)}
            onChange={(e) => handleArrayChange('languages', e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('builder.additionalForm.placeholders.languages')}
            className="min-h-[120px] text-black rounded-none border-black bg-white focus-visible:ring-0 focus-visible:ring-offset-0 focus-visible:border-blue-700"
          />
        </div>
        <div className="space-y-2">
          <Label
            htmlFor="certifications"
            className="font-mono text-xs uppercase tracking-wider text-steel-grey"
          >
            {t('resume.sections.certifications')}
          </Label>
          <Textarea
            rows={documentMode ? 1 : undefined}
            id="certifications"
            value={formatArray(data.certificationsTraining)}
            onChange={(e) => handleArrayChange('certificationsTraining', e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('builder.additionalForm.placeholders.certifications')}
            className="min-h-[120px] text-black rounded-none border-black bg-white focus-visible:ring-0 focus-visible:ring-offset-0 focus-visible:border-blue-700"
          />
        </div>
        <div className="space-y-2">
          <Label
            htmlFor="awards"
            className="font-mono text-xs uppercase tracking-wider text-steel-grey"
          >
            {t('resume.sections.awards')}
          </Label>
          <Textarea
            rows={documentMode ? 1 : undefined}
            id="awards"
            value={formatArray(data.awards)}
            onChange={(e) => handleArrayChange('awards', e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('builder.additionalForm.placeholders.awards')}
            className="min-h-[120px] text-black rounded-none border-black bg-white focus-visible:ring-0 focus-visible:ring-offset-0 focus-visible:border-blue-700"
          />
        </div>
      </div>
    </div>
  );
};

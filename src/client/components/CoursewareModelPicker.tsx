import { useId } from 'react';
import type { CoursewareSettingsDraft, CoursewareSelectionDraft } from '../lib/courseware-ai-settings';
import { ModelField } from './CoursewareAISettingsCard';

interface Props {
  value: CoursewareSettingsDraft;
  includeImages: boolean;
  disabled: boolean;
  onChange: (value: CoursewareSettingsDraft) => void;
}

export default function CoursewareModelPicker({ value, includeImages, disabled, onChange }: Props) {
  const idPrefix = `courseware-model-${useId().replace(/:/g, '')}`;
  const change = (key: 'text' | 'image' | 'teacherSpeech' | 'studentSpeech', selection: CoursewareSelectionDraft) => {
    onChange({ ...value, [key]: selection });
  };

  return (
    <fieldset className="courseware-model-picker courseware-form-wide" disabled={disabled}>
      <legend>本次使用的模型</legend>
      <p className="form-hint">默认带入 AI 服务页保存的配置；这里的调整只影响本次新课件。</p>
      <div className="courseware-model-picker-grid">
        <ModelField id={`${idPrefix}-text`} label="课件脚本" purpose="courseware_text" catalog={value.catalog} selection={value.text} onChange={(selection) => change('text', selection)} disabled={disabled} featureSelection />
        <ModelField id={`${idPrefix}-teacher`} label="老师语音" purpose="teacher_tts" catalog={value.catalog} selection={value.teacherSpeech} onChange={(selection) => change('teacherSpeech', selection)} disabled={disabled} showVoice featureSelection />
        <ModelField id={`${idPrefix}-student`} label="AI 同学语音" purpose="student_tts" catalog={value.catalog} selection={value.studentSpeech} onChange={(selection) => change('studentSpeech', selection)} disabled={disabled} showVoice featureSelection />
        {includeImages && value.image && <ModelField id={`${idPrefix}-image`} label="教学配图" purpose="courseware_image" catalog={value.catalog} selection={value.image} onChange={(selection) => change('image', selection)} disabled={disabled} featureSelection />}
      </div>
    </fieldset>
  );
}

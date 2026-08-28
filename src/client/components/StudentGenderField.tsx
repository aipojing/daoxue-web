import { useId } from 'react';
import { STUDENT_GENDER_OPTIONS, type StudentGender } from '../types';
import StudentAvatar from './StudentAvatar';

const PREVIEW_ACCENTS: Record<StudentGender, string> = {
  male: '#33648f',
  female: '#b8432f',
  unspecified: '#1e5b4a',
};

interface Props {
  value: StudentGender;
  onChange: (gender: StudentGender) => void;
}

export default function StudentGenderField({ value, onChange }: Props) {
  const fieldId = useId();
  return (
    <fieldset className="student-gender-field">
      <legend>孩子性别（用于默认头像）</legend>
      <div className="student-gender-options">
        {STUDENT_GENDER_OPTIONS.map((option) => (
          <label className="student-gender-option" key={option.value}>
            <input
              type="radio"
              name={`${fieldId}-student-gender`}
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
            />
            <span className="student-gender-card">
              <StudentAvatar
                name={option.label}
                gender={option.value}
                color={PREVIEW_ACCENTS[option.value]}
                className="student-gender-preview"
              />
              <strong>{option.label}</strong>
            </span>
          </label>
        ))}
      </div>
      <p className="form-hint">不指定时使用中性头像，不会根据姓名自动判断。</p>
    </fieldset>
  );
}

import type { CSSProperties } from 'react';
import defaultStudentFemaleAvatar from '../assets/avatars/default-student-female.png';
import defaultStudentMaleAvatar from '../assets/avatars/default-student-male.png';
import defaultStudentNeutralAvatar from '../assets/avatars/default-student-neutral.png';
import type { StudentGender } from '../types';

interface Props {
  name: string;
  color?: string;
  gender?: StudentGender;
  className?: string;
}

const AVATAR_BY_GENDER: Record<StudentGender, string> = {
  male: defaultStudentMaleAvatar,
  female: defaultStudentFemaleAvatar,
  unspecified: defaultStudentNeutralAvatar,
};

const GENDER_LABEL: Record<StudentGender, string> = {
  male: '男孩',
  female: '女孩',
  unspecified: '中性',
};

export default function StudentAvatar({
  name,
  color = '#c95135',
  gender = 'unspecified',
  className = '',
}: Props) {
  return (
    <span
      className={`avatar student-avatar${className ? ` ${className}` : ''}`}
      style={{ '--student-avatar-accent': color } as CSSProperties}
      aria-label={`${name}的${GENDER_LABEL[gender]}默认头像`}
      role="img"
    >
      <img src={AVATAR_BY_GENDER[gender]} alt="" />
    </span>
  );
}

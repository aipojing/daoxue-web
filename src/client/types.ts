export type Subject = 'math' | 'chinese' | 'physics' | 'english' | 'chemistry';

export const SUBJECTS: Subject[] = ['math', 'chinese', 'physics', 'english', 'chemistry'];

export function isSubject(value: string): value is Subject {
  return (SUBJECTS as string[]).includes(value);
}

export const SUBJECT_NAMES: Record<Subject, string> = {
  math: '数学',
  chinese: '语文',
  physics: '物理',
  english: '英语',
  chemistry: '化学',
};

export const SUBJECT_COLORS: Record<Subject, string> = {
  math: '#33648f',
  chinese: '#b8432f',
  physics: '#3a7d5c',
  english: '#b0782a',
  chemistry: '#7b4f8c',
};

export const PROVINCES = [
  '北京', '上海', '天津', '重庆',
  '河北', '山西', '内蒙古', '辽宁', '吉林', '黑龙江',
  '江苏', '浙江', '安徽', '福建', '江西', '山东',
  '河南', '湖北', '湖南', '广东', '广西', '海南',
  '四川', '贵州', '云南', '西藏', '陕西', '甘肃',
  '青海', '宁夏', '新疆', '香港', '澳门', '台湾',
];

const PROVINCE_SUFFIXES = [
  '维吾尔自治区',
  '壮族自治区',
  '回族自治区',
  '特别行政区',
  '自治区',
  '省',
  '市',
].sort((a, b) => b.length - a.length);

export function splitRegion(region: string): { province: string; city: string } {
  const trimmed = region.trim();
  if (!trimmed) return { province: '', city: '' };
  const matched = PROVINCES.find((p) => trimmed.startsWith(p));
  if (matched) {
    let city = trimmed.slice(matched.length);
    const suffix = PROVINCE_SUFFIXES.find((candidate) => city.startsWith(candidate));
    if (suffix) city = city.slice(suffix.length);
    city = city.trim();
    return { province: matched, city };
  }
  return { province: '', city: trimmed };
}

export function joinRegion(province: string, city: string): string {
  return [province, city.trim()].filter(Boolean).join(' ');
}

export const GRADES = [
  '一年级', '二年级', '三年级', '四年级', '五年级', '六年级',
  '初一', '初二', '初三',
  '高一', '高二', '高三',
];

export interface User {
  id: number;
  email: string;
  isAdmin: boolean;
  visionEnabled?: boolean;
}

export interface Student {
  id: number;
  name: string;
  grade: string;
  textbook: string;
  region: string;
  color: string;
  notes: string;
  created_at: string;
  conversation_count?: number;
  pending_mistake_count?: number;
}

export type ConversationSubject = Subject | 'selflearn';

export const CONVERSATION_SUBJECT_NAMES: Record<ConversationSubject, string> = {
  ...SUBJECT_NAMES,
  selflearn: '自学',
};

export const CONVERSATION_SUBJECT_COLORS: Record<ConversationSubject, string> = {
  ...SUBJECT_COLORS,
  selflearn: '#635c9b',
};

export const LEVEL_COLORS: Record<string, string> = {
  L1: '#c0392b',
  L2: '#b0782a',
  L3: '#3a7d5c',
  L4: '#33648f',
};

export interface Conversation {
  id: number;
  subject: ConversationSubject;
  mode: 'subject' | 'selflearn-profiling' | 'selflearn-daily';
  title: string;
  deep_thinking: number;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  reasoning_content: string | null;
  created_at: string;
  persisted?: boolean;
}

export interface ConversationDetail {
  conversation: {
    id: number;
    studentId: number;
    subject: ConversationSubject;
    mode: 'subject' | 'selflearn-profiling' | 'selflearn-daily';
    title: string;
    deepThinking: boolean;
    generating: boolean;
  };
  messages: Message[];
}

export interface KnowledgePoint {
  id: number;
  direction: string;
  chain: string;
  name: string;
  level: 'L1' | 'L2' | 'L3' | 'L4';
  evidence: string;
  needs_warmup: number;
  needs_retest: number;
  needs_rebuild: number;
  can_network: number;
  updated_at: string;
}

export interface LessonOutput {
  id: number;
  conversation_id: number | null;
  direction: string;
  content: string;
  next_instruction: string;
  created_at: string;
}

export interface DailyReport {
  id: number;
  conversation_id: number | null;
  report_date: string;
  content: string;
  created_at: string;
}

export interface ProfileFormData {
  directions: string[];
  goal: string;
  currentPosition: string;
  weakSpots: string;
  mainProblem: string;
  parentPriority: string;
  weekdayTime: string;
  weekendTime: string;
  startHabit: string;
  focusDuration: string;
  difficultyReaction: string;
  retellAbility: string;
  preferredStyles: string[];
  mistakeHabit: string;
  interestState: string;
  interests: string;
  parentInvolvement: string;
  forbidden: string[];
  specialNotes: string;
}

export const EMPTY_PROFILE_FORM: ProfileFormData = {
  directions: [],
  goal: '',
  currentPosition: '',
  weakSpots: '',
  mainProblem: '',
  parentPriority: '',
  weekdayTime: '',
  weekendTime: '',
  startHabit: '',
  focusDuration: '',
  difficultyReaction: '',
  retellAbility: '',
  preferredStyles: [],
  mistakeHabit: '',
  interestState: '',
  interests: '',
  parentInvolvement: '',
  forbidden: [],
  specialNotes: '',
};

export function hasProfileFormContent(form: ProfileFormData): boolean {
  return Object.values(form).some((value) =>
    Array.isArray(value) ? value.length > 0 : value.trim().length > 0,
  );
}

export function isProfileFormDirty(current: ProfileFormData, initial: ProfileFormData): boolean {
  return (Object.keys(EMPTY_PROFILE_FORM) as Array<keyof ProfileFormData>).some((key) => {
    const currentValue = current[key];
    const initialValue = initial[key];
    if (Array.isArray(currentValue) && Array.isArray(initialValue)) {
      return currentValue.length !== initialValue.length || currentValue.some((value, index) => value !== initialValue[index]);
    }
    return currentValue !== initialValue;
  });
}

export interface SelfLearnOverview {
  profile: { profile_text: string; form_json: string; ready: number; updated_at: string } | null;
  knowledgePoints: KnowledgePoint[];
  lessonOutputs: LessonOutput[];
  dailyReports: DailyReport[];
  conversations: Conversation[];
}

export interface MistakeCard {
  id: number;
  student_id: number;
  subject: ConversationSubject;
  direction: string;
  conversation_id: number | null;
  title: string;
  knowledge_point: string;
  my_answer: string;
  key_error: string;
  error_tags: string;
  correct_steps: string;
  reminder: string;
  retest_question: string;
  next_review_date: string;
  review_status: 'pending' | 'passed';
  created_at: string;
}

export interface Profile {
  subject: Subject;
  profile_text: string;
  updated_at: string;
}

export interface InviteCode {
  id: number;
  code: string;
  note: string;
  max_uses: number;
  used_count: number;
  disabled: number;
  created_at: string;
}

export interface AdminSettings {
  deepseekKeySet: boolean;
  deepseekKeyTail: string;
  deepseekFromEnv: boolean;
  visionKeySet: boolean;
  visionKeyTail: string;
  visionFromEnv: boolean;
  visionApiUrl: string;
  visionModel: string;
  profileRefineIntervalMinutes: number;
  profileRefineDailyLimit: number;
}

export interface AdminUser {
  id: number;
  email: string;
  is_admin: number;
  daily_message_limit: number;
  created_at: string;
  today_used: number;
  student_count: number;
}

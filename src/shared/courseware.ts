export type CoursewareStatus = 'queued' | 'generating' | 'ready' | 'failed' | 'deleting';
export type CoursewareGenerationStage =
  | 'queued' | 'scripting' | 'speech' | 'images' | 'finalizing' | 'ready' | 'failed';
export type CoursewareSegmentKind =
  | 'teacher_intro'
  | 'teacher_explanation'
  | 'student_question'
  | 'student_misconception'
  | 'teacher_reframe'
  | 'checkpoint'
  | 'summary';
export type CoursewareSpeaker = 'teacher' | 'student' | 'system';

export interface AlternateExplanation {
  displayMarkdown: string;
  speechText: string;
}

export interface CoursewareVisual {
  mode: 'formula' | 'generated_image' | 'none';
  prompt?: string;
  altText?: string;
}

export interface CoursewareCheckpoint {
  prompt: string;
  options?: string[];
  correctAnswer: string;
  explanation: string;
}

export interface CoursewareScriptSegment {
  segmentKey: string;
  kind: CoursewareSegmentKind;
  speaker: CoursewareSpeaker;
  title: string;
  displayMarkdown: string;
  speechText: string;
  alternateExplanation?: AlternateExplanation;
  visual: CoursewareVisual;
  checkpoint?: CoursewareCheckpoint;
}

export interface CoursewareScript {
  schemaVersion: 1;
  title: string;
  subject: string;
  grade: string;
  topic: string;
  learningObjectives: string[];
  estimatedMinutes: number;
  segments: CoursewareScriptSegment[];
}

export interface CoursewareSummary {
  id: number;
  studentId: number;
  title: string;
  subject: string;
  topic: string;
  status: CoursewareStatus;
  generationStage: CoursewareGenerationStage;
  progressPercent: number;
  requiredAudioReadyCount: number;
  requiredAudioTotalCount: number;
  retryable: boolean;
  imageRetryAvailable: boolean;
  errorCode: string;
  errorMessage: string;
  warnings: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CoursewareDetail extends CoursewareSummary {
  grade: string;
  learningObjectives: string[];
  estimatedMinutes: number;
  currentSegmentPosition: number;
  currentTimeMs: number;
  progressRevision: number;
  checkpointAnswers: Record<string, number | 'skipped'>;
  assessmentConversationId: number | null;
  segments: Array<CoursewareScriptSegment & {
    id: number;
    audioUrl: string;
    alternateAudioUrl: string | null;
    imageUrl: string | null;
    audioDurationMs: number;
    alternateAudioDurationMs: number;
  }>;
}

export interface CoursewareProgressSnapshot {
  currentSegmentPosition: number;
  currentTimeMs: number;
  checkpointAnswers: Record<string, number | 'skipped'>;
}

export interface CoursewareProgressPatch extends CoursewareProgressSnapshot {
  revision: number;
}

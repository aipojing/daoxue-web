import type { CoursewareDetail } from '../../shared/courseware';
import type { PlayerMode } from '../lib/courseware-player';
import MarkdownContent from './MarkdownContent';
import CoursewareCheckpoint from './CoursewareCheckpoint';
import teacherAvatar from '../assets/avatars/courseware-teacher.png';
import classmateAvatar from '../assets/avatars/courseware-classmate.png';

const kindMeta: Record<CoursewareDetail['segments'][number]['kind'], { label: string; tone: string }> = {
  teacher_intro: { label: '老师开场', tone: 'teacher' },
  teacher_explanation: { label: '老师讲解', tone: 'teacher' },
  student_question: { label: 'AI 同学提问', tone: 'student' },
  student_misconception: { label: 'AI 同学易错想法', tone: 'student' },
  teacher_reframe: { label: '换个角度讲', tone: 'reframe' },
  checkpoint: { label: '理解检查', tone: 'checkpoint' },
  summary: { label: '本课小结', tone: 'summary' },
};

interface Props {
  courseware: CoursewareDetail;
  currentPosition: number;
  completed: boolean;
  mode: PlayerMode;
  audioError: string;
  checkpointAnswers: Record<string, number | 'skipped'>;
  onSelect: (position: number) => void;
  onCheckpointAnswer: (segmentKey: string, optionIndex: number) => void;
  onCheckpointSkip: (segmentKey: string) => void;
  onContinue: () => void;
}

export default function CoursewareTimeline({
  courseware,
  currentPosition,
  completed,
  mode,
  audioError,
  checkpointAnswers,
  onSelect,
  onCheckpointAnswer,
  onCheckpointSkip,
  onContinue,
}: Props) {
  return (
    <ol className="courseware-timeline" aria-label="课程对话时间线">
      {courseware.segments.map((segment, position) => {
        const meta = kindMeta[segment.kind];
        const current = position === currentPosition;
        const isComplete = position < currentPosition || (completed && current);
        const hasError = current && Boolean(audioError);
        const alternateVisible = current && mode === 'alternate' && segment.alternateExplanation;
        const classmateSpeaking = segment.speaker === 'student';
        const speakerName = classmateSpeaking ? 'AI 同学' : segment.speaker === 'system' ? '互动练习' : '老师';
        return (
          <li
            key={segment.segmentKey}
            className={`courseware-timeline-item tone-${meta.tone}${current ? ' is-current' : ''}${isComplete ? ' is-complete' : ''}`}
            aria-current={current ? 'step' : undefined}
          >
            <div className="courseware-timeline-rail" aria-hidden="true">
              <span>{isComplete ? '✓' : position + 1}</span>
            </div>
            <div className="courseware-speaker">
              <img
                className="courseware-speaker-avatar"
                src={classmateSpeaking ? classmateAvatar : teacherAvatar}
                alt={`${speakerName}头像`}
              />
              <span>{speakerName}</span>
            </div>
            <article className="courseware-dialogue-card">
              <header>
                <button type="button" className="courseware-segment-title" onClick={() => onSelect(position)}>
                  <span>{meta.label}</span>
                  <strong>{segment.title}</strong>
                </button>
                <span className="courseware-segment-state">
                  {hasError ? '播放错误' : isComplete ? '已完成' : current ? '正在学习' : '未开始'}
                </span>
              </header>
              <MarkdownContent content={alternateVisible ? segment.alternateExplanation!.displayMarkdown : segment.displayMarkdown} />
              {alternateVisible && <p className="courseware-alternate-note">正在播放预先准备的备用讲解，结束后会停留在本段。</p>}
              {segment.visual.mode === 'generated_image' && segment.imageUrl && segment.visual.altText && (
                <figure className="courseware-visual">
                  <img src={segment.imageUrl} alt={segment.visual.altText} loading="lazy" />
                  <figcaption>{segment.visual.altText}</figcaption>
                </figure>
              )}
              {current && segment.kind === 'checkpoint' && (
                <CoursewareCheckpoint
                  segment={segment}
                  answer={checkpointAnswers[segment.segmentKey]}
                  onAnswer={(optionIndex) => onCheckpointAnswer(segment.segmentKey, optionIndex)}
                  onSkip={() => onCheckpointSkip(segment.segmentKey)}
                  onContinue={onContinue}
                />
              )}
            </article>
          </li>
        );
      })}
    </ol>
  );
}

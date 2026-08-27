import type { CoursewareDetail } from '../../shared/courseware';
import MarkdownContent from './MarkdownContent';

interface Props {
  segment: CoursewareDetail['segments'][number];
  answer: number | 'skipped' | undefined;
  onAnswer: (optionIndex: number) => void;
  onSkip: () => void;
  onContinue: () => void;
}

export default function CoursewareCheckpoint({ segment, answer, onAnswer, onSkip, onContinue }: Props) {
  const checkpoint = segment.checkpoint;
  if (!checkpoint) return null;
  const answered = answer !== undefined;
  const selectedText = typeof answer === 'number' ? checkpoint.options?.[answer] : undefined;
  const correct = selectedText === checkpoint.correctAnswer;

  return (
    <section className="courseware-checkpoint" aria-labelledby={`checkpoint-${segment.segmentKey}`}>
      <div className="courseware-checkpoint-heading">
        <span aria-hidden="true">✓</span>
        <div>
          <p className="courseware-eyebrow">理解检查</p>
          <h3 id={`checkpoint-${segment.segmentKey}`}>想一想再继续</h3>
        </div>
      </div>
      <MarkdownContent content={checkpoint.prompt} />
      {checkpoint.options && checkpoint.options.length > 0 ? (
        <div className="courseware-checkpoint-options" role="group" aria-label="检查点选项">
          {checkpoint.options.map((option, index) => (
            <button
              key={option}
              type="button"
              className={answer === index ? 'courseware-checkpoint-option is-selected' : 'courseware-checkpoint-option'}
              aria-pressed={answer === index}
              disabled={answered}
              onClick={() => onAnswer(index)}
            >
              <span>{String.fromCharCode(65 + index)}</span>
              {option}
            </button>
          ))}
        </div>
      ) : (
        <p className="courseware-checkpoint-note">这道检查没有选项，可以先听完讲解，再继续学习。</p>
      )}
      {!answered && (
        <button type="button" className="courseware-text-button" onClick={onSkip}>
          先跳过这题
        </button>
      )}
      {answered && (
        <div className="courseware-checkpoint-result" role="status">
          <strong>{answer === 'skipped' ? '已跳过，先看看讲解' : correct ? '回答正确' : '再换个角度理解'}</strong>
          <MarkdownContent content={checkpoint.explanation} />
          <button type="button" className="btn btn-primary" onClick={onContinue}>继续学习</button>
        </div>
      )}
    </section>
  );
}

import { useState } from 'react';
import { CONVERSATION_SUBJECT_NAMES, CONVERSATION_SUBJECT_COLORS, type MistakeCard } from '../types';
import { localToday } from '../lib/datetime';

interface Props {
  card: MistakeCard;
  onAction: (card: MistakeCard, action: 'pass' | 'fail') => void;
  onDelete: (card: MistakeCard) => void;
}

function parseTags(raw: string): string[] {
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

export default function MistakeCardItem({ card, onAction, onDelete }: Props) {
  const [expanded, setExpanded] = useState(false);
  const tags = parseTags(card.error_tags);
  const isDue = card.review_status === 'pending' && card.next_review_date <= localToday();

  return (
    <div className="card mistake-card">
      <button className="mistake-card-header" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        <span className="subject-chip" style={{ background: CONVERSATION_SUBJECT_COLORS[card.subject] }}>
          {card.subject === 'selflearn' && card.direction
            ? card.direction
            : CONVERSATION_SUBJECT_NAMES[card.subject]}
        </span>
        <span className="mistake-title">{card.title}</span>
        {card.review_status === 'passed' ? (
          <span className="badge badge-success">已通过</span>
        ) : isDue ? (
          <span className="badge badge-danger">今日应复测</span>
        ) : (
          <span className="badge">复测 {card.next_review_date.slice(5)}</span>
        )}
        <span className="expand-arrow">{expanded ? '▲' : '▼'}</span>
      </button>

      {tags.length > 0 && (
        <div className="mistake-tags">
          {tags.map((t) => (
            <span key={t} className="tag">
              {t}
            </span>
          ))}
        </div>
      )}

      {expanded && (
        <div className="mistake-detail">
          {card.knowledge_point && (
            <p>
              <strong>知识点：</strong>
              {card.knowledge_point}
            </p>
          )}
          {card.my_answer && (
            <p>
              <strong>原答案：</strong>
              {card.my_answer}
            </p>
          )}
          {card.key_error && (
            <p>
              <strong>关键错误：</strong>
              {card.key_error}
            </p>
          )}
          {card.correct_steps && (
            <p>
              <strong>正确步骤：</strong>
              {card.correct_steps}
            </p>
          )}
          {card.reminder && (
            <p className="mistake-reminder">
              <strong>提醒：{card.reminder}</strong>
            </p>
          )}
          {card.retest_question && (
            <div className="retest-box">
              <strong>复测题：</strong>
              {card.retest_question}
            </div>
          )}
          <div className="mistake-actions">
            {card.review_status === 'pending' && (
              <>
                <button className="btn btn-sm btn-success" onClick={() => onAction(card, 'pass')}>
                  ✓ 复测通过
                </button>
                <button className="btn btn-sm" onClick={() => onAction(card, 'fail')}>
                  ✗ 未通过（顺延 3 天）
                </button>
              </>
            )}
            <button className="btn btn-sm btn-danger-ghost" onClick={() => onDelete(card)}>
              删除
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

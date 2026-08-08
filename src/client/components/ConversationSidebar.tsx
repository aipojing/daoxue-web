import { Link, useNavigate } from 'react-router-dom';
import { apiDelete } from '../api';
import {
  SUBJECTS,
  SUBJECT_NAMES,
  SUBJECT_COLORS,
  CONVERSATION_SUBJECT_COLORS,
  type Conversation,
  type ConversationSubject,
  type Subject,
} from '../types';
import { IconTarget, IconPlus } from './icons';

interface Props {
  studentId: string;
  conversations: Conversation[];
  activeId: number | null;
  /** subject = 解题辅导上下文；selflearn = 自学陪伴上下文，二者互不混排 */
  mode: 'subject' | 'selflearn';
  subjectFilter: ConversationSubject | null;
  onFilterChange: (subject: ConversationSubject | null) => void;
  onDeleted: () => void;
  onNavigate?: () => void;
}

export default function ConversationSidebar({
  studentId,
  conversations,
  activeId,
  mode,
  subjectFilter,
  onFilterChange,
  onDeleted,
  onNavigate,
}: Props) {
  const navigate = useNavigate();
  const isSelfLearn = mode === 'selflearn';

  const scoped = conversations.filter((cv) =>
    isSelfLearn ? cv.subject === 'selflearn' : cv.subject !== 'selflearn',
  );
  const filtered =
    !isSelfLearn && subjectFilter ? scoped.filter((cv) => cv.subject === subjectFilter) : scoped;

  const onDelete = async (cv: Conversation) => {
    if (!window.confirm(`删除会话「${cv.title}」？`)) return;
    try {
      await apiDelete(`/api/conversations/${cv.id}`);
    } catch {
      window.alert('删除失败，请重试');
      return;
    }
    onDeleted();
    if (cv.id === activeId) {
      navigate(isSelfLearn ? `/students/${studentId}/selflearn` : `/students/${studentId}/tutoring`);
    }
  };

  return (
    <aside className="chat-sidebar">
      {isSelfLearn ? (
        <div className="sidebar-context">
          <Link to={`/students/${studentId}/selflearn`} className="sidebar-context-title" onClick={onNavigate}>
            <IconTarget size={16} />
            自学陪伴
          </Link>
          <Link
            to={`/students/${studentId}/chat/new?subject=selflearn&mode=daily`}
            className="sidebar-new-btn sidebar-new-selflearn"
            onClick={onNavigate}
          >
            <IconPlus size={14} />
            新学习会话
          </Link>
        </div>
      ) : (
        <>
          <div className="sidebar-new-row">
            {SUBJECTS.map((subj: Subject) => (
              <Link
                key={subj}
                to={`/students/${studentId}/chat/new?subject=${subj}`}
                className="sidebar-new-btn"
                style={{ color: SUBJECT_COLORS[subj], borderColor: SUBJECT_COLORS[subj] }}
                onClick={onNavigate}
              >
                ＋{SUBJECT_NAMES[subj]}
              </Link>
            ))}
          </div>
          <div className="sidebar-filter-row">
            <button
              className={subjectFilter === null ? 'chip active' : 'chip'}
              aria-pressed={subjectFilter === null}
              onClick={() => onFilterChange(null)}
            >
              全部
            </button>
            {SUBJECTS.map((subj) => (
              <button
                key={subj}
                className={subjectFilter === subj ? 'chip active' : 'chip'}
                aria-pressed={subjectFilter === subj}
                onClick={() => onFilterChange(subj)}
              >
                {SUBJECT_NAMES[subj]}
              </button>
            ))}
          </div>
        </>
      )}

      <div className="sidebar-list">
        {filtered.length === 0 && (
          <p className="text-secondary sidebar-empty">
            {isSelfLearn ? '还没有学习会话' : '暂无会话'}
          </p>
        )}
        {filtered.map((cv) => (
          <div key={cv.id} className={cv.id === activeId ? 'sidebar-item active' : 'sidebar-item'}>
            <Link to={`/students/${studentId}/chat/${cv.id}`} className="sidebar-item-link" onClick={onNavigate}>
              <span
                className="subject-dot"
                style={{ background: CONVERSATION_SUBJECT_COLORS[cv.subject] }}
                title={isSelfLearn ? (cv.mode === 'selflearn-profiling' ? '画像采集' : '每日学习') : undefined}
              />
              <span className="sidebar-item-title">{cv.title}</span>
            </Link>
            <button className="sidebar-item-delete" onClick={() => void onDelete(cv)} aria-label="删除会话">
              ✕
            </button>
          </div>
        ))}
      </div>
    </aside>
  );
}

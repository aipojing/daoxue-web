import { memo, useState } from 'react';
import MarkdownContent from './MarkdownContent';
import ErrorBoundary from './ErrorBoundary';
import { IconSpark, IconNotebook } from './icons';

interface Props {
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string | null;
  streaming?: boolean;
  messageId?: number;
  onSaveMistake?: (messageId: number) => void;
  saveState?: 'idle' | 'saving' | 'saved';
}

function MessageBubble({ role, content, reasoning, streaming, messageId, onSaveMistake, saveState }: Props) {
  const [reasoningOpen, setReasoningOpen] = useState(false);

  if (role === 'user') {
    return (
      <div className="message-row user">
        <div className="bubble bubble-user">{content}</div>
      </div>
    );
  }

  return (
    <div className="message-row assistant">
      <div className="bubble bubble-assistant">
        {reasoning && (
          <div className="reasoning-block">
            <button
              className="reasoning-toggle"
              aria-expanded={reasoningOpen}
              onClick={() => setReasoningOpen(!reasoningOpen)}
            >
              <IconSpark size={14} /> {streaming && !content ? '深度思考中…' : '已深度思考'}{' '}
              {reasoningOpen ? '▲' : '▼'}
            </button>
            {reasoningOpen && <div className="reasoning-content">{reasoning}</div>}
          </div>
        )}
        {content ? (
          <ErrorBoundary fallbackText="这条内容渲染出错了，原文可能含特殊符号。">
            <MarkdownContent content={content} />
          </ErrorBoundary>
        ) : (
          !reasoning && streaming && <span className="typing-indicator">思考中…</span>
        )}
        {streaming && content && <span className="cursor-blink">▍</span>}
        {!streaming && content && messageId !== undefined && onSaveMistake && (
          <div className="bubble-actions">
            <button
              className="btn-link"
              onClick={() => onSaveMistake(messageId)}
              disabled={saveState === 'saving'}
            >
              {saveState === 'saving' ? (
                '整理错题中…'
              ) : saveState === 'saved' ? (
                '✓ 已存入错题本'
              ) : (
                <>
                  <IconNotebook size={13} /> 存入错题本
                </>
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default memo(MessageBubble);

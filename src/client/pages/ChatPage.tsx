import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { apiGet, apiPost, apiPut, streamChatRequest, ApiError } from '../api';
import { useAuth } from '../AuthContext';
import { isNearBottom, isPersistedMessage } from '../lib/chat';
import { compressImageToDataUrl } from '../lib/image';
import {
  CONVERSATION_SUBJECT_NAMES,
  CONVERSATION_SUBJECT_COLORS,
  type Conversation,
  type ConversationDetail,
  type ConversationSubject,
  type Message,
} from '../types';
import MessageBubble from '../components/MessageBubble';
import ConversationSidebar from '../components/ConversationSidebar';
import { IconBack, IconMenu, IconCamera } from '../components/icons';

const SUBJECT_INTROS: Record<string, string> = {
  math: '我可以按提示、分步导学、完整题解、批改复盘或同类训练来帮助学习数学。把完整题目发给我吧；如果已经做过，也把答案或卡住的位置一起发来。',
  chinese: '把题目和阅读材料一起发给我；如果已经作答，附上你的答案。我会帮你找到答案依据，默认分步导学。',
  physics: '把完整题目、数据或实验条件发给我；如果做过也附上过程。我会先和你确认研究对象和物理过程，默认分步导学。',
  english: '把题目、文章或作文要求发给我；如果已经作答，附上答案或草稿。我会先帮你找到关键词和真正卡点，默认分步导学。',
  chemistry:
    '请告诉我：1. 年级；2. 化学题目或清晰图片；3. 你已经写出的过程；4. 你认为卡住的位置；5. 希望使用的模式：提示、分步导学、批改复盘或完整讲解。未选择模式时，我会根据现有信息采用批改复盘或分步导学。',
  'selflearn-profiling':
    '这里是孩子学习画像采集。请家长回复"开始"，我会分几轮提问（每轮最多 6 个问题）了解孩子的情况；不确定的可以答"不确定"。画像建立后就能开始每日学习。',
  'selflearn-daily':
    '输入"开始今天的学习"，我会按固定流程进行：任务确认 → 旧知识保温 → 知识拆解 → 生成课件提示词（复制到 open.maic.chat 上课）→ 孩子学完回来说"学完了" → 测验与错题卡 → 每课输出。当天结束时说"今天结束"生成每日家长反馈。',
};

interface StreamingState {
  active: boolean;
  content: string;
  reasoning: string;
}

const IDLE_STREAM: StreamingState = { active: false, content: '', reasoning: '' };

export default function ChatPage() {
  const { studentId, conversationId } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [detail, setDetail] = useState<ConversationDetail['conversation'] | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [subjectFilter, setSubjectFilter] = useState<ConversationSubject | null>(null);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState<StreamingState>(IDLE_STREAM);
  const [error, setError] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [saveStates, setSaveStates] = useState<Record<number, 'saving' | 'saved'>>({});
  const [toast, setToast] = useState('');

  const scrollRef = useRef<HTMLDivElement>(null);
  const streamingRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const loadGenRef = useRef(0);
  const creatingRef = useRef(false);
  const stickToBottomRef = useRef(true);
  const streamBufRef = useRef({ content: '', reasoning: '' });
  const [ocrLoading, setOcrLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [savedMistakeToast, setSavedMistakeToast] = useState(false);
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches,
  );

  const isNew = conversationId === 'new';

  const loadConversations = useCallback(async () => {
    try {
      setConversations(await apiGet<Conversation[]>(`/api/students/${studentId}/conversations`));
    } catch {
      /* 列表加载失败不阻塞聊天 */
    }
  }, [studentId]);

  const loadDetail = useCallback(async () => {
    if (isNew) return;
    // 世代号：切换会话后旧请求的响应到达时直接丢弃，避免显示错会话的内容
    const gen = ++loadGenRef.current;
    setLoadFailed(false);
    try {
      const data = await apiGet<ConversationDetail>(`/api/conversations/${conversationId}/messages`);
      if (gen !== loadGenRef.current) return;
      setDetail(data.conversation);
      setMessages(data.messages.map((message) => ({ ...message, persisted: true })));
    } catch (e) {
      if (gen !== loadGenRef.current) return;
      setError(e instanceof ApiError ? e.message : '加载会话失败');
      setLoadFailed(true);
    }
  }, [conversationId, isNew]);

  useEffect(() => {
    stickToBottomRef.current = true;
    if (isNew) {
      if (creatingRef.current) return;
      creatingRef.current = true;
      let cancelled = false;
      const subject = searchParams.get('subject') ?? 'math';
      const modeParam = searchParams.get('mode');
      const body: { subject: string; mode?: string } = { subject };
      if (subject === 'selflearn') {
        body.mode = modeParam === 'profiling' ? 'selflearn-profiling' : 'selflearn-daily';
      }
      apiPost<Conversation>(`/api/students/${studentId}/conversations`, body)
        .then((cv) => {
          if (!cancelled) navigate(`/students/${studentId}/chat/${cv.id}`, { replace: true });
        })
        .catch((e) => {
          if (!cancelled) setError(e instanceof ApiError ? e.message : '创建会话失败');
        })
        .finally(() => {
          creatingRef.current = false;
        });
      return () => {
        cancelled = true;
      };
    }
    setDetail(null);
    setMessages([]);
    setError('');
    setStreaming(IDLE_STREAM);
    void loadDetail();
    void loadConversations();
  }, [isNew, conversationId, studentId, searchParams, navigate, loadDetail, loadConversations]);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(max-width: 767px)');
    const onChange = (event: MediaQueryListEvent) => setIsMobile(event.matches);
    setIsMobile(mediaQuery.matches);
    mediaQuery.addEventListener('change', onChange);
    return () => mediaQuery.removeEventListener('change', onChange);
  }, []);

  // 仅在用户本来就贴着底部时自动滚动，避免上翻查看历史时被拽回来
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, streaming]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 3000);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!savedMistakeToast) return;
    const timer = setTimeout(() => setSavedMistakeToast(false), 6000);
    return () => clearTimeout(timer);
  }, [savedMistakeToast]);

  // 输入框随内容自适应高度
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  // 离开页面时中断进行中的流，避免卸载后继续写入状态
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
      streamingRef.current = false;
    };
  }, [conversationId]);

  const send = async (override?: string) => {
    const content = (override ?? input).trim();
    if (!content || streamingRef.current || !detail) return;
    streamingRef.current = true;
    setError('');
    setInput('');
    const optimisticId = -Date.now();
    setMessages((prev) => [
      ...prev,
      { id: optimisticId, role: 'user', content, reasoning_content: null, created_at: '', persisted: false },
    ]);
    setStreaming({ active: true, content: '', reasoning: '' });

    const controller = new AbortController();
    abortRef.current = controller;
    streamBufRef.current = { content: '', reasoning: '' };
    stickToBottomRef.current = true;

    // 把流内容落成一条正式消息（updater 保持纯函数，不在里面套 setState）
    const commitStreamed = (messageId: number | null) => {
      const { content: text, reasoning } = streamBufRef.current;
      streamBufRef.current = { content: '', reasoning: '' };
      if (text || reasoning) {
        setMessages((msgs) => [
          ...msgs,
          {
            id: messageId ?? Date.now(),
            role: 'assistant',
            content: text,
            reasoning_content: reasoning || null,
            created_at: '',
            persisted: messageId !== null,
          },
        ]);
      }
      setStreaming(IDLE_STREAM);
    };

    await streamChatRequest(
      detail.id,
      content,
      {
        onDelta: (text) => {
          if (controller.signal.aborted) return;
          streamBufRef.current.content += text;
          setStreaming((prev) => ({ ...prev, content: prev.content + text }));
        },
        onReasoning: (text) => {
          if (controller.signal.aborted) return;
          streamBufRef.current.reasoning += text;
          setStreaming((prev) => ({ ...prev, reasoning: prev.reasoning + text }));
        },
        onDone: (messageId) => {
          if (controller.signal.aborted) return;
          streamingRef.current = false;
          abortRef.current = null;
          commitStreamed(messageId);
          void loadConversations();
        },
        onError: (message) => {
          if (controller.signal.aborted) return;
          streamingRef.current = false;
          abortRef.current = null;
          setStreaming(IDLE_STREAM);
          setError(message);
          // 失败时把内容还给用户，并撤掉乐观插入的气泡，避免辛苦打的题目丢失
          setMessages((prev) => prev.filter((m) => m.id !== optimisticId));
          setInput((prev) => (prev.trim() ? prev : content));
          streamBufRef.current = { content: '', reasoning: '' };
        },
      },
      controller.signal,
    );
  };

  const stopStreaming = () => {
    const { content: text, reasoning } = streamBufRef.current;
    abortRef.current?.abort();
    abortRef.current = null;
    streamingRef.current = false;
    streamBufRef.current = { content: '', reasoning: '' };
    if (text || reasoning) {
      setMessages((msgs) => [
        ...msgs,
        {
          id: Date.now(),
          role: 'assistant',
          content: text,
          reasoning_content: reasoning || null,
          created_at: '',
          persisted: false,
        },
      ]);
    }
    setStreaming(IDLE_STREAM);
    void loadConversations();
  };

  const toggleDeepThinking = async () => {
    if (!detail) return;
    const next = !detail.deepThinking;
    setDetail((prev) => (prev ? { ...prev, deepThinking: next } : prev));
    try {
      await apiPut(`/api/conversations/${detail.id}`, { deepThinking: next });
    } catch {
      setDetail((prev) => (prev ? { ...prev, deepThinking: !next } : prev));
      setToast('设置未能保存，请重试');
    }
  };

  const saveMistake = async (messageId: number) => {
    if (!detail) return;
    setSaveStates((prev) => ({ ...prev, [messageId]: 'saving' }));
    try {
      const message = messages.find((m) => m.id === messageId);
      const realId = message && isPersistedMessage(message) ? messageId : undefined;
      await apiPost(`/api/conversations/${detail.id}/mistake-card`, realId !== undefined ? { messageId: realId } : {});
      setSaveStates((prev) => ({ ...prev, [messageId]: 'saved' }));
      setSavedMistakeToast(true);
    } catch (e) {
      setSaveStates((prev) => {
        const { [messageId]: _removed, ...rest } = prev;
        return rest;
      });
      setToast(e instanceof ApiError ? e.message : '保存失败');
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // 中文输入法选字时按回车是确认候选词，不能当作发送
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    // 手机软键盘的回车用于换行，只能点发送按钮
    if (isMobile) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  const onPickImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !detail || ocrLoading) return;
    setOcrLoading(true);
    setError('');
    try {
      const dataUrl = await compressImageToDataUrl(file);
      const result = await apiPost<{ text: string }>(`/api/conversations/${detail.id}/ocr`, {
        image: dataUrl,
      });
      setInput((prev) => (prev.trim() ? `${prev}\n${result.text}` : result.text));
      setToast('已识别题目，请核对无误后发送 ✓');
    } catch (err2) {
      setToast(err2 instanceof ApiError ? err2.message : err2 instanceof Error ? err2.message : '图片识别失败');
    } finally {
      setOcrLoading(false);
    }
  };

  const subject = detail?.subject;
  const isSelfLearn = subject === 'selflearn' || (!detail && searchParams.get('subject') === 'selflearn');
  const backLink = isSelfLearn ? `/students/${studentId}/selflearn` : `/students/${studentId}/tutoring`;
  const introKey = subject === 'selflearn' ? detail?.mode : subject;

  return (
    <div className="chat-page">
      <div className={sidebarOpen ? 'chat-sidebar-wrap open' : 'chat-sidebar-wrap'}>
        <ConversationSidebar
          studentId={studentId!}
          conversations={conversations}
          activeId={detail?.id ?? null}
          mode={isSelfLearn ? 'selflearn' : 'subject'}
          subjectFilter={subjectFilter}
          onFilterChange={setSubjectFilter}
          onDeleted={() => void loadConversations()}
          onNavigate={() => setSidebarOpen(false)}
        />
      </div>
      {sidebarOpen && <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} />}

      <div className="chat-main">
        <header className="chat-header">
          <button className="icon-btn sidebar-toggle" onClick={() => setSidebarOpen(true)} aria-label="会话列表">
            <IconMenu />
          </button>
          <Link to={backLink} className="icon-btn" aria-label="返回">
            <IconBack />
          </Link>
          <div className="chat-header-title">
            {loadFailed && (
              <button className="btn btn-sm" onClick={() => void loadDetail()}>
                重新加载
              </button>
            )}
            {subject && (
              <span className="subject-chip" style={{ background: CONVERSATION_SUBJECT_COLORS[subject] }}>
                {CONVERSATION_SUBJECT_NAMES[subject]}
              </span>
            )}
            <span className="chat-title-text">{detail?.title ?? '加载中…'}</span>
          </div>
          <label className="deep-toggle" title="使用 deepseek-reasoner 深度推理，适合难题">
            <input
              type="checkbox"
              checked={detail?.deepThinking ?? false}
              onChange={() => void toggleDeepThinking()}
              disabled={!detail}
            />
            <span>深度思考</span>
          </label>
        </header>

        <div
          className="chat-messages"
          ref={scrollRef}
          onScroll={(event) => {
            stickToBottomRef.current = isNearBottom(event.currentTarget);
          }}
        >
          {detail && messages.length === 0 && !streaming.active && (
            <div className="chat-intro card">
              <p>{introKey ? (SUBJECT_INTROS[introKey] ?? '') : ''}</p>
              <p className="text-secondary chat-intro-note">
                {user?.visionEnabled
                  ? '可以点输入框旁的相机按钮拍题，系统会自动转写成文字——发送前请核对转写内容是否与原题一致。'
                  : '暂不支持图片，请把题目打字或粘贴成文字发送（包括图中的数据和条件）。'}
              </p>
            </div>
          )}
          {messages.map((m) => (
            <MessageBubble
              key={m.id}
              role={m.role}
              content={m.content}
              reasoning={m.reasoning_content}
              onSaveMistake={m.role === 'assistant' && !isSelfLearn ? () => void saveMistake(m.id) : undefined}
              saveState={saveStates[m.id] ?? 'idle'}
            />
          ))}
          {streaming.active && (
            <MessageBubble
              role="assistant"
              content={streaming.content}
              reasoning={streaming.reasoning || null}
              streaming
            />
          )}
          {error && <div className="form-error chat-error">{error}</div>}
        </div>

        {streaming.active ? (
          <div className="stop-bar">
            <button className="btn btn-sm" onClick={stopStreaming}>
              停止生成
            </button>
          </div>
        ) : (
          detail?.mode === 'selflearn-daily' && (
            <div className="quick-phrases">
              {['开始今天的学习', '学完了', '今天结束'].map((phrase) => (
                <button key={phrase} className="chip" onClick={() => void send(phrase)}>
                  {phrase}
                </button>
              ))}
            </div>
          )
        )}

        <div className="chat-input-bar">
          {user?.visionEnabled && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                style={{ display: 'none' }}
                onChange={(e) => void onPickImage(e)}
              />
              <button
                type="button"
                className="icon-btn camera-btn"
                title="拍照/上传题目，自动转写为文字"
                aria-label="拍照识题"
                disabled={!detail || streaming.active || ocrLoading}
                onClick={() => fileInputRef.current?.click()}
              >
                {ocrLoading ? <span className="btn-spinner" /> : <IconCamera size={20} />}
              </button>
            </>
          )}
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={
              isMobile ? '输入题目或问题…' : '输入题目或问题…（Enter 发送，Shift+Enter 换行）'
            }
            rows={1}
            disabled={!detail || streaming.active}
          />
          <button
            className="btn btn-primary chat-send"
            onClick={() => void send()}
            disabled={!detail || streaming.active || !input.trim()}
          >
            发送
          </button>
        </div>
      </div>

      {savedMistakeToast && (
        <div className="toast" role="status">
          已存入错题本 ✓
          <Link to={`/students/${studentId}/mistakes`} className="toast-link">
            去查看
          </Link>
        </div>
      )}
      {toast && !savedMistakeToast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}

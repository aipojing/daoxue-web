import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { apiDelete, apiGet, apiPost, apiPut, streamChatRequest, ApiError } from '../api';
import { useAuth } from '../AuthContext';
import {
  isNearBottom,
  isPersistedMessage,
  isStreamReconciliationExpired,
  finishPending,
  getOrCreatePendingRequest,
  consumeAssessmentRouteState,
  hideCoursewareMachineBlock,
  isCoursewareDailyConversation,
  markPersistedMessages,
  nextStickToBottom,
  resolveChatRequestId,
  shouldApplyConversationDetail,
  shouldApplyAsyncResult,
  shouldCommitAssistantMessage,
  shouldDiscardCancelledCreation,
  shouldSubmitChatOnKeyDown,
  streamErrorRecovery,
  streamReconciliationDecision,
  subscribeToMobileMediaQuery,
  selfLearnDailyIntro,
  tryStartPending,
  type CoursewareSettingsState,
} from '../lib/chat';
import { compressImageToDataUrl } from '../lib/image';
import {
  CONVERSATION_SUBJECT_NAMES,
  CONVERSATION_SUBJECT_COLORS,
  type Conversation,
  type ConversationDetail,
  type ConversationSubject,
  type CoursewareAISettings,
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
  history:
    '请告诉我年级，并发完整题目、材料、选项和分值；如果已经作答，也请附上答案或卡住的位置。未指定模式时，我会默认逐步导学，先确定时空、材料类型和设问。',
  'selflearn-profiling':
    '这里是孩子学习画像采集。请家长回复"开始"，我会分几轮提问（每轮最多 6 个问题）了解孩子的情况；不确定的可以答"不确定"。画像建立后就能开始每日学习。',
};

interface StreamingState {
  active: boolean;
  content: string;
  reasoning: string;
}

const IDLE_STREAM: StreamingState = { active: false, content: '', reasoning: '' };
const waitForReconciliation = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export default function ChatPage() {
  const { studentId, conversationId } = useParams();
  const [searchParams] = useSearchParams();
  const location = useLocation();
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
  const [deepThinkingPendingId, setDeepThinkingPendingId] = useState<number | null>(null);
  const [reconcilingStream, setReconcilingStream] = useState(false);
  const [toast, setToast] = useState('');
  const [coursewareSettings, setCoursewareSettings] = useState<CoursewareAISettings | null>(null);
  const [coursewareSettingsState, setCoursewareSettingsState] = useState<CoursewareSettingsState>('loading');

  const scrollRef = useRef<HTMLDivElement>(null);
  const streamingRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const loadGenRef = useRef(0);
  const routeConversationIdRef = useRef(conversationId);
  const routeKeyRef = useRef(`${studentId ?? ''}:${conversationId ?? ''}`);
  const asyncGenRef = useRef(0);
  const creationRequestsRef = useRef(new Map<string, Promise<Conversation>>());
  const currentCreationKeyRef = useRef('');
  const deletingOrphanIdsRef = useRef(new Set<number>());
  const mountedRef = useRef(false);
  const restoredRequestRef = useRef<{ content: string; requestId: string } | null>(null);
  const pendingActionsRef = useRef(new Set<string>());
  const consumedAssessmentRef = useRef(new Set<string>());
  const stickToBottomRef = useRef(true);
  const streamBufRef = useRef({ content: '', reasoning: '' });
  const detailRef = useRef(detail);
  const messagesRef = useRef(messages);
  const [ocrLoading, setOcrLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [savedMistakeToast, setSavedMistakeToast] = useState(false);
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches,
  );

  const isNew = conversationId === 'new';
  const requestedSubject = searchParams.get('subject') ?? 'math';
  const requestedMode =
    requestedSubject === 'selflearn'
      ? searchParams.get('mode') === 'profiling'
        ? 'selflearn-profiling'
        : 'selflearn-daily'
      : 'subject';
  const requestedCreationKey = `${studentId ?? ''}:${requestedSubject}:${requestedMode}`;
  routeConversationIdRef.current = conversationId;
  routeKeyRef.current = `${studentId ?? ''}:${conversationId ?? ''}`;
  currentCreationKeyRef.current = isNew ? requestedCreationKey : '';
  detailRef.current = detail;
  messagesRef.current = messages;

  const loadConversations = useCallback(async () => {
    try {
      setConversations(await apiGet<Conversation[]>(`/api/students/${studentId}/conversations`));
    } catch {
      /* 列表加载失败不阻塞聊天 */
    }
  }, [studentId]);

  const loadDetail = useCallback(async () => {
    const requestedConversationId = conversationId;
    if (isNew || !requestedConversationId) return null;
    // 世代号：切换会话后旧请求的响应到达时直接丢弃，避免显示错会话的内容
    const gen = ++loadGenRef.current;
    setLoadFailed(false);
    try {
      const data = await apiGet<ConversationDetail>(`/api/conversations/${requestedConversationId}/messages`);
      if (
        !shouldApplyConversationDetail({
          routeConversationId: routeConversationIdRef.current,
          requestedConversationId,
          currentGeneration: loadGenRef.current,
          requestGeneration: gen,
          routeStudentId: studentId,
          responseStudentId: data.conversation.studentId,
        })
      ) {
        const sameConversationRequest =
          routeConversationIdRef.current === requestedConversationId && loadGenRef.current === gen;
        if (sameConversationRequest && studentId && Number(studentId) !== data.conversation.studentId) {
          navigate(`/students/${data.conversation.studentId}/chat/${data.conversation.id}`, { replace: true });
        }
        return null;
      }
      setDetail(data.conversation);
      setMessages(markPersistedMessages(data.messages));
      return data;
    } catch (e) {
      if (
        !shouldApplyConversationDetail({
          routeConversationId: routeConversationIdRef.current,
          requestedConversationId,
          currentGeneration: loadGenRef.current,
          requestGeneration: gen,
        })
      ) return null;
      setError(e instanceof ApiError ? e.message : '加载会话失败');
      setLoadFailed(true);
      return null;
    }
  }, [conversationId, isNew, navigate, studentId]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    stickToBottomRef.current = nextStickToBottom(stickToBottomRef.current, 'route');
    loadGenRef.current += 1;
    asyncGenRef.current += 1;
    setDetail(null);
    setMessages([]);
    setInput('');
    restoredRequestRef.current = null;
    setError('');
    setStreaming(IDLE_STREAM);
    setReconcilingStream(false);
    setOcrLoading(false);
    setLoadFailed(false);
    if (isNew) {
      let cancelled = false;
      const body: { subject: string; mode?: string } = { subject: requestedSubject };
      if (requestedSubject === 'selflearn') {
        body.mode = requestedMode;
      }
      const creationKey = requestedCreationKey;
      getOrCreatePendingRequest(creationRequestsRef.current, creationKey, () =>
        apiPost<Conversation>(`/api/students/${studentId}/conversations`, body),
      )
        .then((cv) => {
          if (!cancelled) {
            navigate(`/students/${studentId}/chat/${cv.id}`, { replace: true });
          } else if (
            shouldDiscardCancelledCreation(
              cancelled,
              creationKey,
              currentCreationKeyRef.current,
              mountedRef.current,
            ) &&
            !deletingOrphanIdsRef.current.has(cv.id)
          ) {
            deletingOrphanIdsRef.current.add(cv.id);
            void apiDelete(`/api/conversations/${cv.id}`)
              .catch(() => {})
              .finally(() => deletingOrphanIdsRef.current.delete(cv.id));
          }
        })
        .catch((e) => {
          if (!cancelled) setError(e instanceof ApiError ? e.message : '创建会话失败');
        });
      return () => {
        cancelled = true;
      };
    }
    void loadDetail();
    void loadConversations();
  }, [
    isNew,
    conversationId,
    studentId,
    searchParams,
    navigate,
    loadDetail,
    loadConversations,
    requestedCreationKey,
    requestedMode,
    requestedSubject,
  ]);

  useEffect(() => {
    return () => {
      asyncGenRef.current += 1;
    };
  }, [studentId, conversationId]);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(max-width: 767px)');
    return subscribeToMobileMediaQuery(mediaQuery, setIsMobile);
  }, []);

  useEffect(() => {
    if (!isCoursewareDailyConversation(detail?.subject, detail?.mode)) {
      setCoursewareSettings(null);
      setCoursewareSettingsState('loading');
      return;
    }
    const controller = new AbortController();
    setCoursewareSettings(null);
    setCoursewareSettingsState('loading');
    void apiGet<CoursewareAISettings>('/api/courseware-ai-settings', { signal: controller.signal })
      .then((settings) => {
        if (controller.signal.aborted) return;
        setCoursewareSettings(settings);
        setCoursewareSettingsState('ready');
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setCoursewareSettings(null);
        setCoursewareSettingsState('error');
      });
    return () => controller.abort();
  }, [detail?.mode, detail?.subject]);

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

  const send = async (override?: string, fixedRequestId?: string) => {
    const content = (override ?? input).trim();
    if (isNew || !content || streamingRef.current || !detail) return;
    const requestId = fixedRequestId ?? resolveChatRequestId(
      restoredRequestRef.current, content, () => crypto.randomUUID(),
    );
    const isCoursewareDaily = isCoursewareDailyConversation(detail.subject, detail.mode);
    restoredRequestRef.current = null;
    streamingRef.current = true;
    setError('');
    setInput('');
    const previousLatestUserId =
      [...messages].reverse().find((message) => message.role === 'user' && isPersistedMessage(message))?.id ?? null;
    const optimisticId = -Date.now();
    setMessages((prev) => [
      ...prev,
      { id: optimisticId, role: 'user', content, reasoning_content: null, created_at: '', persisted: false },
    ]);
    setStreaming({ active: true, content: '', reasoning: '' });

    const controller = new AbortController();
    abortRef.current = controller;
    streamBufRef.current = { content: '', reasoning: '' };
    stickToBottomRef.current = nextStickToBottom(stickToBottomRef.current, 'send');

    // 把流内容落成一条正式消息（updater 保持纯函数，不在里面套 setState）
    const commitStreamed = (messageId: number | null) => {
      const { content: text, reasoning } = streamBufRef.current;
      streamBufRef.current = { content: '', reasoning: '' };
      if (shouldCommitAssistantMessage(text, reasoning)) {
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
          const visible = isCoursewareDaily
            ? hideCoursewareMachineBlock(streamBufRef.current.content)
            : streamBufRef.current.content;
          setStreaming((prev) => ({ ...prev, content: visible }));
        },
        onReasoning: (text) => {
          if (controller.signal.aborted) return;
          streamBufRef.current.reasoning += text;
          const visibleReasoning = isCoursewareDaily
            ? hideCoursewareMachineBlock(streamBufRef.current.reasoning)
            : streamBufRef.current.reasoning;
          setStreaming((prev) => ({ ...prev, reasoning: visibleReasoning }));
        },
        onDone: (messageId) => {
          if (controller.signal.aborted) return;
          streamingRef.current = false;
          abortRef.current = null;
          setReconcilingStream(false);
          if (isCoursewareDaily) {
            streamBufRef.current = { content: '', reasoning: '' };
            setStreaming(IDLE_STREAM);
            void loadDetail();
          } else {
            commitStreamed(messageId);
          }
          void loadConversations();
        },
        onError: (message, metadata) => {
          if (controller.signal.aborted) return;
          setStreaming(IDLE_STREAM);
          setError(message);
          streamBufRef.current = { content: '', reasoning: '' };
          if (streamErrorRecovery(metadata) === 'reconcile') {
            if (metadata) {
              // 服务端已明确返回落库 ID，直接用历史对账。
              streamingRef.current = false;
              abortRef.current = null;
              setReconcilingStream(false);
              void loadDetail();
            } else {
              // 无元数据的网络中断无法立即确定 Worker 是否已接收。
              // 等待服务端会话租约结束后再决定是否恢复草稿，避免重复计费。
              const requestedRouteKey = routeKeyRef.current;
              setReconcilingStream(true);
              setError(`${message}，正在确认发送状态…`);
              void (async () => {
                let consecutiveRestores = 0;
                let loadFailureStartedAt: number | null = null;
                await waitForReconciliation(300);
                while (
                  mountedRef.current &&
                  routeKeyRef.current === requestedRouteKey &&
                  !controller.signal.aborted
                ) {
                  const data = await loadDetail();
                  if (!data) {
                    loadFailureStartedAt ??= Date.now();
                    if (isStreamReconciliationExpired(loadFailureStartedAt, Date.now())) {
                      restoredRequestRef.current = { content, requestId };
                      setInput((prev) => (prev.trim() ? prev : content));
                      setError('暂时无法确认发送状态；可以重试，系统会用同一请求编号避免重复提交');
                      break;
                    }
                    await waitForReconciliation(1500);
                    continue;
                  }
                  loadFailureStartedAt = null;
                  const decision = streamReconciliationDecision(
                    data.messages,
                    content,
                    previousLatestUserId,
                    data.conversation.generating,
                  );
                  if (decision === 'settled') {
                    setError('连接曾中断，已同步服务端记录');
                    break;
                  }
                  if (decision === 'restore') {
                    consecutiveRestores += 1;
                    if (consecutiveRestores >= 2) {
                      restoredRequestRef.current = { content, requestId };
                      setInput((prev) => (prev.trim() ? prev : content));
                      setError(message);
                      break;
                    }
                  } else {
                    consecutiveRestores = 0;
                    setError(`${message}，正在确认发送状态…`);
                  }
                  await waitForReconciliation(decision === 'wait' ? 1000 : 500);
                }
              })().finally(() => {
                if (abortRef.current === controller) abortRef.current = null;
                streamingRef.current = false;
                if (mountedRef.current && routeKeyRef.current === requestedRouteKey) {
                  setReconcilingStream(false);
                }
              });
            }
            void loadConversations();
          } else {
            // 请求未落库时把内容还给用户，并撤掉乐观气泡。
            streamingRef.current = false;
            abortRef.current = null;
            setReconcilingStream(false);
            setMessages((prev) => prev.filter((m) => m.id !== optimisticId));
            restoredRequestRef.current = { content, requestId };
            setInput((prev) => (prev.trim() ? prev : content));
          }
        },
      },
      controller.signal,
      requestId,
    );
  };

  useEffect(() => {
    if (!detail || detail.id !== Number(conversationId)) return;
    const assessment = consumeAssessmentRouteState(location.state, detail.id, consumedAssessmentRef.current);
    if (!assessment) return;
    navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
    void send(assessment.starterText, assessment.requestId);
    // send is intentionally gated by the consumed set and the synchronous streaming ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, detail?.id, location.pathname, location.search, location.state, navigate]);

  const stopStreaming = () => {
    const { content: text, reasoning } = streamBufRef.current;
    abortRef.current?.abort();
    abortRef.current = null;
    streamingRef.current = false;
    streamBufRef.current = { content: '', reasoning: '' };
    const isCoursewareDaily = isCoursewareDailyConversation(detail?.subject, detail?.mode);
    const visibleText = isCoursewareDaily ? hideCoursewareMachineBlock(text) : text;
    const visibleReasoning = isCoursewareDaily ? hideCoursewareMachineBlock(reasoning) : reasoning;
    if (shouldCommitAssistantMessage(visibleText, visibleReasoning)) {
      setMessages((msgs) => [
        ...msgs,
        {
          id: Date.now(),
          role: 'assistant',
          content: visibleText,
          reasoning_content: visibleReasoning || null,
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
    const conversationIdToUpdate = detail.id;
    const pendingKey = `deep-thinking:${conversationIdToUpdate}`;
    if (!tryStartPending(pendingActionsRef.current, pendingKey)) return;
    const next = !detail.deepThinking;
    setDeepThinkingPendingId(conversationIdToUpdate);
    setDetail((prev) =>
      prev?.id === conversationIdToUpdate ? { ...prev, deepThinking: next } : prev,
    );
    try {
      await apiPut(`/api/conversations/${conversationIdToUpdate}`, { deepThinking: next });
    } catch {
      setDetail((prev) =>
        prev?.id === conversationIdToUpdate ? { ...prev, deepThinking: !next } : prev,
      );
      if (detailRef.current?.id === conversationIdToUpdate) setToast('设置未能保存，请重试');
    } finally {
      finishPending(pendingActionsRef.current, pendingKey);
      setDeepThinkingPendingId((current) => (current === conversationIdToUpdate ? null : current));
    }
  };

  const saveMistake = useCallback(async (messageId: number) => {
    const currentDetail = detailRef.current;
    if (!currentDetail) return;
    const requestedRouteKey = routeKeyRef.current;
    const pendingKey = `save-mistake:${currentDetail.id}:${messageId}`;
    if (!tryStartPending(pendingActionsRef.current, pendingKey)) return;
    setSaveStates((prev) => ({ ...prev, [messageId]: 'saving' }));
    try {
      const message = messagesRef.current.find((m) => m.id === messageId);
      const realId = message && isPersistedMessage(message) ? messageId : undefined;
      await apiPost(
        `/api/conversations/${currentDetail.id}/mistake-card`,
        realId !== undefined ? { messageId: realId } : {},
      );
      if (routeKeyRef.current !== requestedRouteKey) return;
      setSaveStates((prev) => ({ ...prev, [messageId]: 'saved' }));
      setSavedMistakeToast(true);
    } catch (e) {
      if (routeKeyRef.current !== requestedRouteKey) return;
      setSaveStates((prev) => {
        const { [messageId]: _removed, ...rest } = prev;
        return rest;
      });
      setToast(e instanceof ApiError ? e.message : '保存失败');
    } finally {
      finishPending(pendingActionsRef.current, pendingKey);
    }
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      shouldSubmitChatOnKeyDown({
        key: e.key,
        shiftKey: e.shiftKey,
        isComposing: e.nativeEvent.isComposing,
        isMobile,
      })
    ) {
      e.preventDefault();
      void send();
    }
  };

  const onPickImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !detail || ocrLoading) return;
    const requestedRouteKey = routeKeyRef.current;
    const requestGeneration = ++asyncGenRef.current;
    setOcrLoading(true);
    setError('');
    try {
      const dataUrl = await compressImageToDataUrl(file);
      if (
        !shouldApplyAsyncResult({
          currentRouteKey: routeKeyRef.current,
          requestedRouteKey,
          currentGeneration: asyncGenRef.current,
          requestGeneration,
        })
      ) return;
      const result = await apiPost<{ text: string }>(`/api/conversations/${detail.id}/ocr`, {
        image: dataUrl,
      });
      if (
        !shouldApplyAsyncResult({
          currentRouteKey: routeKeyRef.current,
          requestedRouteKey,
          currentGeneration: asyncGenRef.current,
          requestGeneration,
        })
      ) return;
      setInput((prev) => (prev.trim() ? `${prev}\n${result.text}` : result.text));
      setToast('已识别题目，请核对无误后发送 ✓');
    } catch (err2) {
      if (
        !shouldApplyAsyncResult({
          currentRouteKey: routeKeyRef.current,
          requestedRouteKey,
          currentGeneration: asyncGenRef.current,
          requestGeneration,
        })
      ) return;
      setToast(err2 instanceof ApiError ? err2.message : err2 instanceof Error ? err2.message : '图片识别失败');
    } finally {
      if (
        shouldApplyAsyncResult({
          currentRouteKey: routeKeyRef.current,
          requestedRouteKey,
          currentGeneration: asyncGenRef.current,
          requestGeneration,
        })
      ) setOcrLoading(false);
    }
  };

  const subject = detail?.subject;
  const isSelfLearn = subject === 'selflearn' || (!detail && searchParams.get('subject') === 'selflearn');
  const backLink = isSelfLearn ? `/students/${studentId}/selflearn` : `/students/${studentId}/tutoring`;
  const introKey = subject === 'selflearn' ? detail?.mode : subject;
  const introText = introKey === 'selflearn-daily'
    ? selfLearnDailyIntro(
        coursewareSettingsState,
        coursewareSettingsState === 'ready' ? (coursewareSettings?.featureEnabled ?? false) : null,
      )
    : introKey ? (SUBJECT_INTROS[introKey] ?? '') : '';

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
              disabled={!detail || deepThinkingPendingId === detail.id}
              aria-busy={detail !== null && deepThinkingPendingId === detail.id}
            />
            <span>{deepThinkingPendingId === detail?.id ? '保存中…' : '深度思考'}</span>
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
              <p>{introText}</p>
              <p className="text-secondary chat-intro-note">
                {user?.visionEnabled
                  ? '可以点输入框旁的相机按钮拍题，系统会自动转写成文字——发送前请核对转写内容是否与原题一致。'
                  : '暂不支持图片，请把题目打字或粘贴成文字发送（包括图中的数据和条件）。'}
              </p>
            </div>
          )}
          {messages.map((m) => {
            const canSaveMistake = m.role === 'assistant' && !isSelfLearn;
            return (
              <MessageBubble
                key={m.id}
                role={m.role}
                content={m.content}
                reasoning={m.reasoning_content}
                messageId={canSaveMistake ? m.id : undefined}
                onSaveMistake={canSaveMistake ? saveMistake : undefined}
                saveState={saveStates[m.id] ?? 'idle'}
                coursewareDraft={m.coursewareDraft}
                studentId={detail?.studentId}
                sourceConversationId={detail?.id}
                coursewareSettings={coursewareSettings}
                coursewareSettingsState={coursewareSettingsState}
              />
            );
          })}
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
                <button
                  key={phrase}
                  className="chip"
                  disabled={reconcilingStream}
                  onClick={() => void send(phrase)}
                >
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
                disabled={isNew || !detail || streaming.active || reconcilingStream || ocrLoading}
                onClick={() => fileInputRef.current?.click()}
              >
                {ocrLoading ? <span className="btn-spinner" /> : <IconCamera size={20} />}
              </button>
            </>
          )}
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              if (e.target.value.trim() !== restoredRequestRef.current?.content) {
                restoredRequestRef.current = null;
              }
            }}
            onKeyDown={onKeyDown}
            placeholder={
              isMobile ? '输入题目或问题…' : '输入题目或问题…（Enter 发送，Shift+Enter 换行）'
            }
            rows={1}
            disabled={isNew || !detail || streaming.active || reconcilingStream}
          />
          <button
            className="btn btn-primary chat-send"
            onClick={() => void send()}
            disabled={isNew || !detail || streaming.active || reconcilingStream || !input.trim()}
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

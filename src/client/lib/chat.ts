import type { Message } from '../types';

const COURSEWARE_TASK_MARKER = '【语音课件任务】';

export type CoursewareSettingsState = 'loading' | 'ready' | 'error';

export function isCoursewareDailyConversation(subject?: string, mode?: string): boolean {
  return subject === 'selflearn' && mode === 'selflearn-daily';
}

export function selfLearnDailyIntro(
  state: CoursewareSettingsState,
  featureEnabled: boolean | null,
): string {
  if (state === 'loading') return '正在确认语音课件状态，请稍候…';
  if (state === 'error') return '无法确认语音课件状态，请稍后重试；当前不会误切换到其他课件流程。';
  if (featureEnabled) {
    return '输入“开始今天的学习”，我会按任务确认、旧知识保温和知识拆解推进，并在会话内给出站内语音课件卡片；学完后回到这里完成正式测验、错题卡和每课输出。';
  }
  return '输入"开始今天的学习"，我会按固定流程进行：任务确认 → 旧知识保温 → 知识拆解 → 生成课件提示词（复制到 open.maic.chat 上课）→ 孩子学完回来说"学完了" → 测验与错题卡 → 每课输出。当天结束时说"今天结束"生成每日家长反馈。';
}

export function hideCoursewareMachineBlock(text: string): string {
  const marker = text.indexOf(COURSEWARE_TASK_MARKER);
  return marker < 0 ? text : text.slice(0, marker).trimEnd();
}

export interface AssessmentRouteState {
  starterText: string;
  requestId: string;
}

export function consumeAssessmentRouteState(
  value: unknown,
  conversationId: number,
  consumed: Set<string>,
): AssessmentRouteState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.starterText !== 'string' || !candidate.starterText.trim()
      || candidate.starterText.length > 1_000
      || typeof candidate.requestId !== 'string'
      || !/^courseware-assessment-[1-9]\d*$/.test(candidate.requestId)) return null;
  const key = `${conversationId}:${candidate.requestId}`;
  if (consumed.has(key)) return null;
  consumed.add(key);
  return { starterText: candidate.starterText.trim(), requestId: candidate.requestId };
}

export interface ScrollMetrics {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

export function isNearBottom({ scrollHeight, scrollTop, clientHeight }: ScrollMetrics, threshold = 120): boolean {
  return scrollHeight - scrollTop - clientHeight < threshold;
}

export function nextStickToBottom(current: boolean, reason: 'send' | 'route'): boolean {
  return reason === 'route' ? true : current;
}

export function shouldSubmitChatOnKeyDown({
  key,
  shiftKey,
  isComposing,
  isMobile,
}: {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
  isMobile: boolean;
}): boolean {
  return key === 'Enter' && !shiftKey && !isComposing && !isMobile;
}

export function isPersistedMessage<T extends { persisted?: boolean }>(message: T): boolean {
  return message.persisted === true;
}

export function shouldApplyConversationDetail({
  routeConversationId,
  requestedConversationId,
  currentGeneration,
  requestGeneration,
  routeStudentId,
  responseStudentId,
}: {
  routeConversationId: string | undefined;
  requestedConversationId: string | undefined;
  currentGeneration: number;
  requestGeneration: number;
  routeStudentId?: string;
  responseStudentId?: number;
}): boolean {
  return (
    routeConversationId !== 'new' &&
    routeConversationId === requestedConversationId &&
    currentGeneration === requestGeneration &&
    (routeStudentId === undefined || responseStudentId === undefined || Number(routeStudentId) === responseStudentId)
  );
}

export function getOrCreatePendingRequest<T>(
  cache: Map<string, Promise<T>>,
  key: string,
  create: () => Promise<T>,
): Promise<T> {
  const pending = cache.get(key);
  if (pending) return pending;
  const request = create();
  cache.set(key, request);
  const clear = () => {
    if (cache.get(key) === request) cache.delete(key);
  };
  void request.then(clear, clear);
  return request;
}

export function shouldDiscardCancelledCreation(
  cancelled: boolean,
  requestedKey: string,
  currentKey: string,
  mounted = true,
): boolean {
  return cancelled && (!mounted || requestedKey !== currentKey);
}

export function streamErrorRecovery(metadata?: {
  userMessageId: number | null;
  assistantMessageId: number | null;
}): 'rollback' | 'reconcile' {
  return metadata && metadata.userMessageId === null && metadata.assistantMessageId === null
    ? 'rollback'
    : 'reconcile';
}

export function hasLatestUserMessage(messages: Message[], content: string, previousId: number | null): boolean {
  return messages.some(
    (message) =>
      message.role === 'user' &&
      message.content === content &&
      (previousId === null || message.id > previousId),
  );
}

export interface RestoredChatRequest {
  content: string;
  requestId: string;
}

export function resolveChatRequestId(
  restored: RestoredChatRequest | null,
  content: string,
  create: () => string,
): string {
  return restored?.content === content ? restored.requestId : create();
}

export function isStreamReconciliationExpired(
  startedAt: number,
  now: number,
  timeoutMs = 30_000,
): boolean {
  return now - startedAt >= timeoutMs;
}

export function streamReconciliationDecision(
  messages: Message[],
  content: string,
  previousId: number | null,
  generating: boolean,
): 'wait' | 'settled' | 'restore' {
  if (generating) return 'wait';
  return hasLatestUserMessage(messages, content, previousId) ? 'settled' : 'restore';
}

export function shouldApplyAsyncResult({
  currentRouteKey,
  requestedRouteKey,
  currentGeneration,
  requestGeneration,
}: {
  currentRouteKey: string;
  requestedRouteKey: string;
  currentGeneration: number;
  requestGeneration: number;
}): boolean {
  return currentRouteKey === requestedRouteKey && currentGeneration === requestGeneration;
}

export function tryStartPending<T>(pending: Set<T>, key: T): boolean {
  if (pending.has(key)) return false;
  pending.add(key);
  return true;
}

export function finishPending<T>(pending: Set<T>, key: T): void {
  pending.delete(key);
}

export function markPersistedMessages(messages: Message[]): Message[] {
  return messages.map((message) => ({ ...message, persisted: true }));
}

export function shouldCommitAssistantMessage(content: string, reasoning: string): boolean {
  return Boolean(content || reasoning);
}

export interface MobileMediaQuery {
  matches: boolean;
  addEventListener(type: 'change', listener: (event: { matches: boolean }) => void): void;
  removeEventListener(type: 'change', listener: (event: { matches: boolean }) => void): void;
}

export function subscribeToMobileMediaQuery(
  mediaQuery: MobileMediaQuery,
  onChange: (matches: boolean) => void,
): () => void {
  onChange(mediaQuery.matches);
  const listener = (event: { matches: boolean }) => onChange(event.matches);
  mediaQuery.addEventListener('change', listener);
  return () => mediaQuery.removeEventListener('change', listener);
}

import type { Message } from '../types';

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

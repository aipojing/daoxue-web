import type { Message } from '../types';

export interface ScrollMetrics {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

export function isNearBottom({ scrollHeight, scrollTop, clientHeight }: ScrollMetrics, threshold = 120): boolean {
  return scrollHeight - scrollTop - clientHeight < threshold;
}

export function isPersistedMessage<T extends { persisted?: boolean }>(message: T): boolean {
  return message.persisted === true;
}

export function shouldApplyConversationDetail({
  routeConversationId,
  requestedConversationId,
  currentGeneration,
  requestGeneration,
}: {
  routeConversationId: string | undefined;
  requestedConversationId: string | undefined;
  currentGeneration: number;
  requestGeneration: number;
}): boolean {
  return (
    routeConversationId !== 'new' &&
    routeConversationId === requestedConversationId &&
    currentGeneration === requestGeneration
  );
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

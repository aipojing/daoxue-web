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

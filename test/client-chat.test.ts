import { describe, expect, it, vi } from 'vitest';
import {
  consumeAssessmentRouteState,
  hideCoursewareMachineBlock,
  isNearBottom,
  isPersistedMessage,
  markPersistedMessages,
  shouldApplyConversationDetail,
  shouldCommitAssistantMessage,
  subscribeToMobileMediaQuery,
} from '../src/client/lib/chat';
import { buildCoursewareDraftCreateRequest } from '../src/client/components/CoursewareDraftCard';
import type { Message } from '../src/client/types';
import * as chatHelpers from '../src/client/lib/chat';

describe('client chat helpers', () => {
  it('hides a complete or partial courseware machine block from the live stream', () => {
    expect(hideCoursewareMachineBlock('课程准备好了\n【语音课件任务】\n```json\n{"apiKey":"secret"}'))
      .toBe('课程准备好了');
    expect(hideCoursewareMachineBlock('普通自学回答')).toBe('普通自学回答');
  });

  it('consumes valid assessment route state exactly once for the target conversation', () => {
    const consumed = new Set<string>();
    const state = {
      starterText: '已学习一次函数，请开始一题一答正式测验。',
      requestId: 'courseware-assessment-42',
    };
    expect(consumeAssessmentRouteState(state, 9, consumed)).toEqual(state);
    expect(consumeAssessmentRouteState(state, 9, consumed)).toBeNull();
    expect(consumeAssessmentRouteState({ ...state, requestId: 'bad external id' }, 9, new Set())).toBeNull();
  });

  it('builds only an internal sanitized courseware creation request from a draft card', () => {
    const request = buildCoursewareDraftCreateRequest(7, 11, {
      subject: '数学', topic: '一次函数', learningGoal: '能判断一次函数', sourceText: '前置诊断摘要',
    }, true);
    expect(request).toEqual({
      path: '/api/students/7/coursewares',
      body: {
        subject: '数学', topic: '一次函数', learningGoal: '能判断一次函数', sourceText: '前置诊断摘要',
        sourceConversationId: 11, includeImages: true,
      },
    });
    expect(JSON.stringify(request)).not.toMatch(/https?:\/\/|apiKey|baseUrl/i);
  });

  it('仅在距离底部小于默认阈值时视为贴底', () => {
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 670, clientHeight: 200 })).toBe(false);
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 680, clientHeight: 200 })).toBe(false);
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 710, clientHeight: 200 })).toBe(true);
  });

  it('发送消息时保留用户当前的滚动意图，仅切换路由时恢复贴底', () => {
    const nextStickToBottom = (chatHelpers as typeof chatHelpers & {
      nextStickToBottom?: (current: boolean, reason: 'send' | 'route') => boolean;
    }).nextStickToBottom;

    expect(nextStickToBottom?.(false, 'send')).toBe(false);
    expect(nextStickToBottom?.(true, 'send')).toBe(true);
    expect(nextStickToBottom?.(false, 'route')).toBe(true);
  });

  it('桌面端仅在非输入法组合状态的 Enter 发送', () => {
    const shouldSubmitChatOnKeyDown = (chatHelpers as typeof chatHelpers & {
      shouldSubmitChatOnKeyDown?: (args: {
        key: string;
        shiftKey: boolean;
        isComposing: boolean;
        isMobile: boolean;
      }) => boolean;
    }).shouldSubmitChatOnKeyDown;

    expect(
      shouldSubmitChatOnKeyDown?.({ key: 'Enter', shiftKey: false, isComposing: false, isMobile: false }),
    ).toBe(true);
    expect(
      shouldSubmitChatOnKeyDown?.({ key: 'Enter', shiftKey: false, isComposing: true, isMobile: false }),
    ).toBe(false);
    expect(
      shouldSubmitChatOnKeyDown?.({ key: 'Enter', shiftKey: true, isComposing: false, isMobile: false }),
    ).toBe(false);
    expect(
      shouldSubmitChatOnKeyDown?.({ key: 'Enter', shiftKey: false, isComposing: false, isMobile: true }),
    ).toBe(false);
  });

  it('仅将显式持久化的消息识别为服务端消息', () => {
    expect(isPersistedMessage({ id: 3, persisted: true })).toBe(true);
    expect(isPersistedMessage({ id: 3, persisted: false })).toBe(false);
  });

  it('拒绝从会话 1 切到 new 后返回的旧详情', () => {
    expect(
      shouldApplyConversationDetail({
        routeConversationId: 'new',
        requestedConversationId: '1',
        currentGeneration: 2,
        requestGeneration: 1,
      }),
    ).toBe(false);
  });

  it('拒绝同一路由的旧世代详情请求', () => {
    expect(
      shouldApplyConversationDetail({
        routeConversationId: '1',
        requestedConversationId: '1',
        currentGeneration: 2,
        requestGeneration: 1,
      }),
    ).toBe(false);
  });

  it('路由 ID 与请求世代都匹配时应用会话详情', () => {
    expect(
      shouldApplyConversationDetail({
        routeConversationId: '1',
        requestedConversationId: '1',
        currentGeneration: 2,
        requestGeneration: 2,
      }),
    ).toBe(true);
  });

  it('会话所属学生与路由学生不同时拒绝应用详情', () => {
    expect(
      shouldApplyConversationDetail({
        routeConversationId: '8',
        requestedConversationId: '8',
        currentGeneration: 2,
        requestGeneration: 2,
        routeStudentId: '2',
        responseStudentId: 1,
      } as Parameters<typeof shouldApplyConversationDetail>[0]),
    ).toBe(false);
  });

  it('StrictMode effect replay 复用同一个 pending 会话创建请求', async () => {
    const getOrCreate = (chatHelpers as typeof chatHelpers & {
      getOrCreatePendingRequest?: <T>(cache: Map<string, Promise<T>>, key: string, create: () => Promise<T>) => Promise<T>;
    }).getOrCreatePendingRequest;
    const cache = new Map<string, Promise<number>>();
    let calls = 0;
    const create = async () => {
      calls += 1;
      return 7;
    };

    const first = getOrCreate?.(cache, 'student:1:math', create);
    const replay = getOrCreate?.(cache, 'student:1:math', create);

    expect(replay).toBe(first);
    await expect(replay).resolves.toBe(7);
    expect(calls).toBe(1);
  });

  it('已取消的新会话请求只在创建目标已改变时删除结果', () => {
    const shouldDiscardCancelledCreation = (chatHelpers as typeof chatHelpers & {
      shouldDiscardCancelledCreation?: (
        cancelled: boolean,
        requestedKey: string,
        currentKey: string,
        mounted?: boolean,
      ) => boolean;
    }).shouldDiscardCancelledCreation;

    expect(shouldDiscardCancelledCreation?.(true, 'student:1:math', 'student:1:physics')).toBe(true);
    expect(shouldDiscardCancelledCreation?.(true, 'student:1:math', 'student:1:math')).toBe(false);
    expect(shouldDiscardCancelledCreation?.(true, 'student:1:math', 'student:1:math', false)).toBe(true);
    expect(shouldDiscardCancelledCreation?.(false, 'student:1:math', 'student:1:physics')).toBe(false);
  });

  it('SSE 落库状态未知时先对账，只有明确未落库才回滚草稿', () => {
    const streamErrorRecovery = (chatHelpers as typeof chatHelpers & {
      streamErrorRecovery?: (metadata?: { userMessageId: number | null; assistantMessageId: number | null }) =>
        | 'rollback'
        | 'reconcile';
    }).streamErrorRecovery;

    expect(streamErrorRecovery?.()).toBe('reconcile');
    expect(streamErrorRecovery?.({ userMessageId: 3, assistantMessageId: null })).toBe('reconcile');
    expect(streamErrorRecovery?.({ userMessageId: null, assistantMessageId: null })).toBe('rollback');
  });

  it('对账时要求同文本 user 消息的 ID 比发送前更新', () => {
    const hasLatestUserMessage = (chatHelpers as typeof chatHelpers & {
      hasLatestUserMessage?: (messages: Message[], content: string, previousId: number | null) => boolean;
    }).hasLatestUserMessage;
    const history: Message[] = [
      { id: 1, role: 'user', content: '旧问题', reasoning_content: null, created_at: '' },
      { id: 2, role: 'assistant', content: '旧回答', reasoning_content: null, created_at: '' },
    ];

    expect(hasLatestUserMessage?.(history, '新问题', 1)).toBe(false);
    expect(hasLatestUserMessage?.(history, '旧问题', 1)).toBe(false);
    expect(
      hasLatestUserMessage?.(
        [...history, { id: 3, role: 'user', content: '新问题', reasoning_content: null, created_at: '' }],
        '新问题',
        1,
      ),
    ).toBe(true);
    expect(
      hasLatestUserMessage?.(
        [
          ...history,
          { id: 3, role: 'user', content: '新问题', reasoning_content: null, created_at: '' },
          { id: 4, role: 'user', content: '另一个标签页的问题', reasoning_content: null, created_at: '' },
        ],
        '新问题',
        1,
      ),
    ).toBe(true);
  });

  it('重发未确认草稿时复用 request ID，内容改变则生成新 ID', () => {
    const resolveRequestId = (chatHelpers as typeof chatHelpers & {
      resolveChatRequestId?: (
        restored: { content: string; requestId: string } | null,
        content: string,
        create: () => string,
      ) => string;
    }).resolveChatRequestId;
    const create = vi.fn(() => 'new-id');

    expect(resolveRequestId?.({ content: '同一道题', requestId: 'old-id' }, '同一道题', create)).toBe('old-id');
    expect(create).not.toHaveBeenCalled();
    expect(resolveRequestId?.({ content: '同一道题', requestId: 'old-id' }, '已修改的题', create)).toBe('new-id');
  });

  it('对账连续失败达到截止时间后停止自动轮询', () => {
    const isExpired = (chatHelpers as typeof chatHelpers & {
      isStreamReconciliationExpired?: (startedAt: number, now: number, timeoutMs?: number) => boolean;
    }).isStreamReconciliationExpired;

    expect(isExpired?.(1_000, 30_999)).toBe(false);
    expect(isExpired?.(1_000, 31_000)).toBe(true);
  });

  it('未知流状态要等服务端生成结束后才能恢复草稿', () => {
    const decide = (chatHelpers as typeof chatHelpers & {
      streamReconciliationDecision?: (
        messages: Message[],
        content: string,
        previousId: number | null,
        generating: boolean,
      ) => 'wait' | 'settled' | 'restore';
    }).streamReconciliationDecision;
    const oldHistory: Message[] = [
      { id: 1, role: 'user', content: '旧问题', reasoning_content: null, created_at: '' },
    ];
    const newHistory: Message[] = [
      ...oldHistory,
      { id: 2, role: 'user', content: '新问题', reasoning_content: null, created_at: '' },
    ];

    expect(decide?.(oldHistory, '新问题', 1, true)).toBe('wait');
    expect(decide?.(newHistory, '新问题', 1, false)).toBe('settled');
    expect(decide?.(oldHistory, '新问题', 1, false)).toBe('restore');
  });

  it('仅在路由和世代仍匹配时应用 OCR 等异步结果', () => {
    const shouldApplyAsyncResult = (chatHelpers as typeof chatHelpers & {
      shouldApplyAsyncResult?: (args: {
        currentRouteKey: string;
        requestedRouteKey: string;
        currentGeneration: number;
        requestGeneration: number;
      }) => boolean;
    }).shouldApplyAsyncResult;

    expect(
      shouldApplyAsyncResult?.({
        currentRouteKey: 'student:1:conversation:2',
        requestedRouteKey: 'student:1:conversation:1',
        currentGeneration: 4,
        requestGeneration: 3,
      }),
    ).toBe(false);
    expect(
      shouldApplyAsyncResult?.({
        currentRouteKey: 'student:1:conversation:2',
        requestedRouteKey: 'student:1:conversation:2',
        currentGeneration: 4,
        requestGeneration: 4,
      }),
    ).toBe(true);
  });

  it('同一记录的异步操作未完成时拒绝重复开始', () => {
    const tryStartPending = (chatHelpers as typeof chatHelpers & {
      tryStartPending?: <T>(pending: Set<T>, key: T) => boolean;
      finishPending?: <T>(pending: Set<T>, key: T) => void;
    }).tryStartPending;
    const finishPending = (chatHelpers as typeof chatHelpers & {
      finishPending?: <T>(pending: Set<T>, key: T) => void;
    }).finishPending;
    const pending = new Set<number>();

    expect(tryStartPending?.(pending, 3)).toBe(true);
    expect(tryStartPending?.(pending, 3)).toBe(false);
    finishPending?.(pending, 3);
    expect(tryStartPending?.(pending, 3)).toBe(true);
  });

  it('深度思考、邀请码和用户限额分别按操作键互斥', () => {
    const tryStartPending = (chatHelpers as typeof chatHelpers & {
      tryStartPending?: <T>(pending: Set<T>, key: T) => boolean;
    }).tryStartPending;
    const pending = new Set<string>();

    expect(tryStartPending?.(pending, 'deep-thinking')).toBe(true);
    expect(tryStartPending?.(pending, 'deep-thinking')).toBe(false);
    expect(tryStartPending?.(pending, 'toggle-invite:4')).toBe(true);
    expect(tryStartPending?.(pending, 'toggle-invite:4')).toBe(false);
    expect(tryStartPending?.(pending, 'save-limit:9')).toBe(true);
    expect(tryStartPending?.(pending, 'save-limit:9')).toBe(false);
  });

  it('为服务端历史消息标记 persisted', () => {
    const history: Message[] = [
      { id: 1, role: 'assistant', content: '答案', reasoning_content: null, created_at: '2026-01-01' },
    ];

    expect(markPersistedMessages(history)).toEqual([{ ...history[0], persisted: true }]);
  });

  it('reasoning-only 流完成后应提交气泡', () => {
    expect(shouldCommitAssistantMessage('', '推理过程')).toBe(true);
    expect(shouldCommitAssistantMessage('', '')).toBe(false);
  });

  it('订阅媒体查询时初始化状态，并在清理时移除同一个监听器', () => {
    const listeners = new Set<(event: { matches: boolean }) => void>();
    let addedListener: ((event: { matches: boolean }) => void) | undefined;
    let removedListener: ((event: { matches: boolean }) => void) | undefined;
    const mediaQuery = {
      matches: false,
      addEventListener: (_type: 'change', listener: (event: { matches: boolean }) => void) => {
        addedListener = listener;
        listeners.add(listener);
      },
      removeEventListener: (_type: 'change', listener: (event: { matches: boolean }) => void) => {
        removedListener = listener;
        listeners.delete(listener);
      },
    };
    const values: boolean[] = [];

    const cleanup = subscribeToMobileMediaQuery(mediaQuery, (matches) => values.push(matches));
    for (const listener of listeners) listener({ matches: true });
    cleanup();
    for (const listener of listeners) listener({ matches: false });

    expect(values).toEqual([false, true]);
    expect(removedListener).toBe(addedListener);
    expect(listeners.size).toBe(0);
  });
});

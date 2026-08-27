import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet, ApiError } from '../api';
import { EMPTY_PROFILE_FORM, type Conversation, type ProfileFormData, type SelfLearnOverview } from '../types';

export function getSelfLearnOverviewPath(studentId: string | number): string {
  return `/api/students/${studentId}/selflearn`;
}

export function getLatestDailyConversation<T extends Pick<Conversation, 'mode' | 'updated_at'>>(
  conversations: T[],
): T | null {
  return conversations
    .filter((conversation) => conversation.mode === 'selflearn-daily')
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at))[0] ?? null;
}

export function parseSelfLearnProfileForm(raw: string): ProfileFormData {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return EMPTY_PROFILE_FORM;
    const source = parsed as Record<string, unknown>;
    const text = (value: unknown) => typeof value === 'string' ? value : '';
    const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
    return {
      directions: strings(source.directions), goal: text(source.goal), currentPosition: text(source.currentPosition),
      weakSpots: text(source.weakSpots), mainProblem: text(source.mainProblem), parentPriority: text(source.parentPriority),
      weekdayTime: text(source.weekdayTime), weekendTime: text(source.weekendTime), startHabit: text(source.startHabit),
      focusDuration: text(source.focusDuration), difficultyReaction: text(source.difficultyReaction), retellAbility: text(source.retellAbility),
      preferredStyles: strings(source.preferredStyles), mistakeHabit: text(source.mistakeHabit), interestState: text(source.interestState),
      interests: text(source.interests), parentInvolvement: text(source.parentInvolvement), forbidden: strings(source.forbidden), specialNotes: text(source.specialNotes),
    };
  } catch {
    return EMPTY_PROFILE_FORM;
  }
}

export function useSelfLearnOverview(studentId: string | undefined) {
  const [overview, setOverview] = useState<SelfLearnOverview | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const generationRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const generation = ++generationRef.current;
    setLoading(true);
    try {
      const data = await apiGet<SelfLearnOverview>(getSelfLearnOverviewPath(studentId ?? ''), {
        signal: controller.signal,
      });
      if (generation !== generationRef.current || controller.signal.aborted) return;
      setOverview(data);
      setError('');
    } catch (cause) {
      if (generation !== generationRef.current || controller.signal.aborted) return;
      setError(cause instanceof ApiError ? cause.message : '加载失败');
    } finally {
      if (generation === generationRef.current && !controller.signal.aborted) setLoading(false);
    }
  }, [studentId]);

  useEffect(() => {
    setOverview(null);
    setError('');
    void load();
    return () => {
      generationRef.current += 1;
      abortRef.current?.abort();
    };
  }, [load]);

  return { overview, error, loading, load };
}

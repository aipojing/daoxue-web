import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CoursewareProgressPatch, CoursewareProgressSnapshot } from '../src/shared/courseware';
import {
  initialPlayerState,
  isTerminalCoursewareLoadStatus,
  playerReducer,
  progressPatch,
  CoursewareProgressWriter,
  CoursewareProgressRevisionClock,
  type CoursewarePlayerInput,
  type CoursewarePlayerState,
} from '../src/client/lib/courseware-player';

function lessonFixture(): CoursewarePlayerInput {
  return {
    currentSegmentPosition: 0,
    currentTimeMs: 0,
    checkpointAnswers: {},
    segments: [
      { segmentKey: 's0', kind: 'teacher_intro', audioUrl: '/audio/0', alternateAudioUrl: null },
      { segmentKey: 's1', kind: 'teacher_explanation', audioUrl: '/audio/1', alternateAudioUrl: '/alternate-audio/1' },
      { segmentKey: 's2', kind: 'student_question', audioUrl: '/audio/2', alternateAudioUrl: null },
      { segmentKey: 's3', kind: 'student_misconception', audioUrl: '/audio/3', alternateAudioUrl: null },
      { segmentKey: 's4', kind: 'checkpoint', audioUrl: '/audio/4', alternateAudioUrl: null },
      { segmentKey: 's5', kind: 'teacher_reframe', audioUrl: '/audio/5', alternateAudioUrl: '/alternate-audio/5' },
      { segmentKey: 's6', kind: 'summary', audioUrl: '/audio/6', alternateAudioUrl: null },
    ],
  };
}

function playingTeacherFixture(): CoursewarePlayerState {
  const started = playerReducer(initialPlayerState(lessonFixture()), { type: 'START' });
  return playerReducer(started, { type: 'NEXT' });
}

function checkpointAnsweredFixture(): CoursewarePlayerState {
  return playerReducer(initialPlayerState(lessonFixture()), {
    type: 'ANSWER_CHECKPOINT',
    segmentKey: 's4',
    optionIndex: 1,
  });
}

describe('courseware player state', () => {
  it('requires a user gesture before the first audio playback', () => {
    expect(initialPlayerState(lessonFixture()).awaitingStart).toBe(true);
  });

  it('moves through segments and stops at the final segment', () => {
    let state = playerReducer(initialPlayerState(lessonFixture()), { type: 'START' });
    state = playerReducer(state, { type: 'AUDIO_ENDED' });
    expect(state.segmentPosition).toBe(1);
    state = playerReducer({ ...state, segmentPosition: 6 }, { type: 'AUDIO_ENDED' });
    expect(state.completed).toBe(true);
    expect(state.segmentPosition).toBe(6);
    expect(state.isPlaying).toBe(false);
  });

  it('plays only pre-generated alternate audio for I did not understand', () => {
    const state = playerReducer(playingTeacherFixture(), { type: 'PLAY_ALTERNATE' });
    expect(state.mode).toBe('alternate');
    expect(state.activeAudioUrl).toContain('/alternate-audio');
    expect(JSON.stringify(state)).not.toContain('/generate');
  });

  it('returns from alternate audio to the same main segment without advancing', () => {
    const atTwelveSeconds = playerReducer(playingTeacherFixture(), { type: 'TIME_UPDATE', seconds: 12 });
    const alternate = playerReducer(atTwelveSeconds, { type: 'PLAY_ALTERNATE' });
    const alternateAtFiveSeconds = playerReducer(alternate, { type: 'TIME_UPDATE', seconds: 5 });
    const returned = playerReducer(alternateAtFiveSeconds, { type: 'AUDIO_ENDED' });
    expect(returned.segmentPosition).toBe(alternate.segmentPosition);
    expect(returned.mode).toBe('main');
    expect(returned.activeAudioUrl).toBe('/audio/1');
    expect(returned.currentSeconds).toBe(12);
    expect(progressPatch(returned).currentTimeMs).toBe(12_000);
    expect(returned.isPlaying).toBe(false);
  });

  it('waits on a checkpoint after its main audio ends', () => {
    const checkpoint = { ...initialPlayerState(lessonFixture()), awaitingStart: false, isPlaying: true, segmentPosition: 4, activeAudioUrl: '/audio/4' };
    const stopped = playerReducer(checkpoint, { type: 'AUDIO_ENDED' });
    expect(stopped.segmentPosition).toBe(4);
    expect(stopped.waitingForCheckpoint).toBe(true);
    expect(stopped.isPlaying).toBe(false);
  });

  it('records checkpoints as local course progress without mastery fields', () => {
    const patch = progressPatch(checkpointAnsweredFixture());
    expect(patch.checkpointAnswers).toEqual({ s4: 1 });
    expect(patch).not.toHaveProperty('masteryLevel');
    expect(patch).not.toHaveProperty('knowledgeEvidence');
  });

  it('clamps restored position and time to safe non-negative values', () => {
    const state = initialPlayerState({ ...lessonFixture(), currentSegmentPosition: 99, currentTimeMs: -10 });
    expect(state.segmentPosition).toBe(6);
    expect(state.currentSeconds).toBe(0);
  });
});

describe('courseware progress writer', () => {
  it('assigns a higher revision to a final snapshot than an in-flight ordinary save', () => {
    const normalCalls: Array<CoursewareProgressPatch & { revision: number }> = [];
    const finalCalls: Array<CoursewareProgressPatch & { revision: number }> = [];
    const writer = new CoursewareProgressWriter(
      new CoursewareProgressRevisionClock(40),
      async (patch) => { normalCalls.push(patch as CoursewareProgressPatch & { revision: number }); },
      async (patch) => { finalCalls.push(patch as CoursewareProgressPatch & { revision: number }); },
    );

    writer.enqueue({ currentSegmentPosition: 0, currentTimeMs: 1_000, checkpointAnswers: {} });
    writer.flushFinal({ currentSegmentPosition: 2, currentTimeMs: 8_000, checkpointAnswers: {} });

    expect(normalCalls[0]?.revision).toBe(41);
    expect(finalCalls[0]?.revision).toBe(42);
  });

  it('shares one revision clock across effect lifecycle replacements', () => {
    const calls: CoursewareProgressPatch[] = [];
    const clock = new CoursewareProgressRevisionClock(7);
    const snapshot = { currentSegmentPosition: 1, currentTimeMs: 2_000, checkpointAnswers: {} };
    const firstWriter = new CoursewareProgressWriter(clock, async (patch) => { calls.push(patch); });
    firstWriter.dispose(snapshot);
    const replacementWriter = new CoursewareProgressWriter(clock, async (patch) => { calls.push(patch); });
    replacementWriter.enqueue(snapshot);

    expect(calls.map((patch) => patch.revision)).toEqual([8, 9]);
  });

  it('serializes requests and collapses queued writes to the newest complete snapshot', async () => {
    const calls: CoursewareProgressPatch[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstPending = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const writer = new CoursewareProgressWriter(
      new CoursewareProgressRevisionClock(0),
      async (patch) => {
        calls.push(patch);
        if (calls.length === 1) await firstPending;
      },
    );
    const patchAt = (position: number): CoursewareProgressSnapshot => ({
      currentSegmentPosition: position,
      currentTimeMs: position * 1_000,
      checkpointAnswers: position > 1 ? { s1: 0 } : {},
    });

    writer.enqueue(patchAt(0));
    writer.enqueue(patchAt(1));
    writer.enqueue(patchAt(2));
    expect(calls.map((patch) => patch.currentSegmentPosition)).toEqual([0]);
    releaseFirst?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.map((patch) => patch.currentSegmentPosition)).toEqual([0, 2]);
    expect(calls[1]?.checkpointAnswers).toEqual({ s1: 0 });
  });

  it('sends the newest full snapshot through the final keepalive channel even while a normal save is in flight', async () => {
    const normalCalls: CoursewareProgressPatch[] = [];
    const finalCalls: CoursewareProgressPatch[] = [];
    let releaseNormal: (() => void) | undefined;
    const pendingNormal = new Promise<void>((resolve) => { releaseNormal = resolve; });
    const writer = new CoursewareProgressWriter(
      new CoursewareProgressRevisionClock(0),
      async (patch) => { normalCalls.push(patch); await pendingNormal; },
      async (patch) => { finalCalls.push(patch); },
    );
    const first = { currentSegmentPosition: 0, currentTimeMs: 1_000, checkpointAnswers: {} };
    const latest = { currentSegmentPosition: 2, currentTimeMs: 8_000, checkpointAnswers: { s1: 0 } };

    writer.enqueue(first);
    writer.flushFinal(latest);
    writer.flushFinal(latest);
    expect(normalCalls).toEqual([{ ...first, revision: 1 }]);
    expect(finalCalls).toEqual([{ ...latest, revision: 2 }]);
    releaseNormal?.();
  });

  it('disposes through the final channel and ignores later ordinary enqueues', () => {
    const normalCalls: CoursewareProgressPatch[] = [];
    const finalCalls: CoursewareProgressPatch[] = [];
    const writer = new CoursewareProgressWriter(
      new CoursewareProgressRevisionClock(0),
      async (patch) => { normalCalls.push(patch); },
      async (patch) => { finalCalls.push(patch); },
    );
    const finalPatch = { currentSegmentPosition: 3, currentTimeMs: 4_000, checkpointAnswers: { s2: 'skipped' as const } };
    writer.dispose(finalPatch);
    writer.enqueue({ currentSegmentPosition: 0, currentTimeMs: 0, checkpointAnswers: {} });
    expect(finalCalls).toEqual([{ ...finalPatch, revision: 1 }]);
    expect(normalCalls).toEqual([]);
  });
});

describe('courseware player polling errors', () => {
  it('stops automatic retries for authentication, ownership, and missing-courseware responses', () => {
    expect(isTerminalCoursewareLoadStatus(401)).toBe(true);
    expect(isTerminalCoursewareLoadStatus(403)).toBe(true);
    expect(isTerminalCoursewareLoadStatus(404)).toBe(true);
    expect(isTerminalCoursewareLoadStatus(0)).toBe(false);
    expect(isTerminalCoursewareLoadStatus(500)).toBe(false);
    expect(isTerminalCoursewareLoadStatus(503)).toBe(false);
  });
});

describe('courseware player approved controls and safety', () => {
  it('renders every approved playback control without browser speech APIs', () => {
    const files = [
      '../src/client/components/CoursewarePlayer.tsx',
      '../src/client/components/CoursewareCheckpoint.tsx',
      '../src/client/pages/CoursewarePlayerPage.tsx',
    ].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8')).join('\n');
    for (const label of ['上一段', '播放', '暂停', '下一段', '倍速', '重播本句', '我没听懂', '继续学习', '开始正式测验']) {
      expect(files).toContain(label);
    }
    expect(files).not.toContain('speechSynthesis');
    expect(files).not.toContain('SpeechRecognition');
  });

  it('uses one authenticated audio element and a PATCH helper', () => {
    const player = readFileSync(new URL('../src/client/components/CoursewarePlayer.tsx', import.meta.url), 'utf8');
    const page = readFileSync(new URL('../src/client/pages/CoursewarePlayerPage.tsx', import.meta.url), 'utf8');
    const api = readFileSync(new URL('../src/client/api.ts', import.meta.url), 'utf8');
    const vite = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');
    expect(player.match(/<audio\b/g)).toHaveLength(1);
    expect(player).toContain('preload="metadata"');
    expect(player).toContain('apiPatch');
    expect(player).toContain("window.addEventListener('pagehide'");
    expect(player).toContain('keepalive: true');
    expect(page).toContain('CoursewarePollChain');
    expect(api).toContain("request<T>('PATCH'");
    expect(api).toContain('keepalive: options?.keepalive');
    expect(vite).toContain("'^/api/'");
  });

  it('does not generate or POST from the alternate explanation path', () => {
    const player = readFileSync(new URL('../src/client/components/CoursewarePlayer.tsx', import.meta.url), 'utf8');
    const handler = player.match(/const playAlternate[\s\S]*?\n\s*};/)?.[0] ?? '';
    expect(handler).toContain("dispatch({ type: 'PLAY_ALTERNATE' })");
    expect(handler).not.toContain('apiPost');
    expect(handler).not.toContain('/generate');
  });
});

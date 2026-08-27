import type {
  CoursewareDetail,
  CoursewareProgressPatch,
  CoursewareProgressSnapshot,
} from '../../shared/courseware';

export type PlayerMode = 'main' | 'alternate';
export type PlaybackRate = 0.75 | 1 | 1.25 | 1.5;

export interface CoursewarePlayerInput {
  currentSegmentPosition: number;
  currentTimeMs: number;
  checkpointAnswers: Record<string, number | 'skipped'>;
  segments: Array<Pick<
    CoursewareDetail['segments'][number],
    'segmentKey' | 'kind' | 'audioUrl' | 'alternateAudioUrl'
  >>;
}

export interface CoursewarePlayerState extends CoursewarePlayerInput {
  segmentPosition: number;
  awaitingStart: boolean;
  isPlaying: boolean;
  mode: PlayerMode;
  activeAudioUrl: string;
  currentSeconds: number;
  durationSeconds: number;
  playbackRate: PlaybackRate;
  waitingForCheckpoint: boolean;
  completed: boolean;
  audioError: string;
}

export type PlayerAction =
  | { type: 'START' }
  | { type: 'TOGGLE' }
  | { type: 'PREVIOUS' }
  | { type: 'NEXT' }
  | { type: 'SELECT_SEGMENT'; position: number }
  | { type: 'REPLAY' }
  | { type: 'SEEK'; seconds: number }
  | { type: 'TIME_UPDATE'; seconds: number }
  | { type: 'METADATA_LOADED'; durationSeconds: number }
  | { type: 'SET_RATE'; rate: PlaybackRate }
  | { type: 'PLAY_ALTERNATE' }
  | { type: 'RETURN_TO_MAIN' }
  | { type: 'AUDIO_ENDED' }
  | { type: 'ANSWER_CHECKPOINT'; segmentKey: string; optionIndex: number }
  | { type: 'SKIP_CHECKPOINT'; segmentKey: string }
  | { type: 'AUDIO_ERROR'; message: string }
  | { type: 'PLAY_REJECTED'; message: string };

function clampPosition(position: number, segmentCount: number): number {
  if (segmentCount === 0) return 0;
  return Math.min(Math.max(0, Number.isFinite(position) ? Math.trunc(position) : 0), segmentCount - 1);
}

function mainAudioUrl(state: Pick<CoursewarePlayerState, 'segments' | 'segmentPosition'>): string {
  return state.segments[state.segmentPosition]?.audioUrl ?? '';
}

function moveTo(state: CoursewarePlayerState, position: number, playing = state.isPlaying): CoursewarePlayerState {
  const segmentPosition = clampPosition(position, state.segments.length);
  return {
    ...state,
    currentSegmentPosition: segmentPosition,
    currentTimeMs: 0,
    segmentPosition,
    currentSeconds: 0,
    durationSeconds: 0,
    mode: 'main',
    activeAudioUrl: state.segments[segmentPosition]?.audioUrl ?? '',
    isPlaying: playing && state.segments.length > 0,
    waitingForCheckpoint: false,
    completed: false,
    audioError: '',
  };
}

export function initialPlayerState(courseware: CoursewarePlayerInput): CoursewarePlayerState {
  const segmentPosition = clampPosition(courseware.currentSegmentPosition, courseware.segments.length);
  const currentTimeMs = Math.max(0, Number.isFinite(courseware.currentTimeMs) ? Math.trunc(courseware.currentTimeMs) : 0);
  return {
    ...courseware,
    currentSegmentPosition: segmentPosition,
    currentTimeMs,
    segmentPosition,
    checkpointAnswers: { ...courseware.checkpointAnswers },
    awaitingStart: true,
    isPlaying: false,
    mode: 'main',
    activeAudioUrl: courseware.segments[segmentPosition]?.audioUrl ?? '',
    currentSeconds: currentTimeMs / 1000,
    durationSeconds: 0,
    playbackRate: 1,
    waitingForCheckpoint: false,
    completed: courseware.segments.length === 0,
    audioError: '',
  };
}

export function playerReducer(state: CoursewarePlayerState, action: PlayerAction): CoursewarePlayerState {
  switch (action.type) {
    case 'START':
      return { ...state, awaitingStart: false, isPlaying: Boolean(state.activeAudioUrl), audioError: '' };
    case 'TOGGLE':
      return { ...state, awaitingStart: false, isPlaying: !state.isPlaying && Boolean(state.activeAudioUrl), audioError: '' };
    case 'PREVIOUS':
      return moveTo(state, state.segmentPosition - 1);
    case 'NEXT':
      return state.segmentPosition >= state.segments.length - 1
        ? { ...state, completed: true, isPlaying: false, waitingForCheckpoint: false, currentTimeMs: Math.round(state.currentSeconds * 1000) }
        : moveTo(state, state.segmentPosition + 1);
    case 'SELECT_SEGMENT':
      return moveTo(state, action.position, false);
    case 'REPLAY':
      return {
        ...state,
        awaitingStart: false,
        currentSeconds: 0,
        currentTimeMs: state.mode === 'main' ? 0 : state.currentTimeMs,
        isPlaying: Boolean(state.activeAudioUrl),
        audioError: '',
      };
    case 'SEEK': {
      const maximum = state.durationSeconds > 0 ? state.durationSeconds : Number.MAX_SAFE_INTEGER;
      const currentSeconds = Math.min(Math.max(0, action.seconds), maximum);
      return {
        ...state,
        currentSeconds,
        currentTimeMs: state.mode === 'main' ? Math.round(currentSeconds * 1000) : state.currentTimeMs,
        audioError: '',
      };
    }
    case 'TIME_UPDATE': {
      const currentSeconds = Math.max(0, action.seconds);
      return {
        ...state,
        currentSeconds,
        currentTimeMs: state.mode === 'main' ? Math.round(currentSeconds * 1000) : state.currentTimeMs,
      };
    }
    case 'METADATA_LOADED':
      return { ...state, durationSeconds: Math.max(0, action.durationSeconds) };
    case 'SET_RATE':
      return { ...state, playbackRate: action.rate };
    case 'PLAY_ALTERNATE': {
      const alternateAudioUrl = state.segments[state.segmentPosition]?.alternateAudioUrl;
      if (!alternateAudioUrl) return state;
      return {
        ...state,
        awaitingStart: false,
        mode: 'alternate',
        activeAudioUrl: alternateAudioUrl,
        currentSeconds: 0,
        durationSeconds: 0,
        isPlaying: true,
        waitingForCheckpoint: false,
        audioError: '',
      };
    }
    case 'RETURN_TO_MAIN':
      return {
        ...state,
        mode: 'main',
        activeAudioUrl: mainAudioUrl(state),
        currentSeconds: state.currentTimeMs / 1000,
        durationSeconds: 0,
        isPlaying: false,
        audioError: '',
      };
    case 'AUDIO_ENDED': {
      if (state.mode === 'alternate') {
        return {
          ...state,
          mode: 'main',
          activeAudioUrl: mainAudioUrl(state),
          currentSeconds: state.currentTimeMs / 1000,
          durationSeconds: 0,
          isPlaying: false,
          audioError: '',
        };
      }
      const segment = state.segments[state.segmentPosition];
      if (segment?.kind === 'checkpoint') {
        return {
          ...state,
          isPlaying: false,
          waitingForCheckpoint: true,
          currentTimeMs: Math.round(state.currentSeconds * 1000),
        };
      }
      if (state.segmentPosition >= state.segments.length - 1) {
        return {
          ...state,
          completed: true,
          isPlaying: false,
          currentTimeMs: Math.round(state.currentSeconds * 1000),
        };
      }
      return moveTo(state, state.segmentPosition + 1, true);
    }
    case 'ANSWER_CHECKPOINT':
      return {
        ...state,
        checkpointAnswers: { ...state.checkpointAnswers, [action.segmentKey]: action.optionIndex },
        waitingForCheckpoint: false,
        isPlaying: false,
      };
    case 'SKIP_CHECKPOINT':
      return {
        ...state,
        checkpointAnswers: { ...state.checkpointAnswers, [action.segmentKey]: 'skipped' },
        waitingForCheckpoint: false,
        isPlaying: false,
      };
    case 'AUDIO_ERROR':
      return { ...state, isPlaying: false, audioError: action.message };
    case 'PLAY_REJECTED':
      return { ...state, awaitingStart: true, isPlaying: false, audioError: action.message };
  }
}

export function progressPatch(state: CoursewarePlayerState): CoursewareProgressSnapshot {
  return {
    currentSegmentPosition: state.segmentPosition,
    currentTimeMs: Math.max(0, state.currentTimeMs),
    checkpointAnswers: { ...state.checkpointAnswers },
  };
}

export function isTerminalCoursewareLoadStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 404;
}

function cloneProgressSnapshot(patch: CoursewareProgressSnapshot): CoursewareProgressSnapshot {
  return {
    currentSegmentPosition: patch.currentSegmentPosition,
    currentTimeMs: patch.currentTimeMs,
    checkpointAnswers: { ...patch.checkpointAnswers },
  };
}

/** Shared across effect lifecycles so React StrictMode cannot reuse a revision. */
export class CoursewareProgressRevisionClock {
  private revision: number;

  constructor(baseRevision: number) {
    this.revision = Number.isSafeInteger(baseRevision) && baseRevision >= 0 ? baseRevision : 0;
  }

  next(): number {
    this.revision += 1;
    return this.revision;
  }
}

/** Serializes saves and collapses queued updates to the newest full snapshot. */
export class CoursewareProgressWriter {
  private pending: CoursewareProgressSnapshot | null = null;
  private inFlight = false;
  private disposed = false;
  private lastFinalSnapshot = '';

  constructor(
    private readonly clock: CoursewareProgressRevisionClock,
    private readonly send: (patch: CoursewareProgressPatch) => Promise<unknown>,
    private readonly sendFinal: (patch: CoursewareProgressPatch) => Promise<unknown> = send,
  ) {}

  enqueue(patch: CoursewareProgressSnapshot): void {
    if (this.disposed) return;
    this.pending = cloneProgressSnapshot(patch);
    void this.drain();
  }

  flushFinal(patch: CoursewareProgressSnapshot): void {
    if (this.disposed) return;
    const snapshot = cloneProgressSnapshot(patch);
    const fingerprint = JSON.stringify(snapshot);
    if (fingerprint === this.lastFinalSnapshot) return;
    this.lastFinalSnapshot = fingerprint;
    this.pending = null;
    void this.sendFinal(this.withRevision(snapshot)).catch(() => undefined);
  }

  dispose(finalPatch: CoursewareProgressSnapshot): void {
    if (this.disposed) return;
    this.flushFinal(finalPatch);
    this.disposed = true;
    this.pending = null;
  }

  private async drain(): Promise<void> {
    if (this.inFlight || this.disposed) return;
    this.inFlight = true;
    let failed = false;
    try {
      while (this.pending && !this.disposed) {
        const next = this.withRevision(this.pending);
        this.pending = null;
        try {
          await this.send(next);
        } catch {
          if (!this.disposed && !this.pending) this.pending = next;
          failed = true;
          break;
        }
      }
    } finally {
      this.inFlight = false;
      if (this.pending && !failed && !this.disposed) void this.drain();
    }
  }

  private withRevision(snapshot: CoursewareProgressSnapshot): CoursewareProgressPatch {
    return { ...cloneProgressSnapshot(snapshot), revision: this.clock.next() };
  }
}

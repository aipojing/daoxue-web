import { useEffect, useReducer, useRef, useState, type KeyboardEvent } from 'react';
import type { CoursewareDetail, CoursewareProgressPatch } from '../../shared/courseware';
import { apiPatch, ApiError } from '../api';
import {
  CoursewareProgressWriter,
  initialPlayerState,
  playerReducer,
  progressPatch,
  type PlaybackRate,
  type PlayerAction,
} from '../lib/courseware-player';
import CoursewareTimeline from './CoursewareTimeline';

interface Props {
  courseware: CoursewareDetail;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const rounded = Math.floor(seconds);
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, '0')}`;
}

export default function CoursewarePlayer({ courseware }: Props) {
  const [state, dispatch] = useReducer(playerReducer, courseware, initialPlayerState);
  const [saveError, setSaveError] = useState('');
  const stateRef = useRef(state);
  const audioRef = useRef<HTMLAudioElement>(null);
  const writerRef = useRef<CoursewareProgressWriter | null>(null);
  const mountedRef = useRef(true);
  stateRef.current = state;

  const applyAction = (action: PlayerAction, saveProgress = false) => {
    const next = playerReducer(stateRef.current, action);
    stateRef.current = next;
    dispatch(action);
    if (saveProgress) writerRef.current?.enqueue(progressPatch(next));
  };

  useEffect(() => {
    mountedRef.current = true;
    const writer = new CoursewareProgressWriter(async (patch: CoursewareProgressPatch) => {
      try {
        await apiPatch<CoursewareProgressPatch>(`/api/coursewares/${courseware.id}/progress`, patch);
        if (mountedRef.current) setSaveError('');
      } catch (cause) {
        if (mountedRef.current) {
          setSaveError(cause instanceof ApiError ? cause.message : '学习进度暂时没有保存');
        }
        throw cause;
      }
    });
    writerRef.current = writer;
    return () => {
      mountedRef.current = false;
      audioRef.current?.pause();
      writer.dispose(progressPatch(stateRef.current));
      writerRef.current = null;
    };
  }, [courseware.id]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onTimeUpdate = () => applyAction({ type: 'TIME_UPDATE', seconds: audio.currentTime });
    const onMetadata = () => {
      applyAction({ type: 'METADATA_LOADED', durationSeconds: Number.isFinite(audio.duration) ? audio.duration : 0 });
      const snapshot = stateRef.current;
      if (snapshot.mode === 'main' && snapshot.currentSeconds > 0) {
        audio.currentTime = Math.min(snapshot.currentSeconds, Number.isFinite(audio.duration) ? audio.duration : snapshot.currentSeconds);
      }
    };
    const onEnded = () => applyAction({ type: 'AUDIO_ENDED' }, true);
    const onError = () => {
      if (stateRef.current.activeAudioUrl) applyAction({ type: 'AUDIO_ERROR', message: '这段语音加载失败，请检查网络后重试' });
    };
    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('loadedmetadata', onMetadata);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('error', onError);
    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('loadedmetadata', onMetadata);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('error', onError);
    };
  }, []);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.pause();
    audio.removeAttribute('src');
    if (state.activeAudioUrl) {
      audio.src = state.activeAudioUrl;
      audio.preload = 'metadata';
      audio.load();
    }
  }, [state.activeAudioUrl]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !state.activeAudioUrl) return;
    if (!state.isPlaying) {
      audio.pause();
      return;
    }
    void audio.play().catch(() => {
      applyAction({ type: 'PLAY_REJECTED', message: '浏览器需要你点一下开始，才能播放老师语音' });
    });
  }, [state.activeAudioUrl, state.isPlaying]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = state.playbackRate;
  }, [state.playbackRate]);

  useEffect(() => {
    if (!state.isPlaying) return;
    const timer = window.setInterval(() => {
      writerRef.current?.enqueue(progressPatch(stateRef.current));
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [state.isPlaying]);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') writerRef.current?.enqueue(progressPatch(stateRef.current));
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, []);

  const seekTo = (seconds: number) => {
    const audio = audioRef.current;
    if (audio) audio.currentTime = Math.max(0, Math.min(seconds, state.durationSeconds || seconds));
    applyAction({ type: 'SEEK', seconds });
  };
  const onSeekKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    seekTo(state.currentSeconds + (event.key === 'ArrowRight' ? 5 : -5));
  };
  const move = (action: Extract<PlayerAction, { type: 'PREVIOUS' | 'NEXT' | 'SELECT_SEGMENT' }>) => {
    applyAction(action, true);
  };
  const toggle = () => {
    applyAction({ type: 'TOGGLE' }, state.isPlaying);
  };
  const replay = () => {
    if (audioRef.current) audioRef.current.currentTime = 0;
    applyAction({ type: 'REPLAY' });
  };
  const playAlternate = () => {
    dispatch({ type: 'PLAY_ALTERNATE' });
    stateRef.current = playerReducer(stateRef.current, { type: 'PLAY_ALTERNATE' });
  };
  const currentSegment = courseware.segments[state.segmentPosition];
  const canPlayAlternate = Boolean(currentSegment?.alternateExplanation && currentSegment.alternateAudioUrl);
  const seekMaximum = state.durationSeconds > 0 ? state.durationSeconds : Math.max(state.currentSeconds, 1);

  return (
    <div className="courseware-player-layout">
      <CoursewareTimeline
        courseware={courseware}
        currentPosition={state.segmentPosition}
        completed={state.completed}
        mode={state.mode}
        audioError={state.audioError}
        checkpointAnswers={state.checkpointAnswers}
        onSelect={(position) => move({ type: 'SELECT_SEGMENT', position })}
        onCheckpointAnswer={(segmentKey, optionIndex) => applyAction({ type: 'ANSWER_CHECKPOINT', segmentKey, optionIndex }, true)}
        onCheckpointSkip={(segmentKey) => applyAction({ type: 'SKIP_CHECKPOINT', segmentKey }, true)}
        onContinue={() => move({ type: 'NEXT' })}
      />

      <section className="courseware-player-dock" aria-label="课件播放控制">
        <audio ref={audioRef} preload="metadata" />
        <div className="courseware-now-playing">
          <span className="courseware-now-icon" aria-hidden="true">{state.mode === 'alternate' ? '换' : '听'}</span>
          <div>
            <p>{state.mode === 'alternate' ? '备用讲解' : currentSegment?.title ?? '本课已完成'}</p>
            <span>{state.mode === 'alternate' ? '听完后回到本段，不会自动前进' : `第 ${state.segmentPosition + 1} 段，共 ${courseware.segments.length} 段`}</span>
          </div>
        </div>
        {state.awaitingStart && (
          <button type="button" className="btn btn-primary courseware-start-button" onClick={() => applyAction({ type: 'START' })}>
            开始上课
          </button>
        )}
        <div className="courseware-transport">
          <button type="button" className="courseware-icon-button" disabled={state.segmentPosition === 0} onClick={() => move({ type: 'PREVIOUS' })}>上一段</button>
          <button type="button" className="btn btn-primary courseware-play-button" onClick={toggle} aria-label={state.isPlaying ? '暂停语音' : '播放语音'}>
            {state.isPlaying ? '暂停' : '播放'}
          </button>
          <button type="button" className="courseware-icon-button" disabled={state.segmentPosition >= courseware.segments.length - 1} onClick={() => move({ type: 'NEXT' })}>下一段</button>
        </div>
        <div className="courseware-seek-row">
          <span>{formatTime(state.currentSeconds)}</span>
          <input
            type="range"
            min={0}
            max={seekMaximum}
            step={0.1}
            value={Math.min(state.currentSeconds, seekMaximum)}
            aria-label="语音播放位置，左右方向键每次移动五秒"
            onChange={(event) => seekTo(Number(event.target.value))}
            onKeyDown={onSeekKeyDown}
          />
          <span>{formatTime(state.durationSeconds)}</span>
        </div>
        <div className="courseware-player-tools">
          <label>
            <span>倍速</span>
            <select value={state.playbackRate} onChange={(event) => applyAction({ type: 'SET_RATE', rate: Number(event.target.value) as PlaybackRate })}>
              <option value={0.75}>0.75×</option>
              <option value={1}>1×</option>
              <option value={1.25}>1.25×</option>
              <option value={1.5}>1.5×</option>
            </select>
          </label>
          <button type="button" className="courseware-text-button" onClick={replay}>重播本句</button>
          {canPlayAlternate && state.mode === 'main' && (
            <button type="button" className="courseware-understand-button" onClick={playAlternate}>我没听懂</button>
          )}
          {state.mode === 'alternate' && (
            <button type="button" className="courseware-text-button" onClick={() => applyAction({ type: 'RETURN_TO_MAIN' })}>返回本段</button>
          )}
        </div>
        {state.audioError && (
          <p className="courseware-audio-error" role="alert">
            {state.audioError} <button type="button" onClick={replay}>重新播放</button>
          </p>
        )}
        {saveError && <p className="courseware-save-error" role="status">{saveError}，稍后操作时会自动重试。</p>}
      </section>
    </div>
  );
}

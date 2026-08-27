import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useOutletContext, useParams } from 'react-router-dom';
import type { CoursewareDetail } from '../../shared/courseware';
import { apiGet, ApiError } from '../api';
import type { StudentWorkspaceContext } from '../components/StudentWorkspaceLayout';
import CoursewareGenerationStatus from '../components/CoursewareGenerationStatus';
import CoursewarePlayer from '../components/CoursewarePlayer';
import { CoursewarePollChain, shouldPollCourseware } from '../lib/courseware';
import { isTerminalCoursewareLoadStatus } from '../lib/courseware-player';

export default function CoursewarePlayerPage() {
  const { studentId, coursewareId } = useParams();
  const { student } = useOutletContext<StudentWorkspaceContext>();
  const [courseware, setCourseware] = useState<CoursewareDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reloadVersion, setReloadVersion] = useState(0);
  const [routeToken, setRouteToken] = useState(0);
  const [routeSignal, setRouteSignal] = useState<AbortSignal>(() => new AbortController().signal);
  const routeEpochRef = useRef(0);

  const isRouteCurrent = useCallback((token: number) => token === routeEpochRef.current && !routeSignal.aborted, [routeSignal]);

  useEffect(() => {
    const parsedId = Number(coursewareId);
    const controller = new AbortController();
    const token = ++routeEpochRef.current;
    let hasLoaded = false;
    let active = false;
    let disposed = false;
    setRouteToken(token);
    setRouteSignal(controller.signal);
    setCourseware(null);
    setLoading(true);
    setError('');

    if (!Number.isSafeInteger(parsedId) || parsedId < 1) {
      setCourseware(null);
      setError('课件地址无效，请返回课件库后重试');
      setLoading(false);
      return () => controller.abort();
    }

    const isCurrent = () => !disposed && !controller.signal.aborted && token === routeEpochRef.current;
    const load = async (background = false) => {
      try {
        const detail = await apiGet<CoursewareDetail>(`/api/coursewares/${parsedId}`, { signal: controller.signal });
        if (!isCurrent()) return;
        if (detail.studentId !== Number(studentId)) {
          active = false;
          setCourseware(null);
          setError('该课件不属于当前孩子，请返回课件库重新选择');
          setLoading(false);
          return;
        }
        hasLoaded = true;
        active = shouldPollCourseware(detail);
        setCourseware(detail);
        setError('');
        setLoading(false);
      } catch (cause) {
        if (!isCurrent()) return;
        const terminal = cause instanceof ApiError && isTerminalCoursewareLoadStatus(cause.status);
        if (terminal) {
          active = false;
          setCourseware(null);
          setError(cause.message);
          setLoading(false);
          return;
        }
        if (!background || !hasLoaded) {
          active = false;
          setError(cause instanceof ApiError ? cause.message : '无法加载课件，请稍后重试');
          setLoading(false);
          return;
        }
        throw cause;
      }
    };
    const chain = new CoursewarePollChain(
      {
        setTimeout: (callback, delay) => window.setTimeout(callback, delay),
        clearTimeout: (id) => window.clearTimeout(id),
      },
      () => active,
      () => load(true),
    );
    chain.start();
    const onFocus = () => chain.resetForFocus();
    window.addEventListener('focus', onFocus);
    void load().finally(() => {
      if (isCurrent() && active) chain.start();
    });
    return () => {
      disposed = true;
      routeEpochRef.current += 1;
      controller.abort();
      chain.stop();
      window.removeEventListener('focus', onFocus);
    };
  }, [coursewareId, reloadVersion, studentId]);

  if (loading && !courseware) {
    return <div className="courseware-loading" aria-live="polite"><div className="spinner" />正在打开语音课件</div>;
  }

  if (!courseware) {
    return (
      <div className="courseware-error-state" role="alert">
        <h1>课件暂时打不开</h1>
        <p>{error || '课件不存在或你没有访问权限'}</p>
        <div className="courseware-page-actions">
          <button type="button" className="btn btn-primary" onClick={() => setReloadVersion((value) => value + 1)}>重新加载</button>
          <Link className="btn" to={`/students/${studentId}/coursewares`}>返回课件库</Link>
        </div>
      </div>
    );
  }

  const ready = courseware.status === 'ready';
  return (
    <div className="courseware-player-page">
      <nav className="courseware-breadcrumb" aria-label="课件位置">
        <Link to={`/students/${studentId}/coursewares`}>语音课件</Link>
        <span aria-hidden="true">/</span>
        <span aria-current="page">{courseware.title}</span>
      </nav>
      <header className="courseware-lesson-header">
        <div>
          <p className="courseware-eyebrow">{student.name}的 AI 对话课堂 · {courseware.subject}</p>
          <h1>{courseware.title}</h1>
          <p>{courseware.topic} · 预计 {courseware.estimatedMinutes} 分钟</p>
        </div>
        <span className={ready ? 'courseware-lesson-status is-ready' : 'courseware-lesson-status'}>
          {ready ? '可以上课' : '课件准备中'}
        </span>
      </header>

      {courseware.learningObjectives.length > 0 && (
        <section className="courseware-objectives" aria-labelledby="courseware-objectives-title">
          <p className="courseware-eyebrow">这节课会学到</p>
          <h2 id="courseware-objectives-title">学习目标</h2>
          <ul>{courseware.learningObjectives.map((objective) => <li key={objective}>{objective}</li>)}</ul>
        </section>
      )}

      {!ready ? (
        <section className="courseware-generation-panel" aria-label="课件生成状态">
          <CoursewareGenerationStatus
            courseware={courseware}
            routeToken={routeToken}
            routeSignal={routeSignal}
            isRouteCurrent={isRouteCurrent}
            onQueued={() => setReloadVersion((value) => value + 1)}
          />
          <Link className="btn" to={`/students/${studentId}/coursewares`}>先返回课件库</Link>
        </section>
      ) : (
        <>
          {courseware.generationStage === 'images' && (
            <CoursewareGenerationStatus
              courseware={courseware}
              routeToken={routeToken}
              routeSignal={routeSignal}
              isRouteCurrent={isRouteCurrent}
              onQueued={() => setReloadVersion((value) => value + 1)}
            />
          )}
          <CoursewarePlayer key={courseware.id} courseware={courseware} />
          <section className="courseware-assessment-callout">
            <div>
              <p className="courseware-eyebrow">学完以后</p>
              <h2>用一次正式测验巩固知识</h2>
              <p>正式测验会记录到学习档案。当前版本先完成课件学习，测验入口将在下一步接通。</p>
            </div>
            <button type="button" className="btn btn-primary" disabled title="正式测验功能即将开放">开始正式测验</button>
          </section>
        </>
      )}
    </div>
  );
}

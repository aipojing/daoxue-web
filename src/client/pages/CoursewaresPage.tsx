import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useOutletContext, useParams } from 'react-router-dom';
import CoursewareCreatePanel from '../components/CoursewareCreatePanel';
import CoursewareGenerationStatus from '../components/CoursewareGenerationStatus';
import { apiDelete, apiGet, ApiError } from '../api';
import { useDialogFocus } from '../lib/modal';
import {
  CoursewareRequestEpoch,
  mergeCoursewarePage,
  pollDelay,
  shouldPollCourseware,
  updateCoursewareList,
} from '../lib/courseware';
import type { CoursewareAISettings } from '../../shared/ai-catalog';
import type { CoursewareSummary } from '../../shared/courseware';
import type { StudentWorkspaceContext } from '../components/StudentWorkspaceLayout';

interface CoursewarePageResponse { items: CoursewareSummary[]; nextCursor: string | null; }

function statusLabel(courseware: CoursewareSummary): string {
  if (courseware.status === 'ready') return '可以上课';
  if (courseware.status === 'failed') return courseware.retryable ? '需要重新生成' : '生成未完成';
  if (courseware.status === 'deleting') return '正在删除';
  return '正在生成';
}

function CoursewareDeleteModal({ courseware, onClose, onConfirm }: { courseware: CoursewareSummary; onClose: () => void; onConfirm: () => Promise<void> }) {
  const [typedTitle, setTypedTitle] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const dialogRef = useDialogFocus<HTMLFormElement>(() => { if (!pending) onClose(); });
  const matches = typedTitle.trim() === courseware.title.trim();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!matches || pending) return;
    setPending(true);
    setError('');
    try { await onConfirm(); } catch (cause) { setError(cause instanceof ApiError ? cause.message : '删除失败，请重试'); setPending(false); }
  };
  return <div className="modal-backdrop" onClick={() => { if (!pending) onClose(); }}>
    <form ref={dialogRef} className="modal" role="dialog" aria-modal="true" aria-labelledby="courseware-delete-title" aria-describedby="courseware-delete-description" tabIndex={-1} onClick={(event) => event.stopPropagation()} onSubmit={(event) => void submit(event)}>
      <h2 id="courseware-delete-title" className="modal-title">删除课件</h2>
      <p id="courseware-delete-description">删除「{courseware.title}」会移除这节课件及其已保存的语音和配图媒体，且无法恢复。</p>
      <label className="form-label">输入课件名称以确认<input value={typedTitle} onChange={(event) => setTypedTitle(event.target.value)} autoComplete="off" disabled={pending} /></label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="modal-actions"><button type="button" className="btn" onClick={onClose} disabled={pending}>取消</button><button type="submit" className="btn btn-primary" disabled={!matches || pending}>{pending ? '删除中…' : '确认删除'}</button></div>
    </form>
  </div>;
}

export default function CoursewaresPage() {
  const { studentId: rawStudentId } = useParams();
  const { student } = useOutletContext<StudentWorkspaceContext>();
  const studentId = Number(rawStudentId);
  const [settings, setSettings] = useState<CoursewareAISettings | null>(null);
  const [items, setItems] = useState<CoursewareSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<CoursewareSummary | null>(null);
  const epochRef = useRef(new CoursewareRequestEpoch());
  const controllersRef = useRef(new Set<AbortController>());
  const itemsRef = useRef(items);
  const pollAttemptRef = useRef(0);
  const loadingMoreRef = useRef(false);
  itemsRef.current = items;

  const request = useCallback(async <T,>(path: string, token: number): Promise<T | null> => {
    const controller = new AbortController();
    controllersRef.current.add(controller);
    try {
      const value = await apiGet<T>(path, { signal: controller.signal });
      return epochRef.current.isCurrent(token) && !controller.signal.aborted ? value : null;
    } finally { controllersRef.current.delete(controller); }
  }, []);

  const loadInitial = useCallback(async () => {
    if (!Number.isSafeInteger(studentId) || studentId < 1) return;
    controllersRef.current.forEach((controller) => controller.abort());
    const token = epochRef.current.begin();
    setLoading(true); setError('');
    try {
      const [loadedSettings, page] = await Promise.all([
        request<CoursewareAISettings>('/api/courseware-ai-settings', token),
        request<CoursewarePageResponse>(`/api/students/${studentId}/coursewares?limit=20`, token),
      ]);
      if (!epochRef.current.isCurrent(token) || !loadedSettings || !page) return;
      setSettings(loadedSettings); setItems(page.items); setNextCursor(page.nextCursor);
    } catch (cause) {
      if (epochRef.current.isCurrent(token)) setError(cause instanceof ApiError ? cause.message : '无法加载课件库');
    } finally { if (epochRef.current.isCurrent(token)) setLoading(false); }
  }, [request, studentId]);

  const refreshItem = useCallback(async (coursewareId: number) => {
    const token = epochRef.current.begin();
    try {
      const next = await request<CoursewareSummary>(`/api/coursewares/${coursewareId}`, token);
      if (next) setItems((current) => updateCoursewareList(current, next));
    } catch { /* Retain the most recently confirmed row while a background refresh is unavailable. */ }
  }, [request]);

  const pollActive = useCallback(async () => {
    const active = itemsRef.current.filter((item) => shouldPollCourseware(item.status));
    if (active.length === 0) return;
    const token = epochRef.current.begin();
    try {
      const updates = await Promise.all(active.map((item) => request<CoursewareSummary>(`/api/coursewares/${item.id}`, token)));
      if (!epochRef.current.isCurrent(token)) return;
      setItems((current) => updates.reduce((merged, update) => update ? updateCoursewareList(merged, update) : merged, current));
    } catch { /* A later scheduled poll can recover a transient network failure. */ }
  }, [request]);

  useEffect(() => { void loadInitial(); return () => { epochRef.current.dispose(); controllersRef.current.forEach((controller) => controller.abort()); }; }, [loadInitial]);

  useEffect(() => {
    let timer: number | null = null;
    const schedule = () => {
      if (!itemsRef.current.some((item) => shouldPollCourseware(item.status))) return;
      timer = window.setTimeout(() => { pollAttemptRef.current += 1; void pollActive().finally(schedule); }, pollDelay(pollAttemptRef.current));
    };
    const reset = () => { pollAttemptRef.current = 0; if (timer !== null) window.clearTimeout(timer); void pollActive().finally(schedule); };
    schedule();
    window.addEventListener('focus', reset);
    return () => { if (timer !== null) window.clearTimeout(timer); window.removeEventListener('focus', reset); };
  }, [items, pollActive]);

  const loadMore = async () => {
    if (!nextCursor || loadingMoreRef.current) return;
    loadingMoreRef.current = true; setLoadingMore(true);
    const token = epochRef.current.begin();
    try {
      const page = await request<CoursewarePageResponse>(`/api/students/${studentId}/coursewares?limit=20&cursor=${encodeURIComponent(nextCursor)}`, token);
      if (page) { setItems((current) => mergeCoursewarePage(current, page.items)); setNextCursor(page.nextCursor); }
    } catch (cause) { if (epochRef.current.isCurrent(token)) setError(cause instanceof ApiError ? cause.message : '加载更多课件失败'); }
    finally { loadingMoreRef.current = false; if (epochRef.current.isCurrent(token)) setLoadingMore(false); }
  };

  const remove = async (courseware: CoursewareSummary) => {
    const token = epochRef.current.begin();
    await apiDelete(`/api/coursewares/${courseware.id}`);
    if (!epochRef.current.isCurrent(token)) return;
    setItems((current) => current.filter((item) => item.id !== courseware.id));
    setDeleteTarget(null);
  };

  if (loading) return <div className="page courseware-page"><div className="courseware-loading" aria-live="polite">正在加载课件库…</div></div>;
  if (error && !settings) return <div className="page courseware-page"><div className="courseware-error-state" role="alert"><p>{error}</p><button className="btn btn-primary" onClick={() => void loadInitial()}>重新加载</button></div></div>;
  if (!settings) return null;
  return <div className="page courseware-page">
    <header className="courseware-hero"><p className="courseware-eyebrow">{student.name}的语音课件</p><h1>把难点讲成一段可跟读的课</h1><p>课件会在后台生成，准备完成后可以从这里继续学习。</p></header>
    <CoursewareCreatePanel studentId={studentId} settings={settings} onCreated={(created) => setItems((current) => [created, ...current.filter((item) => item.id !== created.id)])} />
    <section className="courseware-library" aria-labelledby="courseware-library-title"><div className="courseware-library-heading"><div><p className="courseware-eyebrow">课件库</p><h2 id="courseware-library-title">已经准备的学习内容</h2></div>{error && <p className="courseware-inline-error" role="alert">{error}</p>}</div>
      {items.length === 0 ? <div className="courseware-empty"><h3>还没有语音课件</h3><p>填写上方内容后，就能为孩子准备第一节课。</p></div> : <div className="courseware-list">{items.map((courseware) => <article id={`courseware-${courseware.id}`} className={`courseware-card is-${courseware.status}`} key={courseware.id}>
        <div className="courseware-card-head"><div><p className="courseware-subject">{courseware.subject}</p><h3>{courseware.title}</h3><p>{courseware.topic}</p></div><span className="courseware-badge">{statusLabel(courseware)}</span></div>
        <CoursewareGenerationStatus courseware={courseware} onQueued={() => void refreshItem(courseware.id)} />
        <div className="courseware-card-actions">{courseware.status === 'ready' && <Link className="btn btn-primary" to={`/students/${studentId}/coursewares/${courseware.id}`}>继续上课</Link>}{(courseware.status === 'queued' || courseware.status === 'generating') && <a className="btn" href={`#courseware-${courseware.id}`}>查看进度</a>}<button type="button" className="courseware-delete-button" disabled={courseware.status === 'deleting'} onClick={() => setDeleteTarget(courseware)}>{courseware.status === 'deleting' ? '正在删除' : '删除'}</button></div>
      </article>)}</div>}
      {nextCursor && <div className="courseware-load-more"><button className="btn" type="button" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? '正在加载…' : '加载更多'}</button></div>}
    </section>
    {deleteTarget && <CoursewareDeleteModal courseware={deleteTarget} onClose={() => setDeleteTarget(null)} onConfirm={() => remove(deleteTarget)} />}
  </div>;
}

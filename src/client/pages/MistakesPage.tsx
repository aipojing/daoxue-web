import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { apiGet, apiPut, apiDelete, ApiError } from '../api';
import { SUBJECTS, SUBJECT_NAMES, type MistakeCard, type ConversationSubject } from '../types';
import MistakeCardItem from '../components/MistakeCardItem';
import { IconNotebook } from '../components/icons';
import { finishPending, tryStartPending } from '../lib/chat';

export default function MistakesPage() {
  const { studentId } = useParams();
  const [cards, setCards] = useState<MistakeCard[] | null>(null);
  const [subjectFilter, setSubjectFilter] = useState<ConversationSubject | null>(null);
  const [statusFilter, setStatusFilter] = useState<'pending' | 'passed' | null>('pending');
  const [error, setError] = useState('');
  const [pendingCardIds, setPendingCardIds] = useState<Set<number>>(() => new Set());
  const loadGenRef = useRef(0);
  const pendingCardIdsRef = useRef(new Set<number>());
  const latestLoadRef = useRef<() => Promise<void>>(async () => {});

  const load = useCallback(async () => {
    const gen = ++loadGenRef.current;
    try {
      const params = new URLSearchParams();
      if (subjectFilter) params.set('subject', subjectFilter);
      if (statusFilter) params.set('status', statusFilter);
      const qs = params.toString();
      const next = await apiGet<MistakeCard[]>(`/api/students/${studentId}/mistake-cards${qs ? `?${qs}` : ''}`);
      if (gen !== loadGenRef.current) return;
      setCards(next);
      setError('');
    } catch (e) {
      if (gen !== loadGenRef.current) return;
      setError(e instanceof ApiError ? e.message : '加载失败');
    }
  }, [studentId, subjectFilter, statusFilter]);
  latestLoadRef.current = load;

  useEffect(() => {
    void load();
  }, [load]);

  const onAction = async (card: MistakeCard, action: 'pass' | 'fail') => {
    if (!tryStartPending(pendingCardIdsRef.current, card.id)) return;
    setPendingCardIds(new Set(pendingCardIdsRef.current));
    try {
      await apiPut(`/api/mistake-cards/${card.id}`, { action });
      await latestLoadRef.current();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '操作失败');
    } finally {
      finishPending(pendingCardIdsRef.current, card.id);
      setPendingCardIds(new Set(pendingCardIdsRef.current));
    }
  };

  const onDelete = async (card: MistakeCard) => {
    if (!window.confirm(`删除错题「${card.title}」？`)) return;
    if (!tryStartPending(pendingCardIdsRef.current, card.id)) return;
    setPendingCardIds(new Set(pendingCardIdsRef.current));
    try {
      await apiDelete(`/api/mistake-cards/${card.id}`);
      await latestLoadRef.current();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '删除失败');
    } finally {
      finishPending(pendingCardIdsRef.current, card.id);
      setPendingCardIds(new Set(pendingCardIdsRef.current));
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <h1>
          <IconNotebook size={24} />
          错题本
        </h1>
        <Link to={`/students/${studentId}/today`} className="btn">
          返回今日学习
        </Link>
      </div>

      <div className="filter-bar">
        <div className="filter-group">
          <button
            className={subjectFilter === null ? 'chip active' : 'chip'}
            aria-pressed={subjectFilter === null}
            onClick={() => setSubjectFilter(null)}
          >
            全部学科
          </button>
          {SUBJECTS.map((subj) => (
            <button
              key={subj}
              className={subjectFilter === subj ? 'chip active' : 'chip'}
              aria-pressed={subjectFilter === subj}
              onClick={() => setSubjectFilter(subj)}
            >
              {SUBJECT_NAMES[subj]}
            </button>
          ))}
          <button
            className={subjectFilter === 'selflearn' ? 'chip active' : 'chip'}
            aria-pressed={subjectFilter === 'selflearn'}
            onClick={() => setSubjectFilter('selflearn')}
          >
            自学
          </button>
        </div>
        <div className="filter-group">
          <button
            className={statusFilter === 'pending' ? 'chip active' : 'chip'}
            aria-pressed={statusFilter === 'pending'}
            onClick={() => setStatusFilter('pending')}
          >
            待复测
          </button>
          <button
            className={statusFilter === 'passed' ? 'chip active' : 'chip'}
            aria-pressed={statusFilter === 'passed'}
            onClick={() => setStatusFilter('passed')}
          >
            已通过
          </button>
          <button className={statusFilter === null ? 'chip active' : 'chip'}
            aria-pressed={statusFilter === null}
            onClick={() => setStatusFilter(null)}>
            全部
          </button>
        </div>
      </div>

      {error && <div className="form-error">{error}</div>}

      {cards === null ? (
        <div className="page-loading">
          <div className="spinner" />
        </div>
      ) : cards.length === 0 ? (
        <div className="empty-state">
          {statusFilter === 'passed' ? (
            <p>还没有已通过复测的错题。</p>
          ) : subjectFilter || statusFilter ? (
            <p>当前筛选条件下没有错题，试试切换到「全部」。</p>
          ) : (
            <>
              <p>暂无错题。</p>
              <p>在辅导对话中点击「存入错题本」，AI 会自动整理成结构化错题卡。</p>
            </>
          )}
        </div>
      ) : (
        <div className="mistake-list">
          {cards.map((card) => (
            <MistakeCardItem
              key={card.id}
              card={card}
              busy={pendingCardIds.has(card.id)}
              onAction={(c, a) => void onAction(c, a)}
              onDelete={(c) => void onDelete(c)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { apiGet, apiPut, ApiError } from '../api';
import {
  SUBJECTS,
  SUBJECT_NAMES,
  SUBJECT_COLORS,
  isSubject,
  type Conversation,
  type Profile,
  type Subject,
} from '../types';
import { IconLamp } from '../components/icons';
import { formatDateTime } from '../lib/datetime';

export default function TutoringPage() {
  const { studentId } = useParams();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [editingProfile, setEditingProfile] = useState<{ subject: Subject; text: string } | null>(null);
  const [savingProfile, setSavingProfile] = useState(false);
  const [showAllConversations, setShowAllConversations] = useState(false);
  const loadGenRef = useRef(0);

  const load = useCallback(async () => {
    const gen = ++loadGenRef.current;
    try {
      const [convData, profileData] = await Promise.all([
        apiGet<Conversation[]>(`/api/students/${studentId}/conversations`),
        apiGet<Profile[]>(`/api/students/${studentId}/profiles`),
      ]);
      if (gen !== loadGenRef.current) return;
      setConversations(convData.filter((cv) => cv.subject !== 'selflearn'));
      setProfiles(profileData);
      setLoadError('');
      setLoaded(true);
    } catch (e) {
      if (gen !== loadGenRef.current) return;
      setLoadError(e instanceof ApiError ? e.message : '加载失败');
    }
  }, [studentId]);

  useEffect(() => {
    void load();
  }, [load]);

  const saveProfile = async () => {
    if (!editingProfile) return;
    setSavingProfile(true);
    setActionError('');
    try {
      await apiPut(`/api/students/${studentId}/profiles/${editingProfile.subject}`, {
        profileText: editingProfile.text,
      });
      setEditingProfile(null);
      await load();
    } catch (e) {
      // 只做内联提示：整页替换会把用户正在编辑的画像文字一起清掉
      setActionError(e instanceof ApiError ? e.message : '保存失败，请重试');
    } finally {
      setSavingProfile(false);
    }
  };

  if (!loaded) {
    if (loadError) {
      return (
        <div className="page">
          <div className="form-error">{loadError}</div>
          <div className="selflearn-actions">
            <button className="btn btn-primary" onClick={() => void load()}>
              重新加载
            </button>
            <Link to={`/students/${studentId}/today`} className="btn">
              返回今日学习
            </Link>
          </div>
        </div>
      );
    }
    return (
      <div className="page-loading">
        <div className="spinner" />
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1>
          <IconLamp size={24} />
          解题辅导
        </h1>
        <Link to={`/students/${studentId}/today`} className="btn">
          返回今日学习
        </Link>
      </div>
      <p className="text-secondary mode-intro">
        选择学科，把题目打字或粘贴发给 AI。它会分步引导孩子自己解出来，而不是直接报答案；
        对话中可随时「存入错题本」。
      </p>
      {actionError && <div className="form-error">{actionError}</div>}

      <h2 className="section-title">选择学科</h2>
      <div className="subject-grid">
        {SUBJECTS.map((subj) => (
          <Link
            key={subj}
            to={`/students/${studentId}/chat/new?subject=${subj}`}
            className="subject-card"
            style={{ borderColor: SUBJECT_COLORS[subj] }}
          >
            <span className="subject-card-name" style={{ color: SUBJECT_COLORS[subj] }}>
              {SUBJECT_NAMES[subj]}
            </span>
            <span className="subject-card-hint">新对话 →</span>
          </Link>
        ))}
      </div>

      <h2 className="section-title">最近会话</h2>
      {conversations.length === 0 ? (
        <p className="text-secondary">还没有辅导会话，选择上面的学科开始吧。</p>
      ) : (
        <>
          <div className="conversation-list card">
            {(showAllConversations ? conversations : conversations.slice(0, 10)).map((cv) => {
              const subj = isSubject(cv.subject) ? cv.subject : null;
              return (
                <Link key={cv.id} to={`/students/${studentId}/chat/${cv.id}`} className="conversation-item">
                  <span
                    className="subject-chip"
                    style={{ background: subj ? SUBJECT_COLORS[subj] : '#6b7280' }}
                  >
                    {subj ? SUBJECT_NAMES[subj] : cv.subject}
                  </span>
                  <span className="conversation-title">{cv.title}</span>
                  <span className="conversation-time">{formatDateTime(cv.updated_at)}</span>
                </Link>
              );
            })}
          </div>
          {conversations.length > 10 && (
            <button
              className="btn btn-sm"
              style={{ marginTop: 8 }}
              onClick={() => setShowAllConversations(!showAllConversations)}
            >
              {showAllConversations ? '收起' : `查看全部 ${conversations.length} 条会话`}
            </button>
          )}
        </>
      )}

      <h2 className="section-title">学科学习画像</h2>
      <p className="text-secondary" style={{ marginBottom: 12 }}>
        AI 会随辅导对话自动更新每个学科的画像（薄弱点、高频错因、有效讲法），并在后续辅导中参考。可手动修改。
      </p>
      <div className="profile-grid">
        {SUBJECTS.map((subj) => {
          const profile = profiles.find((p) => p.subject === subj);
          const isEditing = editingProfile?.subject === subj;
          return (
            <div key={subj} className="card profile-card">
              <div className="profile-card-header">
                <span className="subject-chip" style={{ background: SUBJECT_COLORS[subj] }}>
                  {SUBJECT_NAMES[subj]}
                </span>
                {!isEditing && (
                  <button
                    className="btn btn-sm"
                    onClick={() => setEditingProfile({ subject: subj, text: profile?.profile_text ?? '' })}
                  >
                    编辑
                  </button>
                )}
              </div>
              {isEditing ? (
                <div>
                  <textarea
                    value={editingProfile.text}
                    onChange={(e) => setEditingProfile({ subject: subj, text: e.target.value })}
                    rows={6}
                    maxLength={2000}
                    placeholder="填写该学科的学习情况，AI 辅导时会参考"
                  />
                  <div className="modal-actions">
                    <button className="btn btn-sm" onClick={() => setEditingProfile(null)}>
                      取消
                    </button>
                    <button className="btn btn-sm btn-primary" onClick={() => void saveProfile()} disabled={savingProfile}>
                      {savingProfile ? '保存中…' : '保存'}
                    </button>
                  </div>
                </div>
              ) : (
                <p className={profile?.profile_text ? 'profile-text' : 'profile-text text-secondary'}>
                  {profile?.profile_text || '暂无画像，随对话自动生成'}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

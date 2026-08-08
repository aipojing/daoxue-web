import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { apiGet, apiPost, ApiError } from '../api';
import {
  LEVEL_COLORS,
  EMPTY_PROFILE_FORM,
  type Conversation,
  type KnowledgePoint,
  type ProfileFormData,
  type SelfLearnOverview,
} from '../types';
import MarkdownContent from '../components/MarkdownContent';
import StudentWizard from '../components/StudentWizard';
import { IconTarget, IconPlay, IconPlus } from '../components/icons';
import { formatDateTime, formatFullDateTime } from '../lib/datetime';

function KnowledgePointFlags({ kp }: { kp: KnowledgePoint }) {
  const flags: string[] = [];
  if (kp.needs_warmup) flags.push('待保温');
  if (kp.needs_retest) flags.push('待复测');
  if (kp.needs_rebuild) flags.push('需重构');
  if (kp.can_network) flags.push('可组网');
  if (flags.length === 0) return null;
  return (
    <span className="kp-flags">
      {flags.map((f) => (
        <span key={f} className="badge">
          {f}
        </span>
      ))}
    </span>
  );
}

function ExpandableRecord({ title, meta, content }: { title: string; meta: string; content: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="card record-card">
      <button className="record-header" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="record-title">{title}</span>
        <span className="record-meta">{meta}</span>
        <span className="expand-arrow">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="record-content">
          <MarkdownContent content={content} />
        </div>
      )}
    </div>
  );
}

/** 逐字段校验，坏数据不会污染表单（更不会展开出垃圾键提交回服务端） */
function parseFormJson(raw: string): ProfileFormData {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return EMPTY_PROFILE_FORM;
    }
    const p = parsed as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === 'string' ? v : '');
    const arr = (v: unknown) =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    return {
      directions: arr(p.directions),
      goal: str(p.goal),
      currentPosition: str(p.currentPosition),
      weakSpots: str(p.weakSpots),
      mainProblem: str(p.mainProblem),
      parentPriority: str(p.parentPriority),
      weekdayTime: str(p.weekdayTime),
      weekendTime: str(p.weekendTime),
      startHabit: str(p.startHabit),
      focusDuration: str(p.focusDuration),
      difficultyReaction: str(p.difficultyReaction),
      retellAbility: str(p.retellAbility),
      preferredStyles: arr(p.preferredStyles),
      mistakeHabit: str(p.mistakeHabit),
      interestState: str(p.interestState),
      interests: str(p.interests),
      parentInvolvement: str(p.parentInvolvement),
      forbidden: arr(p.forbidden),
      specialNotes: str(p.specialNotes),
    };
  } catch {
    return EMPTY_PROFILE_FORM;
  }
}

export default function SelfLearnPage() {
  const { studentId } = useParams();
  const navigate = useNavigate();
  const [overview, setOverview] = useState<SelfLearnOverview | null>(null);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const loadGenRef = useRef(0);

  const load = useCallback(async () => {
    const gen = ++loadGenRef.current;
    try {
      const data = await apiGet<SelfLearnOverview>(`/api/students/${studentId}/selflearn`);
      if (gen !== loadGenRef.current) return;
      setOverview(data);
      setError('');
    } catch (e) {
      if (gen !== loadGenRef.current) return;
      setError(e instanceof ApiError ? e.message : '加载失败');
    }
  }, [studentId]);

  useEffect(() => {
    void load();
  }, [load]);

  const profileReady = !!overview?.profile?.ready;
  const latestDaily = overview?.conversations.find((cv) => cv.mode === 'selflearn-daily') ?? null;

  const startDaily = async () => {
    setCreating(true);
    try {
      const cv = await apiPost<Conversation>(`/api/students/${studentId}/conversations`, {
        subject: 'selflearn',
        mode: 'selflearn-daily',
      });
      navigate(`/students/${studentId}/chat/${cv.id}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '创建会话失败');
      setCreating(false);
    }
  };

  const knowledgeByDirection = useMemo(() => {
    const groups = new Map<string, KnowledgePoint[]>();
    for (const kp of overview?.knowledgePoints ?? []) {
      const key = kp.direction || '未分类';
      groups.set(key, [...(groups.get(key) ?? []), kp]);
    }
    return Array.from(groups.entries());
  }, [overview]);

  if (!overview) {
    // 加载失败时绝不能渲染"请先填写画像"引导——那会让老用户以为记录丢了，
    // 还可能用空表单覆盖掉服务器上已有的画像
    if (error) {
      return (
        <div className="page">
          <div className="page-header">
            <h1>
              <IconTarget size={24} />
              自学陪伴
            </h1>
            <Link to={`/students/${studentId}`} className="btn">
              返回学生主页
            </Link>
          </div>
          <div className="form-error">{error}</div>
          <button className="btn btn-primary" onClick={() => void load()}>
            重新加载
          </button>
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
          <IconTarget size={24} />
          自学陪伴
        </h1>
        <Link to={`/students/${studentId}`} className="btn">
          返回学生主页
        </Link>
      </div>
      {error && <div className="form-error">{error}</div>}

      {!profileReady ? (
        <div className="card selflearn-intro">
          <h2 className="section-title">第一步：完善孩子学习画像</h2>
          <p>
            自学陪伴会根据孩子的学习画像（方向目标、学习习惯、状态兴趣、家长要求）来安排每天的学习。
            请先花 2 分钟填写画像表单，不确定的项可以先跳过，之后随时可改。
          </p>
          <div className="selflearn-actions">
            <button className="btn btn-primary" onClick={() => setWizardOpen(true)}>
              填写画像表单
            </button>
          </div>
        </div>
      ) : (
        <div className="card selflearn-intro">
          <h2 className="section-title">今日学习</h2>
          <p className="text-secondary">
            固定流程：任务确认 → 旧知识保温 → 知识拆解 → 生成课件提示词（复制到{' '}
            <a href="https://open.maic.chat/" target="_blank" rel="noreferrer">
              OpenMAIC
            </a>{' '}
            上课）→ 学完回来说"学完了" → 测验与错题卡 → 每课输出 → 每日家长反馈。
          </p>
          <div className="selflearn-actions">
            {latestDaily ? (
              <>
                <Link to={`/students/${studentId}/chat/${latestDaily.id}`} className="btn btn-primary">
                  <IconPlay size={16} />
                  继续上次学习（{latestDaily.title}）
                </Link>
                <button className="btn" disabled={creating} onClick={() => void startDaily()}>
                  <IconPlus size={15} />
                  {creating ? '创建中…' : '开始新的学习会话'}
                </button>
              </>
            ) : (
              <button className="btn btn-primary" disabled={creating} onClick={() => void startDaily()}>
                <IconPlay size={16} />
                {creating ? '创建中…' : '开始今天的学习'}
              </button>
            )}
          </div>
        </div>
      )}

      {overview && overview.conversations.length > 0 && (
        <>
          <h2 className="section-title">自学会话</h2>
          <div className="conversation-list card">
            {overview.conversations.map((cv) => (
              <Link key={cv.id} to={`/students/${studentId}/chat/${cv.id}`} className="conversation-item">
                <span className="subject-chip" style={{ background: '#635c9b' }}>
                  {cv.mode === 'selflearn-profiling' ? '画像' : '学习'}
                </span>
                <span className="conversation-title">{cv.title}</span>
                <span className="conversation-time">{formatDateTime(cv.updated_at)}</span>
              </Link>
            ))}
          </div>
        </>
      )}

      {profileReady && overview?.profile && (
        <>
          <h2 className="section-title">孩子学习画像</h2>
          <div className="card">
            <button className="record-header" aria-expanded={profileOpen} onClick={() => setProfileOpen(!profileOpen)}>
              <span className="record-title">画像内容</span>
              <span className="record-meta">更新于 {formatFullDateTime(overview.profile.updated_at)}</span>
              <span className="expand-arrow">{profileOpen ? '▲' : '▼'}</span>
            </button>
            {profileOpen && <pre className="profile-pre">{overview.profile.profile_text}</pre>}
            <div className="selflearn-actions">
              <button className="btn btn-sm" onClick={() => setWizardOpen(true)}>
                编辑画像表单
              </button>
            </div>
          </div>
        </>
      )}

      <h2 className="section-title">知识点掌握记录</h2>
      <div className="level-legend">
        {[
          ['L1', '听过，还讲不出'],
          ['L2', '带着能做，独立易错'],
          ['L3', '能独立做并说清思路'],
          ['L4', '能迁移、能讲给别人'],
        ].map(([lv, desc]) => (
          <span key={lv} className="level-legend-item">
            <span className="level-chip" style={{ background: LEVEL_COLORS[lv!] ?? '#6b7280' }}>
              {lv}
            </span>
            {desc}
          </span>
        ))}
      </div>
      {knowledgeByDirection.length === 0 ? (
        <p className="text-secondary">暂无记录。开始学习后，AI 会自动记录每个知识点的 L1-L4 掌握等级。</p>
      ) : (
        knowledgeByDirection.map(([direction, points]) => (
          <div key={direction} className="card kp-group">
            <h3 className="kp-direction">{direction}</h3>
            {points.map((kp) => (
              <div key={kp.id} className="kp-row">
                <span className="level-chip" style={{ background: LEVEL_COLORS[kp.level] ?? '#6b7280' }}>
                  {kp.level}
                </span>
                <span className="kp-name">
                  {kp.name}
                  {kp.chain && <span className="kp-chain">（{kp.chain}）</span>}
                </span>
                <KnowledgePointFlags kp={kp} />
                {kp.evidence && <span className="kp-evidence">判定依据：{kp.evidence}</span>}
              </div>
            ))}
          </div>
        ))
      )}

      <h2 className="section-title">每课输出</h2>
      {!overview || overview.lessonOutputs.length === 0 ? (
        <p className="text-secondary">暂无每课输出。每完成一个学习单元，AI 会自动生成并存档。</p>
      ) : (
        <div className="record-list">
          {overview.lessonOutputs.map((lo) => (
            <ExpandableRecord
              key={lo.id}
              title={`${lo.direction || '学习'} · ${formatFullDateTime(lo.created_at)}`}
              meta={lo.next_instruction ? `下一步：${lo.next_instruction.slice(0, 30)}` : ''}
              content={lo.content}
            />
          ))}
        </div>
      )}

      <h2 className="section-title">每日家长反馈</h2>
      {!overview || overview.dailyReports.length === 0 ? (
        <p className="text-secondary">暂无每日反馈。每天学习结束时对 AI 说"今天结束"即可生成。</p>
      ) : (
        <div className="record-list">
          {overview.dailyReports.map((dr) => (
            <ExpandableRecord key={dr.id} title={`家长反馈 · ${dr.report_date}`} meta="" content={dr.content} />
          ))}
        </div>
      )}

      {wizardOpen && (
        <StudentWizard
          mode="profile"
          studentId={Number(studentId)}
          initialForm={overview?.profile ? parseFormJson(overview.profile.form_json) : EMPTY_PROFILE_FORM}
          onClose={() => setWizardOpen(false)}
          onDone={() => {
            setWizardOpen(false);
            void load();
          }}
        />
      )}
    </div>
  );
}

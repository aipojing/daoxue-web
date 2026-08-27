import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { apiGet, apiPost, ApiError } from '../api';
import { EMPTY_PROFILE_FORM, type Conversation, type CoursewareAISettings } from '../types';
import StudentWizard from '../components/StudentWizard';
import KnowledgeMasteryPanel from '../components/KnowledgeMasteryPanel';
import LearningArchivePanel from '../components/LearningArchivePanel';
import { IconPlay, IconPlus, IconTarget } from '../components/icons';
import { getLatestDailyConversation, parseSelfLearnProfileForm, useSelfLearnOverview } from '../hooks/useSelfLearnOverview';
import { canCreateCourseware } from '../lib/courseware';

type CoursewareSettingsState = 'loading' | 'ready' | 'error';

export default function SelfLearnPage() {
  const { studentId } = useParams();
  const navigate = useNavigate();
  const { overview, error: loadError, loading, load } = useSelfLearnOverview(studentId);
  const [actionError, setActionError] = useState('');
  const [creating, setCreating] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [coursewareSettings, setCoursewareSettings] = useState<CoursewareAISettings | null>(null);
  const [coursewareSettingsState, setCoursewareSettingsState] = useState<CoursewareSettingsState>('loading');
  const [coursewareSettingsReload, setCoursewareSettingsReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setCoursewareSettingsState('loading');
    void apiGet<CoursewareAISettings>('/api/courseware-ai-settings', { signal: controller.signal })
      .then((settings) => {
        if (controller.signal.aborted) return;
        setCoursewareSettings(settings);
        setCoursewareSettingsState('ready');
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setCoursewareSettings(null);
        setCoursewareSettingsState('error');
      });
    return () => controller.abort();
  }, [coursewareSettingsReload, studentId]);

  const startDaily = async () => {
    setCreating(true);
    setActionError('');
    try {
      const conversation = await apiPost<Conversation>(`/api/students/${studentId}/conversations`, { subject: 'selflearn', mode: 'selflearn-daily' });
      navigate(`/students/${studentId}/chat/${conversation.id}`);
    } catch (cause) {
      setActionError(cause instanceof ApiError ? cause.message : '创建会话失败');
      setCreating(false);
    }
  };

  if (loading && !overview) return <div className="page-loading"><div className="spinner" /></div>;
  if (!overview) return <div className="page"><div className="form-error">{loadError || '加载失败'}</div><button className="btn btn-primary" onClick={() => void load()}>重新加载</button></div>;

  const profileReady = !!overview.profile?.ready;
  const latestDaily = getLatestDailyConversation(overview.conversations);
  const coursewareEnabled = coursewareSettingsState === 'ready' && coursewareSettings?.featureEnabled === true;
  const coursewareDisabled = coursewareSettingsState === 'ready' && coursewareSettings?.featureEnabled === false;
  const coursewareReadiness = coursewareSettings
    ? canCreateCourseware({ featureEnabled: coursewareSettings.featureEnabled, ...coursewareSettings.readiness })
    : null;
  return (
    <div className="page">
      <div className="page-header"><h1><IconTarget size={24} />正式测验与自学</h1></div>
      {(loadError || actionError) && <div className="form-error">{actionError || loadError}</div>}
      <section className="card selflearn-intro" aria-labelledby="selflearn-courseware-mode-title">
        <h2 id="selflearn-courseware-mode-title" className="section-title">学习课程交接</h2>
        {coursewareEnabled ? (
          <>
            <p>完成任务确认、旧知识保温和知识拆解后，Agent 会在会话内给出站内语音课件卡片；主题和目标只取自经过校验的会话任务。</p>
            <div className="selflearn-actions">
              <Link className="btn" to={`/students/${studentId}/coursewares`}>查看已有课件</Link>
              {coursewareReadiness && !coursewareReadiness.ok && <Link className="btn" to="/ai-settings">配置个人 AI 服务</Link>}
            </div>
            {coursewareReadiness && !coursewareReadiness.ok && <p className="courseware-config-note" role="status">{coursewareReadiness.reason}。不会使用平台共享账号生成。</p>}
          </>
        ) : coursewareDisabled ? (
          <p>当前仍按原流程生成可复制到 OpenMAIC 的课件生产提示词；功能灰度开启后会改为站内语音课件卡片。</p>
        ) : coursewareSettingsState === 'loading' ? (
          <p role="status">正在确认语音课件状态…</p>
        ) : (
          <div>
            <p className="form-error" role="alert">无法确认语音课件状态，请检查网络后重试。</p>
            <button type="button" className="btn" onClick={() => setCoursewareSettingsReload((value) => value + 1)}>重新读取配置</button>
          </div>
        )}
      </section>
      {!profileReady ? (
        <section className="card selflearn-intro"><h2 className="section-title">第一步：完善孩子学习画像</h2><p>自学陪伴会根据孩子的学习画像安排每天的学习。请先填写画像表单，不确定的项可以先跳过，之后随时可改。</p><div className="selflearn-actions"><button className="btn btn-primary" onClick={() => setWizardOpen(true)}>填写画像表单</button></div></section>
      ) : (
        <section className="card selflearn-intro"><h2 className="section-title">今日学习</h2><p className="text-secondary">从今日学习开始，完成学习后会沉淀知识掌握、每课输出和家长反馈。</p><div className="selflearn-actions">{latestDaily ? <><Link to={`/students/${studentId}/chat/${latestDaily.id}`} className="btn btn-primary"><IconPlay size={16} />继续上次学习（{latestDaily.title}）</Link><button className="btn" disabled={creating} onClick={() => void startDaily()}><IconPlus size={15} />{creating ? '创建中…' : '开始新的学习会话'}</button></> : <button className="btn btn-primary" disabled={creating} onClick={() => void startDaily()}><IconPlay size={16} />{creating ? '创建中…' : '开始今天的学习'}</button>}</div></section>
      )}
      <KnowledgeMasteryPanel knowledgePoints={overview.knowledgePoints} />
      <LearningArchivePanel overview={overview} studentId={studentId ?? ''} onEditProfile={() => setWizardOpen(true)} />
      {wizardOpen && <StudentWizard mode="profile" studentId={Number(studentId)} initialForm={overview.profile ? parseSelfLearnProfileForm(overview.profile.form_json) : EMPTY_PROFILE_FORM} onClose={() => setWizardOpen(false)} onDone={() => { setWizardOpen(false); void load(); }} />}
    </div>
  );
}

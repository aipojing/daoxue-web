import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet, apiPut, ApiError } from '../api';
import { useAuth } from '../AuthContext';
import { buildAISettingsPatch, validateProfileRefineSettings } from '../lib/ai-settings';
import type { AIConfigSource, UserAISettings } from '../types';
import CoursewareAISettingsCard from '../components/CoursewareAISettingsCard';

function sourceBadge(source: AIConfigSource): JSX.Element {
  const label = source === 'personal' ? '使用个人配置' : source === 'shared' ? '使用站点共享' : '未配置';
  const className = source === 'none' ? 'badge badge-danger' : 'badge badge-success';
  return <span className={className}>{label}</span>;
}

export default function AISettingsPage() {
  const { refresh } = useAuth();
  const [settings, setSettings] = useState<UserAISettings | null>(null);
  const [deepseekInput, setDeepseekInput] = useState('');
  const [visionInput, setVisionInput] = useState('');
  const [visionProvider, setVisionProvider] = useState<'zhipu' | 'dashscope'>('zhipu');
  const [visionModel, setVisionModel] = useState('');
  const [profileInterval, setProfileInterval] = useState('10');
  const [profileDailyLimit, setProfileDailyLimit] = useState('0');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const loadGenerationRef = useRef(0);

  const applyStatus = useCallback((status: UserAISettings) => {
    setSettings(status);
    setVisionProvider(status.personal.visionProvider);
    setVisionModel(status.personal.visionModel);
    setProfileInterval(String(status.personal.profileRefineIntervalMinutes));
    setProfileDailyLimit(String(status.personal.profileRefineDailyLimit));
  }, []);

  const load = useCallback(async () => {
    const generation = ++loadGenerationRef.current;
    try {
      const status = await apiGet<UserAISettings>('/api/ai-settings');
      if (generation !== loadGenerationRef.current) return;
      applyStatus(status);
    } catch (e) {
      if (generation !== loadGenerationRef.current) return;
      setError(e instanceof ApiError ? e.message : '个人 AI 配置加载失败');
    }
  }, [applyStatus]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 2500);
    return () => clearTimeout(timer);
  }, [toast]);

  const save = async () => {
    setError('');
    const intervalMinutes = Number(profileInterval);
    const dailyLimit = Number(profileDailyLimit);
    const validationError = validateProfileRefineSettings(intervalMinutes, dailyLimit);
    if (validationError) {
      setError(validationError);
      return;
    }

    setSaving(true);
    try {
      const saved = await apiPut<UserAISettings>(
        '/api/ai-settings',
        buildAISettingsPatch({
          deepseekInput,
          visionInput,
          visionProvider,
          visionModel,
          clearDeepseek: false,
          clearVision: false,
          profileRefineIntervalMinutes: intervalMinutes,
          profileRefineDailyLimit: dailyLimit,
        }),
      );
      applyStatus(saved);
      setDeepseekInput('');
      setVisionInput('');
      setToast('个人 AI 配置已保存，立即生效');
      await refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '个人 AI 配置保存失败');
    } finally {
      setSaving(false);
    }
  };

  const clearPersonalKey = async (service: 'deepseek' | 'vision') => {
    setSaving(true);
    setError('');
    try {
      const saved = await apiPut<UserAISettings>('/api/ai-settings', {
        [service === 'deepseek' ? 'deepseekApiKey' : 'visionApiKey']: null,
      });
      applyStatus(saved);
      setToast(service === 'deepseek' ? '已清除个人 DeepSeek Key' : '已清除个人视觉 Key');
      await refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '清除失败');
    } finally {
      setSaving(false);
    }
  };

  if (!settings && !error) {
    return (
      <div className="page-loading">
        <div className="spinner" />
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1>AI 服务</h1>
      </div>
      {error && <div className="form-error">{error}</div>}

      <section className="card settings-card" aria-labelledby="personal-ai-title">
        <h2 id="personal-ai-title" className="section-title">我的 AI 服务</h2>
        <p className="form-hint">
          同一账户下的所有学生共用这些 Key 和画像提炼策略。对话、错题提取、自学处理和学习画像可能消耗 DeepSeek 额度。
        </p>

        <div className="key-row">
          <div className="key-row-head">
            <strong>DeepSeek API Key</strong>
            {settings && sourceBadge(settings.effective.deepseekSource)}
            {settings?.personal.deepseekKeySet && (
              <span className="badge">个人 Key（尾号 {settings.personal.deepseekKeyTail || '****'}）</span>
            )}
          </div>
          <p className="form-hint">
            在 <a href="https://platform.deepseek.com" target="_blank" rel="noreferrer">platform.deepseek.com</a> 创建，
            以 sk- 开头。保存后不回显，留空表示不修改。
          </p>
          <input
            type="password"
            value={deepseekInput}
            onChange={(event) => setDeepseekInput(event.target.value)}
            placeholder="sk-…（留空表示不修改）"
            autoComplete="off"
            disabled={saving}
          />
          {settings?.personal.deepseekKeySet && (
            <button
              type="button"
              className="btn btn-danger-ghost"
              disabled={saving}
              onClick={() => void clearPersonalKey('deepseek')}
            >
              清除个人 DeepSeek Key
            </button>
          )}
        </div>

        <div className="key-row">
          <div className="key-row-head">
            <strong>图片识别服务</strong>
            {settings && sourceBadge(settings.effective.visionSource)}
            {settings?.personal.visionKeySet && (
              <span className="badge">个人 Key（尾号 {settings.personal.visionKeyTail || '****'}）</span>
            )}
          </div>
          <p className="form-hint">配置后聊天输入框出现相机按钮；个人配置仅支持智谱与阿里云百炼。</p>
          <input
            type="password"
            value={visionInput}
            onChange={(event) => setVisionInput(event.target.value)}
            placeholder="视觉服务 Key（留空表示不修改）"
            autoComplete="off"
            disabled={saving}
          />
          <select
            value={visionProvider}
            onChange={(event) => setVisionProvider(event.target.value as 'zhipu' | 'dashscope')}
            disabled={saving}
          >
            <option value="zhipu">智谱</option>
            <option value="dashscope">阿里云百炼</option>
          </select>
          <input
            value={visionModel}
            onChange={(event) => setVisionModel(event.target.value)}
            placeholder={visionProvider === 'zhipu' ? 'glm-4.1v-thinking-flash' : 'qwen-vl-plus'}
            disabled={saving}
          />
          {settings?.personal.visionKeySet && (
            <button
              type="button"
              className="btn btn-danger-ghost"
              disabled={saving}
              onClick={() => void clearPersonalKey('vision')}
            >
              清除个人视觉 Key
            </button>
          )}
        </div>

        <div className="key-row">
          <div className="key-row-head">
            <strong>学科画像提炼间隔</strong>（分钟）
          </div>
          <p className="form-hint">
            同一学生同一学科两次画像提炼的最短间隔。画像提炼会消耗当前账户生效的 DeepSeek Key。
          </p>
          <input
            type="number"
            min={1}
            max={1440}
            value={profileInterval}
            onChange={(event) => setProfileInterval(event.target.value)}
            disabled={saving}
          />
        </div>

        <div className="key-row">
          <div className="key-row-head">
            <strong>学科画像每日提炼上限</strong>（0 = 不限）
          </div>
          <p className="form-hint">
            每个学生每个学科每天最多提炼几次；填 0 表示不限制，可按自己的 Key 预算控制后台消耗。
          </p>
          <input
            type="number"
            min={0}
            max={1000}
            value={profileDailyLimit}
            onChange={(event) => setProfileDailyLimit(event.target.value)}
            disabled={saving}
          />
        </div>

        <div className="settings-actions">
          <button type="button" className="btn btn-primary" disabled={saving} onClick={() => void save()}>
            {saving ? '保存中…' : '保存我的配置'}
          </button>
        </div>
      </section>

      <section className="settings-section" aria-labelledby="courseware-ai-title">
        <div className="section-heading">
          <h2 id="courseware-ai-title">语音课件模型配置</h2>
          <p>在这里配置服务商 Key、测试模型，并保存各用途的默认值；新建课件时仍可为本次任务重新选择。</p>
        </div>
        <CoursewareAISettingsCard />
      </section>

      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

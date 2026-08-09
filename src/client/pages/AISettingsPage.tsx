import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet, apiPut, ApiError } from '../api';
import { useAuth } from '../AuthContext';
import { buildAISettingsPatch } from '../lib/ai-settings';
import type { AIConfigSource, AdminSettings, UserAISettings } from '../types';

function sourceBadge(source: AIConfigSource): JSX.Element {
  const label = source === 'personal' ? '使用个人配置' : source === 'shared' ? '使用站点共享' : '未配置';
  const className = source === 'none' ? 'badge badge-danger' : 'badge badge-success';
  return <span className={className}>{label}</span>;
}

function keySetBadge(set: boolean, tail: string, fromEnv: boolean): JSX.Element | null {
  if (!set) return null;
  if (fromEnv) return <span className="badge badge-success">已配置（环境变量）</span>;
  return <span className="badge badge-success">已配置（尾号 {tail || '****'}）</span>;
}

interface SharedAIFieldsProps {
  settings: AdminSettings | null;
  deepseekKey: string;
  visionKey: string;
  visionUrl: string;
  visionModel: string;
  profileInterval: string;
  profileDailyLimit: string;
  disabled: boolean;
  onChange: (
    field: 'deepseekKey' | 'visionKey' | 'visionUrl' | 'visionModel' | 'profileInterval' | 'profileDailyLimit',
    value: string,
  ) => void;
}

function SharedAIFields({
  settings,
  deepseekKey,
  visionKey,
  visionUrl,
  visionModel,
  profileInterval,
  profileDailyLimit,
  disabled,
  onChange,
}: SharedAIFieldsProps) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  return (
    <>
      <div className="key-row">
        <div className="key-row-head">
          <strong>共享 DeepSeek API Key</strong>（必须，驱动全部对话）
          {settings && keySetBadge(settings.deepseekKeySet, settings.deepseekKeyTail, settings.deepseekFromEnv)}
        </div>
        <p className="form-hint">
          在 <a href="https://platform.deepseek.com" target="_blank" rel="noreferrer">platform.deepseek.com</a> 创建，
          以 sk- 开头。粘贴新 Key 保存即覆盖；Key 保存后不回显。
        </p>
        <input
          type="password"
          value={deepseekKey}
          onChange={(e) => onChange('deepseekKey', e.target.value)}
          placeholder="sk-…（留空表示不修改）"
          autoComplete="off"
          disabled={disabled}
        />
      </div>
      <div className="key-row">
        <div className="key-row-head">
          <strong>共享视觉模型 Key</strong>（可选，开启拍照识题）
          {settings && keySetBadge(settings.visionKeySet, settings.visionKeyTail, settings.visionFromEnv)}
        </div>
        <p className="form-hint">
          默认接智谱 GLM-4.1V-Thinking-Flash（免费），在{' '}
          <a href="https://open.bigmodel.cn" target="_blank" rel="noreferrer">open.bigmodel.cn</a> 注册取 Key。
        </p>
        <input
          type="password"
          value={visionKey}
          onChange={(e) => onChange('visionKey', e.target.value)}
          placeholder="智谱 API Key（留空表示不修改）"
          autoComplete="off"
          disabled={disabled}
        />
        <button
          className="btn-link"
          aria-expanded={advancedOpen}
          onClick={() => setAdvancedOpen(!advancedOpen)}
          disabled={disabled}
        >
          {advancedOpen ? '收起高级设置 ▲' : '高级：换其他视觉服务（如通义 qwen-vl）▼'}
        </button>
        {advancedOpen && (
          <div className="key-advanced">
            <input
              value={visionUrl}
              onChange={(e) => onChange('visionUrl', e.target.value)}
              placeholder="接口地址（OpenAI 兼容），留空用智谱默认"
              disabled={disabled}
            />
            <input
              value={visionModel}
              onChange={(e) => onChange('visionModel', e.target.value)}
              placeholder="模型名，如 qwen-vl-plus，留空用 glm-4.1v-thinking-flash"
              disabled={disabled}
            />
          </div>
        )}
      </div>
      <div className="key-row">
        <div className="key-row-head">
          <strong>学科画像提炼间隔</strong>（分钟）
        </div>
        <p className="form-hint">
          同一学生同一学科两次画像提炼的最短间隔。画像提炼会消耗当前生效的 DeepSeek Key。
        </p>
        <input
          type="number"
          min={1}
          max={1440}
          value={profileInterval}
          onChange={(e) => onChange('profileInterval', e.target.value)}
          placeholder="10"
          disabled={disabled}
        />
      </div>
      <div className="key-row">
        <div className="key-row-head">
          <strong>学科画像每日提炼上限</strong>（0 = 不限）
        </div>
        <p className="form-hint">
          每个学生每个学科每天最多提炼几次。填 0 表示不限制；填 1–1000 可在对话非常密集时控制成本。
        </p>
        <input
          type="number"
          min={0}
          max={1000}
          value={profileDailyLimit}
          onChange={(e) => onChange('profileDailyLimit', e.target.value)}
          placeholder="0"
          disabled={disabled}
        />
      </div>
    </>
  );
}

export default function AISettingsPage() {
  const { user, refresh } = useAuth();
  const isAdmin = user?.isAdmin ?? false;

  const [error, setError] = useState('');
  const [toast, setToast] = useState('');

  const [personalSettings, setPersonalSettings] = useState<UserAISettings | null>(null);
  const [adminSettings, setAdminSettings] = useState<AdminSettings | null>(null);

  const [deepseekInput, setDeepseekInput] = useState('');
  const [visionInput, setVisionInput] = useState('');
  const [visionProvider, setVisionProvider] = useState<'zhipu' | 'dashscope'>('zhipu');
  const [visionModel, setVisionModel] = useState('');
  const [savingPersonal, setSavingPersonal] = useState(false);

  const [sharedDeepseekInput, setSharedDeepseekInput] = useState('');
  const [sharedVisionInput, setSharedVisionInput] = useState('');
  const [sharedVisionUrl, setSharedVisionUrl] = useState('');
  const [sharedVisionModel, setSharedVisionModel] = useState('');
  const [profileInterval, setProfileInterval] = useState('10');
  const [profileDailyLimit, setProfileDailyLimit] = useState('0');
  const [sharedFallbackEnabled, setSharedFallbackEnabled] = useState(true);
  const [savingShared, setSavingShared] = useState(false);

  const loadGenRef = useRef(0);

  const applyPersonalStatus = useCallback((status: UserAISettings) => {
    setPersonalSettings(status);
    setVisionProvider(status.personal.visionProvider);
    setVisionModel(status.personal.visionModel);
  }, []);

  const load = useCallback(
    async (syncSharedInputs = false) => {
      const generation = ++loadGenRef.current;
      try {
        // 个人状态所有登录用户都加载；管理员额外并行加载站点共享配置
        const [personal, shared] = await Promise.all([
          apiGet<UserAISettings>('/api/ai-settings'),
          isAdmin ? apiGet<AdminSettings>('/api/admin/settings') : Promise.resolve(null),
        ]);
        if (generation !== loadGenRef.current) return;
        applyPersonalStatus(personal);
        if (shared) {
          setAdminSettings(shared);
          setSharedFallbackEnabled(shared.sharedFallbackEnabled);
          // 只在首次加载/保存后回填，避免覆盖正在输入的内容
          if (syncSharedInputs) {
            setSharedVisionUrl(shared.visionApiUrl);
            setSharedVisionModel(shared.visionModel);
            setProfileInterval(String(shared.profileRefineIntervalMinutes));
            setProfileDailyLimit(String(shared.profileRefineDailyLimit));
          }
        }
      } catch (e) {
        if (generation !== loadGenRef.current) return;
        setError(e instanceof ApiError ? e.message : '加载失败');
      }
    },
    [isAdmin, applyPersonalStatus],
  );

  useEffect(() => {
    void load(true);
  }, [load]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 2500);
    return () => clearTimeout(timer);
  }, [toast]);

  const savePersonal = async () => {
    setSavingPersonal(true);
    setError('');
    try {
      const patch = buildAISettingsPatch({
        deepseekInput,
        visionInput,
        visionProvider,
        visionModel,
        clearDeepseek: false,
        clearVision: false,
      });
      const saved = await apiPut<UserAISettings>('/api/ai-settings', patch);
      applyPersonalStatus(saved);
      setDeepseekInput('');
      setVisionInput('');
      setToast('已保存，立即生效');
      await refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '保存失败');
    } finally {
      setSavingPersonal(false);
    }
  };

  const clearPersonalKey = async (service: 'deepseek' | 'vision') => {
    setSavingPersonal(true);
    setError('');
    try {
      const saved = await apiPut<UserAISettings>('/api/ai-settings', {
        [service === 'deepseek' ? 'deepseekApiKey' : 'visionApiKey']: null,
      });
      applyPersonalStatus(saved);
      setToast(service === 'deepseek' ? '已清除个人 DeepSeek Key' : '已清除个人视觉 Key');
      await refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '清除失败');
    } finally {
      setSavingPersonal(false);
    }
  };

  const updateSharedDraft: SharedAIFieldsProps['onChange'] = (field, value) => {
    if (field === 'deepseekKey') setSharedDeepseekInput(value);
    else if (field === 'visionKey') setSharedVisionInput(value);
    else if (field === 'visionUrl') setSharedVisionUrl(value);
    else if (field === 'visionModel') setSharedVisionModel(value);
    else if (field === 'profileInterval') setProfileInterval(value);
    else setProfileDailyLimit(value);
  };

  const saveShared = async () => {
    setSavingShared(true);
    setError('');
    try {
      const intervalMinutes = Number(profileInterval);
      const dailyLimit = Number(profileDailyLimit);
      if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 1440) {
        setError('画像提炼间隔需为 1–1440 的整数（分钟）');
        return;
      }
      if (!Number.isInteger(dailyLimit) || dailyLimit < 0 || dailyLimit > 1000) {
        setError('每日提炼上限需为 0–1000 的整数（0 表示不限）');
        return;
      }

      const body: Record<string, string | number | boolean> = { sharedFallbackEnabled };
      if (sharedDeepseekInput.trim()) body.deepseekApiKey = sharedDeepseekInput.trim();
      if (sharedVisionInput.trim()) body.visionApiKey = sharedVisionInput.trim();
      // 只要和服务端现值不同就提交，避免改完又收起高级设置导致静默丢弃
      if (sharedVisionUrl.trim() !== (adminSettings?.visionApiUrl ?? '')) {
        body.visionApiUrl = sharedVisionUrl.trim();
      }
      if (sharedVisionModel.trim() !== (adminSettings?.visionModel ?? '')) {
        body.visionModel = sharedVisionModel.trim();
      }
      if (intervalMinutes !== (adminSettings?.profileRefineIntervalMinutes ?? 10)) {
        body.profileRefineIntervalMinutes = intervalMinutes;
      }
      if (dailyLimit !== (adminSettings?.profileRefineDailyLimit ?? 0)) {
        body.profileRefineDailyLimit = dailyLimit;
      }
      await apiPut('/api/admin/settings', body);
      setSharedDeepseekInput('');
      setSharedVisionInput('');
      setToast('已保存，立即生效');
      await load(true);
      // 兜底开关变化也会影响当前管理员自己的生效来源
      await refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '保存失败');
    } finally {
      setSavingShared(false);
    }
  };

  if (!personalSettings && !error) {
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
          同一账户下的所有学生共用这些 Key。对话、错题提取、自学处理和学习画像可能消耗 DeepSeek 额度。
        </p>
        <div className="key-row">
          <div className="key-row-head">
            <strong>DeepSeek API Key</strong>
            {personalSettings && sourceBadge(personalSettings.effective.deepseekSource)}
            {personalSettings?.personal.deepseekKeySet && (
              <span className="badge">个人 Key（尾号 {personalSettings.personal.deepseekKeyTail || '****'}）</span>
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
            disabled={savingPersonal}
          />
          {personalSettings?.personal.deepseekKeySet && (
            <button
              className="btn btn-danger-ghost"
              disabled={savingPersonal}
              onClick={() => void clearPersonalKey('deepseek')}
            >
              清除个人 DeepSeek Key
            </button>
          )}
        </div>
        <div className="key-row">
          <div className="key-row-head">
            <strong>图片识别服务</strong>
            {personalSettings && sourceBadge(personalSettings.effective.visionSource)}
            {personalSettings?.personal.visionKeySet && (
              <span className="badge">个人 Key（尾号 {personalSettings.personal.visionKeyTail || '****'}）</span>
            )}
          </div>
          <p className="form-hint">配置后聊天输入框出现相机按钮；仅支持智谱与阿里云百炼两种服务。</p>
          <input
            type="password"
            value={visionInput}
            onChange={(event) => setVisionInput(event.target.value)}
            placeholder="视觉服务 Key（留空表示不修改）"
            autoComplete="off"
            disabled={savingPersonal}
          />
          <select
            value={visionProvider}
            onChange={(event) => setVisionProvider(event.target.value as 'zhipu' | 'dashscope')}
            disabled={savingPersonal}
          >
            <option value="zhipu">智谱</option>
            <option value="dashscope">阿里云百炼</option>
          </select>
          <input
            value={visionModel}
            onChange={(event) => setVisionModel(event.target.value)}
            placeholder={visionProvider === 'zhipu' ? 'glm-4.1v-thinking-flash' : 'qwen-vl-plus'}
            disabled={savingPersonal}
          />
          {personalSettings?.personal.visionKeySet && (
            <button
              className="btn btn-danger-ghost"
              disabled={savingPersonal}
              onClick={() => void clearPersonalKey('vision')}
            >
              清除个人视觉 Key
            </button>
          )}
        </div>
        <div className="settings-actions">
          <button className="btn btn-primary" disabled={savingPersonal} onClick={() => void savePersonal()}>
            {savingPersonal ? '保存中…' : '保存我的配置'}
          </button>
        </div>
      </section>

      {isAdmin && (
        <section className="card settings-card" aria-labelledby="shared-ai-title">
          <h2 id="shared-ai-title" className="section-title">站点共享 AI 服务</h2>
          <p className="form-hint">仅在开启共享兜底且用户没有相应个人 Key 时使用。</p>
          <SharedAIFields
            settings={adminSettings}
            deepseekKey={sharedDeepseekInput}
            visionKey={sharedVisionInput}
            visionUrl={sharedVisionUrl}
            visionModel={sharedVisionModel}
            profileInterval={profileInterval}
            profileDailyLimit={profileDailyLimit}
            disabled={savingShared}
            onChange={updateSharedDraft}
          />
          <label className="settings-toggle-row">
            <input
              type="checkbox"
              checked={sharedFallbackEnabled}
              onChange={(event) => setSharedFallbackEnabled(event.target.checked)}
              disabled={savingShared}
            />
            允许未配置个人 Key 的用户使用站点共享服务
          </label>
          <div className="settings-actions">
            <button className="btn btn-primary" disabled={savingShared} onClick={() => void saveShared()}>
              {savingShared ? '保存中…' : '保存站点配置'}
            </button>
          </div>
        </section>
      )}

      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}

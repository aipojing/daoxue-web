import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet, apiPut, ApiError } from '../api';
import { useAuth } from '../AuthContext';
import { buildSharedAISettingsPatch } from '../lib/ai-settings';
import type { AdminSettings } from '../types';

function keySetBadge(set: boolean, tail: string, fromEnv: boolean): JSX.Element | null {
  if (!set) return null;
  if (fromEnv) return <span className="badge badge-success">已配置（环境变量）</span>;
  return <span className="badge badge-success">已配置（尾号 {tail || '****'}）</span>;
}

export default function SharedAISettingsCard() {
  const { refresh } = useAuth();
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [deepseekInput, setDeepseekInput] = useState('');
  const [visionInput, setVisionInput] = useState('');
  const [visionApiUrl, setVisionApiUrl] = useState('');
  const [visionModel, setVisionModel] = useState('');
  const [sharedFallbackEnabled, setSharedFallbackEnabled] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const loadGenerationRef = useRef(0);

  const load = useCallback(async (syncInputs = false) => {
    const generation = ++loadGenerationRef.current;
    try {
      const loaded = await apiGet<AdminSettings>('/api/admin/settings');
      if (generation !== loadGenerationRef.current) return;
      setError('');
      setSettings(loaded);
      setSharedFallbackEnabled(loaded.sharedFallbackEnabled);
      if (syncInputs) {
        setVisionApiUrl(loaded.visionApiUrl);
        setVisionModel(loaded.visionModel);
      }
    } catch (e) {
      if (generation !== loadGenerationRef.current) return;
      setError(e instanceof ApiError ? e.message : '站点共享 AI 配置加载失败');
    }
  }, []);

  useEffect(() => {
    void load(true);
  }, [load]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 2500);
    return () => clearTimeout(timer);
  }, [toast]);

  const save = async () => {
    if (!settings || saving) return;
    setSaving(true);
    setError('');
    try {
      await apiPut(
        '/api/admin/settings',
        buildSharedAISettingsPatch({
          deepseekInput,
          visionInput,
          visionApiUrl,
          visionModel,
          sharedFallbackEnabled,
        }),
      );
      setDeepseekInput('');
      setVisionInput('');
      setToast('站点共享 AI 配置已保存');
      await load(true);
      await refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '站点共享 AI 配置保存失败');
    } finally {
      setSaving(false);
    }
  };

  const disabled = saving || !settings;

  return (
    <section className="card settings-card" aria-labelledby="shared-ai-title">
      <h2 id="shared-ai-title" className="section-title">站点共享 AI 服务</h2>
      <p className="form-hint">仅在开启共享兜底且用户没有相应个人 Key 时使用；本区域仅管理员可见。</p>
      {error && <div className="form-error">{error}</div>}

      <div className="key-row">
        <div className="key-row-head">
          <strong>共享 DeepSeek API Key</strong>（驱动对话与文本处理）
          {settings && keySetBadge(settings.deepseekKeySet, settings.deepseekKeyTail, settings.deepseekFromEnv)}
        </div>
        <p className="form-hint">
          在 <a href="https://platform.deepseek.com" target="_blank" rel="noreferrer">platform.deepseek.com</a> 创建。
          粘贴新 Key 保存即覆盖；留空表示不修改，保存后不回显。
        </p>
        <input
          type="password"
          value={deepseekInput}
          onChange={(event) => setDeepseekInput(event.target.value)}
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
          默认接智谱 GLM-4.1V-Thinking-Flash；也可在高级设置中接入 OpenAI 兼容视觉服务。
        </p>
        <input
          type="password"
          value={visionInput}
          onChange={(event) => setVisionInput(event.target.value)}
          placeholder="视觉服务 Key（留空表示不修改）"
          autoComplete="off"
          disabled={disabled}
        />
        <button
          type="button"
          className="btn-link"
          aria-expanded={advancedOpen}
          onClick={() => setAdvancedOpen((open) => !open)}
          disabled={disabled}
        >
          {advancedOpen ? '收起高级设置 ▲' : '高级：换其他视觉服务（如通义 qwen-vl）▼'}
        </button>
        {advancedOpen && (
          <div className="key-advanced">
            <input
              value={visionApiUrl}
              onChange={(event) => setVisionApiUrl(event.target.value)}
              placeholder="接口地址（OpenAI 兼容），留空用智谱默认"
              disabled={disabled}
            />
            <input
              value={visionModel}
              onChange={(event) => setVisionModel(event.target.value)}
              placeholder="模型名，如 qwen-vl-plus，留空用默认模型"
              disabled={disabled}
            />
          </div>
        )}
      </div>

      <label className="settings-toggle-row">
        <input
          type="checkbox"
          checked={sharedFallbackEnabled}
          onChange={(event) => setSharedFallbackEnabled(event.target.checked)}
          disabled={disabled}
        />
        允许未配置个人 Key 的用户使用站点共享服务
      </label>
      <div className="settings-actions">
        <button type="button" className="btn btn-primary" disabled={disabled} onClick={() => void save()}>
          {saving ? '保存中…' : '保存站点共享配置'}
        </button>
      </div>
      {toast && <div className="toast" role="status">{toast}</div>}
    </section>
  );
}

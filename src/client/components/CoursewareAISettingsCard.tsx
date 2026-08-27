import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiGet, apiPut, ApiError } from '../api';
import {
  buildCredentialPatch,
  buildCoursewarePreferences,
  modelsForPurpose,
  voicesForModel,
  type CoursewareSelectionDraft,
} from '../lib/courseware-ai-settings';
import type {
  AIModelOption,
  AIProviderCatalogItem,
  CoursewareAISettings,
  CoursewareModelPurpose,
} from '../types';

type TestKind = 'text' | 'teacher_tts' | 'student_tts' | 'image';

const EMPTY_SELECTION: CoursewareSelectionDraft = {
  endpointId: 0,
  modelCatalogId: null,
  customModelId: '',
  voiceId: '',
  params: {},
};

function healthLabel(status: CoursewareAISettings['providers'][number]['healthStatus']): string {
  return {
    unknown: '待首次验证',
    valid: '连接正常',
    invalid: '密钥无效',
    quota_exhausted: '套餐额度已用完',
  }[status];
}

function normalTestError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 429) return '测试次数较多，请稍后再试';
    if (error.status === 401) return '请先保存完整的 API Key，再重新测试';
    if (error.status === 402) return '套餐额度已用完，请更换 API Key 后重新测试';
    if (error.status === 422) return '请检查模型和音色设置后再测试';
    return error.message || '测试暂时无法完成，请稍后重试';
  }
  return '测试暂时无法完成，请检查网络后重试';
}

async function binaryTest(path: string, body: Record<string, unknown>): Promise<Blob | null> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError('网络连接失败，请检查网络', 0);
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    throw new ApiError(payload?.error ?? '测试请求失败', response.status);
  }
  if (path.endsWith('/text')) return null;
  return response.blob();
}

function selectionFor(
  preferences: CoursewareAISettings['preferences'],
  purpose: CoursewareModelPurpose,
  models: AIModelOption[],
): CoursewareSelectionDraft {
  const saved = preferences.find((item) => item.purpose === purpose);
  if (saved) return { ...saved, params: saved.params ?? {} };
  const recommended = models.find((model) => model.recommended) ?? models[0];
  return recommended
    ? { ...EMPTY_SELECTION, endpointId: recommended.endpointId, modelCatalogId: recommended.id }
    : EMPTY_SELECTION;
}

function providerForModel(catalog: AIProviderCatalogItem[], modelId: number | null): AIProviderCatalogItem | null {
  if (modelId === null) return null;
  return catalog.find((provider) => provider.models.some((model) => model.id === modelId)) ?? null;
}

interface ModelFieldProps {
  id: string;
  label: string;
  purpose: CoursewareModelPurpose;
  catalog: AIProviderCatalogItem[];
  selection: CoursewareSelectionDraft;
  disabled: boolean;
  onChange: (selection: CoursewareSelectionDraft) => void;
  showVoice?: boolean;
}

function ModelField({
  id,
  label,
  purpose,
  catalog,
  selection,
  disabled,
  onChange,
  showVoice = false,
}: ModelFieldProps) {
  const models = modelsForPurpose(catalog, purpose);
  const currentModel = models.find((model) => model.id === selection.modelCatalogId)
    ?? (purpose === 'courseware_text' && selection.modelCatalogId === null
      ? models.find((model) => model.endpointId === selection.endpointId && model.allowCustomModelId) ?? null
      : null);
  const voices = selection.modelCatalogId === null ? [] : voicesForModel(catalog, selection.modelCatalogId);
  const provider = providerForModel(catalog, currentModel?.id ?? null);
  const modelId = `${id}-model`;
  const voiceId = `${id}-voice`;

  const chooseModel = (raw: string) => {
    if (raw === 'custom') {
      if (!currentModel?.allowCustomModelId) return;
      onChange({ ...selection, endpointId: currentModel.endpointId, modelCatalogId: null, voiceId: '' });
      return;
    }
    const model = models.find((item) => item.id === Number(raw));
    if (!model) return;
    const nextVoices = model.voices;
    onChange({
      ...selection,
      endpointId: model.endpointId,
      modelCatalogId: model.id,
      customModelId: '',
      voiceId: showVoice && !nextVoices.some((voice) => voice.id === selection.voiceId)
        ? (nextVoices[0]?.id ?? '')
        : selection.voiceId,
    });
  };

  return (
    <div className="courseware-field">
      <label htmlFor={modelId}>{label}</label>
      <select id={modelId} value={selection.modelCatalogId === null ? (currentModel ? 'custom' : '') : selection.modelCatalogId} onChange={(event) => chooseModel(event.target.value)} disabled={disabled || models.length === 0}>
        {models.length === 0 && <option value="">当前没有可用模型</option>}
        {purpose === 'courseware_text' && currentModel?.allowCustomModelId && <option value="custom">当前端点的自定义模型</option>}
        {models.map((model) => {
          const owner = providerForModel(catalog, model.id);
          return <option key={model.id} value={model.id}>{owner?.displayName} / {model.displayName}</option>;
        })}
      </select>
      {provider && <p className="form-hint">服务商：{provider.displayName}。保存设置后可测试当前选择。</p>}
      {purpose === 'courseware_text' && currentModel?.allowCustomModelId && (
        <div className="courseware-custom-model">
          <label htmlFor={`${id}-custom`}>自定义模型 ID</label>
          <input
            id={`${id}-custom`}
            value={selection.customModelId}
            onChange={(event) => onChange({ ...selection, modelCatalogId: null, customModelId: event.target.value, voiceId: '' })}
            placeholder="仅在需要时填写"
            autoComplete="off"
            disabled={disabled}
          />
          <p className="form-hint">仅当前服务商公开支持自定义模型时可填写。</p>
        </div>
      )}
      {showVoice && (
        <>
          <label htmlFor={voiceId}>音色</label>
          <select id={voiceId} value={selection.voiceId} onChange={(event) => onChange({ ...selection, voiceId: event.target.value })} disabled={disabled || voices.length === 0}>
            {voices.length === 0 && <option value="">当前模型没有可用音色</option>}
            {voices.map((voice) => <option key={voice.id} value={voice.id}>{voice.name}</option>)}
          </select>
          <p className="form-hint">音色会随当前语音模型的目录自动更新。</p>
        </>
      )}
    </div>
  );
}

export default function CoursewareAISettingsCard() {
  const [catalog, setCatalog] = useState<AIProviderCatalogItem[]>([]);
  const [settings, setSettings] = useState<CoursewareAISettings | null>(null);
  const [text, setText] = useState<CoursewareSelectionDraft>(EMPTY_SELECTION);
  const [image, setImage] = useState<CoursewareSelectionDraft>(EMPTY_SELECTION);
  const [teacherSpeech, setTeacherSpeech] = useState<CoursewareSelectionDraft>(EMPTY_SELECTION);
  const [studentSpeech, setStudentSpeech] = useState<CoursewareSelectionDraft>(EMPTY_SELECTION);
  const [includeImages, setIncludeImages] = useState(false);
  const [credentialInput, setCredentialInput] = useState<Record<number, string>>({});
  const [pendingProviderId, setPendingProviderId] = useState<number | null>(null);
  const [savingPreferences, setSavingPreferences] = useState(false);
  const [testing, setTesting] = useState<Set<TestKind>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState('');
  const [audioUrl, setAudioUrl] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const audioUrlRef = useRef('');
  const imageUrlRef = useRef('');

  const applyLoaded = useCallback((loadedCatalog: AIProviderCatalogItem[], loadedSettings: CoursewareAISettings) => {
    setCatalog(loadedCatalog);
    setSettings(loadedSettings);
    setText(selectionFor(loadedSettings.preferences, 'courseware_text', modelsForPurpose(loadedCatalog, 'courseware_text')));
    setImage(selectionFor(loadedSettings.preferences, 'courseware_image', modelsForPurpose(loadedCatalog, 'courseware_image')));
    setTeacherSpeech(selectionFor(loadedSettings.preferences, 'teacher_tts', modelsForPurpose(loadedCatalog, 'teacher_tts')));
    setStudentSpeech(selectionFor(loadedSettings.preferences, 'student_tts', modelsForPurpose(loadedCatalog, 'student_tts')));
    setIncludeImages(loadedSettings.readiness.image !== 'disabled');
  }, []);

  const load = useCallback(async () => {
    try {
      const [loadedCatalog, loadedSettings] = await Promise.all([
        apiGet<AIProviderCatalogItem[]>('/api/ai-catalog'),
        apiGet<CoursewareAISettings>('/api/courseware-ai-settings'),
      ]);
      applyLoaded(loadedCatalog, loadedSettings);
      setErrors({});
    } catch (error) {
      setErrors({ load: error instanceof ApiError ? error.message : '语音课件设置加载失败，请刷新后重试' });
    }
  }, [applyLoaded]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => () => {
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
  }, []);

  const readinessNotice = useMemo(() => {
    if (!settings) return '';
    const statuses = Object.values(settings.readiness);
    if (statuses.includes('quota_exhausted')) return '套餐额度已用完，无法生成新的语音课件。可替换 Key 并重新测试，已保存课件仍可播放。';
    if (statuses.includes('invalid_credential')) return '有密钥需要更新，新的语音课件暂不可生成。可替换 Key 并重新测试。';
    if (statuses.includes('unconfigured')) return '请完成脚本和两种语音的模型、音色及密钥设置后生成语音课件。';
    return '';
  }, [settings]);

  const saveCredential = async (providerId: number, clear = false) => {
    if (pendingProviderId !== null) return;
    setErrors((current) => ({ ...current, [`credential-${providerId}`]: '' }));
    let body: { apiKey: string | null };
    try {
      body = buildCredentialPatch(clear ? null : (credentialInput[providerId] ?? ''));
    } catch (error) {
      setErrors((current) => ({ ...current, [`credential-${providerId}`]: error instanceof Error ? error.message : '请输入完整的 API Key' }));
      return;
    }
    setPendingProviderId(providerId);
    try {
      const saved = await apiPut<CoursewareAISettings>(`/api/courseware-ai-settings/credentials/${providerId}`, body);
      setSettings(saved);
      setCredentialInput((current) => ({ ...current, [providerId]: '' }));
      setNotice(clear ? '个人 API Key 已清除。' : '个人 API Key 已保存，可继续测试连接。');
    } catch (error) {
      setErrors((current) => ({ ...current, [`credential-${providerId}`]: error instanceof ApiError ? error.message : '保存 Key 失败，请稍后重试' }));
    } finally {
      setPendingProviderId(null);
    }
  };

  const savePreferences = async () => {
    if (savingPreferences) return;
    setErrors((current) => ({ ...current, preferences: '' }));
    let body: ReturnType<typeof buildCoursewarePreferences>;
    try {
      body = buildCoursewarePreferences({ catalog, includeImages, text, image, teacherSpeech, studentSpeech });
    } catch (error) {
      setErrors((current) => ({ ...current, preferences: error instanceof Error ? error.message : '请检查模型设置' }));
      return;
    }
    setSavingPreferences(true);
    try {
      const saved = await apiPut<CoursewareAISettings>('/api/courseware-ai-settings/preferences', body);
      setSettings(saved);
      setNotice('课件模型和音色已保存。');
    } catch (error) {
      setErrors((current) => ({ ...current, preferences: error instanceof ApiError ? error.message : '模型设置保存失败，请稍后重试' }));
    } finally {
      setSavingPreferences(false);
    }
  };

  const replaceBlobUrl = (kind: 'audio' | 'image', blob: Blob) => {
    const next = URL.createObjectURL(blob);
    if (kind === 'audio') {
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = next;
      setAudioUrl(next);
    } else {
      if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
      imageUrlRef.current = next;
      setImageUrl(next);
    }
  };

  const runTest = async (kind: TestKind) => {
    if (testing.has(kind)) return;
    const errorKey = `test-${kind}`;
    setErrors((current) => ({ ...current, [errorKey]: '' }));
    setTesting((current) => new Set(current).add(kind));
    try {
      const path = kind === 'text'
        ? '/api/courseware-ai-settings/test/text'
        : kind === 'image'
          ? '/api/courseware-ai-settings/test/image'
          : '/api/courseware-ai-settings/test/speech';
      const blob = await binaryTest(path, kind === 'teacher_tts' || kind === 'student_tts' ? { purpose: kind } : {});
      if (blob) replaceBlobUrl(kind === 'image' ? 'image' : 'audio', blob);
      setNotice(kind === 'text' ? '文本连接正常。' : kind === 'image' ? '图片测试完成。' : '试听已准备好。');
      const refreshed = await apiGet<CoursewareAISettings>('/api/courseware-ai-settings');
      setSettings(refreshed);
    } catch (error) {
      setErrors((current) => ({ ...current, [errorKey]: normalTestError(error) }));
    } finally {
      setTesting((current) => {
        const next = new Set(current);
        next.delete(kind);
        return next;
      });
    }
  };

  if (!settings && !errors.load) {
    return <div className="courseware-settings-loading" aria-live="polite">正在加载模型目录和个人设置…</div>;
  }
  if (errors.load) {
    return <div className="form-error" role="alert">{errors.load} <button type="button" className="btn-link" onClick={() => void load()}>重新加载</button></div>;
  }

  return (
    <div className="courseware-settings" aria-busy={!settings}>
      {readinessNotice && <div className="courseware-readiness" role="status">{readinessNotice}</div>}
      {notice && <div className="courseware-notice" role="status">{notice}</div>}

      <section className="courseware-settings-section" aria-labelledby="courseware-credential-title">
        <h3 id="courseware-credential-title">服务商密钥</h3>
        <p className="form-hint">Key 仅属于当前家长账户，保存后不会回显。替换 Key 后可立即测试连接。</p>
        {catalog.map((provider) => {
          const credential = settings?.providers.find((item) => item.providerId === provider.id);
          const isPending = pendingProviderId === provider.id;
          return (
            <div className="courseware-credential" key={provider.id}>
              <div className="courseware-credential-head">
                <strong>{provider.displayName}</strong>
                {credential?.keySet && <span className="badge">已设置，尾号 {credential.keyTail || '****'}</span>}
                {credential && <span className={`badge ${credential.healthStatus === 'valid' ? 'badge-success' : credential.healthStatus === 'unknown' ? '' : 'badge-danger'}`}>{healthLabel(credential.healthStatus)}</span>}
              </div>
              <label htmlFor={`provider-key-${provider.id}`}>个人 API Key</label>
              <input
                id={`provider-key-${provider.id}`}
                type="password"
                value={credentialInput[provider.id] ?? ''}
                onChange={(event) => setCredentialInput((current) => ({ ...current, [provider.id]: event.target.value }))}
                placeholder={credential?.keySet ? '输入新 Key 以替换' : '输入完整 API Key'}
                autoComplete="new-password"
                disabled={isPending}
              />
              <div className="courseware-action-row">
                <button type="button" className="btn btn-primary" disabled={isPending} onClick={() => void saveCredential(provider.id)}>{isPending ? '保存中…' : credential?.keySet ? '替换 Key' : '保存 Key'}</button>
                {credential?.keySet && <button type="button" className="btn btn-danger-ghost" disabled={isPending} onClick={() => void saveCredential(provider.id, true)}>清除 Key</button>}
              </div>
              {errors[`credential-${provider.id}`] && <p className="field-error" role="alert">{errors[`credential-${provider.id}`]}</p>}
            </div>
          );
        })}
        {catalog.length === 0 && <p className="form-hint">当前没有可用服务商，请稍后重试。</p>}
      </section>

      <section className="courseware-settings-section" aria-labelledby="courseware-text-title">
        <h3 id="courseware-text-title">课件脚本模型</h3>
        <ModelField id="courseware-text" label="文本模型" purpose="courseware_text" catalog={catalog} selection={text} onChange={setText} disabled={savingPreferences} />
        <div className="courseware-action-row">
          <button type="button" className="btn btn-secondary" disabled={testing.has('text')} onClick={() => void runTest('text')}>{testing.has('text') ? '测试中…' : '测试连接'}</button>
        </div>
        {errors['test-text'] && <p className="field-error" role="alert">{errors['test-text']}</p>}
      </section>

      <section className="courseware-settings-section" aria-labelledby="teacher-voice-title">
        <h3 id="teacher-voice-title">老师语音</h3>
        <ModelField id="teacher-voice" label="语音模型" purpose="teacher_tts" catalog={catalog} selection={teacherSpeech} onChange={setTeacherSpeech} disabled={savingPreferences} showVoice />
        <div className="courseware-action-row">
          <button type="button" className="btn btn-secondary" disabled={testing.has('teacher_tts')} onClick={() => void runTest('teacher_tts')}>{testing.has('teacher_tts') ? '准备中…' : '试听'}</button>
        </div>
        {errors['test-teacher_tts'] && <p className="field-error" role="alert">{errors['test-teacher_tts']}</p>}
      </section>

      <section className="courseware-settings-section" aria-labelledby="student-voice-title">
        <h3 id="student-voice-title">AI 同学语音</h3>
        <ModelField id="student-voice" label="语音模型" purpose="student_tts" catalog={catalog} selection={studentSpeech} onChange={setStudentSpeech} disabled={savingPreferences} showVoice />
        <div className="courseware-action-row">
          <button type="button" className="btn btn-secondary" disabled={testing.has('student_tts')} onClick={() => void runTest('student_tts')}>{testing.has('student_tts') ? '准备中…' : '试听'}</button>
        </div>
        {errors['test-student_tts'] && <p className="field-error" role="alert">{errors['test-student_tts']}</p>}
      </section>

      <section className="courseware-settings-section" aria-labelledby="courseware-image-title">
        <h3 id="courseware-image-title">配图模型（可选）</h3>
        <label className="settings-toggle-row" htmlFor="courseware-images-enabled">
          <input id="courseware-images-enabled" type="checkbox" checked={includeImages} onChange={(event) => setIncludeImages(event.target.checked)} disabled={savingPreferences} />
          <span><strong>生成配图</strong><small>关闭后不影响脚本和语音课件生成。</small></span>
        </label>
        {includeImages && <>
          <ModelField id="courseware-image" label="图片模型" purpose="courseware_image" catalog={catalog} selection={image} onChange={setImage} disabled={savingPreferences} />
          <div className="courseware-action-row">
            <button type="button" className="btn btn-secondary" disabled={testing.has('image')} onClick={() => void runTest('image')}>{testing.has('image') ? '生成中…' : '测试图片'}</button>
          </div>
          {errors['test-image'] && <p className="field-error" role="alert">{errors['test-image']}</p>}
        </>}
      </section>

      {audioUrl && <section className="courseware-preview" aria-labelledby="courseware-audio-preview"><h3 id="courseware-audio-preview">语音试听</h3><audio controls src={audioUrl}>当前浏览器不支持音频试听。</audio></section>}
      {imageUrl && <section className="courseware-preview" aria-labelledby="courseware-image-preview"><h3 id="courseware-image-preview">图片预览</h3><img src={imageUrl} alt="测试生成的课件配图预览" /></section>}

      <div className="courseware-save-row">
        <button type="button" className="btn btn-primary" disabled={savingPreferences} onClick={() => void savePreferences()}>{savingPreferences ? '保存中…' : '保存课件设置'}</button>
        {errors.preferences && <p className="field-error" role="alert">{errors.preferences}</p>}
      </div>
    </div>
  );
}

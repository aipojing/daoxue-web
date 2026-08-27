import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiGet, apiPut, ApiError } from '../api';
import {
  buildCredentialPatch,
  buildCoursewarePreferences,
  applyCurrentRequestResult,
  CoursewareRequestGuard,
  CoursewareSettingsRevision,
  CoursewareSettingsWriteTracker,
  mergeCredentialSettings,
  mergePreferenceSettings,
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

async function binaryTest(
  path: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Blob | null> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'same-origin',
      signal,
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
  error?: string;
  errorId?: string;
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
  error = '',
  errorId,
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
      <select id={modelId} value={selection.modelCatalogId === null ? (currentModel ? 'custom' : '') : selection.modelCatalogId} onChange={(event) => chooseModel(event.target.value)} disabled={disabled || models.length === 0} aria-invalid={error ? true : undefined} aria-describedby={error ? errorId : undefined}>
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
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
          />
          <p className="form-hint">仅当前服务商公开支持自定义模型时可填写。</p>
        </div>
      )}
      {showVoice && (
        <>
          <label htmlFor={voiceId}>音色</label>
          <select id={voiceId} value={selection.voiceId} onChange={(event) => onChange({ ...selection, voiceId: event.target.value })} disabled={disabled || voices.length === 0} aria-invalid={error ? true : undefined} aria-describedby={error ? errorId : undefined}>
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
  const [pendingProviderIds, setPendingProviderIds] = useState<Set<number>>(new Set());
  const [savingPreferences, setSavingPreferences] = useState(false);
  const [testing, setTesting] = useState<Set<TestKind>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState('');
  const [syncError, setSyncError] = useState('');
  const [credentialNotices, setCredentialNotices] = useState<Record<number, string>>({});
  const [audioUrls, setAudioUrls] = useState<Record<'teacher_tts' | 'student_tts', string>>({
    teacher_tts: '',
    student_tts: '',
  });
  const [imageUrl, setImageUrl] = useState('');
  const pendingProviderIdsRef = useRef(new Set<number>());
  const pendingTestsRef = useRef(new Set<TestKind>());
  const requestGuardRef = useRef(new CoursewareRequestGuard());
  const settingsRevisionRef = useRef(new CoursewareSettingsRevision());
  const settingsWritesRef = useRef(new CoursewareSettingsWriteTracker());
  const requestControllersRef = useRef(new Set<AbortController>());
  const audioUrlRefs = useRef<Partial<Record<'teacher_tts' | 'student_tts', string>>>({});
  const imageUrlRef = useRef('');

  const beginRequest = () => {
    const controller = new AbortController();
    requestControllersRef.current.add(controller);
    return controller;
  };

  const finishRequest = (controller: AbortController) => {
    requestControllersRef.current.delete(controller);
  };

  const isAbort = (error: unknown, controller: AbortController) =>
    controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError');

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
    const scope = 'load';
    const token = requestGuardRef.current.begin(scope);
    const settingsRevision = settingsRevisionRef.current.captureRefresh();
    const controller = beginRequest();
    try {
      const [loadedCatalog, loadedSettings] = await Promise.all([
        apiGet<AIProviderCatalogItem[]>('/api/ai-catalog', { signal: controller.signal }),
        apiGet<CoursewareAISettings>('/api/courseware-ai-settings', { signal: controller.signal }),
      ]);
      if (
        !requestGuardRef.current.isCurrent(scope, token) ||
        !settingsRevisionRef.current.isRefreshCurrent(settingsRevision)
      ) return;
      applyLoaded(loadedCatalog, loadedSettings);
      setErrors({});
    } catch (error) {
      if (
        !requestGuardRef.current.isCurrent(scope, token) ||
        !settingsRevisionRef.current.isRefreshCurrent(settingsRevision) ||
        isAbort(error, controller)
      ) return;
      setErrors({ load: error instanceof ApiError ? error.message : '语音课件设置加载失败，请刷新后重试' });
    } finally {
      finishRequest(controller);
    }
  }, [applyLoaded]);

  useEffect(() => {
    requestGuardRef.current = new CoursewareRequestGuard();
    settingsRevisionRef.current = new CoursewareSettingsRevision();
    settingsWritesRef.current = new CoursewareSettingsWriteTracker();
    return () => {
      requestGuardRef.current.dispose();
      for (const controller of requestControllersRef.current) controller.abort();
      requestControllersRef.current.clear();
      for (const url of Object.values(audioUrlRefs.current)) {
        if (url) URL.revokeObjectURL(url);
      }
      audioUrlRefs.current = {};
      if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
      imageUrlRef.current = '';
    };
  }, []);

  useEffect(() => { void load(); }, [load]);

  const readinessNotice = useMemo(() => {
    if (!settings) return '';
    const statuses = Object.values(settings.readiness);
    if (statuses.includes('quota_exhausted')) return '套餐额度已用完，无法生成新的语音课件。可替换 Key 并重新测试，已保存课件仍可播放。';
    if (statuses.includes('invalid_credential')) return '有密钥需要更新，新的语音课件暂不可生成。可替换 Key 并重新测试。';
    if (statuses.includes('unconfigured')) return '请完成脚本和两种语音的模型、音色及密钥设置后生成语音课件。';
    return '';
  }, [settings]);

  const refreshSettings = async (errorKey: string, authoritative = false) => {
    if (authoritative && settingsWritesRef.current.hasPending()) return;
    const scope = authoritative ? 'settings-authority-refresh' : 'settings-refresh';
    const token = requestGuardRef.current.begin(scope);
    const settingsRevision = settingsRevisionRef.current.captureRefresh();
    const controller = beginRequest();
    try {
      const refreshed = await apiGet<CoursewareAISettings>(
        '/api/courseware-ai-settings',
        { signal: controller.signal },
      );
      if (
        requestGuardRef.current.isCurrent(scope, token) &&
        settingsRevisionRef.current.isRefreshCurrent(settingsRevision)
      ) {
        setSettings(refreshed);
        if (authoritative) setSyncError('');
      }
    } catch (error) {
      if (
        !isAbort(error, controller) &&
        requestGuardRef.current.isCurrent(scope, token) &&
        settingsRevisionRef.current.isRefreshCurrent(settingsRevision)
      ) {
        if (authoritative) {
          setSyncError('设置已保存，但状态同步失败。请重新同步后再确认可用状态。');
        } else {
          setErrors((current) => ({ ...current, [errorKey]: '连接已验证，但状态刷新失败，请稍后重试' }));
        }
      }
    } finally {
      finishRequest(controller);
    }
  };

  const settleSettingsWrite = (writeId: number, succeeded: boolean) => {
    if (settingsWritesRef.current.settle(writeId, succeeded)) {
      void refreshSettings('sync', true);
    }
  };

  const saveCredential = async (providerId: number, clear = false) => {
    if (pendingProviderIdsRef.current.has(providerId)) return;
    let body: { apiKey: string | null };
    try {
      body = buildCredentialPatch(clear ? null : (credentialInput[providerId] ?? ''));
    } catch (error) {
      setErrors((current) => ({ ...current, [`credential-${providerId}`]: error instanceof Error ? error.message : '请输入完整的 API Key' }));
      return;
    }
    const scope = `credential-${providerId}`;
    const token = requestGuardRef.current.begin(scope);
    const settingsWriteRevision = settingsRevisionRef.current.beginWrite();
    const writeId = settingsWritesRef.current.begin();
    requestGuardRef.current.invalidate('load');
    requestGuardRef.current.invalidate('settings-refresh');
    pendingProviderIdsRef.current.add(providerId);
    setPendingProviderIds((current) => new Set(current).add(providerId));
    setErrors((current) => ({ ...current, [`credential-${providerId}`]: '' }));
    setCredentialNotices((current) => ({ ...current, [providerId]: '' }));
    const controller = beginRequest();
    let succeeded = false;
    try {
      const saved = await apiPut<CoursewareAISettings>(
        `/api/courseware-ai-settings/credentials/${providerId}`,
        body,
        { signal: controller.signal },
      );
      if (!requestGuardRef.current.isCurrent(scope, token)) return;
      succeeded = true;
      settingsRevisionRef.current.commitWrite(settingsWriteRevision);
      setSettings((current) => current ? mergeCredentialSettings(current, saved, providerId) : saved);
      setCredentialInput((current) => ({ ...current, [providerId]: '' }));
      setCredentialNotices((current) => ({
        ...current,
        [providerId]: clear ? '个人 API Key 已清除。' : '个人 API Key 已保存，可继续测试连接。',
      }));
    } catch (error) {
      if (!requestGuardRef.current.isCurrent(scope, token) || isAbort(error, controller)) return;
      setErrors((current) => ({ ...current, [`credential-${providerId}`]: error instanceof ApiError ? error.message : '保存 Key 失败，请稍后重试' }));
    } finally {
      finishRequest(controller);
      pendingProviderIdsRef.current.delete(providerId);
      if (requestGuardRef.current.isCurrent(scope, token)) {
        setPendingProviderIds((current) => {
          const next = new Set(current);
          next.delete(providerId);
          return next;
        });
        settleSettingsWrite(writeId, succeeded);
      }
    }
  };

  const savePreferences = async () => {
    if (savingPreferences) return;
    let body: ReturnType<typeof buildCoursewarePreferences>;
    try {
      body = buildCoursewarePreferences({ catalog, includeImages, text, image, teacherSpeech, studentSpeech });
    } catch (error) {
      setErrors((current) => ({ ...current, preferences: error instanceof Error ? error.message : '请检查模型设置' }));
      return;
    }
    const scope = 'preferences';
    const token = requestGuardRef.current.begin(scope);
    const settingsWriteRevision = settingsRevisionRef.current.beginWrite();
    const writeId = settingsWritesRef.current.begin();
    requestGuardRef.current.invalidate('load');
    requestGuardRef.current.invalidate('settings-refresh');
    setErrors((current) => ({ ...current, preferences: '' }));
    setSavingPreferences(true);
    const controller = beginRequest();
    let succeeded = false;
    try {
      const saved = await apiPut<CoursewareAISettings>(
        '/api/courseware-ai-settings/preferences',
        body,
        { signal: controller.signal },
      );
      if (!requestGuardRef.current.isCurrent(scope, token)) return;
      succeeded = true;
      settingsRevisionRef.current.commitWrite(settingsWriteRevision);
      setSettings((current) => current ? mergePreferenceSettings(current, saved) : saved);
      setNotice('课件模型和音色已保存。');
    } catch (error) {
      if (!requestGuardRef.current.isCurrent(scope, token) || isAbort(error, controller)) return;
      setErrors((current) => ({ ...current, preferences: error instanceof ApiError ? error.message : '模型设置保存失败，请稍后重试' }));
    } finally {
      finishRequest(controller);
      if (requestGuardRef.current.isCurrent(scope, token)) {
        setSavingPreferences(false);
        settleSettingsWrite(writeId, succeeded);
      }
    }
  };

  const replaceBlobUrl = (kind: 'teacher_tts' | 'student_tts' | 'image', blob: Blob) => {
    const next = URL.createObjectURL(blob);
    if (kind === 'teacher_tts' || kind === 'student_tts') {
      const previous = audioUrlRefs.current[kind];
      if (previous) URL.revokeObjectURL(previous);
      audioUrlRefs.current[kind] = next;
      setAudioUrls((current) => ({ ...current, [kind]: next }));
    } else {
      if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
      imageUrlRef.current = next;
      setImageUrl(next);
    }
  };

  const runTest = async (kind: TestKind) => {
    if (pendingTestsRef.current.has(kind)) return;
    const scope = `test-${kind}`;
    const token = requestGuardRef.current.begin(scope);
    pendingTestsRef.current.add(kind);
    const errorKey = `test-${kind}`;
    setErrors((current) => ({ ...current, [errorKey]: '' }));
    setTesting((current) => new Set(current).add(kind));
    const controller = beginRequest();
    try {
      const path = kind === 'text'
        ? '/api/courseware-ai-settings/test/text'
        : kind === 'image'
          ? '/api/courseware-ai-settings/test/image'
          : '/api/courseware-ai-settings/test/speech';
      const blob = await binaryTest(
        path,
        kind === 'teacher_tts' || kind === 'student_tts' ? { purpose: kind } : {},
        controller.signal,
      );
      if (!applyCurrentRequestResult(requestGuardRef.current, scope, token, () => {
        if (blob && kind !== 'text') replaceBlobUrl(kind, blob);
      })) return;
      setNotice(kind === 'text' ? '文本连接正常。' : kind === 'image' ? '图片测试完成。' : '试听已准备好。');
      await refreshSettings(errorKey);
    } catch (error) {
      if (!requestGuardRef.current.isCurrent(scope, token) || isAbort(error, controller)) return;
      setErrors((current) => ({ ...current, [errorKey]: normalTestError(error) }));
    } finally {
      finishRequest(controller);
      pendingTestsRef.current.delete(kind);
      if (requestGuardRef.current.isCurrent(scope, token)) {
        setTesting((current) => {
          const next = new Set(current);
          next.delete(kind);
          return next;
        });
      }
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
      {syncError && <div className="form-error" role="alert">{syncError} <button type="button" className="btn-link" onClick={() => void refreshSettings('sync', true)}>重新同步</button></div>}

      <section className="courseware-settings-section" aria-labelledby="courseware-credential-title">
        <h3 id="courseware-credential-title">服务商密钥</h3>
        <p className="form-hint">Key 仅属于当前家长账户，保存后不会回显。替换 Key 后可立即测试连接。</p>
        {catalog.map((provider) => {
          const credential = settings?.providers.find((item) => item.providerId === provider.id);
          const providerId = provider.id;
          const isPending = pendingProviderIds.has(providerId);
          const credentialError = errors[`credential-${providerId}`];
          const credentialErrorId = `credential-${providerId}-error`;
          return (
            <div className="courseware-credential" key={providerId}>
              <div className="courseware-credential-head">
                <strong>{provider.displayName}</strong>
                {credential?.keySet && <span className="badge">已设置，尾号 {credential.keyTail || '****'}</span>}
                {credential && <span className={`badge ${credential.healthStatus === 'valid' ? 'badge-success' : credential.healthStatus === 'unknown' ? '' : 'badge-danger'}`}>{healthLabel(credential.healthStatus)}</span>}
              </div>
              <label htmlFor={`provider-key-${providerId}`}>个人 API Key</label>
              <input
                id={`provider-key-${providerId}`}
                type="password"
                value={credentialInput[providerId] ?? ''}
                onChange={(event) => setCredentialInput((current) => ({ ...current, [providerId]: event.target.value }))}
                placeholder={credential?.keySet ? '输入新 Key 以替换' : '输入完整 API Key'}
                autoComplete="new-password"
                disabled={isPending}
                aria-invalid={credentialError ? true : undefined}
                aria-describedby={credentialError ? credentialErrorId : undefined}
              />
              <div className="courseware-action-row">
                <button type="button" className="btn btn-primary" disabled={isPending} onClick={() => void saveCredential(providerId)}>{isPending ? '保存中…' : credential?.keySet ? '替换 Key' : '保存 Key'}</button>
                {credential?.keySet && <button type="button" className="btn btn-danger-ghost" disabled={isPending} onClick={() => void saveCredential(providerId, true)}>清除 Key</button>}
              </div>
              {credentialNotices[providerId] && <p className="field-notice" role="status">{credentialNotices[providerId]}</p>}
              {credentialError && <p id={credentialErrorId} className="field-error" role="alert">{credentialError}</p>}
            </div>
          );
        })}
        {catalog.length === 0 && <p className="form-hint">当前没有可用服务商，请稍后重试。</p>}
      </section>

      <section className="courseware-settings-section" aria-labelledby="courseware-text-title">
        <h3 id="courseware-text-title">课件脚本模型</h3>
        <ModelField id="courseware-text" label="文本模型" purpose="courseware_text" catalog={catalog} selection={text} onChange={setText} disabled={savingPreferences} error={errors.preferences} errorId="courseware-preferences-error" />
        <div className="courseware-action-row">
          <button type="button" className="btn btn-secondary" disabled={testing.has('text')} aria-describedby={errors['test-text'] ? 'test-text-error' : undefined} onClick={() => void runTest('text')}>{testing.has('text') ? '测试中…' : '测试连接'}</button>
        </div>
        {errors['test-text'] && <p id="test-text-error" className="field-error" role="alert">{errors['test-text']}</p>}
      </section>

      <section className="courseware-settings-section" aria-labelledby="teacher-voice-title">
        <h3 id="teacher-voice-title">老师语音</h3>
        <ModelField id="teacher-voice" label="语音模型" purpose="teacher_tts" catalog={catalog} selection={teacherSpeech} onChange={setTeacherSpeech} disabled={savingPreferences} showVoice error={errors.preferences} errorId="courseware-preferences-error" />
        <div className="courseware-action-row">
          <button type="button" className="btn btn-secondary" disabled={testing.has('teacher_tts')} aria-describedby={errors['test-teacher_tts'] ? 'test-teacher_tts-error' : undefined} onClick={() => void runTest('teacher_tts')}>{testing.has('teacher_tts') ? '准备中…' : '试听'}</button>
        </div>
        {errors['test-teacher_tts'] && <p id="test-teacher_tts-error" className="field-error" role="alert">{errors['test-teacher_tts']}</p>}
        {audioUrls.teacher_tts && <section className="courseware-preview" aria-labelledby="teacher-audio-preview"><h4 id="teacher-audio-preview">老师语音试听</h4><audio controls src={audioUrls.teacher_tts}>当前浏览器不支持音频试听。</audio></section>}
      </section>

      <section className="courseware-settings-section" aria-labelledby="student-voice-title">
        <h3 id="student-voice-title">AI 同学语音</h3>
        <ModelField id="student-voice" label="语音模型" purpose="student_tts" catalog={catalog} selection={studentSpeech} onChange={setStudentSpeech} disabled={savingPreferences} showVoice error={errors.preferences} errorId="courseware-preferences-error" />
        <div className="courseware-action-row">
          <button type="button" className="btn btn-secondary" disabled={testing.has('student_tts')} aria-describedby={errors['test-student_tts'] ? 'test-student_tts-error' : undefined} onClick={() => void runTest('student_tts')}>{testing.has('student_tts') ? '准备中…' : '试听'}</button>
        </div>
        {errors['test-student_tts'] && <p id="test-student_tts-error" className="field-error" role="alert">{errors['test-student_tts']}</p>}
        {audioUrls.student_tts && <section className="courseware-preview" aria-labelledby="student-audio-preview"><h4 id="student-audio-preview">AI 同学语音试听</h4><audio controls src={audioUrls.student_tts}>当前浏览器不支持音频试听。</audio></section>}
      </section>

      <section className="courseware-settings-section" aria-labelledby="courseware-image-title">
        <h3 id="courseware-image-title">配图模型（可选）</h3>
        <label className="settings-toggle-row" htmlFor="courseware-images-enabled">
          <input id="courseware-images-enabled" type="checkbox" checked={includeImages} onChange={(event) => setIncludeImages(event.target.checked)} disabled={savingPreferences} />
          <span><strong>生成配图</strong><small>关闭后不影响脚本和语音课件生成。</small></span>
        </label>
        {includeImages && <>
          <ModelField id="courseware-image" label="图片模型" purpose="courseware_image" catalog={catalog} selection={image} onChange={setImage} disabled={savingPreferences} error={errors.preferences} errorId="courseware-preferences-error" />
          <div className="courseware-action-row">
            <button type="button" className="btn btn-secondary" disabled={testing.has('image')} aria-describedby={errors['test-image'] ? 'test-image-error' : undefined} onClick={() => void runTest('image')}>{testing.has('image') ? '生成中…' : '测试图片'}</button>
          </div>
          {errors['test-image'] && <p id="test-image-error" className="field-error" role="alert">{errors['test-image']}</p>}
        </>}
      </section>

      {imageUrl && <section className="courseware-preview" aria-labelledby="courseware-image-preview"><h3 id="courseware-image-preview">图片预览</h3><img src={imageUrl} alt="测试生成的课件配图预览" /></section>}

      <div className="courseware-save-row">
        <button type="button" className="btn btn-primary" disabled={savingPreferences} aria-describedby={errors.preferences ? 'courseware-preferences-error' : undefined} onClick={() => void savePreferences()}>{savingPreferences ? '保存中…' : '保存课件设置'}</button>
        {errors.preferences && <p id="courseware-preferences-error" className="field-error" role="alert">{errors.preferences}</p>}
      </div>
    </div>
  );
}

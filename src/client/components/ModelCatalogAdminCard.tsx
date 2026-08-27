import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet, apiPost, apiPut, ApiError } from '../api';
import { CatalogAdminLoadLifecycle } from '../lib/catalog-admin-lifecycle';

type Capability = 'structured_text' | 'speech_synthesis' | 'image_generation';
type AdapterType = 'openai_text' | 'token_plan_tts' | 'token_plan_image';

interface VoiceRow {
  id: string;
  name: string;
  recommendedRole?: 'teacher' | 'student';
}

interface CatalogModel {
  id: number;
  endpointId: number;
  modelId: string;
  displayName: string;
  config: Record<string, unknown>;
  voices: VoiceRow[];
  recommended: boolean;
  enabled: boolean;
  sortOrder: number;
}

interface CatalogEndpoint {
  id: number;
  providerId: number;
  capability: Capability;
  adapterType: AdapterType;
  baseUrl: string;
  config: Record<string, unknown>;
  enabled: boolean;
  models: CatalogModel[];
}

interface CatalogProvider {
  id: number;
  slug: string;
  displayName: string;
  enabled: boolean;
  endpoints: CatalogEndpoint[];
}

interface FeatureStatus {
  enabled: boolean;
  providerCount: number;
  enabledModelCount: number;
  failedLast24Hours: number;
}

interface EndpointDraft {
  id: number | null;
  providerId: number;
  capability: Capability;
  adapterType: AdapterType;
  baseUrl: string;
  mediaHostSuffixes: string;
  enabled: boolean;
}

interface ModelDraft {
  id: number | null;
  endpointId: number;
  modelId: string;
  displayName: string;
  format: string;
  sampleRate: string;
  size: string;
  voices: VoiceRow[];
  recommended: boolean;
  enabled: boolean;
  sortOrder: string;
}

const EMPTY_ENDPOINT: EndpointDraft = {
  id: null, providerId: 0, capability: 'structured_text', adapterType: 'openai_text',
  baseUrl: '', mediaHostSuffixes: '', enabled: true,
};

const EMPTY_MODEL: ModelDraft = {
  id: null, endpointId: 0, modelId: '', displayName: '', format: 'mp3', sampleRate: '24000',
  size: '1024*1024', voices: [], recommended: false, enabled: true, sortOrder: '0',
};

const capabilityLabel: Record<Capability, string> = {
  structured_text: '结构化文本', speech_synthesis: '语音合成', image_generation: '图片生成',
};

const adapterForCapability: Record<Capability, AdapterType> = {
  structured_text: 'openai_text', speech_synthesis: 'token_plan_tts', image_generation: 'token_plan_image',
};

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

function mediaSuffixes(config: Record<string, unknown>): string {
  return Array.isArray(config.mediaHostSuffixes)
    ? config.mediaHostSuffixes.filter((value): value is string => typeof value === 'string').join(', ')
    : '';
}

function configForEndpoint(draft: EndpointDraft): Record<string, unknown> {
  if (draft.capability === 'structured_text') return { allowCustomModelId: true };
  const mediaHostSuffixes = draft.mediaHostSuffixes.split(',').map((value) => value.trim()).filter(Boolean);
  return draft.capability === 'speech_synthesis'
    ? { formats: ['mp3'], sampleRates: [24000], mediaHostSuffixes }
    : { sizes: ['1024*1024'], mediaHostSuffixes };
}

function modelConfigFor(draft: ModelDraft, capability: Capability): Record<string, unknown> {
  if (capability === 'speech_synthesis') {
    const sampleRate = Number(draft.sampleRate);
    return { format: draft.format, ...(Number.isInteger(sampleRate) ? { sampleRate } : {}) };
  }
  return capability === 'image_generation' ? { size: draft.size } : {};
}

export default function ModelCatalogAdminCard() {
  const [status, setStatus] = useState<FeatureStatus | null>(null);
  const [providers, setProviders] = useState<CatalogProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmation, setConfirmation] = useState<boolean | null>(null);
  const [providerSlug, setProviderSlug] = useState('');
  const [providerName, setProviderName] = useState('');
  const [providerNames, setProviderNames] = useState<Record<number, string>>({});
  const [endpointDraft, setEndpointDraft] = useState<EndpointDraft>(EMPTY_ENDPOINT);
  const [modelDraft, setModelDraft] = useState<ModelDraft>(EMPTY_MODEL);
  const lifecycleRef = useRef(new CatalogAdminLoadLifecycle());

  const load = useCallback(async () => {
    const request = lifecycleRef.current.begin();
    setLoading(true);
    setError('');
    try {
      const [nextStatus, nextProviders] = await Promise.all([
        apiGet<FeatureStatus>('/api/admin/courseware/status', { signal: request.controller.signal }),
        apiGet<CatalogProvider[]>('/api/admin/ai-catalog/providers', { signal: request.controller.signal }),
      ]);
      if (!lifecycleRef.current.isCurrent(request)) return;
      setStatus(nextStatus);
      setProviders(nextProviders);
      setProviderNames(Object.fromEntries(nextProviders.map((provider) => [provider.id, provider.displayName])));
      setEndpointDraft((current) => current.providerId ? current : { ...current, providerId: nextProviders[0]?.id ?? 0 });
    } catch (caught) {
      if (!lifecycleRef.current.isCurrent(request)) return;
      setError(errorMessage(caught, '目录加载失败，请稍后重试'));
    } finally {
      if (lifecycleRef.current.isCurrent(request)) setLoading(false);
    }
  }, []);

  useEffect(() => {
    lifecycleRef.current.activate();
    void load();
    return () => {
      lifecycleRef.current.cleanup();
    };
  }, [load]);

  const mutate = async (action: () => Promise<unknown>, success: string) => {
    if (pending) return;
    setPending(true);
    setError('');
    setNotice('');
    try {
      await action();
      if (!lifecycleRef.current.isActive()) return;
      setNotice(success);
      await load();
    } catch (caught) {
      if (lifecycleRef.current.isActive()) setError(errorMessage(caught, '保存失败，请检查输入后重试'));
    } finally {
      if (lifecycleRef.current.isActive()) setPending(false);
    }
  };

  const toggleFeature = async () => {
    if (confirmation === null) return;
    const enabled = confirmation;
    setConfirmation(null);
    await mutate(() => apiPut('/api/admin/courseware/status', { enabled }), enabled ? '课件功能已开启' : '课件功能已关闭');
  };

  const saveProvider = async (provider?: CatalogProvider, enabled?: boolean) => {
    if (provider) {
      await mutate(
        () => apiPut(`/api/admin/ai-catalog/providers/${provider.id}`, {
          displayName: providerNames[provider.id] ?? provider.displayName,
          enabled: enabled ?? provider.enabled,
        }),
        enabled === undefined ? '服务商名称已更新' : enabled ? '服务商已启用' : '服务商已停用',
      );
      return;
    }
    await mutate(async () => {
      await apiPost('/api/admin/ai-catalog/providers', { slug: providerSlug, displayName: providerName, enabled: true });
      setProviderSlug('');
      setProviderName('');
    }, '服务商已添加');
  };

  const saveEndpoint = async () => {
    const payload = {
      providerId: endpointDraft.providerId, capability: endpointDraft.capability,
      adapterType: endpointDraft.adapterType, baseUrl: endpointDraft.baseUrl,
      config: configForEndpoint(endpointDraft), enabled: endpointDraft.enabled,
    };
    await mutate(async () => {
      if (endpointDraft.id === null) await apiPost('/api/admin/ai-catalog/endpoints', payload);
      else await apiPut(`/api/admin/ai-catalog/endpoints/${endpointDraft.id}`, payload);
      setEndpointDraft({ ...EMPTY_ENDPOINT, providerId: providers[0]?.id ?? 0 });
    }, endpointDraft.id === null ? '端点已添加' : '端点已更新');
  };

  const saveModel = async () => {
    const endpoint = providers.flatMap((provider) => provider.endpoints)
      .find((item) => item.id === modelDraft.endpointId);
    if (!endpoint) {
      setError('请先选择一个端点');
      return;
    }
    const payload = {
      endpointId: modelDraft.endpointId, modelId: modelDraft.modelId, displayName: modelDraft.displayName,
      config: modelConfigFor(modelDraft, endpoint.capability), voices: modelDraft.voices,
      recommended: modelDraft.recommended, enabled: modelDraft.enabled,
      sortOrder: Number(modelDraft.sortOrder),
    };
    await mutate(async () => {
      if (modelDraft.id === null) await apiPost('/api/admin/ai-catalog/models', payload);
      else await apiPut(`/api/admin/ai-catalog/models/${modelDraft.id}`, payload);
      setModelDraft(EMPTY_MODEL);
    }, modelDraft.id === null ? '模型已添加' : '模型已更新');
  };

  const editEndpoint = (endpoint: CatalogEndpoint) => {
    setEndpointDraft({
      id: endpoint.id, providerId: endpoint.providerId, capability: endpoint.capability,
      adapterType: endpoint.adapterType, baseUrl: endpoint.baseUrl,
      mediaHostSuffixes: mediaSuffixes(endpoint.config), enabled: endpoint.enabled,
    });
  };

  const editModel = (model: CatalogModel) => {
    setModelDraft({
      id: model.id, endpointId: model.endpointId, modelId: model.modelId, displayName: model.displayName,
      format: typeof model.config.format === 'string' ? model.config.format : 'mp3',
      sampleRate: String(model.config.sampleRate ?? 24000), size: typeof model.config.size === 'string' ? model.config.size : '1024*1024',
      voices: model.voices, recommended: model.recommended, enabled: model.enabled, sortOrder: String(model.sortOrder),
    });
  };

  const selectedModelEndpoint = providers.flatMap((provider) => provider.endpoints)
    .find((endpoint) => endpoint.id === modelDraft.endpointId);

  return (
    <section className="card settings-card catalog-admin-card" aria-labelledby="catalog-admin-title">
      <h2 id="catalog-admin-title" className="section-title">服务商与模型目录</h2>
      <p className="form-hint">目录仅供管理员维护。用户只会看到已启用的服务商、端点与模型，历史课件仍保留原快照。</p>
      {error && <div id="catalog-admin-error" className="form-error" role="alert">{error}</div>}
      {notice && <div className="catalog-admin-notice" role="status">{notice}</div>}

      {loading ? (
        <div className="catalog-admin-skeleton" aria-label="正在加载目录"><span /><span /><span /></div>
      ) : (
        <>
          <div className="catalog-feature-status">
            <div>
              <h3>课件功能开关</h3>
              <p>{status?.enabled ? '当前已开启，满足配置条件的账户可以创建语音课件。' : '当前已关闭，线上功能不会向普通账户开放。'}</p>
            </div>
            <span className={`badge ${status?.enabled ? 'badge-success' : ''}`}>{status?.enabled ? '已开启' : '已关闭'}</span>
          </div>
          <div className="catalog-admin-metrics" aria-label="课件目录汇总">
            <span>服务商 {status?.providerCount ?? 0}</span>
            <span>可选模型 {status?.enabledModelCount ?? 0}</span>
            <span>近 24 小时失败 {status?.failedLast24Hours ?? 0}</span>
          </div>
          <div className="catalog-feature-actions">
            <button type="button" className="btn btn-primary" disabled={pending} onClick={() => setConfirmation(!(status?.enabled ?? false))}>
              {status?.enabled ? '关闭课件功能' : '开启课件功能'}
            </button>
            {confirmation !== null && (
              <div className="catalog-confirm" role="alertdialog" aria-label="确认课件功能开关">
                <p>{confirmation ? '确认开启课件功能吗？开启后，已完成个人模型配置的账户可创建课件。' : '确认关闭课件功能吗？关闭后，不再开始新的课件生成任务。'}</p>
                <button type="button" className="btn btn-primary" disabled={pending} onClick={() => void toggleFeature()}>确认{confirmation ? '开启' : '关闭'}</button>
                <button type="button" className="btn" disabled={pending} onClick={() => setConfirmation(null)}>取消</button>
              </div>
            )}
          </div>

          <div className="catalog-admin-grid">
            <form className="catalog-admin-form" aria-describedby={error ? 'catalog-admin-error' : undefined} onSubmit={(event) => { event.preventDefault(); void saveProvider(); }}>
              <h3>添加服务商</h3>
              <label htmlFor="catalog-provider-slug">服务商标识</label>
              <input id="catalog-provider-slug" value={providerSlug} onChange={(event) => setProviderSlug(event.target.value)} placeholder="例如 my-provider" required maxLength={80} disabled={pending} />
              <label htmlFor="catalog-provider-name">显示名称</label>
              <input id="catalog-provider-name" value={providerName} onChange={(event) => setProviderName(event.target.value)} required maxLength={100} disabled={pending} />
              <button type="submit" className="btn" disabled={pending}>添加服务商</button>
            </form>

            <form className="catalog-admin-form" aria-describedby={error ? 'catalog-admin-error' : undefined} onSubmit={(event) => { event.preventDefault(); void saveEndpoint(); }}>
              <h3>{endpointDraft.id === null ? '添加端点' : '编辑端点'}</h3>
              <label htmlFor="catalog-endpoint-provider">服务商</label>
              <select id="catalog-endpoint-provider" value={endpointDraft.providerId} onChange={(event) => setEndpointDraft((draft) => ({ ...draft, providerId: Number(event.target.value) }))} required disabled={pending || endpointDraft.id !== null}>
                <option value={0}>请选择服务商</option>
                {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.displayName}</option>)}
              </select>
              <label htmlFor="catalog-endpoint-capability">能力</label>
              <select id="catalog-endpoint-capability" value={endpointDraft.capability} onChange={(event) => {
                const capability = event.target.value as Capability;
                setEndpointDraft((draft) => ({ ...draft, capability, adapterType: adapterForCapability[capability] }));
              }} disabled={pending || endpointDraft.id !== null}>
                {(Object.keys(capabilityLabel) as Capability[]).map((capability) => <option key={capability} value={capability}>{capabilityLabel[capability]}</option>)}
              </select>
              <label htmlFor="catalog-endpoint-url">Base URL</label>
              <input id="catalog-endpoint-url" type="url" value={endpointDraft.baseUrl} onChange={(event) => setEndpointDraft((draft) => ({ ...draft, baseUrl: event.target.value }))} placeholder="https://api.example.com/v1" required disabled={pending} />
              {endpointDraft.capability !== 'structured_text' && <>
                <label htmlFor="catalog-media-suffixes">媒体域名后缀</label>
                <input id="catalog-media-suffixes" value={endpointDraft.mediaHostSuffixes} onChange={(event) => setEndpointDraft((draft) => ({ ...draft, mediaHostSuffixes: event.target.value }))} placeholder="media.example.com, cdn.example.com" required disabled={pending} />
              </>}
              <label className="catalog-inline-checkbox"><input type="checkbox" checked={endpointDraft.enabled} onChange={(event) => setEndpointDraft((draft) => ({ ...draft, enabled: event.target.checked }))} disabled={pending} />启用端点</label>
              <p className="form-hint">适配器：{endpointDraft.adapterType}。媒体域名使用小写 DNS 后缀，以英文逗号分隔。编辑已有端点时，服务商、能力和适配器不可更改。</p>
              <button type="submit" className="btn" disabled={pending || endpointDraft.providerId === 0}>{endpointDraft.id === null ? '添加端点' : '保存端点'}</button>
            </form>
          </div>

          <form className="catalog-admin-form catalog-model-form" aria-describedby={error ? 'catalog-admin-error' : undefined} onSubmit={(event) => { event.preventDefault(); void saveModel(); }}>
            <h3>{modelDraft.id === null ? '添加模型' : '编辑模型'}</h3>
            <div className="form-row">
              <label htmlFor="catalog-model-endpoint">端点<select id="catalog-model-endpoint" value={modelDraft.endpointId} onChange={(event) => setModelDraft((draft) => ({ ...draft, endpointId: Number(event.target.value) }))} required disabled={pending || modelDraft.id !== null}><option value={0}>请选择端点</option>{providers.flatMap((provider) => provider.endpoints).map((endpoint) => <option key={endpoint.id} value={endpoint.id}>{endpoint.adapterType} / {endpoint.baseUrl}</option>)}</select></label>
              <label htmlFor="catalog-model-id">模型 ID<input id="catalog-model-id" value={modelDraft.modelId} onChange={(event) => setModelDraft((draft) => ({ ...draft, modelId: event.target.value }))} required maxLength={150} disabled={pending} /></label>
              <label htmlFor="catalog-model-name">显示名称<input id="catalog-model-name" value={modelDraft.displayName} onChange={(event) => setModelDraft((draft) => ({ ...draft, displayName: event.target.value }))} required maxLength={150} disabled={pending} /></label>
              <label htmlFor="catalog-model-order">排序<input id="catalog-model-order" type="number" min={-10000} max={10000} value={modelDraft.sortOrder} onChange={(event) => setModelDraft((draft) => ({ ...draft, sortOrder: event.target.value }))} required disabled={pending} /></label>
            </div>
            {modelDraft.id !== null && <p className="form-hint">编辑已有模型时，端点不可更改，以保护既有模型偏好。</p>}
            {selectedModelEndpoint?.capability === 'speech_synthesis' && <div className="form-row"><label htmlFor="catalog-model-format">音频格式<select id="catalog-model-format" value={modelDraft.format} onChange={(event) => setModelDraft((draft) => ({ ...draft, format: event.target.value }))} disabled={pending}><option value="mp3">MP3</option><option value="wav">WAV</option><option value="pcm">PCM</option><option value="opus">Opus</option><option value="aac">AAC</option></select></label><label htmlFor="catalog-model-rate">采样率<select id="catalog-model-rate" value={modelDraft.sampleRate} onChange={(event) => setModelDraft((draft) => ({ ...draft, sampleRate: event.target.value }))} disabled={pending}>{[8000, 16000, 22050, 24000, 44100, 48000].map((rate) => <option key={rate} value={rate}>{rate} Hz</option>)}</select></label></div>}
            {selectedModelEndpoint?.capability === 'image_generation' && <label htmlFor="catalog-model-size">图片尺寸<select id="catalog-model-size" value={modelDraft.size} onChange={(event) => setModelDraft((draft) => ({ ...draft, size: event.target.value }))} disabled={pending}>{['512*512', '768*768', '1024*1024', '1280*720', '720*1280'].map((size) => <option key={size} value={size}>{size}</option>)}</select></label>}
            {selectedModelEndpoint?.capability === 'speech_synthesis' && <fieldset className="catalog-voice-fieldset"><legend>音色</legend>{modelDraft.voices.length === 0 && <p className="form-hint">尚未添加音色。</p>}{modelDraft.voices.map((voice, index) => <div className="catalog-voice-row" key={`${voice.id}-${index}`}><label>音色 ID<input value={voice.id} onChange={(event) => setModelDraft((draft) => ({ ...draft, voices: draft.voices.map((item, itemIndex) => itemIndex === index ? { ...item, id: event.target.value } : item) }))} required disabled={pending} /></label><label>名称<input value={voice.name} onChange={(event) => setModelDraft((draft) => ({ ...draft, voices: draft.voices.map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value } : item) }))} required disabled={pending} /></label><label>推荐角色<select value={voice.recommendedRole ?? ''} onChange={(event) => setModelDraft((draft) => ({ ...draft, voices: draft.voices.map((item, itemIndex) => {
              if (itemIndex !== index) return item;
              return event.target.value
                ? { ...item, recommendedRole: event.target.value as 'teacher' | 'student' }
                : { id: item.id, name: item.name };
            }) }))} disabled={pending}><option value="">未指定</option><option value="teacher">老师</option><option value="student">AI 同学</option></select></label><button type="button" className="btn btn-sm" disabled={pending} onClick={() => setModelDraft((draft) => ({ ...draft, voices: draft.voices.filter((_, itemIndex) => itemIndex !== index) }))}>移除音色</button></div>)}<button type="button" className="btn btn-sm" disabled={pending} onClick={() => setModelDraft((draft) => ({ ...draft, voices: [...draft.voices, { id: '', name: '' }] }))}>添加音色</button></fieldset>}
            <div className="catalog-checkbox-row"><label><input type="checkbox" checked={modelDraft.recommended} onChange={(event) => setModelDraft((draft) => ({ ...draft, recommended: event.target.checked }))} disabled={pending} />推荐</label><label><input type="checkbox" checked={modelDraft.enabled} onChange={(event) => setModelDraft((draft) => ({ ...draft, enabled: event.target.checked }))} disabled={pending} />启用</label></div>
            <button type="submit" className="btn" disabled={pending || modelDraft.endpointId === 0}>{modelDraft.id === null ? '添加模型' : '保存模型'}</button>
          </form>

          <div className="catalog-provider-list">
            {providers.length === 0 ? <div className="empty-state"><p>还没有服务商。请先添加服务商和端点。</p></div> : providers.map((provider) => (
              <details key={provider.id} className="catalog-provider" open>
                <summary><span>{provider.displayName}</span><span className={`badge ${provider.enabled ? 'badge-success' : ''}`}>{provider.enabled ? '已启用' : '已停用'}</span></summary>
                <div className="catalog-provider-body"><p className="form-hint">标识：{provider.slug}</p><div className="catalog-provider-edit"><label htmlFor={`catalog-provider-name-${provider.id}`}>显示名称</label><input id={`catalog-provider-name-${provider.id}`} value={providerNames[provider.id] ?? provider.displayName} onChange={(event) => setProviderNames((current) => ({ ...current, [provider.id]: event.target.value }))} disabled={pending} maxLength={100} /><button type="button" className="btn btn-sm" disabled={pending} onClick={() => void saveProvider(provider)}>保存名称</button><button type="button" className="btn btn-sm" disabled={pending} onClick={() => void saveProvider(provider, !provider.enabled)}>{provider.enabled ? '停用服务商' : '启用服务商'}</button></div>{provider.endpoints.map((endpoint) => <div key={endpoint.id} className="catalog-endpoint"><div className="catalog-endpoint-head"><strong>{capabilityLabel[endpoint.capability]}</strong><span className="badge">{endpoint.enabled ? '已启用' : '已停用'}</span></div><dl><div><dt>Base URL</dt><dd>{endpoint.baseUrl}</dd></div><div><dt>适配器</dt><dd>{endpoint.adapterType}</dd></div><div><dt>能力</dt><dd>{capabilityLabel[endpoint.capability]}</dd></div></dl><button type="button" className="btn btn-sm" disabled={pending} onClick={() => editEndpoint(endpoint)}>编辑端点</button><div className="catalog-model-list">{endpoint.models.map((model) => <div key={model.id} className="catalog-model-row"><span><strong>{model.displayName}</strong><small>{model.modelId}</small></span><span className={`badge ${model.enabled ? 'badge-success' : ''}`}>{model.enabled ? '已启用' : '已停用'}</span><button type="button" className="btn btn-sm" disabled={pending} onClick={() => editModel(model)}>{model.enabled ? '编辑或停用' : '编辑或启用'}</button></div>)}</div></div>)}</div>
              </details>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

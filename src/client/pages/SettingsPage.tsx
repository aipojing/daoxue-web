import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiGet, apiPost, apiPut, ApiError } from '../api';
import { useAuth } from '../AuthContext';
import type { InviteCode, AdminUser, AdminSettings } from '../types';

export default function SettingsPage() {
  const { user, clear } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');

  const [invites, setInvites] = useState<InviteCode[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [inviteNote, setInviteNote] = useState('');
  const [limitEdits, setLimitEdits] = useState<Record<number, string>>({});
  const [aiSettings, setAiSettings] = useState<AdminSettings | null>(null);
  const [deepseekKeyInput, setDeepseekKeyInput] = useState('');
  const [visionKeyInput, setVisionKeyInput] = useState('');
  const [visionAdvancedOpen, setVisionAdvancedOpen] = useState(false);
  const [visionUrlInput, setVisionUrlInput] = useState('');
  const [visionModelInput, setVisionModelInput] = useState('');
  const [savingKeys, setSavingKeys] = useState(false);

  const isAdmin = user?.isAdmin ?? false;

  const loadAdmin = useCallback(
    async (syncInputs = false) => {
      if (!isAdmin) return;
      try {
        const [inviteData, userData, settingsData] = await Promise.all([
          apiGet<InviteCode[]>('/api/admin/invite-codes'),
          apiGet<AdminUser[]>('/api/admin/users'),
          apiGet<AdminSettings>('/api/admin/settings'),
        ]);
        setInvites(inviteData);
        setUsers(userData);
        setAiSettings(settingsData);
        // 只在首次加载/保存配置后回填，否则生成邀请码会把正在输入的地址冲掉
        if (syncInputs) {
          setVisionUrlInput(settingsData.visionApiUrl);
          setVisionModelInput(settingsData.visionModel);
        }
      } catch (e) {
        setError(e instanceof ApiError ? e.message : '加载失败');
      }
    },
    [isAdmin],
  );

  const saveAIKeys = async () => {
    setSavingKeys(true);
    setError('');
    try {
      const body: Record<string, string> = {};
      if (deepseekKeyInput.trim()) body.deepseekApiKey = deepseekKeyInput.trim();
      if (visionKeyInput.trim()) body.visionApiKey = visionKeyInput.trim();
      // 只要和服务端现值不同就提交，避免用户改完又收起高级设置导致静默丢弃
      if (visionUrlInput.trim() !== (aiSettings?.visionApiUrl ?? '')) {
        body.visionApiUrl = visionUrlInput.trim();
      }
      if (visionModelInput.trim() !== (aiSettings?.visionModel ?? '')) {
        body.visionModel = visionModelInput.trim();
      }
      await apiPut('/api/admin/settings', body);
      setDeepseekKeyInput('');
      setVisionKeyInput('');
      setToast('已保存，立即生效');
      await loadAdmin(true);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '保存失败');
    } finally {
      setSavingKeys(false);
    }
  };

  const keyStatus = (set: boolean, tail: string, fromEnv: boolean) => {
    if (!set) return <span className="badge badge-danger">未配置</span>;
    if (fromEnv) return <span className="badge badge-success">已配置（环境变量）</span>;
    return <span className="badge badge-success">已配置（尾号 {tail || '****'}）</span>;
  };

  useEffect(() => {
    void loadAdmin(true);
  }, [loadAdmin]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 2500);
    return () => clearTimeout(timer);
  }, [toast]);

  const logout = async () => {
    await apiPost('/api/auth/logout').catch(() => {});
    clear();
    navigate('/login', { replace: true });
  };

  const createInvite = async () => {
    try {
      await apiPost('/api/admin/invite-codes', { note: inviteNote, maxUses: 1 });
      setInviteNote('');
      await loadAdmin();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '生成失败');
    }
  };

  const toggleInvite = async (invite: InviteCode) => {
    try {
      await apiPut(`/api/admin/invite-codes/${invite.id}`, { disabled: !invite.disabled });
      await loadAdmin();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '操作失败');
    }
  };

  const copyCode = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setToast('已复制邀请码');
    } catch {
      setToast(`邀请码：${code}`);
    }
  };

  const saveLimit = async (u: AdminUser) => {
    const raw = limitEdits[u.id];
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > 10000) {
      setError('每日上限需为 1-10000 的整数');
      return;
    }
    try {
      await apiPut(`/api/admin/users/${u.id}`, { dailyMessageLimit: value });
      setLimitEdits((prev) => {
        const { [u.id]: _removed, ...rest } = prev;
        return rest;
      });
      setToast('已保存');
      await loadAdmin();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '保存失败');
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <h1>设置</h1>
      </div>
      {error && <div className="form-error">{error}</div>}

      <div className="card settings-card">
        <h2 className="section-title">账号</h2>
        <p>
          登录邮箱：<strong>{user?.email}</strong>
          {isAdmin && <span className="badge badge-primary settings-admin-badge">管理员</span>}
        </p>
        <button className="btn btn-danger-ghost" onClick={() => void logout()}>
          退出登录
        </button>
      </div>

      {isAdmin && (
        <>
          <div className="card settings-card">
            <h2 className="section-title">AI 服务配置</h2>
            <div className="key-row">
              <div className="key-row-head">
                <strong>DeepSeek API Key</strong>（必须，驱动全部对话）
                {aiSettings && keyStatus(aiSettings.deepseekKeySet, aiSettings.deepseekKeyTail, aiSettings.deepseekFromEnv)}
              </div>
              <p className="form-hint">
                在 <a href="https://platform.deepseek.com" target="_blank" rel="noreferrer">platform.deepseek.com</a> 创建，
                以 sk- 开头。粘贴新 Key 保存即覆盖；Key 保存后不回显。
              </p>
              <input
                type="password"
                value={deepseekKeyInput}
                onChange={(e) => setDeepseekKeyInput(e.target.value)}
                placeholder="sk-…（留空表示不修改）"
                autoComplete="off"
              />
            </div>
            <div className="key-row">
              <div className="key-row-head">
                <strong>视觉模型 Key</strong>（可选，开启拍照识题）
                {aiSettings && keyStatus(aiSettings.visionKeySet, aiSettings.visionKeyTail, aiSettings.visionFromEnv)}
              </div>
              <p className="form-hint">
                默认接智谱 GLM-4.1V-Thinking-Flash（免费），在{' '}
                <a href="https://open.bigmodel.cn" target="_blank" rel="noreferrer">open.bigmodel.cn</a> 注册取 Key。
                配置后聊天输入框出现相机按钮。
              </p>
              <input
                type="password"
                value={visionKeyInput}
                onChange={(e) => setVisionKeyInput(e.target.value)}
                placeholder="智谱 API Key（留空表示不修改）"
                autoComplete="off"
              />
              <button
                className="btn-link"
                aria-expanded={visionAdvancedOpen}
                onClick={() => setVisionAdvancedOpen(!visionAdvancedOpen)}
              >
                {visionAdvancedOpen ? '收起高级设置 ▲' : '高级：换其他视觉服务（如通义 qwen-vl）▼'}
              </button>
              {visionAdvancedOpen && (
                <div className="key-advanced">
                  <input
                    value={visionUrlInput}
                    onChange={(e) => setVisionUrlInput(e.target.value)}
                    placeholder="接口地址（OpenAI 兼容），留空用智谱默认"
                  />
                  <input
                    value={visionModelInput}
                    onChange={(e) => setVisionModelInput(e.target.value)}
                    placeholder="模型名，如 qwen-vl-plus，留空用 glm-4.1v-thinking-flash"
                  />
                </div>
              )}
            </div>
            <button className="btn btn-primary" onClick={() => void saveAIKeys()} disabled={savingKeys}>
              {savingKeys ? '保存中…' : '保存配置'}
            </button>
          </div>

          <div className="card settings-card">
            <h2 className="section-title">邀请码管理</h2>
            <div className="invite-create-row">
              <input
                value={inviteNote}
                onChange={(e) => setInviteNote(e.target.value)}
                placeholder="备注（给谁用，可留空）"
                maxLength={50}
              />
              <button className="btn btn-primary" onClick={() => void createInvite()}>
                生成邀请码
              </button>
            </div>
            {invites.length === 0 ? (
              <p className="text-secondary">还没有邀请码</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>邀请码</th>
                      <th>备注</th>
                      <th>使用</th>
                      <th>状态</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invites.map((inv) => (
                      <tr key={inv.id}>
                        <td>
                          <code className="invite-code" onClick={() => void copyCode(inv.code)} title="点击复制">
                            {inv.code}
                          </code>
                        </td>
                        <td>{inv.note || '—'}</td>
                        <td>
                          {inv.used_count}/{inv.max_uses}
                        </td>
                        <td>
                          {inv.disabled ? (
                            <span className="badge">已停用</span>
                          ) : inv.used_count >= inv.max_uses ? (
                            <span className="badge">已用完</span>
                          ) : (
                            <span className="badge badge-success">可用</span>
                          )}
                        </td>
                        <td>
                          <button className="btn btn-sm" onClick={() => void toggleInvite(inv)}>
                            {inv.disabled ? '启用' : '停用'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="card settings-card">
            <h2 className="section-title">用户管理</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>邮箱</th>
                    <th>学生数</th>
                    <th>今日用量</th>
                    <th>每日上限</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.id}>
                      <td>
                        {u.email}
                        {u.is_admin ? <span className="badge badge-primary settings-admin-badge">管理员</span> : null}
                      </td>
                      <td>{u.student_count}</td>
                      <td>{u.today_used}</td>
                      <td>
                        <input
                          className="limit-input"
                          value={limitEdits[u.id] ?? String(u.daily_message_limit)}
                          onChange={(e) => setLimitEdits((prev) => ({ ...prev, [u.id]: e.target.value }))}
                          inputMode="numeric"
                        />
                      </td>
                      <td>
                        <button
                          className="btn btn-sm"
                          onClick={() => void saveLimit(u)}
                          disabled={limitEdits[u.id] === undefined}
                        >
                          保存
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}

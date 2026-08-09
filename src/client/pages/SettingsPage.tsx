import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiGet, apiPost, apiPut, ApiError, performLogout } from '../api';
import { useAuth } from '../AuthContext';
import type { InviteCode, AdminUser } from '../types';
import { finishPending, tryStartPending } from '../lib/chat';
import SharedAISettingsCard from '../components/SharedAISettingsCard';

export default function SettingsPage() {
  const { user, clear } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');

  const [invites, setInvites] = useState<InviteCode[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [inviteNote, setInviteNote] = useState('');
  const [limitEdits, setLimitEdits] = useState<Record<number, string>>({});
  const [loggingOut, setLoggingOut] = useState(false);
  const [creatingInvite, setCreatingInvite] = useState(false);
  const [pendingInviteIds, setPendingInviteIds] = useState<Set<number>>(() => new Set());
  const [pendingLimitIds, setPendingLimitIds] = useState<Set<number>>(() => new Set());
  const pendingActionsRef = useRef(new Set<string>());
  const loadAdminGenRef = useRef(0);

  const isAdmin = user?.isAdmin ?? false;

  const loadAdmin = useCallback(async () => {
    if (!isAdmin) return;
    const generation = ++loadAdminGenRef.current;
    try {
      const [inviteData, userData] = await Promise.all([
        apiGet<InviteCode[]>('/api/admin/invite-codes'),
        apiGet<AdminUser[]>('/api/admin/users'),
      ]);
      if (generation !== loadAdminGenRef.current) return;
      setInvites(inviteData);
      setUsers(userData);
    } catch (e) {
      if (generation !== loadAdminGenRef.current) return;
      setError(e instanceof ApiError ? e.message : '加载失败');
    }
  }, [isAdmin]);

  useEffect(() => {
    void loadAdmin();
  }, [loadAdmin]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 2500);
    return () => clearTimeout(timer);
  }, [toast]);

  const logout = async () => {
    if (!tryStartPending(pendingActionsRef.current, 'logout')) return;
    setLoggingOut(true);
    setError('');
    try {
      await performLogout(() => apiPost('/api/auth/logout'), clear);
      navigate('/login', { replace: true });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '退出失败，请检查网络后重试');
    } finally {
      finishPending(pendingActionsRef.current, 'logout');
      setLoggingOut(false);
    }
  };

  const createInvite = async () => {
    if (!tryStartPending(pendingActionsRef.current, 'create-invite')) return;
    setCreatingInvite(true);
    setError('');
    try {
      await apiPost('/api/admin/invite-codes', { note: inviteNote, maxUses: 1 });
      setInviteNote('');
      await loadAdmin();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '生成失败');
    } finally {
      finishPending(pendingActionsRef.current, 'create-invite');
      setCreatingInvite(false);
    }
  };

  const toggleInvite = async (invite: InviteCode) => {
    const pendingKey = `toggle-invite:${invite.id}`;
    if (!tryStartPending(pendingActionsRef.current, pendingKey)) return;
    setPendingInviteIds((current) => {
      const next = new Set(current);
      next.add(invite.id);
      return next;
    });
    setError('');
    try {
      await apiPut(`/api/admin/invite-codes/${invite.id}`, { disabled: !invite.disabled });
      await loadAdmin();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '操作失败');
    } finally {
      finishPending(pendingActionsRef.current, pendingKey);
      setPendingInviteIds((current) => {
        const next = new Set(current);
        next.delete(invite.id);
        return next;
      });
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
    const pendingKey = `save-limit:${u.id}`;
    if (!tryStartPending(pendingActionsRef.current, pendingKey)) return;
    setPendingLimitIds((current) => {
      const next = new Set(current);
      next.add(u.id);
      return next;
    });
    setError('');
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
    } finally {
      finishPending(pendingActionsRef.current, pendingKey);
      setPendingLimitIds((current) => {
        const next = new Set(current);
        next.delete(u.id);
        return next;
      });
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
        <p className="form-hint">
          DeepSeek 与图片识别服务的 Key 请在「AI 服务」页配置。
        </p>
        <button className="btn btn-danger-ghost" disabled={loggingOut} onClick={() => void logout()}>
          {loggingOut ? '退出中…' : '退出登录'}
        </button>
      </div>

      {isAdmin && (
        <>
          <SharedAISettingsCard />

          <div className="card settings-card">
            <h2 className="section-title">邀请码管理</h2>
            <div className="invite-create-row">
              <input
                value={inviteNote}
                onChange={(e) => setInviteNote(e.target.value)}
                placeholder="备注（给谁用，可留空）"
                maxLength={50}
              />
              <button className="btn btn-primary" disabled={creatingInvite} onClick={() => void createInvite()}>
                {creatingInvite ? '生成中…' : '生成邀请码'}
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
                          <button
                            className="btn btn-sm"
                            onClick={() => void toggleInvite(inv)}
                            disabled={pendingInviteIds.has(inv.id)}
                          >
                            {pendingInviteIds.has(inv.id) ? '处理中…' : inv.disabled ? '启用' : '停用'}
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
                          disabled={pendingLimitIds.has(u.id)}
                        />
                      </td>
                      <td>
                        <button
                          className="btn btn-sm"
                          onClick={() => void saveLimit(u)}
                          disabled={limitEdits[u.id] === undefined || pendingLimitIds.has(u.id)}
                        >
                          {pendingLimitIds.has(u.id) ? '保存中…' : '保存'}
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

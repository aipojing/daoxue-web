import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { apiPost, ApiError } from '../api';
import { useAuth } from '../AuthContext';
import { IconBook } from '../components/icons';

export default function RegisterPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const { refresh } = useAuth();
  const navigate = useNavigate();

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      await apiPost('/api/auth/register', {
        email,
        password,
        inviteCode: inviteCode.trim() || undefined,
      });
      await refresh();
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '注册失败，请重试');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={onSubmit}>
        <h1 className="auth-title">
          <IconBook size={24} />
          注册账号
        </h1>
        <p className="auth-subtitle">注册后可为孩子创建学习档案</p>
        {error && <div className="form-error">{error}</div>}
        <label className="form-label">
          邮箱
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            required
            autoComplete="email"
            autoFocus
          />
        </label>
        <label className="form-label">
          密码（至少 8 位）
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="设置密码"
            required
            minLength={8}
            autoComplete="new-password"
          />
        </label>
        <label className="form-label">
          邀请码
          <input
            type="text"
            value={inviteCode}
            onChange={(e) => setInviteCode(e.target.value)}
            placeholder="请输入邀请码"
          />
        </label>
        <p className="form-hint">注册需要邀请码，请向管理员索取。系统首个账号无需邀请码。</p>
        <button type="submit" className="btn btn-primary btn-block" disabled={submitting}>
          {submitting ? '注册中…' : '注册'}
        </button>
        <p className="auth-switch">
          已有账号？<Link to="/login">登录</Link>
        </p>
      </form>
    </div>
  );
}

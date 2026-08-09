import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { apiPost, ApiError } from '../api';
import { useAuth } from '../AuthContext';
import { IconBook } from '../components/icons';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const { refresh } = useAuth();
  const navigate = useNavigate();

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      await apiPost('/api/auth/login', { email, password });
      await refresh().catch(() => {
        throw new Error('登录成功，但获取账号信息失败，请刷新页面');
      });
      navigate('/', { replace: true });
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : err instanceof Error ? err.message : '登录失败，请重试',
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={onSubmit}>
        <h1 className="auth-title">
          <IconBook size={24} />
          学伴 AI
        </h1>
        <p className="auth-subtitle">自学陪伴 · 解题辅导 · 错题本 · 学习画像</p>
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
          密码
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="请输入密码"
            required
            autoComplete="current-password"
          />
        </label>
        <button type="submit" className="btn btn-primary btn-block" disabled={submitting}>
          {submitting ? '登录中…' : '登录'}
        </button>
        <p className="auth-switch">
          还没有账号？<Link to="/register">注册</Link>
        </p>
        <p className="auth-switch text-secondary" style={{ fontSize: 12, marginTop: 6 }}>
          忘记密码请联系管理员重置
        </p>
      </form>
    </div>
  );
}

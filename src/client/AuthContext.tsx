import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';
import { apiGet, ApiError, getAuthProbeError } from './api';
import type { User } from './types';

interface AuthState {
  user: User | null;
  loading: boolean;
  error: string;
  refresh: () => Promise<void>;
  clear: () => void;
}

const AuthContext = createContext<AuthState>({
  user: null,
  loading: true,
  error: '',
  refresh: async () => {},
  clear: () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const me = await apiGet<User>('/api/auth/me');
      setUser(me);
    } catch (e) {
      // 只有确认未登录才清空用户态；网络抖动/500 不应该把已登录用户踢去登录页
      if (e instanceof ApiError && e.status === 401) setUser(null);
      else {
        setError(getAuthProbeError(e));
        throw e;
      }
    } finally {
      setLoading(false);
    }
  }, []);

  const clear = useCallback(() => {
    setUser(null);
    setError('');
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh().catch(() => {
      /* 首次探测失败保持未登录态，页面自身会提示 */
    });
  }, [refresh]);

  return <AuthContext.Provider value={{ user, loading, error, refresh, clear }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  return useContext(AuthContext);
}

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------
export type Role = 'admin' | 'inspector' | 'resident';

export interface AuthUser {
  id: string;
  username: string;
  name: string;
  role: Role;
}

// ---------------------------------------------------------------------------
// 统一 API 错误：服务端返回 { error, code }
// ---------------------------------------------------------------------------
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const roleNames: Record<Role, string> = {
  admin: '管理员',
  inspector: '巡检人员',
  resident: '居民',
};

// ---------------------------------------------------------------------------
// 令牌持久化：localStorage 保存，刷新页面后通过 /auth/me 校验恢复
// ---------------------------------------------------------------------------
const TOKEN_KEY = 'ctcc.token';

export function getStoredToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

// 全局未授权回调（AuthProvider 注册），任何请求拿到 401 都统一登出
type UnauthorizedHandler = (code: string, message: string) => void;
let onUnauthorized: UnauthorizedHandler | null = null;
export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  onUnauthorized = handler;
}

export async function request<T = unknown>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set('Content-Type', 'application/json');
  const token = getStoredToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);

  let res: Response;
  try {
    res = await fetch(`/api${path}`, { ...options, headers });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', '网络异常，无法连接服务器');
  }

  let payload: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!res.ok) {
    const body = (payload ?? {}) as { error?: string; code?: string };
    const code = body.code || 'ERROR';
    const message = body.error || `请求失败（${res.status}）`;
    // 登录接口的 401 表示“用户名或密码错误”，由登录页自行提示，
    // 不作为“会话失效”统一登出处理
    if (res.status === 401 && path !== '/auth/login' && onUnauthorized) {
      onUnauthorized(code, message);
    }
    throw new ApiError(res.status, code, message);
  }

  return payload as T;
}

// ---------------------------------------------------------------------------
// 认证接口
// ---------------------------------------------------------------------------
interface LoginResponse {
  token: string;
  user: AuthUser;
}

export async function login(username: string, password: string): Promise<AuthUser> {
  const data = await request<LoginResponse>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
  localStorage.setItem(TOKEN_KEY, data.token);
  return data.user;
}

// ---------------------------------------------------------------------------
// AuthContext
// ---------------------------------------------------------------------------
interface AuthContextValue {
  user: AuthUser | null;
  status: 'restoring' | 'authenticated' | 'anonymous';
  loginWith: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  authError: string;
  clearAuthError: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [status, setStatus] = useState<'restoring' | 'authenticated' | 'anonymous'>('restoring');
  const [authError, setAuthError] = useState('');

  const clearAuthError = useCallback(() => setAuthError(''), []);

  // 刷新恢复：若本地有令牌，向服务端验证；令牌无效则清空并回到未登录
  useEffect(() => {
    const token = getStoredToken();
    if (!token) {
      setStatus('anonymous');
      return;
    }
    let cancelled = false;
    request<AuthUser>('/auth/me')
      .then((currentUser) => {
        if (!cancelled) {
          setUser(currentUser);
          setStatus('authenticated');
        }
      })
      .catch((error) => {
        // 401 会触发全局处理器；非 401（如断网）也要停留在登录页
        if (!cancelled) {
          localStorage.removeItem(TOKEN_KEY);
          setUser(null);
          setStatus('anonymous');
          if (error instanceof ApiError && error.status !== 401) {
            setAuthError(error.message);
          }
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 任意业务请求返回 401 时的统一处理：清理会话、回到登录页并提示
  useEffect(() => {
    setUnauthorizedHandler((code, message) => {
      localStorage.removeItem(TOKEN_KEY);
      setUser(null);
      setStatus('anonymous');
      setAuthError(code === 'SESSION_EXPIRED' ? '登录已过期，请重新登录' : message);
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  const loginWith = useCallback(async (username: string, password: string) => {
    const currentUser = await login(username, password);
    setUser(currentUser);
    setStatus('authenticated');
    setAuthError('');
  }, []);

  const logout = useCallback(async () => {
    try {
      await request('/auth/logout', { method: 'POST' });
    } catch {
      // 即使服务端注销失败也清理本地状态
    }
    localStorage.removeItem(TOKEN_KEY);
    setUser(null);
    setStatus('anonymous');
  }, []);

  const value = useMemo(
    () => ({ user, status, loginWith, logout, authError, clearAuthError }),
    [user, status, loginWith, logout, authError, clearAuthError],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth 必须在 AuthProvider 内使用');
  return context;
}

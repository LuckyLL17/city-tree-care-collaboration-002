import { useState, type FormEvent } from 'react';
import { roleNames, useAuth, type Role } from './auth';
import { roleDescriptions } from './permissions';

interface DemoAccount {
  role: Role;
  username: string;
  password: string;
}

const demoAccounts: DemoAccount[] = [
  { role: 'admin', username: 'admin', password: 'admin123' },
  { role: 'inspector', username: 'inspector', password: 'inspect123' },
  { role: 'resident', username: 'resident', password: 'resident123' },
];

export default function Login() {
  const { loginWith, authError, clearAuthError } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    clearAuthError();
    if (!username.trim() || !password) {
      setError('请输入用户名和密码');
      return;
    }
    setSubmitting(true);
    try {
      await loginWith(username.trim(), password);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : '登录失败，请重试');
    } finally {
      setSubmitting(false);
    }
  }

  function quickFill(account: DemoAccount) {
    setUsername(account.username);
    setPassword(account.password);
    setError('');
    clearAuthError();
  }

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={submit}>
        <span className="eyebrow">LOGIN REQUIRED</span>
        <h1>城市公共树木养护协作系统</h1>
        <p className="login-desc">请使用账号登录，系统将根据角色开放相应功能。</p>

        {(error || authError) && <div className="notice error">{error || authError}</div>}

        <label>
          用户名
          <input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            placeholder="请输入用户名"
            autoComplete="username"
          />
        </label>
        <label>
          密码
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="请输入密码"
            autoComplete="current-password"
          />
        </label>
        <button className="primary login-btn" disabled={submitting}>
          {submitting ? '登录中…' : '登 录'}
        </button>

        <div className="demo-accounts">
          <h2>演示账号（点击自动填充）</h2>
          {demoAccounts.map((account) => (
            <button
              type="button"
              key={account.role}
              className="demo-account"
              onClick={() => quickFill(account)}
            >
              <span className={`role-tag role-${account.role}`}>{roleNames[account.role]}</span>
              <span className="demo-meta">
                {account.username} / {account.password}
              </span>
              <small>{roleDescriptions[account.role]}</small>
            </button>
          ))}
        </div>
      </form>
    </div>
  );
}

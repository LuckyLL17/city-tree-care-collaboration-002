import { useEffect, useState, type FormEvent } from 'react';
import './styles.css';

type Item = { id: string; createdAt: string; [key: string]: string };
type Resource = { key: string; label: string; fields: string[] };
type Role = 'admin' | 'inspector' | 'resident';
type User = { id: string; username: string; name: string; role: Role };

const config = {"name": "城市公共树木养护协作系统", "description": "用于维护城市公共树木档案、巡检任务和居民异常反馈的基础协作系统。", "flow": "建立树木档案 → 安排巡检 → 记录异常 → 派发养护 → 完成复核", "resources": [{"key": "trees", "label": "树木档案", "fields": ["species", "location", "health", "lastInspection"]}, {"key": "reports", "label": "异常反馈", "fields": ["tree", "reporter", "issue", "status"]}, {"key": "inspections", "label": "巡检任务", "fields": ["tree", "inspector", "date", "status"]}], "states": ["待派单", "待执行", "处理中", "已完成"], "labels": {"name": "名称", "title": "标题", "category": "分类", "location": "位置", "status": "状态", "equipment": "设备", "member": "成员", "date": "日期", "slot": "时段", "issue": "问题", "assignee": "负责人", "species": "树种", "health": "健康状况", "lastInspection": "最近巡检", "tree": "树木", "reporter": "反馈人", "inspector": "巡检人", "activity": "活动", "checkpoint": "检查点", "route": "路线", "capacity": "人数上限", "phone": "联系方式", "project": "项目", "author": "作者", "editor": "编辑", "version": "版本", "wordCount": "字数", "owner": "负责人", "dueDate": "截止日期", "venue": "场地", "openingDate": "开幕日期", "collectionNo": "藏品编号", "condition": "保存状况", "serialNo": "序列号", "borrower": "借用人", "gear": "器材", "returnDate": "归还日期", "description": "描述", "ageGroup": "年龄段", "duration": "时长", "lesson": "课程", "instructor": "讲师", "type": "类型", "customer": "客户", "product": "产品", "priority": "优先级", "order": "订单", "stepName": "工序名称", "workstation": "工作台", "result": "结果"}} as { name:string; description:string; flow:string; resources:Resource[]; states:string[]; labels:Record<string,string> };

const TOKEN_KEY = 'treecare.token';
const roleNames: Record<Role, string> = { admin: '管理员', inspector: '巡检人员', resident: '居民' };
const roleHints: Record<Role, string> = {
  admin: '可维护全部树木档案、异常反馈与巡检记录及其状态',
  inspector: '可处理巡检与养护相关记录，树木档案为只读',
  resident: '可提交并查看本人发起的异常反馈',
};
// 与后端权限矩阵保持一致，仅用于隐藏界面上的不可用操作；接口安全由后端统一校验
const uiPermissions: Record<Role, { resources: string[]; create: string[]; transition: string[] }> = {
  admin: { resources: ['trees', 'reports', 'inspections'], create: ['trees', 'reports', 'inspections'], transition: ['trees', 'reports', 'inspections'] },
  inspector: { resources: ['trees', 'inspections'], create: ['inspections'], transition: ['inspections'] },
  resident: { resources: ['reports'], create: ['reports'], transition: [] },
};

class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

async function api(path: string, options: RequestInit = {}, token?: string | null) {
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.code || 'ERROR', data.error || `请求失败（${res.status}）`);
  return data;
}

export default function App() {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_KEY));
  const [user, setUser] = useState<User | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [loginForm, setLoginForm] = useState({ username: '', password: '' });
  const [authNotice, setAuthNotice] = useState('');
  const [active, setActive] = useState('');
  const [rows, setRows] = useState<Record<string, Item[]>>({});
  const [form, setForm] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState('');
  const [noticeError, setNoticeError] = useState(false);
  const [loading, setLoading] = useState(false);

  // 刷新页面后恢复登录状态：凭本地令牌换取当前用户，无效则回到登录页
  useEffect(() => {
    (async () => {
      if (!token) { setAuthChecked(true); return; }
      try {
        setUser(await api('/auth/me', {}, token));
      } catch {
        localStorage.removeItem(TOKEN_KEY);
        setToken(null);
        setAuthNotice('登录状态已过期，请重新登录');
      } finally {
        setAuthChecked(true);
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const perms = user ? uiPermissions[user.role] : null;
  const visibleResources = perms ? config.resources.filter(r => perms.resources.includes(r.key)) : [];
  const current = visibleResources.find(r => r.key === active) ?? visibleResources[0];
  const canCreate = !!(perms && current && perms.create.includes(current.key));
  const canTransition = !!(perms && current && perms.transition.includes(current.key));
  // 居民提交反馈时，反馈人固定为本人、状态由后端置为初始状态，无需填写
  const hiddenFields = user?.role === 'resident' ? ['reporter', 'status'] : [];
  const formFields = current ? current.fields.filter(f => !hiddenFields.includes(f)) : [];

  useEffect(() => {
    if (user && token) {
      setActive(uiPermissions[user.role].resources[0]);
      setNotice('');
      void load();
    }
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function load() {
    if (!user || !token) return;
    setLoading(true);
    try {
      const keys = uiPermissions[user.role].resources;
      const entries = await Promise.all(keys.map(async key => [key, await api(`/${key}`, {}, token)] as const));
      setRows(Object.fromEntries(entries));
    } catch (e) {
      handleError(e);
    } finally {
      setLoading(false);
    }
  }

  function showInfo(message: string) { setNotice(message); setNoticeError(false); }
  function showError(message: string) { setNotice(message); setNoticeError(true); }

  // 统一错误处理：401 未登录/会话过期回到登录页，403 越权给出提示，其余原样展示
  function handleError(e: unknown) {
    if (e instanceof ApiError) {
      if (e.status === 401) { logoutLocal(e.message); return; }
      showError(e.status === 403 ? `越权访问已被拦截：${e.message}` : e.message);
    } else {
      showError('网络异常，请稍后重试');
    }
  }

  function logoutLocal(message?: string) {
    localStorage.removeItem(TOKEN_KEY);
    setToken(null);
    setUser(null);
    setRows({});
    setForm({});
    setNotice('');
    setAuthNotice(message ?? '');
  }

  async function logout() {
    try { await api('/auth/logout', { method: 'POST' }, token); } catch { /* 忽略登出请求失败 */ }
    logoutLocal();
  }

  async function login(e: FormEvent) {
    e.preventDefault();
    setAuthNotice('');
    try {
      const res = await api('/auth/login', { method: 'POST', body: JSON.stringify(loginForm) });
      localStorage.setItem(TOKEN_KEY, res.token);
      setToken(res.token);
      setUser(res.user);
      setLoginForm({ username: '', password: '' });
    } catch (err) {
      setAuthNotice(err instanceof ApiError ? err.message : '登录失败，请稍后重试');
    }
  }

  function label(field: string) { return config.labels[field] || field; }

  async function create(e: FormEvent) {
    e.preventDefault();
    if (!user || !token || !current) return;
    try {
      const payload: Record<string, string> = { ...form };
      if (user.role === 'resident') payload.reporter = user.name;
      if (current.fields.includes('status')) payload.status = payload.status || config.states[0];
      await api(`/${current.key}`, { method: 'POST', body: JSON.stringify(payload) }, token);
      setForm({});
      showInfo('记录已创建');
      await load();
    } catch (err) { handleError(err); }
  }

  async function transition(item: Item) {
    if (!current) return;
    const i = config.states.indexOf(item.status);
    const next = config.states[Math.min(i + 1, config.states.length - 1)];
    if (!next || next === item.status) return;
    try {
      await api(`/${current.key}/${item.id}/transition`, { method: 'POST', body: JSON.stringify({ status: next }) }, token);
      showInfo(`状态已更新为：${next}`);
      await load();
    } catch (err) { handleError(err); }
  }

  if (!authChecked) {
    return <div className="login-wrap"><div className="login-card"><span className="eyebrow">LOADING</span><h1>正在恢复登录状态…</h1></div></div>;
  }

  if (!user) {
    return (
      <div className="login-wrap">
        <div className="login-card">
          <span className="eyebrow">CITY TREE CARE</span>
          <h1>{config.name}</h1>
          <p>{config.description}</p>
          {authNotice && <div className="login-error">{authNotice}</div>}
          <form className="login-form" onSubmit={login}>
            <label>用户名
              <input required autoFocus value={loginForm.username} onChange={e => setLoginForm({ ...loginForm, username: e.target.value })} placeholder="请输入用户名" />
            </label>
            <label>密码
              <input required type="password" value={loginForm.password} onChange={e => setLoginForm({ ...loginForm, password: e.target.value })} placeholder="请输入密码" />
            </label>
            <button className="primary" type="submit">登录</button>
          </form>
          <div className="login-accounts">
            <b>演示账号</b><br />
            管理员 <code>admin / admin123</code>：维护全部档案与状态<br />
            巡检人员 <code>inspector / inspector123</code>：处理巡检与养护记录<br />
            居民 <code>resident / resident123</code>：提交并查看本人反馈
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <header>
        <div>
          <span className="eyebrow">NODE.JS · TYPESCRIPT · VITE · REACT</span>
          <h1>{config.name}</h1>
          <p>{config.description}</p>
        </div>
        <div className="userbar">
          <span className="role-tag">{roleNames[user.role]}</span>
          <span className="username">{user.name}</span>
          <button className="ghost" onClick={logout}>退出登录</button>
        </div>
      </header>
      <div className="layout">
        <aside>
          <h2>业务模块</h2>
          {visibleResources.map(r => (
            <button className={r.key === current?.key ? 'nav active' : 'nav'} onClick={() => { setActive(r.key); setForm({}); setNotice(''); }} key={r.key}>{r.label}</button>
          ))}
          <div className="flow"><b>当前权限</b><p>{roleHints[user.role]}</p></div>
        </aside>
        <main>
          {current && <>
            <div className="heading">
              <div>
                <span className="eyebrow">CURRENT MODULE</span>
                <h2>{current.label}{!canCreate && <span className="readonly-tag">只读</span>}</h2>
              </div>
              <span className="muted">{(rows[current.key] || []).length} 条记录</span>
            </div>
            {notice && <div className={noticeError ? 'notice error' : 'notice'}>{notice}</div>}
            {canCreate && (
              <section className="panel">
                <h3>新增{current.label}</h3>
                <form onSubmit={create} className="form">
                  {formFields.map(field => (
                    <label key={field}>{label(field)}
                      <input required={field !== 'status'} value={form[field] || ''} onChange={e => setForm({ ...form, [field]: e.target.value })} placeholder={`请输入${label(field)}`} />
                    </label>
                  ))}
                  <button className="primary">保存记录</button>
                </form>
              </section>
            )}
            <section className="panel">
              <div className="panel-title"><h3>{current.label}列表</h3><button className="ghost" onClick={load}>刷新</button></div>
              {loading ? <p className="muted">正在加载...</p> : (rows[current.key] || []).length === 0 ? <p className="muted">暂无记录</p> : (
                <div className="table">
                  <table>
                    <thead>
                      <tr>{current.fields.map(f => <th key={f}>{label(f)}</th>)}{canTransition && <th>操作</th>}</tr>
                    </thead>
                    <tbody>
                      {(rows[current.key] || []).map(item => (
                        <tr key={item.id}>
                          {current.fields.map(f => <td key={f}>{item[f] || '-'}</td>)}
                          {canTransition && (
                            <td><button className="action" disabled={!config.states.includes(item.status) || item.status === config.states.at(-1)} onClick={() => transition(item)}>推进状态</button></td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>}
        </main>
      </div>
    </div>
  );
}

import { useEffect, useState, type FormEvent } from 'react';
import { roleNames, request, ApiError, useAuth, type AuthUser } from './auth';
import {
  can,
  visibleResources,
  reportResidentFields,
  roleDescriptions,
  type Action,
  type ResourceKey,
} from './permissions';

// ---------------------------------------------------------------------------
// 模块配置（与后端资源 / 状态对齐）
// ---------------------------------------------------------------------------
type Item = { id: string; createdAt: string; [key: string]: string };
type Resource = { key: ResourceKey; label: string; fields: string[] };

const config = {
  name: '城市公共树木养护协作系统',
  description: '用于维护城市公共树木档案、巡检任务和居民异常反馈的基础协作系统。',
  flow: '建立树木档案 → 安排巡检 → 记录异常 → 派发养护 → 完成复核',
  resources: [
    { key: 'trees', label: '树木档案', fields: ['species', 'location', 'health', 'lastInspection'] },
    { key: 'reports', label: '异常反馈', fields: ['tree', 'reporter', 'issue', 'status'] },
    { key: 'inspections', label: '巡检任务', fields: ['tree', 'inspector', 'date', 'status'] },
  ] as Resource[],
  states: ['待派单', '待执行', '处理中', '已完成'],
  labels: {
    status: '状态', date: '日期', issue: '问题', species: '树种', health: '健康状况',
    lastInspection: '最近巡检', tree: '树木', reporter: '反馈人', inspector: '巡检人',
  } as Record<string, string>,
};

function describeError(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  return fallback;
}

export default function Shell({ user }: { user: AuthUser }) {
  const { logout } = useAuth();
  const allowed = visibleResources(user.role);
  const [active, setActive] = useState<ResourceKey>(allowed[0]);
  const [rows, setRows] = useState<Record<string, Item[]>>({});
  const [form, setForm] = useState<Record<string, string>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const current = config.resources.find((item) => item.key === active)!;
  // 居民提交反馈只需填写树木与问题，其余字段服务端强制写入
  const formFields =
    user.role === 'resident' && active === 'reports'
      ? reportResidentFields
      : current.fields;

  function flash(type: 'success' | 'error', text: string) {
    setNotice({ type, text });
  }

  async function load() {
    setLoading(true);
    try {
      const entries = await Promise.all(
        allowed.map(
          async (key) => [key, await request<Item[]>(`/${key}`)] as const,
        ),
      );
      setRows(Object.fromEntries(entries));
    } catch (error) {
      // 401 由全局处理器统一跳转登录；其余错误就地提示
      flash('error', describeError(error, '数据加载失败'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 角色不可见的模块一律不展示
  useEffect(() => {
    if (!allowed.includes(active)) {
      setActive(allowed[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user.role]);

  function label(field: string) {
    return config.labels[field] || field;
  }

  function switchModule(key: ResourceKey) {
    setActive(key);
    setForm({});
    setEditingId(null);
    setNotice(null);
  }

  function startEdit(item: Item) {
    const next: Record<string, string> = {};
    for (const field of current.fields) next[field] = item[field] ?? '';
    setForm(next);
    setEditingId(item.id);
    setNotice(null);
  }

  function cancelEdit() {
    setForm({});
    setEditingId(null);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      if (editingId) {
        await request(`/${active}/${editingId}`, {
          method: 'PATCH',
          body: JSON.stringify(form),
        });
        flash('success', '记录已更新');
      } else {
        const body: Record<string, string> = { ...form };
        // 居民提交的反馈由服务端强制为“待派单”；其他模块给出业务默认初态
        if (!body.status && user.role !== 'resident') {
          body.status = active === 'inspections' ? '待执行' : config.states[0];
        }
        await request(`/${active}`, { method: 'POST', body: JSON.stringify(body) });
        flash('success', '记录已创建');
      }
      setForm({});
      setEditingId(null);
      await load();
    } catch (error) {
      flash('error', describeError(error, editingId ? '更新失败' : '创建失败'));
    } finally {
      setSaving(false);
    }
  }

  async function transition(item: Item) {
    const index = config.states.indexOf(item.status);
    const next = config.states[Math.min(index + 1, config.states.length - 1)];
    if (!next || next === item.status) return;
    try {
      await request(`/${active}/${item.id}/transition`, {
        method: 'POST',
        body: JSON.stringify({ status: next }),
      });
      flash('success', `状态已更新为：${next}`);
      await load();
    } catch (error) {
      flash('error', describeError(error, '状态更新失败'));
    }
  }

  async function remove(item: Item) {
    if (!window.confirm(`确定删除该${current.label}记录吗？`)) return;
    try {
      await request(`/${active}/${item.id}`, { method: 'DELETE' });
      flash('success', '记录已删除');
      if (editingId === item.id) cancelEdit();
      await load();
    } catch (error) {
      flash('error', describeError(error, '删除失败'));
    }
  }

  const showCreate = can(user.role, active, 'create') || can(user.role, active, 'update');

  function actionAvailable(action: Action) {
    return can(user.role, active, action);
  }

  return (
    <div className="app">
      <header>
        <div>
          <span className="eyebrow">NODE.JS · TYPESCRIPT · VITE · REACT</span>
          <h1>{config.name}</h1>
          <p>{config.description}</p>
        </div>
        <div className="header-user">
          <span className={`role-tag role-${user.role}`}>{roleNames[user.role]}</span>
          <span className="user-name">{user.name}</span>
          <button className="ghost" onClick={logout}>
            退出登录
          </button>
        </div>
      </header>

      <div className="layout">
        <aside>
          <h2>业务模块</h2>
          {config.resources
            .filter((resource) => allowed.includes(resource.key))
            .map((resource) => (
              <button
                className={resource.key === active ? 'nav active' : 'nav'}
                onClick={() => switchModule(resource.key)}
                key={resource.key}
              >
                {resource.label}
              </button>
            ))}
          <div className="flow">
            <b>推荐流程</b>
            <p>{config.flow}</p>
          </div>
        </aside>

        <main>
          <div className="heading">
            <div>
              <span className="eyebrow">CURRENT MODULE</span>
              <h2>{current.label}</h2>
            </div>
            <span className="muted">{(rows[active] || []).length} 条记录</span>
          </div>

          <div className="role-hint">{roleDescriptions[user.role]}</div>

          {notice && (
            <div className={`notice ${notice.type === 'error' ? 'error' : ''}`}>{notice.text}</div>
          )}

          {showCreate && (
            <section className="panel">
              <h3>{editingId ? `编辑${current.label}` : `新增${current.label}`}</h3>
              <form onSubmit={submit} className="form">
                {formFields.map((field) => (
                  <label key={field}>
                    {label(field)}
                    {field === 'status' ? (
                      <select
                        value={form[field] || ''}
                        onChange={(event) => setForm({ ...form, [field]: event.target.value })}
                      >
                        <option value="">请选择状态</option>
                        {config.states.map((state) => (
                          <option key={state} value={state}>
                            {state}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        required
                        value={form[field] || ''}
                        onChange={(event) => setForm({ ...form, [field]: event.target.value })}
                        placeholder={`请输入${label(field)}`}
                      />
                    )}
                  </label>
                ))}
                <div className="form-actions">
                  <button className="primary" disabled={saving}>
                    {saving ? '保存中…' : editingId ? '保存修改' : '保存记录'}
                  </button>
                  {editingId && (
                    <button type="button" className="ghost" onClick={cancelEdit}>
                      取消编辑
                    </button>
                  )}
                </div>
              </form>
            </section>
          )}

          <section className="panel">
            <div className="panel-title">
              <h3>{current.label}列表</h3>
              <button className="ghost" onClick={load}>
                刷新
              </button>
            </div>
            {loading ? (
              <p className="muted">正在加载...</p>
            ) : (rows[active] || []).length === 0 ? (
              <p className="muted">
                {active === 'reports' && user.role === 'resident'
                  ? '您还没有发起过异常反馈，可在上方表单提交。'
                  : '暂无记录'}
              </p>
            ) : (
              <div className="table">
                <table>
                  <thead>
                    <tr>
                      {current.fields.map((field) => (
                        <th key={field}>{label(field)}</th>
                      ))}
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(rows[active] || []).map((item) => {
                      const canTransition =
                        actionAvailable('transition') &&
                        config.states.includes(item.status) &&
                        item.status !== config.states.at(-1);
                      const showActions =
                        canTransition || actionAvailable('update') || actionAvailable('delete');
                      return (
                        <tr key={item.id}>
                          {current.fields.map((field) => (
                            <td key={field}>{item[field] || '-'}</td>
                          ))}
                          <td className="row-actions">
                            {actionAvailable('update') && (
                              <button
                                className="action"
                                onClick={() => startEdit(item)}
                                disabled={editingId === item.id}
                              >
                                编辑
                              </button>
                            )}
                            {canTransition && (
                              <button className="action" onClick={() => transition(item)}>
                                推进状态
                              </button>
                            )}
                            {actionAvailable('delete') && (
                              <button className="action danger" onClick={() => remove(item)}>
                                删除
                              </button>
                            )}
                            {!showActions && <span className="muted">只读</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </main>
      </div>
    </div>
  );
}

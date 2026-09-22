import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

type Role = 'admin' | 'inspector' | 'resident';
type ResourceKey = 'trees' | 'reports' | 'inspections';
type Action = 'read' | 'create' | 'update' | 'transition' | 'delete';
type Item = { id: string; createdAt: string; [key: string]: string };
type User = { id: string; username: string; name: string; role: Role; passwordHash: string };

const PORT = Number(process.env.PORT || 4001);
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 会话有效期 12 小时
const root = dirname(dirname(fileURLToPath(import.meta.url)));

const resources: ResourceKey[] = ['trees', 'reports', 'inspections'];
const states = ['待派单', '待执行', '处理中', '已完成'];

// 角色权限矩阵：接口安全的唯一权威，前端仅据此隐藏不可用操作
// admin     管理员：维护全部档案、反馈、巡检记录及状态
// inspector 巡检人员：处理巡检与养护相关记录，树木档案只读
// resident  居民：只能提交和查看本人发起的异常反馈
const permissions: Record<Role, Partial<Record<ResourceKey, Action[]>>> = {
  admin: {
    trees: ['read', 'create', 'update', 'transition', 'delete'],
    reports: ['read', 'create', 'update', 'transition', 'delete'],
    inspections: ['read', 'create', 'update', 'transition', 'delete'],
  },
  inspector: {
    trees: ['read'],
    inspections: ['read', 'create', 'update', 'transition'],
  },
  resident: {
    reports: ['read', 'create'],
  },
};

function can(role: Role, resource: ResourceKey, action: Action) {
  return permissions[role]?.[resource]?.includes(action) ?? false;
}

// ---------- 用户与口令（scrypt 加盐哈希） ----------
function hashPassword(password: string, salt = randomBytes(16).toString('hex')) {
  return `${salt}:${scryptSync(password, salt, 32).toString('hex')}`;
}
function verifyPassword(password: string, stored: string) {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = scryptSync(password, salt, 32);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const users: User[] = [
  { id: randomUUID(), username: 'admin', name: '系统管理员', role: 'admin', passwordHash: hashPassword('admin123') },
  { id: randomUUID(), username: 'inspector', name: '养护一组', role: 'inspector', passwordHash: hashPassword('inspector123') },
  { id: randomUUID(), username: 'resident', name: '周宁', role: 'resident', passwordHash: hashPassword('resident123') },
  { id: randomUUID(), username: 'resident2', name: '李明', role: 'resident', passwordHash: hashPassword('resident123') },
];

// ---------- 会话（内存令牌，可替换为 JWT / Redis） ----------
const sessions = new Map<string, { userId: string; expiresAt: number }>();

function publicUser(user: User) {
  return { id: user.id, username: user.username, name: user.name, role: user.role };
}
function issueToken(userId: string) {
  const token = randomBytes(32).toString('hex');
  sessions.set(token, { userId, expiresAt: Date.now() + SESSION_TTL_MS });
  return token;
}
function resolveUser(req: IncomingMessage): User | null {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return users.find(u => u.id === session.userId) ?? null;
}

// ---------- 业务数据（内存存储，可替换为 Repository / 数据库） ----------
const seed: Record<string, Record<string, string>[]> = {
  trees: [
    { species: '香樟', location: '青松路18号', health: '良好', lastInspection: '2026-09-10' },
    { species: '银杏', location: '滨河公园东门', health: '需关注', lastInspection: '2026-09-12' },
  ],
  reports: [
    { tree: '银杏', reporter: '周宁', issue: '树冠部分枝条枯黄', status: '待派单' },
    { tree: '香樟', reporter: '李明', issue: '树干底部出现虫洞', status: '待派单' },
  ],
  inspections: [{ tree: '香樟', inspector: '养护一组', date: '2026-09-23', status: '待执行' }],
};
const data: Record<string, Item[]> = Object.fromEntries(
  resources.map(key => [key, (seed[key] || []).map(item => ({ ...item, id: randomUUID(), createdAt: new Date().toISOString() }))]),
);

// ---------- 统一响应与错误格式 ----------
function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(body));
}
function fail(res: ServerResponse, status: number, code: string, message: string) {
  json(res, status, { error: message, code });
}
const unauthorized = (res: ServerResponse) => fail(res, 401, 'UNAUTHENTICATED', '未登录或会话已过期，请重新登录');
const forbidden = (res: ServerResponse) => fail(res, 403, 'FORBIDDEN', '当前角色没有权限执行此操作');

async function readBody(req: IncomingMessage) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}
function parts(url: string) {
  return new URL(url, 'http://localhost').pathname.split('/').filter(Boolean);
}
// 客户端不得覆盖系统字段
function sanitize(input: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...input };
  delete copy.id;
  delete copy.createdAt;
  return copy;
}

const server = createServer(async (req, res) => {
  try {
    const p = parts(req.url || '/');

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
      });
      return res.end();
    }

    // 健康检查（公开）
    if (req.method === 'GET' && p[0] === 'api' && p[1] === 'health') {
      return json(res, 200, {
        status: 'ok',
        project: 'city-tree-care-collaboration',
        workflow: '建立树木档案 → 安排巡检 → 记录异常 → 派发养护 → 完成复核',
      });
    }

    // ---------- 认证接口 ----------
    if (p[0] === 'api' && p[1] === 'auth') {
      if (req.method === 'POST' && p[2] === 'login') {
        const { username, password } = await readBody(req);
        const user = users.find(u => u.username === username);
        if (!user || !verifyPassword(String(password ?? ''), user.passwordHash)) {
          return fail(res, 401, 'UNAUTHENTICATED', '用户名或密码错误');
        }
        return json(res, 200, { token: issueToken(user.id), user: publicUser(user) });
      }
      // 刷新页面后凭令牌恢复登录状态
      if (req.method === 'GET' && p[2] === 'me') {
        const user = resolveUser(req);
        if (!user) return unauthorized(res);
        return json(res, 200, publicUser(user));
      }
      if (req.method === 'POST' && p[2] === 'logout') {
        const header = req.headers.authorization ?? '';
        const token = header.startsWith('Bearer ') ? header.slice(7) : '';
        if (token) sessions.delete(token);
        return json(res, 200, { ok: true });
      }
      return fail(res, 404, 'NOT_FOUND', '接口不存在');
    }

    // 非 API 请求：返回前端页面
    if (p[0] !== 'api') {
      if (req.method === 'GET') {
        const html = await readFile(join(root, 'index.html'), 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(html);
      }
      return fail(res, 404, 'NOT_FOUND', 'Not found');
    }

    // ---------- 以下业务接口一律要求登录 ----------
    const user = resolveUser(req);
    if (!user) return unauthorized(res);

    const resource = p[1] as ResourceKey;
    if (!resource || !resources.includes(resource)) return fail(res, 404, 'NOT_FOUND', '未知业务模块');

    // 列表
    if (req.method === 'GET' && p.length === 2) {
      if (!can(user.role, resource, 'read')) return forbidden(res);
      // 居民数据隔离：只能看到本人发起的异常反馈
      const items =
        user.role === 'resident' && resource === 'reports'
          ? data[resource].filter(item => item.reporter === user.name)
          : data[resource];
      return json(res, 200, items);
    }

    // 新建
    if (req.method === 'POST' && p.length === 2) {
      if (!can(user.role, resource, 'create')) return forbidden(res);
      const payload = sanitize(await readBody(req)) as Record<string, string>;
      if (user.role === 'resident' && resource === 'reports') {
        payload.reporter = user.name; // 反馈人固定为本人，防止冒名提交
        payload.status = states[0]; // 状态固定为初始状态，防止越权推进
      }
      const item = { ...payload, id: randomUUID(), createdAt: new Date().toISOString() } as Item;
      data[resource].push(item);
      return json(res, 201, item);
    }

    const item = data[resource].find(x => x.id === p[2]);
    if (!item) return fail(res, 404, 'NOT_FOUND', '记录不存在');

    // 状态推进
    if (req.method === 'POST' && p[3] === 'transition') {
      if (!can(user.role, resource, 'transition')) return forbidden(res);
      const next = (await readBody(req)).status;
      if (!states.includes(next)) return fail(res, 400, 'BAD_REQUEST', '不支持的状态');
      item.status = next;
      return json(res, 200, item);
    }

    // 编辑
    if (req.method === 'PATCH' && p.length === 3) {
      if (!can(user.role, resource, 'update')) return forbidden(res);
      Object.assign(item, sanitize(await readBody(req)));
      return json(res, 200, item);
    }

    // 删除
    if (req.method === 'DELETE' && p.length === 3) {
      if (!can(user.role, resource, 'delete')) return forbidden(res);
      data[resource] = data[resource].filter(x => x.id !== item.id);
      return json(res, 200, { ok: true });
    }

    return fail(res, 405, 'METHOD_NOT_ALLOWED', '不支持的操作');
  } catch (error) {
    return fail(res, 500, 'INTERNAL_ERROR', error instanceof Error ? error.message : '服务器错误');
  }
});

server.listen(PORT, () => console.log(`API server running at http://localhost:${PORT}`));

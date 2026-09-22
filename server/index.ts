import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// 领域类型
// ---------------------------------------------------------------------------
type Role = 'admin' | 'inspector' | 'resident';
type ResourceKey = 'trees' | 'reports' | 'inspections';
type Action = 'read' | 'create' | 'update' | 'delete' | 'transition';

type Item = Record<string, string> & {
  id: string;
  createdAt: string;
  ownerId?: string;
};

interface PublicUser {
  id: string;
  username: string;
  name: string;
  role: Role;
}
interface User extends PublicUser {
  salt: string;
  hash: Buffer;
}

interface Session {
  token: string;
  userId: string;
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// 统一错误
// ---------------------------------------------------------------------------
class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// 用户与口令（演示账号；生产应放到数据库/环境变量中）
// ---------------------------------------------------------------------------
function createUser(username: string, password: string, name: string, role: Role): User {
  const salt = randomBytes(16).toString('hex');
  return { id: randomUUID(), username, name, role, salt, hash: scryptSync(password, salt, 64) };
}

function verifyPassword(user: User, password: string): boolean {
  const candidate = scryptSync(password, user.salt, 64);
  return candidate.length === user.hash.length && timingSafeEqual(candidate, user.hash);
}

function toPublicUser(user: User): PublicUser {
  return { id: user.id, username: user.username, name: user.name, role: user.role };
}

const users: User[] = [
  createUser('admin', 'admin123', '林管理员', 'admin'),
  createUser('inspector', 'inspect123', '陈巡检（养护一组）', 'inspector'),
  createUser('resident', 'resident123', '周宁', 'resident'),
];
const userByUsername = new Map(users.map((user) => [user.username, user]));

// ---------------------------------------------------------------------------
// 内存业务数据
// ---------------------------------------------------------------------------
const resources: ResourceKey[] = ['trees', 'reports', 'inspections'];
const states = ['待派单', '待执行', '处理中', '已完成'];
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function makeItem(fields: Record<string, string>): Item {
  return { ...fields, id: randomUUID(), createdAt: new Date().toISOString() };
}

const data = new Map<ResourceKey, Item[]>([
  [
    'trees',
    [
      makeItem({ species: '香樟', location: '青松路18号', health: '良好', lastInspection: '2026-09-10' }),
      makeItem({ species: '银杏', location: '滨河公园东门', health: '需关注', lastInspection: '2026-09-12' }),
    ],
  ],
  [
    'reports',
    [
      // 种子反馈归属居民账号“周宁”，登录后可见
      makeItem({
        tree: '银杏',
        reporter: '周宁',
        issue: '树冠部分枝条枯黄',
        status: '待派单',
        ownerId: users[2].id,
      }),
    ],
  ],
  [
    'inspections',
    [makeItem({ tree: '香樟', inspector: '养护一组', date: '2026-09-23', status: '待执行' })],
  ],
]);

// ---------------------------------------------------------------------------
// 会话（不透明令牌，服务端保存，可过期、可注销）
// ---------------------------------------------------------------------------
const sessions = new Map<string, Session>();

function createSession(userId: string): Session {
  const session: Session = {
    token: randomBytes(32).toString('hex'),
    userId,
    expiresAt: Date.now() + SESSION_TTL_MS,
  };
  sessions.set(session.token, session);
  return session;
}

// ---------------------------------------------------------------------------
// RBAC 权限矩阵：接口保护的唯一权威来源（前端隐藏仅为体验优化）
// ---------------------------------------------------------------------------
const ALL_ACTIONS: Action[] = ['read', 'create', 'update', 'delete', 'transition'];

const permissions: Record<Role, Partial<Record<ResourceKey, Action[]>>> = {
  // 管理员：维护全部档案和状态
  admin: { trees: ALL_ACTIONS, reports: ALL_ACTIONS, inspections: ALL_ACTIONS },
  // 巡检人员：树木档案只读，处理巡检任务与异常反馈的养护流转
  inspector: {
    trees: ['read'],
    reports: ['read', 'update', 'transition'],
    inspections: ['read', 'create', 'update', 'transition'],
  },
  // 居民：只能提交并查看自己发起的异常反馈
  resident: {
    reports: ['read', 'create'],
  },
};

function assertAuthorized(user: User, resource: ResourceKey, action: Action): void {
  const allowed = permissions[user.role][resource] ?? [];
  if (!allowed.includes(action)) {
    throw new HttpError(403, 'FORBIDDEN', '权限不足：当前角色无权执行该操作');
  }
}

// 不允许客户端自行设置的受保护字段
const PROTECTED_FIELDS = ['id', 'createdAt', 'ownerId'];

// ---------------------------------------------------------------------------
// HTTP 工具
// ---------------------------------------------------------------------------
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
} as const;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...CORS_HEADERS,
  });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  let size = 0;
  for await (const chunk of req) {
    raw += chunk;
    size += chunk.length;
    if (size > 1_000_000) {
      throw new HttpError(413, 'PAYLOAD_TOO_LARGE', '请求内容过大');
    }
  }
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    throw new HttpError(400, 'INVALID_JSON', '请求体不是合法的 JSON');
  }
}

function field(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === 'string' ? value.trim() : '';
}

// ---------------------------------------------------------------------------
// 认证 / 鉴权
// ---------------------------------------------------------------------------
function authenticate(req: IncomingMessage): User {
  const match = /^Bearer ([A-Za-z0-9._-]+)$/.exec(req.headers.authorization ?? '');
  const session = match ? sessions.get(match[1]) : undefined;
  if (!session) {
    throw new HttpError(401, 'UNAUTHORIZED', '未登录或登录状态已失效，请先登录');
  }
  if (session.expiresAt <= Date.now()) {
    sessions.delete(session.token);
    throw new HttpError(401, 'SESSION_EXPIRED', '登录已过期，请重新登录');
  }
  const user = users.find((item) => item.id === session.userId);
  if (!user) {
    sessions.delete(session.token);
    throw new HttpError(401, 'UNAUTHORIZED', '账号不存在，请重新登录');
  }
  return user;
}

function writableFields(actor: User, body: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(body)) {
    if (typeof value !== 'string') continue;
    if (actor.role !== 'admin' && PROTECTED_FIELDS.includes(key)) continue;
    result[key] = value;
  }
  return result;
}

function buildNewItem(actor: User, resource: ResourceKey, body: Record<string, unknown>): Item {
  const item: Item = { ...writableFields(actor, body), id: randomUUID(), createdAt: new Date().toISOString() };

  if (resource === 'reports') {
    if (actor.role === 'resident') {
      // 居民提交反馈：反馈人、状态、归属一律由服务端强制写入，防止伪造
      item.tree = (item.tree || '').trim();
      item.issue = (item.issue || '').trim();
      if (!item.tree || !item.issue) {
        throw new HttpError(400, 'VALIDATION_ERROR', '请填写树木位置/名称和问题描述');
      }
      item.reporter = actor.name;
      item.status = '待派单';
      item.ownerId = actor.id;
    } else {
      item.status = item.status || states[0];
      item.ownerId = item.ownerId || actor.id;
    }
  }

  if (resource === 'inspections') {
    item.status = item.status || '待执行';
  }

  return item;
}

function applyPatch(actor: User, resource: ResourceKey, item: Item, body: Record<string, unknown>): void {
  const patch = writableFields(actor, body);
  if (actor.role === 'resident' && resource === 'reports') {
    // 矩阵层已拒绝（无 update 权限），双保险
    throw new HttpError(403, 'FORBIDDEN', '权限不足：当前角色无权执行该操作');
  }
  Object.assign(item, patch);
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT || 4001);
const root = dirname(dirname(fileURLToPath(import.meta.url)));

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    const parts = new URL(req.url ?? '/', 'http://localhost').pathname.split('/').filter(Boolean);

    // 非 /api：返回前端入口（开发态由 Vite 提供资源）
    if (parts[0] !== 'api') {
      if (req.method === 'GET') {
        const html = await readFile(join(root, 'index.html'), 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }
      throw new HttpError(404, 'NOT_FOUND', '资源不存在');
    }

    // 健康检查：公开
    if (req.method === 'GET' && parts[1] === 'health' && parts.length === 2) {
      sendJson(res, 200, {
        status: 'ok',
        project: 'city-tree-care-collaboration',
        workflow: '建立树木档案 → 安排巡检 → 记录异常 → 派发养护 → 完成复核',
      });
      return;
    }

    // 认证接口：/api/auth/login、/api/auth/me、/api/auth/logout
    if (parts[1] === 'auth' && parts.length === 3) {
      if (req.method === 'POST' && parts[2] === 'login') {
        const body = await readBody(req);
        const username = field(body, 'username');
        const password = field(body, 'password');
        if (!username || !password) {
          throw new HttpError(400, 'VALIDATION_ERROR', '请输入用户名和密码');
        }
        const user = userByUsername.get(username);
        if (!user) {
          // 用户不存在时也执行一次哈希，降低用户名枚举的时序差异
          scryptSync(password, 'invalid-user-placeholder-salt', 64);
          throw new HttpError(401, 'INVALID_CREDENTIALS', '用户名或密码错误');
        }
        if (!verifyPassword(user, password)) {
          throw new HttpError(401, 'INVALID_CREDENTIALS', '用户名或密码错误');
        }
        const session = createSession(user.id);
        sendJson(res, 200, { token: session.token, user: toPublicUser(user) });
        return;
      }

      if (req.method === 'GET' && parts[2] === 'me') {
        sendJson(res, 200, toPublicUser(authenticate(req)));
        return;
      }

      if (req.method === 'POST' && parts[2] === 'logout') {
        const actor = authenticate(req);
        const match = /^Bearer ([A-Za-z0-9._-]+)$/.exec(req.headers.authorization ?? '');
        if (match) sessions.delete(match[1]);
        sendJson(res, 200, { ok: true, username: actor.username });
        return;
      }

      throw new HttpError(405, 'METHOD_NOT_ALLOWED', '不支持的认证操作');
    }

    // 以下全部为受保护业务接口：先认证（401），再鉴权（403）
    const actor = authenticate(req);
    const resource = parts[1] as ResourceKey;
    if (!parts[1] || !resources.includes(resource)) {
      throw new HttpError(404, 'NOT_FOUND', '未知业务模块');
    }
    const collection = data.get(resource)!;
    const assertCan = (action: Action) => assertAuthorized(actor, resource, action);

    // 集合：GET 列表 / POST 新建
    if (parts.length === 2) {
      if (req.method === 'GET') {
        assertCan('read');
        // 居民只能看到自己发起的反馈（服务端强制过滤）
        const rows =
          resource === 'reports' && actor.role === 'resident'
            ? collection.filter((item) => item.ownerId === actor.id)
            : collection;
        sendJson(res, 200, rows);
        return;
      }
      if (req.method === 'POST') {
        assertCan('create');
        const item = buildNewItem(actor, resource, await readBody(req));
        collection.push(item);
        sendJson(res, 201, item);
        return;
      }
      throw new HttpError(405, 'METHOD_NOT_ALLOWED', '不支持的操作');
    }

    const item = collection.find((entry) => entry.id === parts[2]);
    if (!item) {
      throw new HttpError(404, 'NOT_FOUND', '记录不存在');
    }

    // 单条：GET /:id
    if (parts.length === 3 && req.method === 'GET') {
      assertCan('read');
      if (resource === 'reports' && actor.role === 'resident' && item.ownerId !== actor.id) {
        throw new HttpError(403, 'FORBIDDEN', '权限不足：只能查看自己发起的异常反馈');
      }
      sendJson(res, 200, item);
      return;
    }

    // 状态推进：POST /:id/transition
    if (parts.length === 4 && parts[3] === 'transition' && req.method === 'POST') {
      assertCan('transition');
      const next = field(await readBody(req), 'status');
      if (!states.includes(next)) {
        throw new HttpError(400, 'VALIDATION_ERROR', '不支持的状态');
      }
      item.status = next;
      sendJson(res, 200, item);
      return;
    }

    // 编辑：PATCH /:id
    if (parts.length === 3 && req.method === 'PATCH') {
      assertCan('update');
      applyPatch(actor, resource, item, await readBody(req));
      sendJson(res, 200, item);
      return;
    }

    // 删除：DELETE /:id
    if (parts.length === 3 && req.method === 'DELETE') {
      assertCan('delete');
      data.set(resource, collection.filter((entry) => entry.id !== item.id));
      sendJson(res, 200, { ok: true });
      return;
    }

    throw new HttpError(405, 'METHOD_NOT_ALLOWED', '不支持的操作');
  } catch (error) {
    if (error instanceof HttpError) {
      sendJson(res, error.status, { error: error.message, code: error.code });
      return;
    }
    console.error(error);
    sendJson(res, 500, { error: '服务器内部错误', code: 'INTERNAL_ERROR' });
  }
});

server.listen(PORT, () => console.log(`API server running at http://localhost:${PORT}`));

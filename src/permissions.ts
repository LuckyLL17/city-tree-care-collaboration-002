import type { Role } from './auth';

export type ResourceKey = 'trees' | 'reports' | 'inspections';
export type Action = 'read' | 'create' | 'update' | 'delete' | 'transition';

const ALL_ACTIONS: Action[] = ['read', 'create', 'update', 'delete', 'transition'];

// 与后端 server/index.ts 中的权限矩阵保持一致；前端只用于隐藏入口，
// 所有操作仍会在服务端再做一次认证与鉴权。
const matrix: Record<Role, Partial<Record<ResourceKey, Action[]>>> = {
  admin: { trees: ALL_ACTIONS, reports: ALL_ACTIONS, inspections: ALL_ACTIONS },
  inspector: {
    trees: ['read'],
    reports: ['read', 'update', 'transition'],
    inspections: ['read', 'create', 'update', 'transition'],
  },
  resident: {
    reports: ['read', 'create'],
  },
};

export function can(role: Role, resource: ResourceKey, action: Action): boolean {
  return (matrix[role][resource] ?? []).includes(action);
}

export function visibleResources(role: Role): ResourceKey[] {
  return (['trees', 'reports', 'inspections'] as ResourceKey[]).filter((key) =>
    can(role, key, 'read'),
  );
}

// 居民提交反馈时仅需填写的字段（reporter / status / ownerId 由服务端强制写入）
export const reportResidentFields = ['tree', 'issue'];

export const roleDescriptions: Record<Role, string> = {
  admin: '管理员：可维护全部树木档案、异常反馈、巡检任务及状态流转。',
  inspector: '巡检人员：可查看树木档案，创建巡检任务，处理巡检与养护相关记录。',
  resident: '居民：可提交异常反馈，并查看自己发起的反馈及处理状态。',
};

import { AuthProvider, useAuth } from './auth';
import Login from './Login';
import Shell from './Shell';

function Root() {
  const { user, status } = useAuth();

  // 刷新页面后正在用本地令牌向服务端恢复会话
  if (status === 'restoring') {
    return <div className="bootstrap">正在恢复登录状态…</div>;
  }

  // 未登录：统一登录入口；业务页面不会渲染，接口也由服务端拦截
  if (!user || status === 'anonymous') {
    return <Login />;
  }

  return <Shell user={user} />;
}

export default function App() {
  return (
    <AuthProvider>
      <Root />
    </AuthProvider>
  );
}

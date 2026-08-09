import { Link, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { IconBook } from './icons';

export default function Layout({ children }: { children: ReactNode }) {
  const location = useLocation();
  const isActive = (path: string) =>
    path === '/'
      ? location.pathname === '/' || location.pathname.startsWith('/students')
      : location.pathname.startsWith(path);

  return (
    <div className="layout">
      <header className="navbar">
        <div className="navbar-inner">
          <Link to="/" className="navbar-brand">
            <IconBook size={20} />
            学伴 AI
          </Link>
          <nav className="navbar-links">
            <Link to="/" className={isActive('/') ? 'nav-link active' : 'nav-link'}>
              学生
            </Link>
            <Link to="/ai-settings" className={isActive('/ai-settings') ? 'nav-link active' : 'nav-link'}>
              AI 服务
            </Link>
            <Link to="/settings" className={isActive('/settings') ? 'nav-link active' : 'nav-link'}>
              设置
            </Link>
          </nav>
        </div>
      </header>
      <main className="layout-main">{children}</main>
    </div>
  );
}

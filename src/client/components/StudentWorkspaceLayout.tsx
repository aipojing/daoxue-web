import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { apiGet, ApiError } from '../api';
import type { Student } from '../types';
import {
  getNextWorkspaceFocusIndex,
  isStudentWorkspacePathActive,
  shouldCloseDrawerForBreakpointChange,
  shouldRestoreWorkspaceMenuFocus,
  studentWorkspaceGroups,
  type StudentWorkspaceIcon,
} from '../lib/student-workspace';
import {
  IconArchive,
  IconBook,
  IconCalendar,
  IconChart,
  IconHeadphones,
  IconLamp,
  IconMenu,
  IconNotebook,
  IconTarget,
} from './icons';
import StudentAvatar from './StudentAvatar';

export interface StudentWorkspaceContext {
  student: Student;
  reloadStudent: () => Promise<void>;
}

function WorkspaceIcon({ icon }: { icon: StudentWorkspaceIcon }) {
  const icons: Record<StudentWorkspaceIcon, typeof IconBook> = {
    calendar: IconCalendar,
    lamp: IconLamp,
    headphones: IconHeadphones,
    target: IconTarget,
    notebook: IconNotebook,
    chart: IconChart,
    archive: IconArchive,
  };
  const Icon = icons[icon];
  return <Icon size={20} />;
}

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(
    'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )).filter((element) => !element.hasAttribute('disabled'));
}

export default function StudentWorkspaceLayout() {
  const location = useLocation();
  const studentId = location.pathname.match(/^\/students\/([^/]+)/)?.[1] ?? '';
  const [student, setStudent] = useState<Student | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [compactNavigation, setCompactNavigation] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 899px)').matches,
  );
  const requestGenerationRef = useRef(0);
  const requestAbortRef = useRef<AbortController | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const previousPathnameRef = useRef(location.pathname);
  const compactNavigationRef = useRef(compactNavigation);
  const drawerOpenRef = useRef(drawerOpen);
  compactNavigationRef.current = compactNavigation;
  drawerOpenRef.current = drawerOpen;

  const restoreMenuFocus = useCallback(() => {
    window.requestAnimationFrame(() => menuButtonRef.current?.focus());
  }, []);

  const closeDrawer = useCallback(() => {
    const restoreFocus = shouldRestoreWorkspaceMenuFocus(drawerOpen);
    setDrawerOpen(false);
    if (restoreFocus) restoreMenuFocus();
  }, [drawerOpen, restoreMenuFocus]);

  const reloadStudent = useCallback(async () => {
    requestAbortRef.current?.abort();
    const controller = new AbortController();
    requestAbortRef.current = controller;
    const generation = ++requestGenerationRef.current;
    setLoading(true);
    setError('');
    try {
      const data = await apiGet<Student>(`/api/students/${studentId}`, { signal: controller.signal });
      if (generation !== requestGenerationRef.current || controller.signal.aborted) return;
      setStudent(data);
    } catch (cause) {
      if (generation !== requestGenerationRef.current || controller.signal.aborted) return;
      setStudent(null);
      setError(cause instanceof ApiError ? cause.message : '无法加载学生信息');
    } finally {
      if (generation === requestGenerationRef.current && !controller.signal.aborted) setLoading(false);
    }
  }, [studentId]);

  useEffect(() => {
    setStudent(null);
    void reloadStudent();
    return () => {
      requestGenerationRef.current += 1;
      requestAbortRef.current?.abort();
    };
  }, [reloadStudent]);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(max-width: 899px)');
    const updateCompactNavigation = () => {
      const nextCompactNavigation = mediaQuery.matches;
      if (shouldCloseDrawerForBreakpointChange(
        compactNavigationRef.current,
        nextCompactNavigation,
        drawerOpenRef.current,
      )) {
        setDrawerOpen(false);
      }
      compactNavigationRef.current = nextCompactNavigation;
      setCompactNavigation(nextCompactNavigation);
    };
    updateCompactNavigation();
    mediaQuery.addEventListener('change', updateCompactNavigation);
    return () => mediaQuery.removeEventListener('change', updateCompactNavigation);
  }, []);

  useEffect(() => {
    if (!drawerOpen) return;
    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousBodyOverflow;
    };
  }, [drawerOpen]);

  useEffect(() => {
    const backgroundElements = [menuButtonRef.current, contentRef.current];
    for (const element of backgroundElements) element?.toggleAttribute('inert', drawerOpen);
    return () => {
      for (const element of backgroundElements) element?.removeAttribute('inert');
    };
  }, [drawerOpen]);

  useEffect(() => {
    if (!drawerOpen) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeDrawer();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [closeDrawer, drawerOpen]);

  useEffect(() => {
    if (!drawerOpen) return;
    getFocusableElements(drawerRef.current ?? document.body)[0]?.focus();
  }, [drawerOpen]);

  useEffect(() => {
    if (previousPathnameRef.current !== location.pathname) {
      previousPathnameRef.current = location.pathname;
      if (drawerOpen) closeDrawer();
    }
  }, [closeDrawer, drawerOpen, location.pathname]);

  const trapDrawerFocus = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (!drawerOpen || event.key !== 'Tab' || !drawerRef.current) return;
    const focusable = getFocusableElements(drawerRef.current);
    if (focusable.length === 0) return;
    const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
    const atBoundary = event.shiftKey ? currentIndex <= 0 : currentIndex === focusable.length - 1;
    if (!atBoundary) return;
    event.preventDefault();
    focusable[getNextWorkspaceFocusIndex(currentIndex < 0 ? 0 : currentIndex, focusable.length, event.shiftKey ? 'previous' : 'next')]?.focus();
  };

  if (loading && !student) {
    return <div className="workspace-loading" aria-live="polite"><div className="spinner" />正在打开学习工作台</div>;
  }

  if (!student) {
    return (
      <div className="workspace-error" role="alert">
        <h1>无法打开孩子学习工作台</h1>
        <p>{error || '学生信息不可用'}</p>
        <div className="workspace-error-actions">
          <button className="btn btn-primary" onClick={() => void reloadStudent()}>重新加载</button>
          <Link className="btn" to="/">返回学生列表</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="student-workspace">
      <button
        ref={menuButtonRef}
        type="button"
        className="workspace-menu-button"
        aria-label="打开孩子学习菜单"
        aria-controls="student-workspace-navigation"
        aria-expanded={drawerOpen}
        onClick={() => setDrawerOpen(true)}
      >
        <IconMenu size={22} />
        <span>学习菜单</span>
      </button>
      {drawerOpen && <div className="workspace-backdrop" aria-hidden="true" onClick={() => closeDrawer()} />}
      <aside
        ref={drawerRef}
        id="student-workspace-navigation"
        className={drawerOpen ? 'workspace-sidebar is-open' : 'workspace-sidebar'}
        aria-label="孩子学习功能"
        aria-modal={drawerOpen || undefined}
        aria-hidden={compactNavigation && !drawerOpen ? true : undefined}
        role={drawerOpen ? 'dialog' : undefined}
        onKeyDown={trapDrawerFocus}
      >
        <div className="workspace-sidebar-header">
          <div className="workspace-brand"><IconBook size={20} /><span>学伴 AI</span></div>
          <button type="button" className="workspace-drawer-close" aria-label="关闭菜单" onClick={() => closeDrawer()}>关闭</button>
        </div>
        <div className="workspace-student">
          <StudentAvatar name={student.name} color={student.color} gender={student.gender} className="workspace-avatar" />
          <p className="workspace-student-summary">
            <strong>{student.name}</strong><span aria-hidden="true">·</span><span>{student.grade}</span>
          </p>
        </div>
        <nav className="workspace-navigation" aria-label="孩子学习功能">
          {studentWorkspaceGroups.map((group) => (
            <div className="workspace-nav-group" key={group.label}>
              <h2>{group.label}</h2>
              {group.items.map((item) => {
                const destination = item.path(student.id);
                const active = isStudentWorkspacePathActive(destination, location.pathname);
                return (
                  <Link
                    key={item.label}
                    to={destination}
                    className={active ? 'workspace-nav-item is-active' : 'workspace-nav-item'}
                    aria-current={active ? 'page' : undefined}
                    onClick={() => closeDrawer()}
                  >
                    <WorkspaceIcon icon={item.icon} />
                    <span>{item.label}</span>
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="workspace-sidebar-footer">
          <Link to="/ai-settings" className="workspace-nav-item" onClick={() => closeDrawer()}><IconLamp size={18} /><span>AI 服务</span></Link>
          <Link to="/" className="workspace-back-link" onClick={() => closeDrawer()}>返回学生列表</Link>
        </div>
      </aside>
      <main ref={contentRef} className="workspace-content" aria-hidden={drawerOpen || undefined}>
        <Outlet context={{ student, reloadStudent } satisfies StudentWorkspaceContext} />
      </main>
    </div>
  );
}

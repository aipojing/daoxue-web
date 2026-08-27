import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { lazy, Suspense, type ReactNode } from 'react';
import { AuthProvider, useAuth } from './AuthContext';
import Layout from './components/Layout';
import ErrorBoundary from './components/ErrorBoundary';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';

const StudentsPage = lazy(() => import('./pages/StudentsPage'));
const StudentDetailPage = lazy(() => import('./pages/StudentDetailPage'));
const ChatPage = lazy(() => import('./pages/ChatPage'));
const MistakesPage = lazy(() => import('./pages/MistakesPage'));
const SelfLearnPage = lazy(() => import('./pages/SelfLearnPage'));
const TutoringPage = lazy(() => import('./pages/TutoringPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const AISettingsPage = lazy(() => import('./pages/AISettingsPage'));
const StudentWorkspaceLayout = lazy(() => import('./components/StudentWorkspaceLayout'));
const StudentMasteryPage = lazy(() => import('./pages/StudentMasteryPage'));
const StudentProfilePage = lazy(() => import('./pages/StudentProfilePage'));
const CoursewaresPage = lazy(() => import('./pages/CoursewaresPage'));

function WorkspacePlaceholder({ title }: { title: string }) {
  return (
    <div className="page">
      <div className="page-header"><h1>{title}</h1></div>
      <div className="empty-state"><p>该功能正在准备中，请从左侧菜单继续使用其他学习功能。</p></div>
    </div>
  );
}

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading, error, refresh } = useAuth();
  if (loading) {
    return (
      <div className="page-loading">
        <div className="spinner" />
      </div>
    );
  }
  if (!user && error) {
    return (
      <div className="page">
        <div className="empty-state">
          <p>{error}</p>
          <button className="btn btn-primary" onClick={() => void refresh()}>
            重试
          </button>
        </div>
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

/** 已登录用户不该再看到登录/注册表单 */
function RedirectIfAuthed({ children }: { children: ReactNode }) {
  const { user, loading, error, refresh } = useAuth();
  if (loading) {
    return (
      <div className="page-loading">
        <div className="spinner" />
      </div>
    );
  }
  if (!user && error) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <div className="form-error">{error}</div>
          <button className="btn btn-primary btn-block" onClick={() => void refresh()}>
            重试
          </button>
        </div>
      </div>
    );
  }
  if (user) return <Navigate to="/" replace />;
  return <>{children}</>;
}

function AppRoutes() {
  return (
    <Suspense
      fallback={
        <div className="page-loading">
          <div className="spinner" />
        </div>
      }
    >
      <Routes>
      <Route
        path="/login"
        element={
          <RedirectIfAuthed>
            <LoginPage />
          </RedirectIfAuthed>
        }
      />
      <Route
        path="/register"
        element={
          <RedirectIfAuthed>
            <RegisterPage />
          </RedirectIfAuthed>
        }
      />
      <Route
        path="/"
        element={
          <RequireAuth>
            <Layout>
              <StudentsPage />
            </Layout>
          </RequireAuth>
        }
      />
      <Route
        path="/students/:studentId"
        element={
          <RequireAuth>
            <StudentWorkspaceLayout />
          </RequireAuth>
        }
      >
        <Route index element={<Navigate to="today" replace />} />
        <Route path="today" element={<StudentDetailPage />} />
        <Route path="tutoring" element={<TutoringPage />} />
        <Route path="chat/:conversationId" element={<ChatPage />} />
        <Route path="selflearn" element={<SelfLearnPage />} />
        <Route path="mistakes" element={<MistakesPage />} />
        <Route path="coursewares" element={<CoursewaresPage />} />
        <Route path="coursewares/:coursewareId" element={<WorkspacePlaceholder title="语音课件" />} />
        <Route path="mastery" element={<StudentMasteryPage />} />
        <Route path="profile" element={<StudentProfilePage />} />
      </Route>
      <Route
        path="/ai-settings"
        element={
          <RequireAuth>
            <Layout>
              <AISettingsPage />
            </Layout>
          </RequireAuth>
        }
      />
      <Route
        path="/settings"
        element={
          <RequireAuth>
            <Layout>
              <SettingsPage />
            </Layout>
          </RequireAuth>
        }
      />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </AuthProvider>
    </ErrorBoundary>
  );
}

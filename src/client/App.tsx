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
            <Layout>
              <StudentDetailPage />
            </Layout>
          </RequireAuth>
        }
      />
      <Route
        path="/students/:studentId/chat/:conversationId"
        element={
          <RequireAuth>
            <ChatPage />
          </RequireAuth>
        }
      />
      <Route
        path="/students/:studentId/tutoring"
        element={
          <RequireAuth>
            <Layout>
              <TutoringPage />
            </Layout>
          </RequireAuth>
        }
      />
      <Route
        path="/students/:studentId/selflearn"
        element={
          <RequireAuth>
            <Layout>
              <SelfLearnPage />
            </Layout>
          </RequireAuth>
        }
      />
      <Route
        path="/students/:studentId/mistakes"
        element={
          <RequireAuth>
            <Layout>
              <MistakesPage />
            </Layout>
          </RequireAuth>
        }
      />
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

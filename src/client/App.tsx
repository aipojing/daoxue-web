import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import { AuthProvider, useAuth } from './AuthContext';
import Layout from './components/Layout';
import ErrorBoundary from './components/ErrorBoundary';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import StudentsPage from './pages/StudentsPage';
import StudentDetailPage from './pages/StudentDetailPage';
import ChatPage from './pages/ChatPage';
import MistakesPage from './pages/MistakesPage';
import SelfLearnPage from './pages/SelfLearnPage';
import TutoringPage from './pages/TutoringPage';
import SettingsPage from './pages/SettingsPage';

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="page-loading">
        <div className="spinner" />
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

/** 已登录用户不该再看到登录/注册表单 */
function RedirectIfAuthed({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="page-loading">
        <div className="spinner" />
      </div>
    );
  }
  if (user) return <Navigate to="/" replace />;
  return <>{children}</>;
}

function AppRoutes() {
  return (
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

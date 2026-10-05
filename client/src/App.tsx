import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import './index.css';
import Sidebar from './components/Sidebar';
import Topbar from './components/Topbar';
import FacebookAppBanner from './components/FacebookAppBanner';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import PagesPage from './pages/PagesPage';
import PostsPage from './pages/PostsPage';
import ReelPage from './pages/ReelPage';
import CommentsPage from './pages/CommentsPage';
import CreatePostPage from './pages/CreatePostPage';
import SchedulesPage from './pages/SchedulesPage';
import ScheduleDetailPage from './pages/ScheduleDetailPage';
import SettingsPage from './pages/SettingsPage';
import DomainsPage from './pages/DomainsPage';
import UsersPage from './pages/UsersPage';
import { ProtectedRoute } from './auth';

/** `flush`: the page lays out its own full-height panes (e.g. list + inspector) */
function AppLayout({ children, flush = false }: { children: React.ReactNode; flush?: boolean }) {
  const location = useLocation();
  /** Phones: the sidebar is a slide-in menu opened from the top bar */
  const [navOpen, setNavOpen] = useState(false);
  useEffect(() => setNavOpen(false), [location.pathname]);

  return (
    <div className="app-layout">
      <Sidebar open={navOpen} onClose={() => setNavOpen(false)} />
      <div className="main-column">
        <Topbar navOpen={navOpen} onMenu={() => setNavOpen(true)} />
        <main className={`main-content ${flush ? 'flush' : ''}`}>
          <FacebookAppBanner />
          {children}
        </main>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/"
          element={
            <ProtectedRoute>
              <AppLayout>
                <DashboardPage />
              </AppLayout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/pages"
          element={
            <ProtectedRoute>
              <AppLayout>
                <PagesPage />
              </AppLayout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/posts"
          element={
            <ProtectedRoute>
              <AppLayout flush>
                <PostsPage />
              </AppLayout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/posts/create"
          element={
            <ProtectedRoute>
              <AppLayout>
                <CreatePostPage />
              </AppLayout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/schedules"
          element={
            <ProtectedRoute>
              <AppLayout>
                <SchedulesPage />
              </AppLayout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/schedules/:id"
          element={
            <ProtectedRoute>
              <AppLayout>
                <ScheduleDetailPage />
              </AppLayout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/settings"
          element={
            <ProtectedRoute>
              <AppLayout>
                <SettingsPage />
              </AppLayout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/domains"
          element={
            <ProtectedRoute>
              <AppLayout>
                <DomainsPage />
              </AppLayout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/users"
          element={
            <ProtectedRoute adminOnly>
              <AppLayout>
                <UsersPage />
              </AppLayout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/posts/:id/reel"
          element={
            <ProtectedRoute>
              <AppLayout>
                <ReelPage />
              </AppLayout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/comments"
          element={
            <ProtectedRoute>
              <AppLayout>
                <CommentsPage />
              </AppLayout>
            </ProtectedRoute>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

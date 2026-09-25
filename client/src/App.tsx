import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import './index.css';
import Sidebar from './components/Sidebar';
import Topbar from './components/Topbar';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import PagesPage from './pages/PagesPage';
import PostsPage from './pages/PostsPage';
import CreatePostPage from './pages/CreatePostPage';
import SchedulesPage from './pages/SchedulesPage';
import SettingsPage from './pages/SettingsPage';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  // Tạm thời bỏ qua đăng nhập
  return <>{children}</>;
}

/** `flush`: the page lays out its own full-height panes (e.g. list + inspector) */
function AppLayout({ children, flush = false }: { children: React.ReactNode; flush?: boolean }) {
  return (
    <div className="app-layout">
      <Sidebar />
      <div className="main-column">
        <Topbar />
        <main className={`main-content ${flush ? 'flush' : ''}`}>{children}</main>
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
          path="/settings"
          element={
            <ProtectedRoute>
              <AppLayout>
                <SettingsPage />
              </AppLayout>
            </ProtectedRoute>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

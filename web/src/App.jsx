import { Routes, Route, NavLink, Link, Navigate } from 'react-router-dom';
import { useSession } from './lib/session.jsx';
import { useTheme } from './lib/theme.jsx';
import Home from './pages/Home.jsx';
import EventPage from './pages/EventPage.jsx';
import Tickets from './pages/Tickets.jsx';
import Login from './pages/Login.jsx';
import StaffLogin from './pages/StaffLogin.jsx';
import Account from './pages/Account.jsx';
import AdminLayout from './pages/admin/AdminLayout.jsx';
import AdminEvents from './pages/admin/Events.jsx';
import AdminEventEdit from './pages/admin/EventEdit.jsx';
import AdminAttendees from './pages/admin/Attendees.jsx';
import AdminKiosk from './pages/admin/Kiosk.jsx';
import AdminMerch from './pages/admin/Merch.jsx';
import AdminReconciliation from './pages/admin/Reconciliation.jsx';
import AdminVouchers from './pages/admin/Vouchers.jsx';
import AdminScanner from './pages/admin/Scanner.jsx';
import AdminBadges from './pages/admin/Badges.jsx';
import AdminEmail from './pages/admin/Email.jsx';
import AdminStaff from './pages/admin/Staff.jsx';
import AdminAuditLog from './pages/admin/AuditLog.jsx';
import AdminSettings from './pages/admin/Settings.jsx';

export default function App() {
  const { user, settings, isStaff, logout, loading } = useSession();
  const { theme, toggleTheme } = useTheme();
  if (loading) return null;

  return (
    <>
      <nav className="nav">
        <div className="nav-inner">
          <Link to="/" className="brand">
            {settings?.logoUrl
              ? <img src={settings.logoUrl} alt={settings?.orgName || 'Home'} className="brand-banner" />
              : <><span className="brand-mark" />{settings?.orgName || 'PawPass'}</>}
          </Link>
          <NavLink to="/" className="link" end>Events</NavLink>
          {user && <NavLink to="/tickets" className="link">My tickets</NavLink>}
          {isStaff && <NavLink to="/admin" className="link">Admin</NavLink>}
          <span style={{ flex: 1 }} />
          <button className="btn ghost icon sm" onClick={toggleTheme} aria-label="Toggle dark mode" title="Toggle dark mode">
            {theme === 'dark' ? '☀' : '☾'}
          </button>
          {user
            ? <>
                <Link to="/account" className="link">{user.displayName}</Link>
                <button className="btn ghost sm" onClick={logout}>Sign out</button>
              </>
            : <Link to="/login" className="btn sm">Sign in</Link>}
        </div>
      </nav>

      <main className="shell">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/e/:slug" element={<EventPage />} />
          <Route path="/tickets" element={user ? <Tickets /> : <Navigate to="/login" />} />
          <Route path="/account" element={user ? <Account /> : <Navigate to="/login" />} />
          <Route path="/login" element={<Login />} />
          <Route path="/staff" element={<StaffLogin />} />
          <Route path="/admin" element={<AdminLayout />}>
            <Route index element={<AdminEvents />} />
            <Route path="events/:id" element={<AdminEventEdit />} />
            <Route path="events/:id/attendees" element={<AdminAttendees />} />
            <Route path="events/:id/kiosk" element={<AdminKiosk />} />
            <Route path="events/:id/merch" element={<AdminMerch />} />
            <Route path="events/:id/reconciliation" element={<AdminReconciliation />} />
            <Route path="events/:id/vouchers" element={<AdminVouchers />} />
            <Route path="scan" element={<AdminScanner />} />
            <Route path="badges" element={<AdminBadges />} />
            <Route path="email" element={<AdminEmail />} />
            <Route path="staff" element={<AdminStaff />} />
            <Route path="audit" element={<AdminAuditLog />} />
            <Route path="settings" element={<AdminSettings />} />
          </Route>
          <Route path="*" element={<p style={{ paddingTop: 40 }}>That page does not exist. <Link to="/">Back to events</Link>.</p>} />
        </Routes>
      </main>

      <footer className="site-footer">
        <div className="hero-rule" />
        <p className="small muted">
          PawPass • Mobile Event Management<br />
          Beta 2026.0.5.2 • © {new Date().getFullYear()} • <a href="https://pawpass.folfy.dev">pawpass.folfy.dev</a>
        </p>
      </footer>
    </>
  );
}

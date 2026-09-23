import { lazy, Suspense } from 'react';
import { Routes, Route, NavLink, Link, Navigate } from 'react-router-dom';
import { useSession } from './lib/session.jsx';
import { useTheme } from './lib/theme.jsx';
import Home from './pages/Home.jsx';
import EventPage from './pages/EventPage.jsx';
import Tickets from './pages/Tickets.jsx';
import Login from './pages/Login.jsx';
import StaffLogin from './pages/StaffLogin.jsx';
import Account from './pages/Account.jsx';
import Terms from './pages/Terms.jsx';
import Privacy from './pages/Privacy.jsx';
import NotFound from './pages/NotFound.jsx';

// Lazy-loaded: the admin console (and the changelog, staff-only same as it)
// is only ever reached by staff, so it has no business shipping in the
// bundle every attendee downloads just to register.
const Changelog = lazy(() => import('./pages/Changelog.jsx'));
const AdminLayout = lazy(() => import('./pages/admin/AdminLayout.jsx'));
const AdminEvents = lazy(() => import('./pages/admin/Events.jsx'));
const AdminEventEdit = lazy(() => import('./pages/admin/EventEdit.jsx'));
const AdminAttendees = lazy(() => import('./pages/admin/Attendees.jsx'));
const AdminKiosk = lazy(() => import('./pages/admin/Kiosk.jsx'));
const AdminMerch = lazy(() => import('./pages/admin/Merch.jsx'));
const AdminReconciliation = lazy(() => import('./pages/admin/Reconciliation.jsx'));
const AdminVouchers = lazy(() => import('./pages/admin/Vouchers.jsx'));
const AdminCheckInSelect = lazy(() => import('./pages/admin/CheckInSelect.jsx'));
const AdminScanner = lazy(() => import('./pages/admin/Scanner.jsx'));
const AdminCheckInDisplay = lazy(() => import('./pages/admin/CheckInDisplay.jsx'));
const AdminBadges = lazy(() => import('./pages/admin/Badges.jsx'));
const AdminEmail = lazy(() => import('./pages/admin/Email.jsx'));
const AdminStaff = lazy(() => import('./pages/admin/Staff.jsx'));
const AdminBans = lazy(() => import('./pages/admin/Bans.jsx'));
const AdminAuditLog = lazy(() => import('./pages/admin/AuditLog.jsx'));
const AdminSettings = lazy(() => import('./pages/admin/Settings.jsx'));
const AdminBackup = lazy(() => import('./pages/admin/Backup.jsx'));
const AdminAnalytics = lazy(() => import('./pages/admin/Analytics.jsx'));

export default function App() {
  const { user, settings, isStaff, logout, loading } = useSession();
  const { theme, toggleTheme } = useTheme();
  if (loading) return null;

    const banner = theme === 'light' && settings?.useLightBanner && settings?.logoUrlLight
    ? settings.logoUrlLight
    : settings?.logoUrl;

  return (
    <>
      <nav className="nav">
        <div className="nav-inner">
          <Link to="/" className="brand">
            {banner
              ? <img src={banner} alt={settings?.orgName || 'Home'} className="brand-banner" />
              : <><span className="brand-mark" />{settings?.orgName || 'PawPass'}</>}
          </Link>
          <NavLink to="/" className="link" end>Events</NavLink>
          {user && <NavLink to="/tickets" className="link">My tickets</NavLink>}
          {isStaff && <NavLink to="/admin" className="link">Admin</NavLink>}
          <span className="nav-spacer" />
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
        <Suspense fallback={<p className="muted" style={{ paddingTop: 40 }}>Loading…</p>}>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/e/:slug" element={<EventPage />} />
            <Route path="/tickets" element={user ? <Tickets /> : <Navigate to="/login" />} />
            <Route path="/account" element={user ? <Account /> : <Navigate to="/login" />} />
            <Route path="/login" element={<Login />} />
            <Route path="/staff" element={<StaffLogin />} />
            <Route path="/legal/terms" element={<Terms />} />
            <Route path="/legal/privacy" element={<Privacy />} />
            <Route path="/changelog" element={isStaff ? <Changelog /> : <Navigate to="/" />} />
            {/* Outside AdminLayout on purpose — a fullscreen second-monitor
                view has no business showing the admin sidebar/nav. */}
            <Route path="/admin/scan/:eventId/display" element={isStaff ? <AdminCheckInDisplay /> : <Navigate to="/login" />} />
            <Route path="/admin" element={<AdminLayout />}>
              <Route index element={<AdminEvents />} />
              <Route path="events/:id" element={<AdminEventEdit />} />
              <Route path="events/:id/attendees" element={<AdminAttendees />} />
              <Route path="events/:id/kiosk" element={<AdminKiosk />} />
              <Route path="events/:id/merch" element={<AdminMerch />} />
              <Route path="events/:id/reconciliation" element={<AdminReconciliation />} />
              <Route path="events/:id/vouchers" element={<AdminVouchers />} />
              <Route path="scan" element={<AdminCheckInSelect />} />
              <Route path="scan/:eventId" element={<AdminScanner />} />
              <Route path="badges" element={<AdminBadges />} />
              <Route path="email" element={<AdminEmail />} />
              <Route path="staff" element={<AdminStaff />} />
              <Route path="bans" element={<AdminBans />} />
              <Route path="audit" element={<AdminAuditLog />} />
              <Route path="analytics" element={<AdminAnalytics />} />
              <Route path="settings" element={<AdminSettings />} />
              <Route path="backup" element={<AdminBackup />} />
              <Route path="*" element={<NotFound />} />
            </Route>
            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
      </main>

      <footer className="site-footer">
        <div className="hero-rule" />
        <p className="small muted">
          PawPass • Mobile Event Management<br />
          PROD-2026.1.1.4 • © {new Date().getFullYear()} • <a href="https://pawpass.folfy.dev">PawPass Team</a>
          <br />
          <Link to="/legal/terms">Terms of Service</Link> • <Link to="/legal/privacy">Privacy Policy</Link>
          {isStaff && <> • <Link to="/changelog">Changelog</Link></>}
        </p>
      </footer>
    </>
  );
}

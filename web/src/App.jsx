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
import { Bone, PageSkeleton } from './components/Skeleton.jsx';

// Lazy-loaded: the admin console (and the changelog, staff-only same as it)
// is only ever reached by staff, so it has no business shipping in the
// bundle every attendee downloads just to register.
const Changelog = lazy(() => import('./pages/Changelog.jsx'));
const Schedule = lazy(() => import('./pages/Schedule.jsx'));
const SubmitPanel = lazy(() => import('./pages/SubmitPanel.jsx'));
const VendorApply = lazy(() => import('./pages/VendorApply.jsx'));
const AdminLayout = lazy(() => import('./pages/admin/AdminLayout.jsx'));
const AdminEvents = lazy(() => import('./pages/admin/Events.jsx'));
const AdminEventEdit = lazy(() => import('./pages/admin/EventEdit.jsx'));
const AdminOverview = lazy(() => import('./pages/admin/Overview.jsx'));
const AdminAttendees = lazy(() => import('./pages/admin/Attendees.jsx'));
const AdminKiosk = lazy(() => import('./pages/admin/Kiosk.jsx'));
const AdminTiers = lazy(() => import('./pages/admin/Tiers.jsx'));
const AdminMerch = lazy(() => import('./pages/admin/Merch.jsx'));
const AdminReconciliation = lazy(() => import('./pages/admin/Reconciliation.jsx'));
const AdminVouchers = lazy(() => import('./pages/admin/Vouchers.jsx'));
const AdminHotels = lazy(() => import('./pages/admin/Hotels.jsx'));
const AdminRoomRequests = lazy(() => import('./pages/admin/RoomRequests.jsx'));
const AdminSchedule = lazy(() => import('./pages/admin/AdminSchedule.jsx'));
const AdminSubmissions = lazy(() => import('./pages/admin/AdminSubmissions.jsx'));
const AdminVendors = lazy(() => import('./pages/admin/AdminVendors.jsx'));
const AdminVolunteers = lazy(() => import('./pages/admin/Volunteers.jsx'));
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
const AdminIncidents = lazy(() => import('./pages/admin/Incidents.jsx'));
const AdminIncidentDetail = lazy(() => import('./pages/admin/IncidentDetail.jsx'));
const AdminAnalytics = lazy(() => import('./pages/admin/Analytics.jsx'));

export default function App() {
  const { user, settings, isStaff, logout, loading } = useSession();
  const { theme, toggleTheme } = useTheme();
  // Until the session is known the links can't be drawn yet, but the frame
  // can: same bar, same height, so nothing shifts when it fills in.
  if (loading) {
    return (
      <>
        <nav className="nav" aria-hidden="true">
          <div className="nav-inner">
            <span className="brand"><span className="brand-mark" /><Bone w={90} h={16} /></span>
            <Bone w={52} h={14} />
            <span className="nav-spacer" />
            <Bone w={70} h={32} r={10} />
          </div>
        </nav>
        <main className="shell"><PageSkeleton /></main>
      </>
    );
  }

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
        <Suspense fallback={<PageSkeleton />}>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/e/:slug" element={<EventPage />} />
            <Route path="/e/:slug/schedule" element={<Schedule />} />
            <Route path="/e/:slug/submit" element={<SubmitPanel />} />
            <Route path="/e/:slug/vendors" element={<VendorApply />} />
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
              <Route path="events/:id" element={<AdminOverview />} />
              <Route path="events/:id/details" element={<AdminEventEdit />} />
              <Route path="events/:id/tickets" element={<AdminTiers />} />
              <Route path="events/:id/attendees" element={<AdminAttendees />} />
              <Route path="events/:id/kiosk" element={<AdminKiosk />} />
              <Route path="events/:id/merch" element={<AdminMerch />} />
              <Route path="events/:id/reconciliation" element={<AdminReconciliation />} />
              <Route path="events/:id/vouchers" element={<AdminVouchers />} />
              <Route path="events/:id/volunteers" element={<AdminVolunteers />} />
              <Route path="events/:id/hotels" element={<AdminHotels />} />
              <Route path="events/:id/rooms" element={<AdminRoomRequests />} />
              <Route path="events/:id/schedule" element={<AdminSchedule />} />
              <Route path="events/:id/submissions" element={<AdminSubmissions />} />
              <Route path="events/:id/vendors" element={<AdminVendors />} />
              <Route path="scan" element={<AdminCheckInSelect />} />
              <Route path="scan/:eventId" element={<AdminScanner />} />
              <Route path="badges" element={<AdminBadges />} />
              <Route path="email" element={<AdminEmail />} />
              <Route path="staff" element={<AdminStaff />} />
              <Route path="bans" element={<AdminBans />} />
              <Route path="incidents" element={<AdminIncidents />} />
              <Route path="incidents/:id" element={<AdminIncidentDetail />} />
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
          PROD-2026.2.1.0• © {new Date().getFullYear()} • <a href="https://pawpass.folfy.dev">PawPass Team</a>
          <br />
          <Link to="/legal/terms">Terms of Service</Link> • <Link to="/legal/privacy">Privacy Policy</Link>
          {isStaff && <> • <Link to="/changelog">Changelog</Link></>}
        </p>
      </footer>
    </>
  );
}

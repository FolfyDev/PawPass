import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, Navigate, useLocation, useMatch } from 'react-router-dom';
import { useSession } from '../../lib/session.jsx';
import { usePageMeta } from '../../lib/meta.js';
import { useEventTitle } from '../../lib/eventTitle.js';
import Breadcrumbs from '../../components/Breadcrumbs.jsx';

/// Inside an event, its sections — grouped the way a con team thinks about
/// them — replace the old row of tabs.
const EVENT_NAV = [
  [null, [['', 'Overview']]],
  ['Set up', [['details', 'Details'], ['tickets', 'Tickets'], ['vouchers', 'Vouchers']]],
  ['People', [['attendees', 'Attendees'], ['volunteers', 'Volunteers'], ['hotels', 'Hotels']]],
  ['Program', [['schedule', 'Schedule'], ['submissions', 'Panels'], ['vendors', 'Vendors']]],
  ['Money', [['kiosk', 'Kiosk'], ['merch', 'Merch'], ['reconciliation', 'Cash']]],
];

function globalNav(isOwner) {
  return [
    ['Operations', [
      ['/admin', 'Events', true], ['/admin/scan', 'Check in & print'],
      isOwner && ['/admin/badges', 'Badge designer'], ['/admin/email', 'Email'], ['/admin/incidents', 'Incidents'],
    ]],
    ['Instance', [
      isOwner && ['/admin/staff', 'Staff'], ['/admin/bans', 'Bans'],
      isOwner && ['/admin/audit', 'Audit log'], isOwner && ['/admin/analytics', 'Analytics'],
      isOwner && ['/admin/settings', 'Settings'], isOwner && ['/admin/backup', 'Backup & restore'],
    ]],
  ].map(([group, links]) => [group, links.filter(Boolean)]);
}

export default function AdminLayout() {
  const { user, isStaff, loading } = useSession();
  const location = useLocation();
  const match = useMatch('/admin/events/:id/*');
  const eventId = match?.params.id;
  const title = useEventTitle(eventId);
  const [menuOpen, setMenuOpen] = useState(false);
  usePageMeta({ title: 'Admin', noindex: true });
  useEffect(() => { setMenuOpen(false); }, [location.pathname]);

  if (loading) return null;
  if (!user) return <Navigate to="/login" replace />;
  if (!isStaff) return <p className="note bad" style={{ marginTop: 40 }}>You do not have permission to access this page.</p>;
  const isOwner = user.role === 'OWNER';
  const groups = globalNav(isOwner);

  // What the phone menu button says: the section you're on.
  const section = eventId
    ? EVENT_NAV.flatMap(([, l]) => l).find(([p]) => (p ? location.pathname.startsWith(`/admin/events/${eventId}/${p}`) : location.pathname.replace(/\/$/, '') === `/admin/events/${eventId}`))?.[1]
    : groups.flatMap(([, l]) => l).find(([to, , end]) => (end ? location.pathname === to : location.pathname.startsWith(to)))?.[1];

  return (
    <div className="admin" style={{ paddingTop: 32 }}>
      <aside className={`side${menuOpen ? ' open' : ''}`}>
        <button type="button" className="side-toggle" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>
          <span aria-hidden="true">☰</span>
          <span>{eventId ? <><span className="muted">{title || 'Event'} · </span>{section || ''}</> : section || 'Menu'}</span>
        </button>
        <nav className="side-links" aria-label="Admin">
          {eventId ? (
            <>
              <Link to="/admin" className="side-back">← All events</Link>
              <p className="side-event" title={title}>{title || '…'}</p>
              {EVENT_NAV.map(([group, links]) => (
                <div key={group || 'top'} className="side-group">
                  {group && <p className="eyebrow">{group}</p>}
                  {links.map(([path, label]) => (
                    <NavLink key={path} to={`/admin/events/${eventId}${path ? `/${path}` : ''}`} end={!path}>{label}</NavLink>
                  ))}
                </div>
              ))}
              <div className="side-group side-quiet">
                <p className="eyebrow">Admin</p>
                {groups.flatMap(([, l]) => l).filter(([to]) => to !== '/admin').map(([to, label]) => <NavLink key={to} to={to}>{label}</NavLink>)}
              </div>
            </>
          ) : groups.map(([group, links]) => (
            <div key={group} className="side-group">
              <p className="eyebrow">{group}</p>
              {links.map(([to, label, end]) => <NavLink key={to} to={to} end={end}>{label}</NavLink>)}
            </div>
          ))}
        </nav>
      </aside>
      <div className="admin-content">
        {/* Every page inside an event gets the same trail, above its heading. */}
        {eventId && (
          <Breadcrumbs items={[
            { label: 'Events', to: '/admin' },
            section && section !== 'Overview' ? { label: title || '…', to: `/admin/events/${eventId}` } : { label: title || '…' },
            ...(section && section !== 'Overview' ? [{ label: section }] : []),
          ]} />
        )}
        <Outlet />
      </div>
    </div>
  );
}

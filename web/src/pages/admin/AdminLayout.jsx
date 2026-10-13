import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, Navigate, useLocation, useMatch } from 'react-router-dom';
import { useSession } from '../../lib/session.jsx';
import { usePageMeta } from '../../lib/meta.js';
import { useEventInfo } from '../../lib/eventTitle.js';
import { FEATURES, featureOn } from '../../lib/features.js';
import Breadcrumbs from '../../components/Breadcrumbs.jsx';

/// Inside an event, its sections — grouped the way a con team thinks about
/// them — replace the old row of tabs. Then who sees the link: any one of
/// those permissions (null = all staff); and the optional feature it belongs
/// to, which hides it when switched off on the details page.
const EVENT_NAV = [
  [null, [['', 'Overview', null]]],
  ['Set up', [['details', 'Details', null], ['tickets', 'Tickets', null], ['vouchers', 'Vouchers', ['vouchers.manage'], 'vouchers']]],
  ['People', [
    ['attendees', 'Attendees', ['attendees.view']], ['volunteers', 'Volunteers', ['volunteers.manage', 'volunteers.shifts'], 'volunteers'],
    ['hotels', 'Hotels', ['hotels.setup', 'hotels.requests'], 'hotels'], ['rooms', 'Room requests', ['hotels.requests', 'hotels.setup'], 'hotels'],
  ]],
  ['Program', [
    ['schedule', 'Schedule', ['schedule.manage', 'schedule.publish', 'submissions.review'], 'schedule'],
    ['submissions', 'Panels', ['submissions.review', 'schedule.manage'], 'schedule'], ['vendors', 'Vendors', ['vendors.review', 'vendors.setup'], 'vendors'],
  ]],
  ['Money', [
    ['kiosk', 'Kiosk', ['attendees.edit'], 'kiosk'], ['merch', 'Merch', ['merch.sell', 'merch.manage', 'reconciliation.view'], 'merch'],
    ['reconciliation', 'Cash', ['reconciliation.view']],
  ]],
];

/// Instance-wide pages, same shape; 'owner' means owners only.
const GLOBAL_NAV = [
  ['Operations', [
    ['/admin', 'Events', null, true], ['/admin/scan', 'Check in & print', ['checkin']],
    ['/admin/badges', 'Badge designer', ['badges.design']], ['/admin/email', 'Email', ['email.draft', 'email.send']],
    ['/admin/incidents', 'Incidents', ['incidents.file', 'incidents.manage']],
  ]],
  ['Instance', [
    ['/admin/staff', 'Staff', 'owner'], ['/admin/bans', 'Bans', ['bans.view', 'bans.manage']],
    ['/admin/audit', 'Audit log', ['audit.view']], ['/admin/analytics', 'Analytics', ['analytics.view']],
    ['/admin/settings', 'Settings', 'owner'], ['/admin/backup', 'Backup & restore', 'owner'],
  ]],
];

const allowed = (need, can, isOwner) => (need === 'owner' ? isOwner : !need || need.some(can));

export default function AdminLayout() {
  const { user, isStaff, isOwner, can, loading } = useSession();
  const location = useLocation();
  const match = useMatch('/admin/events/:id/*');
  const eventId = match?.params.id;
  const info = useEventInfo(eventId);
  const title = info?.title || '';
  const [menuOpen, setMenuOpen] = useState(false);
  usePageMeta({ title: 'Admin', noindex: true });
  useEffect(() => { setMenuOpen(false); }, [location.pathname]);

  if (loading) return null;
  if (!user) return <Navigate to="/login" replace />;
  if (!isStaff) return <p className="note bad" style={{ marginTop: 40 }}>You do not have permission to access this page.</p>;
  const ok = ([, , need]) => allowed(need, can, isOwner);
  const groups = GLOBAL_NAV.map(([group, links]) => [group, links.filter(ok)]).filter(([, links]) => links.length);
  const on = ([, , , feature]) => !feature || featureOn(info, feature);
  const eventGroups = EVENT_NAV.map(([group, links]) => [group, links.filter((l) => ok(l) && on(l))]).filter(([, links]) => links.length);

  // The section you're on: what the phone menu button says, and whether
  // you're allowed to be here at all.
  const current = eventId
    ? EVENT_NAV.flatMap(([, l]) => l).find(([p]) => (p ? location.pathname.startsWith(`/admin/events/${eventId}/${p}`) : location.pathname.replace(/\/$/, '') === `/admin/events/${eventId}`))
    : GLOBAL_NAV.flatMap(([, l]) => l).find(([to, , , end]) => (end ? location.pathname === to : location.pathname.startsWith(to)));
  const section = current?.[1];
  const blocked = current && !ok(current);
  const switchedOff = eventId && current && !on(current) && FEATURES.find(([k]) => k === current[3])?.[1];

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
              {eventGroups.map(([group, links]) => (
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
              {links.map(([to, label, , end]) => <NavLink key={to} to={to} end={end}>{label}</NavLink>)}
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
        {blocked ? (
          <div className="empty" style={{ marginTop: 24 }}>
            <h3>You don't have access to {section}</h3>
            <div className="small">Ask an owner to add the permission to one of your staff groups, or to you directly.</div>
          </div>
        ) : switchedOff ? (
          <div className="empty" style={{ marginTop: 24 }}>
            <h3>{switchedOff} is turned off for this event</h3>
            <div className="small">Turn it back on under <Link to={`/admin/events/${eventId}/details`}>Details → Features</Link>. Anything set up before is still there.</div>
          </div>
        ) : <Outlet />}
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { api } from '../lib/api.js';
import Breadcrumbs from './Breadcrumbs.jsx';

const TABS = [
  ['', 'Details'],
  ['attendees', 'Attendees'],
  ['kiosk', 'Kiosk'],
  ['merch', 'Merch'],
  ['reconciliation', 'Cash'],
  ['vouchers', 'Vouchers'],
];

/// Shared sub-nav for every per-event admin page, so Attendees/Kiosk/Merch/
/// Cash/Vouchers/Details are all one click apart instead of only reachable
/// from a crowded button row on the Events list. Also carries the breadcrumb
/// trail for this event, since every page that needs the tabs also needs it.
export default function EventTabs({ id }) {
  const [title, setTitle] = useState('');
  useEffect(() => { api.get(`/api/admin/events/${id}`).then((e) => setTitle(e.title)).catch(() => {}); }, [id]);

  return (
    <>
      <Breadcrumbs items={[{ label: 'Admin', to: '/admin' }, { label: 'Events', to: '/admin' }, { label: title || '…' }]} />
      <nav className="tabbar">
        {TABS.map(([path, label]) => (
          <NavLink key={path} to={`/admin/events/${id}${path ? `/${path}` : ''}`} end>
            {label}
          </NavLink>
        ))}
      </nav>
    </>
  );
}

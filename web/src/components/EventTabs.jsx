import { NavLink } from 'react-router-dom';

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
/// from a crowded button row on the Events list.
export default function EventTabs({ id }) {
  return (
    <nav className="tabbar">
      {TABS.map(([path, label]) => (
        <NavLink key={path} to={`/admin/events/${id}${path ? `/${path}` : ''}`} end>
          {label}
        </NavLink>
      ))}
    </nav>
  );
}

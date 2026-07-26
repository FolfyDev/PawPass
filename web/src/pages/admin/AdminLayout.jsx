import { NavLink, Outlet, Navigate } from 'react-router-dom';
import { useSession } from '../../lib/session.jsx';

export default function AdminLayout() {
  const { user, isStaff, loading } = useSession();
  if (loading) return null;
  if (!user) return <Navigate to="/login" replace />;
  if (!isStaff) return <p className="note bad" style={{ marginTop: 40 }}>This area is for staff. Ask an owner to grant you admin access.</p>;

  return (
    <div className="admin" style={{ paddingTop: 32 }}>
      <aside className="side">
        <p className="eyebrow" style={{ padding: '0 12px 6px' }}>Operations</p>
        <NavLink to="/admin" end>Events</NavLink>
        <NavLink to="/admin/scan">Check in &amp; print</NavLink>
        <NavLink to="/admin/badges">Badge designer</NavLink>
        <NavLink to="/admin/email">Email</NavLink>
        <p className="eyebrow" style={{ padding: '14px 12px 6px' }}>Instance</p>
        <NavLink to="/admin/staff">Staff</NavLink>
        <NavLink to="/admin/audit">Audit log</NavLink>
        <NavLink to="/admin/settings">Settings</NavLink>
      </aside>
      <div><Outlet /></div>
    </div>
  );
}

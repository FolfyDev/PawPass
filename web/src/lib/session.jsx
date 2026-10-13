import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api } from './api.js';
import { wipeOfflineCheckin, isNetworkError } from './offlineCheckin.js';

// The last signed-in staff member (name, role and permissions only), so a door scanner
// that's reloaded with no connection still opens instead of bouncing to the
// sign-in page. Only ever used when the server can't be reached at all; the
// server checks the real session cookie on every request regardless.
const OFFLINE_STAFF = 'pawpass.offline.staff';
const OFFLINE_STAFF_DAYS = 4;
const rememberStaff = (user) => {
  try {
    if (user && (user.role === 'ADMIN' || user.role === 'OWNER')) {
      localStorage.setItem(OFFLINE_STAFF, JSON.stringify({ id: user.id, displayName: user.displayName, role: user.role, permissions: user.permissions, savedAt: Date.now() }));
    } else localStorage.removeItem(OFFLINE_STAFF);
  } catch { /* no storage, no offline sign-in */ }
};
const rememberedStaff = () => {
  try {
    const u = JSON.parse(localStorage.getItem(OFFLINE_STAFF) || 'null');
    return u && Date.now() - u.savedAt < OFFLINE_STAFF_DAYS * 86_400_000 ? { ...u, offline: true } : null;
  } catch { return null; }
};

const Ctx = createContext(null);

export function SessionProvider({ children }) {
  const [user, setUser] = useState(null);
  const [settings, setSettings] = useState(null);
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const [me, s, c] = await Promise.all([
      api.get('/api/auth/me')
        .then((r) => { rememberStaff(r.user); return r; })
        .catch((e) => ({ user: isNetworkError(e) ? rememberedStaff() : null })),
      api.get('/api/settings').catch(() => ({})),
      api.get('/api/auth/config').catch(() => ({})),
    ]);
    setUser(me.user);
    setSettings(s);
    setConfig(c);
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    if (settings?.accentColor) document.documentElement.style.setProperty('--signal', settings.accentColor);
  }, [settings]);

  const logout = async () => {
    rememberStaff(null);
    wipeOfflineCheckin();
    await api.post('/api/auth/logout').catch(() => {});
    setUser(null);
  };

  // What this staff member may do (lib/permissions.js on the server). The
  // server checks every request regardless; this only decides what to show.
  const can = useCallback((perm) => user?.role === 'OWNER' || Boolean(user?.permissions?.includes(perm)), [user]);

  return (
    <Ctx.Provider value={{
      user, settings, config, loading, refresh, logout, can,
      isStaff: user?.role === 'ADMIN' || user?.role === 'OWNER', isOwner: user?.role === 'OWNER',
    }}>
      {children}
    </Ctx.Provider>
  );
}


export const useSession = () => useContext(Ctx);

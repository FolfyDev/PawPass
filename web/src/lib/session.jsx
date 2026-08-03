import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api } from './api.js';

const Ctx = createContext(null);

export function SessionProvider({ children }) {
  const [user, setUser] = useState(null);
  const [settings, setSettings] = useState(null);
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const [me, s, c] = await Promise.all([
      api.get('/api/auth/me').catch(() => ({ user: null })),
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
    if (settings?.orgName) document.title = settings.orgName;
  }, [settings]);

  const logout = async () => { await api.post('/api/auth/logout'); setUser(null); };

  return (
    <Ctx.Provider value={{ user, settings, config, loading, refresh, logout, isStaff: user?.role === 'ADMIN' || user?.role === 'OWNER' }}>
      {children}
    </Ctx.Provider>
  );
}


export const useSession = () => useContext(Ctx);

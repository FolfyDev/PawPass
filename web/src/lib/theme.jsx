import { createContext, useContext, useEffect, useState, useCallback } from 'react';

const Ctx = createContext(null);
const STORAGE_KEY = 'pawpass-theme';

const systemPrefersDark = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches;

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(() => localStorage.getItem(STORAGE_KEY) || (systemPrefersDark() ? 'dark' : 'light'));

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  const toggleTheme = useCallback(() => setTheme((t) => (t === 'dark' ? 'light' : 'dark')), []);

  return <Ctx.Provider value={{ theme, toggleTheme }}>{children}</Ctx.Provider>;
}

export const useTheme = () => useContext(Ctx);

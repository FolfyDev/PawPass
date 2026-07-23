import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { SessionProvider } from './lib/session.jsx';
import { ThemeProvider } from './lib/theme.jsx';
import App from './App.jsx';
import './theme.css';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <ThemeProvider>
        <SessionProvider>
          <App />
        </SessionProvider>
      </ThemeProvider>
    </BrowserRouter>
  </React.StrictMode>,
);

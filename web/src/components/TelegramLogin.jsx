import { useEffect, useRef } from 'react';
import { api } from '../lib/api.js';

/// Mounts Telegram's Login Widget. The callback hash is verified server-side,
/// so the button is the whole sign-in flow for attendees.
export default function TelegramLogin({ botUsername, onDone, mode = 'login', label = 'Log in with Telegram' }) {
  const host = useRef(null);

  useEffect(() => {
    if (!botUsername || !host.current) return;
    window.onTelegramAuth = async (data) => {
      try {
        await api.post(mode === 'link' ? '/api/auth/link-telegram' : '/api/auth/telegram', data);
        onDone?.();
      } catch (e) {
        alert(e.message);
      }
    };
    const s = document.createElement('script');
    s.src = 'https://telegram.org/js/telegram-widget.js?22';
    s.async = true;
    s.setAttribute('data-telegram-login', botUsername);
    s.setAttribute('data-size', 'large');
    s.setAttribute('data-radius', '10');
    s.setAttribute('data-userpic', 'false');
    s.setAttribute('data-onauth', 'onTelegramAuth(user)');
    host.current.replaceChildren(s);
  }, [botUsername, mode, onDone]);

  if (!botUsername)
    return <p className="note bad">Telegram sign-in is not configured. Set TELEGRAM_BOT_USERNAME and run /setdomain with BotFather.</p>;

  return (
    <div>
      <div ref={host} />
      <p className="small muted" style={{ marginTop: 8 }}>{label}</p>
    </div>
  );
}

import { useEffect, useRef } from 'react';
let scriptPromise;
function loadScript() {
  if (!scriptPromise) {
    scriptPromise = new Promise((resolve) => {
      window.__onTurnstileLoad = resolve;
      const s = document.createElement('script');
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=__onTurnstileLoad&render=explicit';
      s.async = true;
      s.defer = true;
      document.head.appendChild(s);
    });
  }
  return scriptPromise;
}


export default function Turnstile({ siteKey, onChange }) {
  const host = useRef(null);
  const widgetId = useRef(null);

  useEffect(() => {
    let cancelled = false;
    loadScript().then(() => {
      if (cancelled || !host.current || widgetId.current !== null) return;
      widgetId.current = window.turnstile.render(host.current, {
        sitekey: siteKey,
        callback: (token) => onChange(token),
        'expired-callback': () => onChange(''),
        'error-callback': () => onChange(''),
      });
    });
    return () => { cancelled = true; };
  }, [siteKey]);

  return <div ref={host} />;
}

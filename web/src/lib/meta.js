import { useEffect } from 'react';
import { useSession } from './session.jsx';

function setMeta(selector, attr, value, content) {
  if (!content) return;
  let el = document.querySelector(selector);
  if (!el) { el = document.createElement('meta'); el.setAttribute(attr, value); document.head.appendChild(el); }
  el.setAttribute('content', content);
}

/// Per-page <title>, meta description, and Open Graph/Twitter tags. Only
/// meaningfully reaches crawlers that execute JS (Googlebot does; link
/// unfurlers like Discord/Slack/Twitter do not) — this is a client-rendered
/// SPA with no server-side rendering, so those still see index.html's static
/// defaults. Call once per route component, after `loading` is settled.
export function usePageMeta({ title, description, noindex = false }) {
  const { settings } = useSession();

  useEffect(() => {
    const orgName = settings?.orgName || 'PawPass';
    const fullTitle = title ? `${title} · ${orgName}` : orgName;
    const desc = description || settings?.tagline || 'Registration for community events';

    document.title = fullTitle;
    setMeta('meta[name="description"]', 'name', 'description', desc);
    setMeta('meta[name="robots"]', 'name', 'robots', noindex ? 'noindex, nofollow' : 'index, follow');
    setMeta('meta[property="og:title"]', 'property', 'og:title', fullTitle);
    setMeta('meta[property="og:description"]', 'property', 'og:description', desc);
    setMeta('meta[property="og:type"]', 'property', 'og:type', 'website');
    setMeta('meta[property="og:url"]', 'property', 'og:url', window.location.href);
    setMeta('meta[name="twitter:card"]', 'name', 'twitter:card', 'summary');
    setMeta('meta[name="twitter:title"]', 'name', 'twitter:title', fullTitle);
    setMeta('meta[name="twitter:description"]', 'name', 'twitter:description', desc);
  }, [title, description, noindex, settings?.orgName, settings?.tagline]);
}

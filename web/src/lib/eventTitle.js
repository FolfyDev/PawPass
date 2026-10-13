import { useEffect, useState } from 'react';
import { api } from './api.js';

// The admin sidebar and every event page's breadcrumbs want the event's
// title. One request per event per page load, shared.
const cache = new Map();

export function useEventTitle(id) {
  const [title, setTitle] = useState(() => (id && typeof cache.get(id) === 'string' ? cache.get(id) : ''));
  useEffect(() => {
    if (!id) return undefined;
    let live = true;
    if (!cache.has(id)) cache.set(id, api.get(`/api/admin/events/${id}`).then((e) => { cache.set(id, e.title); return e.title; }).catch(() => { cache.delete(id); return ''; }));
    Promise.resolve(cache.get(id)).then((t) => { if (live) setTitle(t); });
    return () => { live = false; };
  }, [id]);
  return title;
}

/// After renaming an event, so the sidebar shows the new title.
export const forgetEventTitle = (id) => cache.delete(id);

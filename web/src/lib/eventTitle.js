import { useEffect, useState } from 'react';
import { api } from './api.js';

// The admin sidebar and every event page's breadcrumbs want the event's
// title (and the sidebar, which features are on). One request per event per
// page load, shared.
const cache = new Map();
const listeners = new Set();

const load = (id) => {
  if (!cache.has(id)) {
    cache.set(id, api.get(`/api/admin/events/${id}`)
      .then((e) => { const info = { title: e.title, disabledFeatures: e.disabledFeatures || [] }; cache.set(id, info); return info; })
      .catch(() => { cache.delete(id); return null; }));
  }
  return Promise.resolve(cache.get(id));
};

/// { title, disabledFeatures }, or null until it has loaded.
export function useEventInfo(id) {
  const [info, setInfo] = useState(() => {
    const hit = id && cache.get(id);
    return hit && !(hit instanceof Promise) ? hit : null;
  });
  useEffect(() => {
    if (!id) return undefined;
    let live = true;
    const refresh = () => load(id).then((i) => { if (live) setInfo(i); });
    refresh();
    listeners.add(refresh);
    return () => { live = false; listeners.delete(refresh); };
  }, [id]);
  return info;
}

export const useEventTitle = (id) => useEventInfo(id)?.title || '';

/// After saving an event, so the sidebar shows the new title and features.
export const forgetEventTitle = (id) => {
  cache.delete(id);
  for (const refresh of listeners) refresh();
};

const BASE = import.meta.env.VITE_API_BASE || '';

async function request(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    credentials: 'include',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.error || 'Request failed.');
  return data;
}

async function upload(path, file) {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`${BASE}${path}`, { method: 'POST', credentials: 'include', body: form });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.error || 'Upload failed.');
  return data;
}

export const api = {
  base: BASE,
  get: (p) => request('GET', p),
  post: (p, b) => request('POST', p, b),
  patch: (p, b) => request('PATCH', p, b),
  put: (p, b) => request('PUT', p, b),
  del: (p) => request('DELETE', p),
  upload,
};

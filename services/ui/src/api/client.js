const BASE = '/api';

function headers(token) {
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function request(method, path, body, token) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: headers(token),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = res.headers.get('content-type')?.includes('json')
    ? await res.json()
    : await res.text();
  if (!res.ok) throw Object.assign(new Error(data?.error || 'Request failed'), { status: res.status, data });
  return data;
}

export const api = {
  login:        (apiKey)         => request('POST', '/auth/token', { apiKey }),
  createTest:   (config, idKey, token) =>
    request('POST', '/tests', config, token, idKey),
  listTests:    (page = 1, token) => request('GET', `/tests?page=${page}&limit=20`, undefined, token),
  getTest:      (id, token)      => request('GET', `/tests/${id}`, undefined, token),
  cancelTest:   (id, token)      => request('DELETE', `/tests/${id}`, undefined, token),
};

// createTest needs the Idempotency-Key header — override fetch call
api.createTest = async (config, idempotencyKey, token) => {
  const res = await fetch(`${BASE}/tests`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify(config),
  });
  const data = res.headers.get('content-type')?.includes('json')
    ? await res.json()
    : await res.text();
  if (!res.ok) throw Object.assign(new Error(data?.error || 'Create failed'), { status: res.status, data });
  return data;
};

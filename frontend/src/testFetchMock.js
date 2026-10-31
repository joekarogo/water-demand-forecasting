// Minimal fetch Response stand-in for tests. Avoids depending on
// whatwg-fetch's Headers/Response globals (not polyfilled in this
// Jest/jsdom setup) by only implementing what apiClient.js and the
// components here actually call: .ok, .status, .headers.get(name), .json().
export function fakeResponse({ status = 200, body = {}, headers = {} } = {}) {
  const lowerHeaders = {};
  Object.keys(headers).forEach((key) => {
    lowerHeaders[key.toLowerCase()] = headers[key];
  });
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (name ? lowerHeaders[name.toLowerCase()] ?? null : null) },
    json: async () => body,
  };
}

export const SAMPLE_SESSION = {
  user_id: 1,
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  job_title: null,
  role: 'admin',
  role_label: 'Admin',
  permissions: ['forecast:view', 'user:manage', 'plan:view'],
  csrf_token: 'test-csrf-token',
  session_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
};

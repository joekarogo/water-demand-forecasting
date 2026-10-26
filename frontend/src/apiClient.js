import { API_BASE } from './api';

// Set by session.js whenever the session changes (including to null on
// sign-out) — kept as a plain module-level value rather than something
// apiFetch has to be handed on every call, since apiFetch is used from
// plain async functions, not just components that can read context.
let currentCsrfToken = null;

export function setCsrfToken(token) {
  currentCsrfToken = token || null;
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Thin wrapper around fetch — it still returns the raw Response, so every
// page keeps its own existing status handling (401 -> session expired,
// 403 -> no permission, etc.) exactly as before. All it adds is: cookies
// on same-origin requests, and the CSRF header required by the backend on
// cookie-authenticated writes.
export async function apiFetch(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const headers = new Headers(options.headers || {});

  if (MUTATING_METHODS.has(method) && currentCsrfToken) {
    headers.set('X-CSRF-Token', currentCsrfToken);
  }

  return fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
    credentials: 'same-origin',
  });
}

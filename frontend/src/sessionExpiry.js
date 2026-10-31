// Shared session-expiry state, read from the X-Session-Expires-In /
// X-Session-Max-Reached headers apiClient.js attaches to on every
// response. Kept as a plain module (like apiClient.js's own CSRF token)
// rather than React state, since it has to be set from apiFetch itself,
// not just from components. Mirrored across tabs with BroadcastChannel so
// one tab extending the session (or signing out) stops every other tab
// from warning on stale information.
const CHANNEL_NAME = 'session-expiry';

let expiresAt = null; // epoch ms, or null when signed out
let maxReached = false;
const listeners = new Set();

let channel = null;
try {
  if (typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = (event) => {
      applyLocal(event.data.expiresAt, event.data.maxReached, false);
    };
  }
} catch (err) {
  channel = null;
}

function applyLocal(newExpiresAt, newMaxReached, broadcast) {
  expiresAt = newExpiresAt;
  maxReached = newMaxReached;
  listeners.forEach((fn) => fn({ expiresAt, maxReached }));
  if (broadcast && channel) {
    try {
      channel.postMessage({ expiresAt, maxReached });
    } catch (err) {
      // Cross-tab sharing is a nice-to-have, not load-bearing — this
      // tab's own state (set above) is unaffected either way.
    }
  }
}

export function setSessionExpiryFromHeaders(headers) {
  const secondsHeader = headers.get('X-Session-Expires-In');
  if (secondsHeader === null) return;
  const seconds = Number(secondsHeader);
  if (!Number.isFinite(seconds)) return;
  applyLocal(Date.now() + seconds * 1000, headers.get('X-Session-Max-Reached') === 'true', true);
}

export function clearSessionExpiry() {
  applyLocal(null, false, true);
}

export function getSessionExpiry() {
  return { expiresAt, maxReached };
}

export function subscribeSessionExpiry(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

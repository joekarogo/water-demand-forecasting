// Decodes a JWT's payload without verifying its signature. This is safe for
// reading non-sensitive claims (like `role`/`name`) to decide what to render —
// the backend still independently verifies the token's signature on every
// protected request, so a tampered token can't actually grant extra access.
export function decodeToken(token) {
  if (!token) {
    return null;
  }

  try {
    const payload = token.split('.')[1];
    const decoded = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(decoded);
  } catch (err) {
    return null;
  }
}

export function getUserRole(token) {
  const decoded = decodeToken(token);
  return decoded ? decoded.role : null;
}

export function getUserName(token) {
  const decoded = decodeToken(token);
  return decoded ? decoded.name : null;
}

// In development, requests go through CRA's dev-server proxy (see the
// "proxy" field in package.json), so API_BASE is empty and `fetch` calls
// relative paths. In production, set REACT_APP_API_URL to the backend's
// real origin at build time.
export const API_BASE = process.env.REACT_APP_API_URL || '';

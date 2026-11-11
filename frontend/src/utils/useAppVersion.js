import { useEffect, useState } from 'react';
import { apiFetch } from '../apiClient';

// Shared by Sidebar.js (signed-in shell) and AuthLayout.js (sign-in /
// emergency-access, unauthenticated) — both just need "major.minor" from
// the live backend version, not the full semver string. GET /api/health is
// deliberately unauthenticated, so this works before sign-in too.
// Returns null while loading or if the fetch fails, so callers can render
// nothing rather than "Version undefined".
export function useAppVersion() {
  const [majorMinor, setMajorMinor] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await apiFetch('/api/health');
        if (!response.ok) return;
        const body = await response.json();
        const parts = String(body.version || '').split('.');
        if (!cancelled && parts.length >= 2) {
          setMajorMinor(`${parts[0]}.${parts[1]}`);
        }
      } catch (err) {
        // Leave majorMinor as null — callers render nothing rather than
        // a broken "Version undefined" string.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return majorMinor;
}

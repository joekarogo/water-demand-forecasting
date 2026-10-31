import { useEffect } from 'react';

// WCAG 2.4.2 (Page Titled): every page gets its own, distinguishable
// document.title, not just the app's generic name.
export function useDocumentTitle(title) {
  useEffect(() => {
    document.title = title ? `${title} · Water Demand Forecasting` : 'Water Demand Forecasting';
  }, [title]);
}

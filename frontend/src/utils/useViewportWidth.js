import { useEffect, useState } from 'react';

// Tracks window.innerWidth, used as a proxy for how much room the chart
// actually has (it spans ~the full content width) so the X axis can switch
// to fewer, shorter-labeled ticks before they start overlapping.
export function useViewportWidth() {
  const [width, setWidth] = useState(() => (typeof window !== 'undefined' ? window.innerWidth : 1280));

  useEffect(() => {
    const handleResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  return width;
}

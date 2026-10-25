import { useEffect, useRef, useState } from 'react';
import { InfoIcon } from '../layout/icons';

// ⓘ tooltip that works on hover (CSS :hover), keyboard focus (CSS
// :focus-visible + .tip) and tap (toggles the `open` class, closed by an
// outside click or Escape) — mirrors the behavior in the design mockup.
function InfoTip({ id, label, align, children }) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handleOutsideClick = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        setOpen(false);
      }
    };
    document.addEventListener('click', handleOutsideClick);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('click', handleOutsideClick);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  return (
    <span className={`info${open ? ' open' : ''}`} ref={wrapperRef}>
      <button
        type="button"
        className="info-btn"
        aria-label={label}
        aria-describedby={id}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <InfoIcon />
      </button>
      <span className={`tip${align === 'right' ? ' right' : ''}`} role="tooltip" id={id}>
        {children}
      </span>
    </span>
  );
}

export default InfoTip;

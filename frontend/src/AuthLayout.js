import { BrandIcon } from './layout/icons';
import './App.css';

// Shared shell for the sign-in and emergency-access pages: a single
// centred card on the app's plain background, same pattern as the rest
// of the app's pages (docs/design/sign_in_mockup.html).
function AuthLayout({ title, subtitle, children }) {
  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="logo-row">
          <span className="brand-icon" aria-hidden="true">
            <BrandIcon />
          </span>
          <span>Water Demand Forecasting</span>
        </div>
        <h1>{title}</h1>
        {subtitle && <p className="auth-sub">{subtitle}</p>}
        {children}
      </div>
      <footer className="auth-foot">Version 1.0 · Data: İZSU Open Data (İzmir)</footer>
    </div>
  );
}

export default AuthLayout;

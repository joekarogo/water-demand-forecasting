import { BrandIcon } from './layout/icons';
import { useAppVersion } from './utils/useAppVersion';
import './App.css';

// Shared shell for the sign-in and emergency-access pages: a single
// centred card on the app's plain background, same pattern as the rest
// of the app's pages (docs/design/sign_in_mockup.html).
function AuthLayout({ title, subtitle, children }) {
  const appVersion = useAppVersion();
  return (
    <div className="auth-page">
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>
      <div className="auth-card">
        <div className="logo-row">
          <span className="brand-icon" aria-hidden="true">
            <BrandIcon />
          </span>
          <span>Water Demand Forecasting</span>
        </div>
        <main id="main-content" tabIndex="-1">
          <h1>{title}</h1>
          {subtitle && <p className="auth-sub">{subtitle}</p>}
          {children}
        </main>
      </div>
      <footer className="auth-foot">
        {appVersion ? `Version ${appVersion} · ` : ''}Data: İZSU Open Data (İzmir)
      </footer>
    </div>
  );
}

export default AuthLayout;

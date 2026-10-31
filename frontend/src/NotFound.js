import { Link } from 'react-router-dom';
import { useSession } from './session';
import { getFirstPermittedPath } from './layout/menuConfig';
import AppLayout from './layout/AppLayout';
import { useDocumentTitle } from './useDocumentTitle';
import './App.css';

function SignedOutNotFound() {
  useDocumentTitle('Page not found');
  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1>Page not found</h1>
        <p className="auth-sub">This page doesn't exist.</p>
        <Link className="btn btn-primary" to="/login">
          Go to sign in
        </Link>
      </div>
    </div>
  );
}

function SignedInNotFound() {
  const { session } = useSession();
  return (
    <AppLayout title="Page not found">
      <section className="card error-card" role="alert">
        <h2>This page doesn't exist.</h2>
        <Link className="btn btn-primary" to={getFirstPermittedPath(session?.permissions)}>
          Go to a page you can access
        </Link>
      </section>
    </AppLayout>
  );
}

// Signed in: shown inside the normal shell, with a way back to somewhere
// permitted. Signed out: a plain card pointing at sign-in — unknown URLs
// are never silently redirected away in either case.
function NotFound() {
  const { session, loading } = useSession();
  if (loading) return null;
  return session ? <SignedInNotFound /> : <SignedOutNotFound />;
}

export default NotFound;

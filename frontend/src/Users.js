import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiFetch } from './apiClient';
import { useSession } from './session';
import AppLayout from './layout/AppLayout';
import { RetryIcon, ErrorTriangleIcon } from './layout/icons';
import { formatDateTime } from './utils/format';
import './App.css';

const ROLES = [
  { value: 'admin', label: 'Admin' },
  { value: 'production_manager', label: 'Production Manager' },
  { value: 'commercial_officer', label: 'Commercial Officer' },
];
const ROLE_LABELS = Object.fromEntries(ROLES.map((r) => [r.value, r.label]));

const STATUS_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'invited', label: 'Invited' },
  { value: 'active', label: 'Active' },
  { value: 'deactivated', label: 'Deactivated' },
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Clears one field's stale server-side error as soon as the user edits
// that field — same pattern as ProductionPlanning.js.
function clearFieldError(setErrors, field) {
  setErrors((prev) => {
    if (!(field in prev)) return prev;
    const next = { ...prev };
    delete next[field];
    return next;
  });
}

// Escape closes, Tab wraps focus inside the panel — same behaviour as
// ProductionPlanning.js's single panel, factored out here since this
// page has two (invite + detail).
function usePanelFocusTrap(isOpen, panelRef, onClose) {
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key === 'Tab' && panelRef.current) {
        const focusable = [...panelRef.current.querySelectorAll('button, input, select, textarea')].filter(
          (el) => !el.disabled && el.offsetParent !== null
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, panelRef, onClose]);
}

function StatusBadge({ status }) {
  if (status === 'active') {
    return (
      <span className="badge ok">
        <span aria-hidden="true">✓</span> Active
      </span>
    );
  }
  if (status === 'invited') {
    return (
      <span className="badge warn">
        <span aria-hidden="true">✉</span> Invited
      </span>
    );
  }
  return (
    <span className="badge none">
      <span aria-hidden="true">○</span> Deactivated
    </span>
  );
}

function ReauthPrompt({ onSignInAgain }) {
  return (
    <div className="alert danger" role="alert">
      <span aria-hidden="true">⚠</span>
      <span>
        For security, sign in again to make this change.{' '}
        <button type="button" className="kpi-link" onClick={onSignInAgain}>
          Sign in again
        </button>
      </span>
    </div>
  );
}

function Users() {
  const navigate = useNavigate();
  const { session, loading: sessionLoading, clearSession } = useSession();
  const hasUserManage = useMemo(() => Boolean(session?.permissions?.includes('user:manage')), [session]);
  const currentUserId = session?.user_id;

  const [status, setStatus] = useState('loading'); // loading | ready | error | forbidden
  const [errorReference, setErrorReference] = useState(null);
  const [users, setUsers] = useState([]);

  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');

  const [toast, setToast] = useState('');
  const toastTimerRef = useRef(null);
  const showToast = useCallback((message) => {
    setToast(message);
    clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(''), 3200);
  }, []);

  const handleAuthError = useCallback(
    (response) => {
      if (response.status === 401) {
        clearSession();
        navigate('/login', {
          replace: true,
          state: { message: 'Your session has expired. Please sign in again.' },
        });
        return true;
      }
      return false;
    },
    [navigate, clearSession]
  );

  // Used by the reauth_required prompt: a risky action's session was too
  // old, so the only fix is a genuinely fresh sign-in, not just reloading.
  const signInAgain = useCallback(async () => {
    try {
      await apiFetch('/api/auth/logout', { method: 'POST' });
    } catch (err) {
      // ignore — we're sending them to sign in again regardless
    }
    clearSession();
    navigate('/login', { replace: true, state: { message: 'Sign in again to continue.' } });
  }, [navigate, clearSession]);

  const fetchUsers = useCallback(async () => {
    setStatus('loading');
    try {
      const response = await apiFetch('/api/users');
      if (handleAuthError(response)) return;
      if (response.status === 403) {
        setStatus('forbidden');
        return;
      }
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setErrorReference(body.reference || null);
        setStatus('error');
        return;
      }
      setUsers(body.users || []);
      setStatus('ready');
    } catch (err) {
      setErrorReference(null);
      setStatus('error');
    }
  }, [handleAuthError]);

  useEffect(() => {
    if (sessionLoading || !session || !hasUserManage) return;
    fetchUsers();
  }, [sessionLoading, session, hasUserManage, fetchUsers]);

  const filteredUsers = useMemo(() => {
    const term = search.trim().toLowerCase();
    return users.filter((u) => {
      if (roleFilter !== 'all' && u.role !== roleFilter) return false;
      if (statusFilter !== 'all' && u.status !== statusFilter) return false;
      if (term && !u.name.toLowerCase().includes(term) && !u.email.toLowerCase().includes(term)) return false;
      return true;
    });
  }, [users, search, roleFilter, statusFilter]);

  const hasActiveFilters = search.trim() !== '' || roleFilter !== 'all' || statusFilter !== 'all';
  const clearFilters = () => {
    setSearch('');
    setRoleFilter('all');
    setStatusFilter('all');
  };

  function applyUpdatedUser(updated) {
    setUsers((prev) => prev.map((u) => (u.user_id === updated.user_id ? updated : u)));
  }

  // ---------------------------------------------------------------------
  // Invite panel
  // ---------------------------------------------------------------------
  const [invitePanelOpen, setInvitePanelOpen] = useState(false);
  const [inviteName, setInviteName] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('production_manager');
  const [inviteFieldErrors, setInviteFieldErrors] = useState({});
  const [inviteError, setInviteError] = useState('');
  const [inviteSubmitting, setInviteSubmitting] = useState(false);
  const invitePanelRef = useRef(null);
  const inviteOpenerRef = useRef(null);

  const openInvitePanel = () => {
    inviteOpenerRef.current = document.activeElement;
    setInviteName('');
    setInviteEmail('');
    setInviteRole('production_manager');
    setInviteFieldErrors({});
    setInviteError('');
    setInvitePanelOpen(true);
  };
  const closeInvitePanel = useCallback(() => {
    setInvitePanelOpen(false);
    if (inviteOpenerRef.current && document.body.contains(inviteOpenerRef.current)) {
      inviteOpenerRef.current.focus();
    }
  }, []);
  usePanelFocusTrap(invitePanelOpen, invitePanelRef, closeInvitePanel);
  useEffect(() => {
    if (invitePanelOpen) {
      invitePanelRef.current?.querySelector('input, select, textarea')?.focus();
    }
  }, [invitePanelOpen]);

  const handleInviteSubmit = async (e) => {
    e.preventDefault();
    const trimmedName = inviteName.trim();
    const trimmedEmail = inviteEmail.trim();
    const fieldErrors = {};
    if (!trimmedName) fieldErrors.name = 'Name is required.';
    if (!trimmedEmail) {
      fieldErrors.email = 'Email is required.';
    } else if (!EMAIL_RE.test(trimmedEmail)) {
      fieldErrors.email = 'Enter a valid email address.';
    }
    if (!inviteRole) fieldErrors.role = 'Choose a role.';
    if (Object.keys(fieldErrors).length > 0) {
      setInviteFieldErrors(fieldErrors);
      return;
    }

    setInviteSubmitting(true);
    setInviteFieldErrors({});
    setInviteError('');
    try {
      const response = await apiFetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmedName, email: trimmedEmail, role: inviteRole }),
      });
      if (handleAuthError(response)) return;
      const body = await response.json().catch(() => ({}));

      if (response.status === 400) {
        setInviteFieldErrors(body.fields || {});
        return;
      }
      if (!response.ok) {
        // 409 (duplicate email) and any other failure both land here —
        // the entered name/email/role are deliberately left as they are
        // so the user can fix and resubmit without retyping.
        setInviteError(body.error || 'Unable to invite this user right now.');
        return;
      }

      setUsers((prev) => [...prev, body].sort((a, b) => a.name.localeCompare(b.name)));
      showToast(`Invited ${body.name}`);
      closeInvitePanel();
    } catch (err) {
      setInviteError('Unable to reach the server. Please try again.');
    } finally {
      setInviteSubmitting(false);
    }
  };

  // ---------------------------------------------------------------------
  // Detail panel: change role, deactivate, reactivate
  // ---------------------------------------------------------------------
  const [selectedUserId, setSelectedUserId] = useState(null);
  const selectedUser = useMemo(() => users.find((u) => u.user_id === selectedUserId) || null, [users, selectedUserId]);
  const isSelf = Boolean(selectedUser && currentUserId === selectedUser.user_id);
  const isEmergency = selectedUser?.auth_provider === 'emergency';

  const [roleSelect, setRoleSelect] = useState('');
  const [roleSaving, setRoleSaving] = useState(false);
  const [roleFieldError, setRoleFieldError] = useState('');
  const [roleAlert, setRoleAlert] = useState(null); // { reauth: true } | { message }

  const [deactivateConfirming, setDeactivateConfirming] = useState(false);
  const [deactivateReason, setDeactivateReason] = useState('');
  const [deactivateFieldError, setDeactivateFieldError] = useState('');
  const [deactivateAlert, setDeactivateAlert] = useState(null);
  const [deactivateSubmitting, setDeactivateSubmitting] = useState(false);

  const [reactivateConfirming, setReactivateConfirming] = useState(false);
  const [reactivateAlert, setReactivateAlert] = useState(null);
  const [reactivateSubmitting, setReactivateSubmitting] = useState(false);

  const detailPanelRef = useRef(null);
  const detailOpenerRef = useRef(null);

  const openDetailPanel = (user, openerEl) => {
    detailOpenerRef.current = openerEl || document.activeElement;
    setSelectedUserId(user.user_id);
    setRoleSelect(user.role);
    setRoleFieldError('');
    setRoleAlert(null);
    setDeactivateConfirming(false);
    setDeactivateReason('');
    setDeactivateFieldError('');
    setDeactivateAlert(null);
    setReactivateConfirming(false);
    setReactivateAlert(null);
  };
  const closeDetailPanel = useCallback(() => {
    setSelectedUserId(null);
    if (detailOpenerRef.current && document.body.contains(detailOpenerRef.current)) {
      detailOpenerRef.current.focus();
    }
  }, []);
  usePanelFocusTrap(selectedUserId !== null, detailPanelRef, closeDetailPanel);
  useEffect(() => {
    if (selectedUserId !== null) {
      detailPanelRef.current?.querySelector('.icon-btn')?.focus();
    }
  }, [selectedUserId]);

  const handleRoleSave = async (e) => {
    e.preventDefault();
    if (!selectedUser) return;
    setRoleSaving(true);
    setRoleFieldError('');
    setRoleAlert(null);
    try {
      const response = await apiFetch(`/api/users/${selectedUser.user_id}/role`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: roleSelect }),
      });
      if (handleAuthError(response)) return;
      const body = await response.json().catch(() => ({}));

      if (response.status === 403 && body.code === 'reauth_required') {
        setRoleAlert({ reauth: true });
        return;
      }
      if (response.status === 400) {
        setRoleFieldError((body.fields && body.fields.role) || 'Choose a valid role.');
        return;
      }
      if (!response.ok) {
        setRoleAlert({ message: body.error || 'Unable to change this role right now.' });
        return;
      }

      applyUpdatedUser(body);
      showToast(`Role updated for ${body.name}`);
    } catch (err) {
      setRoleAlert({ message: 'Unable to reach the server. Please try again.' });
    } finally {
      setRoleSaving(false);
    }
  };

  const handleDeactivateConfirm = async (e) => {
    e.preventDefault();
    if (!selectedUser) return;
    const trimmedReason = deactivateReason.trim();
    if (trimmedReason.length < 5) {
      setDeactivateFieldError('Enter a reason (at least 5 characters).');
      return;
    }
    if (trimmedReason.length > 300) {
      setDeactivateFieldError('The reason can be at most 300 characters.');
      return;
    }

    setDeactivateSubmitting(true);
    setDeactivateFieldError('');
    setDeactivateAlert(null);
    try {
      const response = await apiFetch(`/api/users/${selectedUser.user_id}/deactivate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: trimmedReason }),
      });
      if (handleAuthError(response)) return;
      const body = await response.json().catch(() => ({}));

      if (response.status === 403 && body.code === 'reauth_required') {
        setDeactivateAlert({ reauth: true });
        return;
      }
      if (response.status === 400) {
        setDeactivateFieldError((body.fields && body.fields.reason) || 'Enter a valid reason.');
        return;
      }
      if (!response.ok) {
        setDeactivateAlert({ message: body.error || 'Unable to deactivate this user right now.' });
        return;
      }

      applyUpdatedUser(body);
      showToast(`${body.name} has been deactivated`);
      setDeactivateConfirming(false);
      setDeactivateReason('');
    } catch (err) {
      setDeactivateAlert({ message: 'Unable to reach the server. Please try again.' });
    } finally {
      setDeactivateSubmitting(false);
    }
  };

  const handleReactivateConfirm = async () => {
    if (!selectedUser) return;
    setReactivateSubmitting(true);
    setReactivateAlert(null);
    try {
      const response = await apiFetch(`/api/users/${selectedUser.user_id}/reactivate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (handleAuthError(response)) return;
      const body = await response.json().catch(() => ({}));

      if (response.status === 403 && body.code === 'reauth_required') {
        setReactivateAlert({ reauth: true });
        return;
      }
      if (!response.ok) {
        setReactivateAlert({ message: body.error || 'Unable to reactivate this user right now.' });
        return;
      }

      applyUpdatedUser(body);
      showToast(`${body.name} has been reactivated`);
      setReactivateConfirming(false);
    } catch (err) {
      setReactivateAlert({ message: 'Unable to reach the server. Please try again.' });
    } finally {
      setReactivateSubmitting(false);
    }
  };

  if (sessionLoading || !session) {
    return null;
  }

  return (
    <AppLayout title="Users" subtitle="Manage who can sign in and what they can do" requiredPermission="user:manage">
      {status === 'loading' && (
        <>
          <div className="state-banner" role="status" aria-live="polite">
            <span className="state-banner-spinner" aria-hidden="true" />
            <div>Loading users…</div>
          </div>
          <div className="card sk-table" aria-hidden="true">
            <div className="sk" style={{ width: '30%', height: 14 }} />
            <div className="sk" style={{ width: '40%', height: 28 }} />
            {[1, 2, 3, 4, 5].map((n) => (
              <div className="sk" style={{ height: 16 }} key={n} />
            ))}
          </div>
        </>
      )}

      {status === 'error' && (
        <section className="card error-card" role="alert">
          <span className="error-icon" aria-hidden="true">
            <ErrorTriangleIcon />
          </span>
          <h2>The user list couldn't be loaded.</h2>
          <p>
            Try again in a moment.
            {errorReference
              ? ` If it keeps happening, tell your system administrator (reference ${errorReference}).`
              : ' If it keeps happening, tell your system administrator.'}
          </p>
          <button className="btn btn-primary" type="button" style={{ marginTop: 8 }} onClick={fetchUsers}>
            <RetryIcon />
            Retry
          </button>
        </section>
      )}

      {status === 'forbidden' && (
        <section className="card error-card" role="alert">
          <span className="error-icon" aria-hidden="true">
            <ErrorTriangleIcon />
          </span>
          <h2>You don't have permission to manage users.</h2>
        </section>
      )}

      {status === 'ready' && (
        <section className="card" aria-labelledby="usersTitle">
          <div className="card-head">
            <div>
              <h2 className="card-title" id="usersTitle">
                All users
              </h2>
              <p className="card-sub">{users.length} total</p>
            </div>
            <button type="button" className="btn btn-primary" onClick={openInvitePanel}>
              Invite user
            </button>
          </div>

          <div className="controls" role="group" aria-label="Filter users">
            <div className="field" style={{ minWidth: 220 }}>
              <label htmlFor="userSearch">Search</label>
              <input
                className="input"
                type="search"
                id="userSearch"
                placeholder="Name or email"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div className="field" style={{ minWidth: 180 }}>
              <label htmlFor="roleFilter">Role</label>
              <select className="input" id="roleFilter" value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)}>
                <option value="all">All roles</option>
                {ROLES.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="ctl-group">
              <span className="ctl-label" id="statusFilterLabel">
                Status
              </span>
              <div className="segmented" role="radiogroup" aria-labelledby="statusFilterLabel">
                {STATUS_FILTERS.map((s) => (
                  <button
                    key={s.value}
                    type="button"
                    role="radio"
                    aria-checked={statusFilter === s.value}
                    tabIndex={statusFilter === s.value ? 0 : -1}
                    onClick={() => setStatusFilter(s.value)}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {filteredUsers.length === 0 ? (
            <div style={{ padding: '32px 24px', textAlign: 'center', color: 'var(--text-2)' }}>
              <p style={{ margin: '0 0 10px' }}>
                {users.length === 0 ? 'No users yet.' : 'No users match your search or filters.'}
              </p>
              {hasActiveFilters && (
                <button type="button" className="btn" onClick={clearFilters}>
                  Clear filters
                </button>
              )}
            </div>
          ) : (
            <div className="table-wrap">
              <table className="plan-table">
                <caption className="sr-only">Users and their roles and status. Select a row to manage that user.</caption>
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col" className="l">
                      Email
                    </th>
                    <th scope="col" className="l">
                      Role
                    </th>
                    <th scope="col" className="l">
                      Status
                    </th>
                    <th scope="col">Last sign-in</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredUsers.map((u) => (
                    <tr key={u.user_id} onClick={() => openDetailPanel(u, null)}>
                      <td>
                        <button type="button" className="row-btn" aria-label={`Manage ${u.name}`} aria-haspopup="dialog">
                          {u.name}
                        </button>
                        {u.user_id === currentUserId && <span className="tag-next">You</span>}
                        {u.auth_provider === 'emergency' && <span className="warn-pill">Emergency</span>}
                      </td>
                      <td className="l">{u.email}</td>
                      <td className="l">{u.role_label || ROLE_LABELS[u.role] || u.role}</td>
                      <td className="l">
                        <StatusBadge status={u.status} />
                      </td>
                      <td>{u.last_login_at ? formatDateTime(u.last_login_at) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {invitePanelOpen && (
        <>
          <div className="panel-scrim" onClick={closeInvitePanel} />
          <aside className="panel open" role="dialog" aria-modal="true" aria-labelledby="inviteTitle" ref={invitePanelRef}>
            <div className="panel-head">
              <div>
                <p className="kicker">Users</p>
                <h2 id="inviteTitle">Invite user</h2>
              </div>
              <button type="button" className="icon-btn" aria-label="Close panel" onClick={closeInvitePanel}>
                ✕
              </button>
            </div>
            <form className="panel-body" id="inviteForm" onSubmit={handleInviteSubmit}>
              <div className="field">
                <label htmlFor="inviteName">Name</label>
                <input
                  className="input"
                  id="inviteName"
                  value={inviteName}
                  aria-invalid={inviteFieldErrors.name ? 'true' : 'false'}
                  onChange={(e) => {
                    setInviteName(e.target.value);
                    clearFieldError(setInviteFieldErrors, 'name');
                  }}
                />
                {inviteFieldErrors.name && <span className="field-err">{inviteFieldErrors.name}</span>}
              </div>
              <div className="field">
                <label htmlFor="inviteEmail">Google email</label>
                <input
                  className="input"
                  type="email"
                  id="inviteEmail"
                  value={inviteEmail}
                  aria-invalid={inviteFieldErrors.email ? 'true' : 'false'}
                  onChange={(e) => {
                    setInviteEmail(e.target.value);
                    clearFieldError(setInviteFieldErrors, 'email');
                  }}
                />
                {inviteFieldErrors.email && <span className="field-err">{inviteFieldErrors.email}</span>}
              </div>
              <div className="field">
                <label htmlFor="inviteRole">Role</label>
                <select
                  className="input"
                  id="inviteRole"
                  value={inviteRole}
                  aria-invalid={inviteFieldErrors.role ? 'true' : 'false'}
                  onChange={(e) => {
                    setInviteRole(e.target.value);
                    clearFieldError(setInviteFieldErrors, 'role');
                  }}
                >
                  {ROLES.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
                {inviteFieldErrors.role && <span className="field-err">{inviteFieldErrors.role}</span>}
              </div>
              {inviteError && (
                <div className="alert danger" role="alert">
                  <span aria-hidden="true">⚠</span>
                  <span>{inviteError}</span>
                </div>
              )}
            </form>
            <div className="panel-foot">
              <button type="button" className="btn" onClick={closeInvitePanel}>
                Cancel
              </button>
              <button type="submit" form="inviteForm" className="btn btn-primary" disabled={inviteSubmitting}>
                {inviteSubmitting ? 'Inviting…' : 'Send invite'}
              </button>
            </div>
          </aside>
        </>
      )}

      {selectedUser && (
        <>
          <div className="panel-scrim" onClick={closeDetailPanel} />
          <aside className="panel open" role="dialog" aria-modal="true" aria-labelledby="detailTitle" ref={detailPanelRef}>
            <div className="panel-head">
              <div>
                <p className="kicker">Users</p>
                <h2 id="detailTitle">{selectedUser.name}</h2>
              </div>
              <button type="button" className="icon-btn" aria-label="Close panel" onClick={closeDetailPanel}>
                ✕
              </button>
            </div>
            <div className="panel-body">
              <div className="current">
                {selectedUser.email} · <StatusBadge status={selectedUser.status} />
                {isSelf && <span className="tag-next">You</span>}
                {isEmergency && <span className="warn-pill">Emergency account</span>}
              </div>
              {selectedUser.status === 'deactivated' && selectedUser.deactivation_reason && (
                <p className="field-hint">Deactivation reason: {selectedUser.deactivation_reason}</p>
              )}

              <form onSubmit={handleRoleSave} className="field">
                <label htmlFor="roleSelect">Change role</label>
                <select
                  className="input"
                  id="roleSelect"
                  value={roleSelect}
                  disabled={isSelf || isEmergency}
                  aria-invalid={roleFieldError ? 'true' : 'false'}
                  onChange={(e) => {
                    setRoleSelect(e.target.value);
                    setRoleFieldError('');
                  }}
                >
                  {ROLES.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
                {roleFieldError && <span className="field-err">{roleFieldError}</span>}
                {isSelf && <span className="field-hint">You can't change your own role.</span>}
                {!isSelf && isEmergency && <span className="field-hint">Emergency accounts can't be changed here.</span>}
                {roleAlert &&
                  (roleAlert.reauth ? (
                    <ReauthPrompt onSignInAgain={signInAgain} />
                  ) : (
                    <div className="alert danger" role="alert">
                      <span aria-hidden="true">⚠</span>
                      <span>{roleAlert.message}</span>
                    </div>
                  ))}
                <button
                  type="submit"
                  className="btn btn-primary"
                  style={{ marginTop: 8, width: 'max-content' }}
                  disabled={isSelf || isEmergency || roleSaving || roleSelect === selectedUser.role}
                >
                  {roleSaving ? 'Saving…' : 'Save role'}
                </button>
              </form>

              {selectedUser.status !== 'deactivated' ? (
                <div className="field">
                  <span className="label">Deactivate</span>
                  {!deactivateConfirming ? (
                    <button
                      type="button"
                      className="btn"
                      disabled={isSelf}
                      onClick={() => setDeactivateConfirming(true)}
                      style={{ width: 'max-content' }}
                    >
                      Deactivate this user
                    </button>
                  ) : (
                    <form onSubmit={handleDeactivateConfirm} className="custom-fields">
                      <p style={{ margin: 0 }}>
                        Deactivate <b>{selectedUser.name}</b>? This signs them out immediately.
                      </p>
                      <div className="field">
                        <label htmlFor="deactivateReason">Reason</label>
                        <textarea
                          className="input"
                          id="deactivateReason"
                          rows={3}
                          value={deactivateReason}
                          aria-invalid={deactivateFieldError ? 'true' : 'false'}
                          onChange={(e) => {
                            setDeactivateReason(e.target.value);
                            setDeactivateFieldError('');
                          }}
                        />
                        {deactivateFieldError && <span className="field-err">{deactivateFieldError}</span>}
                      </div>
                      {deactivateAlert &&
                        (deactivateAlert.reauth ? (
                          <ReauthPrompt onSignInAgain={signInAgain} />
                        ) : (
                          <div className="alert danger" role="alert">
                            <span aria-hidden="true">⚠</span>
                            <span>{deactivateAlert.message}</span>
                          </div>
                        ))}
                      <div className="panel-actions">
                        <button
                          type="button"
                          className="btn"
                          onClick={() => {
                            setDeactivateConfirming(false);
                            setDeactivateReason('');
                            setDeactivateFieldError('');
                            setDeactivateAlert(null);
                          }}
                        >
                          Cancel
                        </button>
                        <button type="submit" className="btn btn-primary" disabled={deactivateSubmitting}>
                          {deactivateSubmitting ? 'Deactivating…' : 'Confirm deactivation'}
                        </button>
                      </div>
                    </form>
                  )}
                </div>
              ) : (
                <div className="field">
                  <span className="label">Reactivate</span>
                  {!reactivateConfirming ? (
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => setReactivateConfirming(true)}
                      style={{ width: 'max-content' }}
                    >
                      Reactivate this user
                    </button>
                  ) : (
                    <div className="custom-fields">
                      <p style={{ margin: 0 }}>
                        Reactivate <b>{selectedUser.name}</b>?
                      </p>
                      {reactivateAlert &&
                        (reactivateAlert.reauth ? (
                          <ReauthPrompt onSignInAgain={signInAgain} />
                        ) : (
                          <div className="alert danger" role="alert">
                            <span aria-hidden="true">⚠</span>
                            <span>{reactivateAlert.message}</span>
                          </div>
                        ))}
                      <div className="panel-actions">
                        <button type="button" className="btn" onClick={() => setReactivateConfirming(false)}>
                          Cancel
                        </button>
                        <button
                          type="button"
                          className="btn btn-primary"
                          onClick={handleReactivateConfirm}
                          disabled={reactivateSubmitting}
                        >
                          {reactivateSubmitting ? 'Reactivating…' : 'Confirm reactivation'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="panel-foot">
              <button type="button" className="btn" onClick={closeDetailPanel}>
                Close
              </button>
            </div>
          </aside>
        </>
      )}

      {toast && (
        <div className="toast show" role="status" aria-live="polite">
          <span className="tick" aria-hidden="true">
            ✓
          </span>
          <span>{toast}</span>
        </div>
      )}
    </AppLayout>
  );
}

export default Users;

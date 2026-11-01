import { Link, NavLink } from 'react-router-dom';
import { useSession } from '../session';
import { MENU_ITEMS } from './menuConfig';
import { BrandIcon } from './icons';

function Sidebar({ open, onNavigate, onClose, closeBtnRef }) {
  const { session } = useSession();
  const permissions = session?.permissions || [];
  const visibleItems = MENU_ITEMS.filter((item) => item.permission == null || permissions.includes(item.permission));

  return (
    <nav className={`sidebar${open ? ' open' : ''}`} id="sidebar" aria-label="Main navigation">
      <div className="brand">
        <span className="brand-icon" aria-hidden="true">
          <BrandIcon />
        </span>
        <span>
          Water Demand
          <br />
          Forecasting
        </span>
        <button
          className="close-btn"
          type="button"
          aria-label="Close navigation"
          onClick={onClose}
          ref={closeBtnRef}
        >
          ✕
        </button>
      </div>
      <ul className="nav">
        {visibleItems.map((item) => {
          const Icon = item.icon;
          return (
            <li key={item.path}>
              <NavLink to={item.path} onClick={onNavigate}>
                <Icon />
                {item.label}
              </NavLink>
            </li>
          );
        })}
      </ul>
      <div className="sidebar-foot">
        <div className="ver">
          <Link to="/about">Version 1.0</Link>
        </div>
        <div className="src">Data: İZSU Open Data (İzmir)</div>
      </div>
    </nav>
  );
}

export default Sidebar;

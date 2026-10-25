-- Foundation schema for the planned modules (RBAC, consumption detail,
-- tariffs, water balance, settings, production planning, audit log).
--
-- Run manually (see database/schema/README.md). Wrapped in a single
-- transaction: either all of this applies, or none of it does.

BEGIN;

-- ---------------------------------------------------------------------------
-- a) Safety: refuse to drop production_records / analytics_reports if either
--    unexpectedly contains data. Both were confirmed empty on inspection
--    (25 Oct 2026), but this guards against that having changed since.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    pr_count INT := 0;
    ar_count INT := 0;
BEGIN
    IF to_regclass('public.production_records') IS NOT NULL THEN
        SELECT COUNT(*) INTO pr_count FROM production_records;
    END IF;
    IF to_regclass('public.analytics_reports') IS NOT NULL THEN
        SELECT COUNT(*) INTO ar_count FROM analytics_reports;
    END IF;
    IF pr_count > 0 OR ar_count > 0 THEN
        RAISE EXCEPTION
            'Refusing to drop: production_records has % row(s), analytics_reports has % row(s). Back up and clear them first.',
            pr_count, ar_count;
    END IF;
END $$;

DROP TABLE IF EXISTS production_records;
DROP TABLE IF EXISTS analytics_reports;

-- ---------------------------------------------------------------------------
-- b) RBAC
-- ---------------------------------------------------------------------------
CREATE TABLE roles (
    role_id SERIAL PRIMARY KEY,
    name VARCHAR(50) UNIQUE NOT NULL,
    display_name VARCHAR(100) NOT NULL
);

INSERT INTO roles (name, display_name) VALUES
    ('admin', 'Admin'),
    ('production_manager', 'Production Manager'),
    ('commercial_officer', 'Commercial Officer');

CREATE TABLE permissions (
    permission_id SERIAL PRIMARY KEY,
    code VARCHAR(50) UNIQUE NOT NULL,
    description TEXT
);

INSERT INTO permissions (code) VALUES
    ('forecast:view'),
    ('plan:view'),
    ('plan:create'),
    ('stock:create'),
    ('distribution:view'),
    ('tariff:view'),
    ('tariff:edit'),
    ('revenue:view'),
    ('user:manage'),
    ('settings:edit'),
    ('audit:view_all'),
    ('audit:view_own'),
    ('report:view'),
    ('report:export');

CREATE TABLE role_permissions (
    role_id INTEGER NOT NULL REFERENCES roles(role_id),
    permission_id INTEGER NOT NULL REFERENCES permissions(permission_id),
    PRIMARY KEY (role_id, permission_id)
);

-- Set-based on role name / permission code, rather than hardcoded ids, so
-- this doesn't depend on insertion order.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM roles r
JOIN permissions p ON (
    (r.name = 'admin' AND p.code IN (
        'forecast:view', 'plan:view', 'distribution:view', 'tariff:view',
        'revenue:view', 'user:manage', 'settings:edit', 'audit:view_all',
        'report:view', 'report:export'
    ))
    OR (r.name = 'production_manager' AND p.code IN (
        'forecast:view', 'plan:view', 'plan:create', 'stock:create',
        'distribution:view', 'audit:view_own', 'report:view', 'report:export'
    ))
    OR (r.name = 'commercial_officer' AND p.code IN (
        'forecast:view', 'tariff:view', 'tariff:edit', 'revenue:view',
        'audit:view_own', 'report:view', 'report:export'
    ))
);

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS role_id INT REFERENCES roles(role_id),
    ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'active'
        CHECK (status IN ('invited', 'active', 'deactivated')),
    ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS deactivation_reason TEXT,
    ADD COLUMN IF NOT EXISTS auth_provider VARCHAR(20) NOT NULL DEFAULT 'password';

-- Backfill role_id from the existing (kept) users.role column.
UPDATE users SET role_id = (SELECT role_id FROM roles WHERE name = 'admin')
    WHERE role = 'admin';
UPDATE users SET role_id = (SELECT role_id FROM roles WHERE name = 'production_manager')
    WHERE role = 'manager';

-- ---------------------------------------------------------------------------
-- c) Detailed (district / customer-group / subscriber-type) consumption
-- ---------------------------------------------------------------------------
CREATE TABLE consumption_detail (
    year_month DATE NOT NULL,
    district VARCHAR(50) NOT NULL,
    customer_group VARCHAR(50) NOT NULL,
    subscriber_type VARCHAR(100) NOT NULL,
    subscribers INTEGER,
    consumption_m3 BIGINT,
    PRIMARY KEY (year_month, district, customer_group, subscriber_type)
);

-- ---------------------------------------------------------------------------
-- d) Tariffs
-- ---------------------------------------------------------------------------
CREATE TABLE tariffs (
    tariff_id SERIAL PRIMARY KEY,
    subscriber_type VARCHAR(150) NOT NULL,
    band_min_m3 NUMERIC NOT NULL,
    band_max_m3 NUMERIC NULL, -- NULL = no upper limit on this band
    price_per_m3 NUMERIC(10, 2) NOT NULL,
    currency CHAR(3) NOT NULL DEFAULT 'TRY',
    valid_from DATE NOT NULL,
    source VARCHAR(100)
);
-- No unique constraint: the source tariff file contains a duplicate row;
-- the loader is responsible for reporting it, not this schema.

CREATE TABLE tariff_type_map (
    consumption_type VARCHAR(100) PRIMARY KEY,
    tariff_type VARCHAR(150) NULL,
    is_assumption BOOLEAN NOT NULL DEFAULT false,
    note TEXT
);

-- ---------------------------------------------------------------------------
-- e) Water balance
-- ---------------------------------------------------------------------------
CREATE TABLE water_balance (
    year INTEGER NOT NULL,
    district VARCHAR(50) NOT NULL,
    system_input_m3 BIGINT,
    revenue_water_m3 BIGINT,
    non_revenue_water_m3 BIGINT,
    water_losses_m3 BIGINT,
    physical_losses_m3 BIGINT,
    admin_losses_m3 BIGINT,
    PRIMARY KEY (year, district)
);

-- ---------------------------------------------------------------------------
-- f) Settings
-- ---------------------------------------------------------------------------
CREATE TABLE settings (
    key VARCHAR(50) PRIMARY KEY,
    value TEXT NOT NULL,
    unit VARCHAR(20),
    source TEXT,
    updated_by INTEGER REFERENCES users(user_id),
    updated_at TIMESTAMPTZ DEFAULT now()
);

INSERT INTO settings (key, value, unit, source) VALUES
    ('loss_rate', '0.324', 'fraction',
     'IZSU 2019 water balance, all 20 districts: non-revenue water 94,579,006 m3 / system input 291,984,950 m3'),
    ('currency', 'TRY', NULL, 'IZSU tariff file');

-- ---------------------------------------------------------------------------
-- g) Production planning
-- ---------------------------------------------------------------------------
CREATE TABLE production_plans (
    plan_id SERIAL PRIMARY KEY,
    plan_month DATE NOT NULL,
    forecast_id INTEGER REFERENCES forecasts(forecast_id),
    forecast_m3 BIGINT NOT NULL,
    forecast_upper_m3 BIGINT NOT NULL,
    loss_rate NUMERIC(5, 4) NOT NULL,
    planned_m3 BIGINT NOT NULL,
    safe_plan_m3 BIGINT NOT NULL,
    notes TEXT,
    created_by INTEGER NOT NULL REFERENCES users(user_id),
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE stock_entries (
    entry_id SERIAL PRIMARY KEY,
    recorded_on DATE NOT NULL,
    stock_m3 BIGINT NOT NULL CHECK (stock_m3 >= 0),
    note TEXT,
    created_by INTEGER NOT NULL REFERENCES users(user_id),
    created_at TIMESTAMPTZ DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- h) Audit log — append-only
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
    audit_id BIGSERIAL PRIMARY KEY,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    user_id INTEGER REFERENCES users(user_id),
    action VARCHAR(50) NOT NULL,
    entity VARCHAR(50),
    entity_id VARCHAR(50),
    details JSONB,
    ip_address VARCHAR(45)
);

CREATE INDEX idx_audit_log_occurred_at ON audit_log(occurred_at);
CREATE INDEX idx_audit_log_user_id ON audit_log(user_id);

-- Unconditionally raises before reaching any RETURN, so the same function
-- body works for both a row-level trigger (UPDATE/DELETE) and a
-- statement-level trigger (TRUNCATE) — no adjustment needed.
CREATE OR REPLACE FUNCTION audit_log_prevent_modification()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'audit_log is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_log_append_only
    BEFORE UPDATE OR DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION audit_log_prevent_modification();

CREATE TRIGGER trg_audit_log_append_only_truncate
    BEFORE TRUNCATE ON audit_log
    FOR EACH STATEMENT EXECUTE FUNCTION audit_log_prevent_modification();

COMMIT;

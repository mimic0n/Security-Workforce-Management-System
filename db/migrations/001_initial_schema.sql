CREATE EXTENSION IF NOT EXISTS btree_gist;

DO $$ BEGIN
  CREATE TYPE post_tier AS ENUM ('TIER1', 'TIER2');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE post_status AS ENUM (
    'NOT_ACTIVE',
    'OCCUPIED',
    'HANDOVER_PENDING',
    'RELIEVED_FOR_MEAL',
    'VACANT_ALERT',
    'VACANT_PLANNED',
    'COVERED_BY_PAIR',
    'UNCERTAIN'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE guard_role AS ENUM ('GUARD', 'FLOAT', 'SUPERVISOR');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE shift_code AS ENUM ('MORNING', 'AFTERNOON', 'NIGHT');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- 1. Guards
CREATE TABLE IF NOT EXISTS guards (
  id bigserial PRIMARY KEY,
  code text UNIQUE NOT NULL,
  full_name text NOT NULL,
  role guard_role NOT NULL,
  float_kind text CHECK (float_kind IN ('TIER1_RELIEF', 'GENERAL')),
  phone text,
  active boolean NOT NULL DEFAULT true,
  hired_on date,
  ot_minutes_month int NOT NULL DEFAULT 0,
  ot_minutes_year int NOT NULL DEFAULT 0
);

-- 2. Certifications
CREATE TABLE IF NOT EXISTS certifications (
  id bigserial PRIMARY KEY,
  guard_id bigint NOT NULL REFERENCES guards(id) ON DELETE CASCADE,
  cert_no text NOT NULL,
  issued_on date NOT NULL,
  expires_on date NOT NULL
);

-- 3. Devices
CREATE TABLE IF NOT EXISTS devices (
  id bigserial PRIMARY KEY,
  guard_id bigint NOT NULL REFERENCES guards(id) ON DELETE CASCADE,
  device_uid text UNIQUE NOT NULL,
  registered_at timestamptz NOT NULL DEFAULT now(),
  active boolean NOT NULL DEFAULT true
);

-- 4. Posts
CREATE TABLE IF NOT EXISTS posts (
  id text PRIMARY KEY,
  site_id text NOT NULL DEFAULT 'AEON_THANH_KHE_F1',
  name text NOT NULL,
  zone text NOT NULL,
  x real NOT NULL,
  y real NOT NULL,
  lat double precision,
  lon double precision,
  geofence_m int NOT NULL DEFAULT 25,
  qr_code_id text UNIQUE NOT NULL
);

-- 5. Post Rules
CREATE TABLE IF NOT EXISTS post_rules (
  post_id text PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
  tier post_tier NOT NULL,
  max_vacant_sec int NOT NULL DEFAULT 0,
  pair_with text[] NOT NULL DEFAULT '{}',
  active_shifts shift_code[] NOT NULL,
  needs_meal_cover boolean NOT NULL DEFAULT true,
  CHECK (tier <> 'TIER1' OR max_vacant_sec = 0)
);

-- 6. Shift Templates
CREATE TABLE IF NOT EXISTS shift_templates (
  code shift_code PRIMARY KEY,
  start_time time NOT NULL,
  end_time time NOT NULL,
  crosses_midnight boolean NOT NULL,
  break_minutes int NOT NULL
);

-- 7. Policies (time-versioned)
CREATE TABLE IF NOT EXISTS policies (
  key text NOT NULL,
  value jsonb NOT NULL,
  valid_from timestamptz NOT NULL,
  valid_to timestamptz,
  created_by bigint,
  PRIMARY KEY (key, valid_from)
);

-- 8. Schedules
CREATE TABLE IF NOT EXISTS schedules (
  id bigserial PRIMARY KEY,
  period daterange NOT NULL,
  version int NOT NULL DEFAULT 1,
  status text NOT NULL CHECK (status IN ('DRAFT', 'PUBLISHED', 'ARCHIVED')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 9. Assignments
CREATE TABLE IF NOT EXISTS assignments (
  id bigserial PRIMARY KEY,
  schedule_id bigint REFERENCES schedules(id),
  guard_id bigint NOT NULL REFERENCES guards(id),
  post_id text REFERENCES posts(id),
  role text NOT NULL CHECK (role IN ('FIXED', 'FLOAT_T1', 'FLOAT_GEN', 'SUPERVISOR')),
  shift shift_code NOT NULL,
  period tstzrange NOT NULL,
  source text NOT NULL DEFAULT 'ROSTER' CHECK (source IN ('ROSTER', 'DISPATCH', 'MANUAL')),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'CANCELLED')),
  EXCLUDE USING gist (guard_id WITH =, period WITH &&) WHERE (status = 'ACTIVE')
);

-- 10. Absences
CREATE TABLE IF NOT EXISTS absences (
  id bigserial PRIMARY KEY,
  guard_id bigint NOT NULL REFERENCES guards(id),
  reported_at timestamptz NOT NULL,
  for_shift shift_code NOT NULL,
  for_date date NOT NULL,
  reason text,
  status text NOT NULL DEFAULT 'REPORTED' CHECK (status IN ('REPORTED', 'HANDLED', 'REJECTED')),
  idem_key text UNIQUE
);

-- 11. Attendance Logs
CREATE TABLE IF NOT EXISTS attendance_logs (
  id bigserial PRIMARY KEY,
  guard_id bigint NOT NULL REFERENCES guards(id),
  post_id text REFERENCES posts(id),
  kind text NOT NULL CHECK (kind IN ('CHECK_IN', 'CHECK_OUT', 'PRESENCE_PING', 'QR_CONFIRM')),
  method text NOT NULL CHECK (method IN ('GPS', 'QR', 'SUPERVISOR', 'SIM')),
  lat double precision,
  lon double precision,
  accuracy_m real,
  device_uid text,
  sim_ts timestamptz NOT NULL,
  real_ts timestamptz NOT NULL DEFAULT clock_timestamp(),
  accepted boolean NOT NULL,
  reject_reason text
);

-- 11b. Attendance Nonces (single-use, bound to guard+device+post)
CREATE TABLE IF NOT EXISTS attendance_nonces (
  id bigserial PRIMARY KEY,
  nonce text UNIQUE NOT NULL,
  guard_id bigint NOT NULL REFERENCES guards(id) ON DELETE CASCADE,
  device_uid text NOT NULL,
  post_id text NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_attendance_nonces_lookup ON attendance_nonces (nonce, guard_id, post_id);

-- 12. Site State
CREATE TABLE IF NOT EXISTS site_state (
  site_id text PRIMARY KEY,
  mode text NOT NULL DEFAULT 'NORMAL' CHECK (mode IN ('NORMAL', 'EMERGENCY')),
  version int NOT NULL DEFAULT 0,
  since timestamptz
);

-- 13. Post State
CREATE TABLE IF NOT EXISTS post_state (
  post_id text PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
  status post_status NOT NULL,
  guard_id bigint REFERENCES guards(id),
  since timestamptz NOT NULL,
  deadline_at timestamptz,
  version int NOT NULL DEFAULT 0
);

-- 14. State Events (append-only)
CREATE TABLE IF NOT EXISTS state_events (
  id bigserial PRIMARY KEY,
  site_id text NOT NULL,
  post_id text,
  from_status post_status,
  to_status post_status,
  cause text NOT NULL,
  actor_id bigint,
  payload jsonb NOT NULL DEFAULT '{}',
  sim_ts timestamptz NOT NULL,
  real_ts timestamptz NOT NULL DEFAULT clock_timestamp(),
  idem_key text UNIQUE
);

-- 15. Incidents
CREATE TABLE IF NOT EXISTS incidents (
  id bigserial PRIMARY KEY,
  kind text NOT NULL,
  post_id text,
  guard_id bigint,
  severity text NOT NULL,
  opened_at timestamptz NOT NULL,
  closed_at timestamptz,
  vacant_seconds int,
  details jsonb NOT NULL DEFAULT '{}'
);

-- 16. Dispatch Orders
CREATE TABLE IF NOT EXISTS dispatch_orders (
  id bigserial PRIMARY KEY,
  shift_key text NOT NULL,
  kind text NOT NULL,
  to_guard_id bigint REFERENCES guards(id),
  from_post text,
  to_post text,
  status text NOT NULL DEFAULT 'SENT' CHECK (status IN ('PROPOSED', 'SENT', 'ACKED', 'DECLINED', 'EXPIRED', 'CANCELLED')),
  explain jsonb NOT NULL,
  sent_at timestamptz,
  ack_at timestamptz,
  idem_key text UNIQUE
);

-- 17. Break Plans
CREATE TABLE IF NOT EXISTS break_plans (
  id bigserial PRIMARY KEY,
  shift_key text NOT NULL,
  post_id text NOT NULL,
  original_guard_id bigint REFERENCES guards(id),
  float_guard_id bigint REFERENCES guards(id),
  slot tstzrange NOT NULL,
  status text NOT NULL DEFAULT 'PLANNED'
);

-- 18. Staffing Requests
CREATE TABLE IF NOT EXISTS staffing_requests (
  id bigserial PRIMARY KEY,
  created_at timestamptz NOT NULL,
  shift shift_code,
  qty int NOT NULL,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'OPEN'
);

-- 19. Outbox
CREATE TABLE IF NOT EXISTS outbox (
  id bigserial PRIMARY KEY,
  topic text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz DEFAULT clock_timestamp(),
  sent_at timestamptz
);

CREATE SEQUENCE IF NOT EXISTS site_event_seq START WITH 1;

-- 20. Audit Log
CREATE TABLE IF NOT EXISTS audit_log (
  id bigserial PRIMARY KEY,
  actor_id bigint,
  action text NOT NULL,
  entity text,
  before jsonb,
  after jsonb,
  at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- 21. Post Travel
CREATE TABLE IF NOT EXISTS post_travel (
  from_post text NOT NULL,
  to_post text NOT NULL,
  minutes int NOT NULL,
  PRIMARY KEY (from_post, to_post)
);

-- 22. Sim Runs
CREATE TABLE IF NOT EXISTS sim_runs (
  id bigserial PRIMARY KEY,
  scenario_id text NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  passed boolean,
  details jsonb NOT NULL DEFAULT '{}'
);

-- 23. Users (for authentication & RBAC)
CREATE TABLE IF NOT EXISTS users (
  id bigserial PRIMARY KEY,
  username text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('ADMIN', 'HR', 'MANAGER', 'DISPATCHER', 'SUPERVISOR', 'FLOAT', 'GUARD')),
  guard_id bigint REFERENCES guards(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 24. Dispatch Tasks (for serial queue per site:shiftKey)
CREATE TABLE IF NOT EXISTS dispatch_tasks (
  id bigserial PRIMARY KEY,
  site_id text NOT NULL,
  shift_key text NOT NULL,
  priority int NOT NULL DEFAULT 4,
  kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED')),
  created_at timestamptz NOT NULL,
  processed_at timestamptz,
  error text,
  idem_key text UNIQUE
);

CREATE INDEX IF NOT EXISTS idx_dispatch_tasks_pending ON dispatch_tasks (site_id, shift_key, status, priority ASC, id ASC);


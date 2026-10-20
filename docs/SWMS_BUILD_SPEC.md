# SWMS Build Specification (for the coding agent)

Read `AGENTS.md` first (rules, stack, workflow). This file is the detailed spec. Sections are numbered so milestones (§14) can reference them. Values tagged **ASSUMPTION** are defaults: implement as configuration and log in `docs/OPEN_QUESTIONS.md`.

## Contents
1. Domain model · 2. Seed data · 3. Database schema · 4. Config/policies · 5. Staffing calculator · 6. State machine · 7. Meal-relief planner · 8. Dispatch engine · 9. LegalGuard · 10. Attendance & debounce · 11. Realtime (WebSocket) · 12. REST API · 13. Simulation harness & scenarios · 14. Milestones · 15. UI requirements · 16. Testing requirements · 17. Definition of done

---

## 1. Domain model

| Term | Meaning |
|---|---|
| Site | One mall floor. Single site `AEON_THANH_KHE_F1` (keep `site_id` column everywhere for clarity). |
| Post | Fixed guard position. 14 of them. |
| Tier | `TIER1` = must never be empty (`max_vacant_sec = 0`). `TIER2` = may be empty up to `max_vacant_sec`. |
| Shift | `MORNING` 06:00–14:00, `AFTERNOON` 14:00–22:00, `NIGHT` 22:00–06:00 (Asia/Ho_Chi_Minh). NIGHT belongs to the date it starts. |
| Guard roles | `GUARD`, `FLOAT` (covers meal breaks of Tier 1 and general incidents), `SUPERVISOR`. A FLOAT has `float_kind`: `TIER1_RELIEF` or `GENERAL`. |
| Vacancy | A post with no valid present guard. |
| Zero-Vacancy | Tier 1 posts must never be vacant; system always prefers sacrificing Tier 2. |
| Site mode | `NORMAL` or `EMERGENCY` (fire). |

Headcount per shift (defaults, stored in `policies`): `fixed` 14/14/6, `float_t1` 2/2/0, `float_gen` 1/1/1, `sup` 1/1/1 → 18/18/8 = 44 slot-persons/day.
`required_total = ceil(44 × K_relief)`; K default 1.35 → 60 (59.4 rounded up). Present headcount 45 → gap 15.

## 2. Seed data (`db/seed`)

### 2.1 Posts (id, name, zone, tier, max_vacant_sec, pair_with)
```
G1 Cổng Võ Văn Tân        north gate        TIER1  0    []
G2 Cổng Hải Phòng         east gate         TIER2  900  []
G3 Cổng Điện Biên Phủ     main facade       TIER2  900  []
G4 Cổng Bách hóa góc dưới south dept gate   TIER1  0    []
G5 Cổng Bách hóa góc trên north dept gate   TIER1  0    []
G6 Cổng Hầm giữ xe        basement ramp     TIER2  900  []
P1 Sảnh Mặt Trời          AEON Delica       TIER1  0    []
P2 Khu vực Langfarm       specialty         TIER2  900  [P3]
P3 Sảnh Mặt Trăng         event hall        TIER2  900  [P2]     # can merge observation with P2
P4 AEON Bakery            bakery exit       TIER2  900  [P5]     # cross-monitored from P5
P5 Cụm Cafe               Starbucks/Phê La  TIER2  900  [P4]
P6 Thang cuốn Bách hóa    dept escalator    TIER1  0    []
P7 Cụm Thang máy          dept elevators    TIER1  0    []
P8 Quầy Thu ngân/Thông tin cashier/info     TIER1  0    []
```
Coordinates: placeholder grid values on an SVG viewBox (e.g. 0–1000 × 0–600); `geofence_m` default 25. **ASSUMPTION**: Tier 2 `max_vacant_sec`=900 for all (only G2 is stated in the source doc).

### 2.2 Night shift posts — **ASSUMPTION** (source says "6 fixed posts at night" without naming them)
`night_posts = [G1, G3, G4, G5, G6, P8]` (stored in `post_rules.active_shifts`). Posts not active in a shift have status `NOT_ACTIVE`.

### 2.3 Fictional people
Create 45 guards: 36 GUARD, 4 FLOAT(TIER1_RELIEF), 3 FLOAT(GENERAL), 2 SUPERVISOR — adjust so shift rosters of 18/18/8 are possible with the available pool; every guard has a valid `certifications` row (expiry in the future) except 2 deliberately expired ones (used by LegalGuard tests). One device per guard in `devices`.

### 2.4 Shift templates
```
MORNING   06:00 14:00 break_minutes 30
AFTERNOON 14:00 22:00 break_minutes 30
NIGHT     22:00 06:00 break_minutes 45     # Labor Code: night break ≥ 45 min
```
Meal-break window for Tier 1 relief (morning): `10:00–12:45` (policy `meal_window.MORNING`). Define windows for AFTERNOON `16:00–18:45` **ASSUMPTION**; NIGHT: no relief float, supervisor/float_gen covers **ASSUMPTION**.

### 2.5 Travel-time matrix (minutes) — **ASSUMPTION**
Default 5 min between posts in same zone group, 10 min across groups, stored in `post_travel`. Groups: gates-north (G1,G5,P8), gates-south (G4,G3,G2,G6), hall (P3,P2,P4,P5), dept (P1,P6,P7). Configurable; used by §7.

## 3. Database schema (PostgreSQL)

Use SQL migrations. Required extensions: `btree_gist`. Create **14 core tables** + 3 auxiliary.

Core: `guards`, `certifications`, `devices`, `posts`, `post_rules`, `shift_templates`, `policies`, `schedules`, `assignments`, `absences`, `attendance_logs`, `post_state`, `state_events`, `incidents`.
Auxiliary: `dispatch_orders`, `break_plans`, `staffing_requests`. Plus infra: `site_state`, `outbox`, `audit_log`, `post_travel`, `sim_runs`. (pg-boss creates its own schema.)

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TYPE post_tier   AS ENUM ('TIER1','TIER2');
CREATE TYPE post_status AS ENUM ('NOT_ACTIVE','OCCUPIED','HANDOVER_PENDING','RELIEVED_FOR_MEAL',
                                 'VACANT_ALERT','VACANT_PLANNED','COVERED_BY_PAIR','UNCERTAIN');
CREATE TYPE guard_role  AS ENUM ('GUARD','FLOAT','SUPERVISOR');
CREATE TYPE shift_code  AS ENUM ('MORNING','AFTERNOON','NIGHT');

CREATE TABLE guards (
  id bigserial PRIMARY KEY, code text UNIQUE NOT NULL, full_name text NOT NULL,
  role guard_role NOT NULL, float_kind text CHECK (float_kind IN ('TIER1_RELIEF','GENERAL')),
  phone text, active boolean NOT NULL DEFAULT true, hired_on date,
  ot_minutes_month int NOT NULL DEFAULT 0, ot_minutes_year int NOT NULL DEFAULT 0   -- maintained by dispatch
);
CREATE TABLE certifications (
  id bigserial PRIMARY KEY, guard_id bigint NOT NULL REFERENCES guards(id),
  cert_no text NOT NULL, issued_on date NOT NULL, expires_on date NOT NULL
);
CREATE TABLE devices (
  id bigserial PRIMARY KEY, guard_id bigint NOT NULL REFERENCES guards(id),
  device_uid text UNIQUE NOT NULL, registered_at timestamptz NOT NULL DEFAULT now(), active boolean NOT NULL DEFAULT true
);
CREATE TABLE posts (
  id text PRIMARY KEY, site_id text NOT NULL, name text NOT NULL, zone text NOT NULL,
  x real NOT NULL, y real NOT NULL, lat double precision, lon double precision,
  geofence_m int NOT NULL DEFAULT 25, qr_code_id text UNIQUE NOT NULL
);
CREATE TABLE post_rules (
  post_id text PRIMARY KEY REFERENCES posts(id), tier post_tier NOT NULL,
  max_vacant_sec int NOT NULL DEFAULT 0,
  pair_with text[] NOT NULL DEFAULT '{}',
  active_shifts shift_code[] NOT NULL,
  needs_meal_cover boolean NOT NULL DEFAULT true,
  CHECK (tier <> 'TIER1' OR max_vacant_sec = 0)
);
CREATE TABLE shift_templates (
  code shift_code PRIMARY KEY, start_time time NOT NULL, end_time time NOT NULL,
  crosses_midnight boolean NOT NULL, break_minutes int NOT NULL
);
CREATE TABLE policies (                      -- time-versioned config
  key text NOT NULL, value jsonb NOT NULL,
  valid_from timestamptz NOT NULL, valid_to timestamptz,
  created_by bigint, PRIMARY KEY (key, valid_from)
);
CREATE TABLE schedules (
  id bigserial PRIMARY KEY, period daterange NOT NULL, version int NOT NULL DEFAULT 1,
  status text NOT NULL CHECK (status IN ('DRAFT','PUBLISHED','ARCHIVED')), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE assignments (
  id bigserial PRIMARY KEY, schedule_id bigint REFERENCES schedules(id),
  guard_id bigint NOT NULL REFERENCES guards(id), post_id text REFERENCES posts(id),
  role text NOT NULL CHECK (role IN ('FIXED','FLOAT_T1','FLOAT_GEN','SUPERVISOR')),
  shift shift_code NOT NULL, period tstzrange NOT NULL,
  source text NOT NULL DEFAULT 'ROSTER' CHECK (source IN ('ROSTER','DISPATCH','MANUAL')),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','CANCELLED')),
  EXCLUDE USING gist (guard_id WITH =, period WITH &&) WHERE (status = 'ACTIVE')
);
CREATE TABLE absences (
  id bigserial PRIMARY KEY, guard_id bigint NOT NULL REFERENCES guards(id),
  reported_at timestamptz NOT NULL, for_shift shift_code NOT NULL, for_date date NOT NULL,
  reason text, status text NOT NULL DEFAULT 'REPORTED' CHECK (status IN ('REPORTED','HANDLED','REJECTED')),
  idem_key text UNIQUE
);
CREATE TABLE attendance_logs (
  id bigserial PRIMARY KEY, guard_id bigint NOT NULL REFERENCES guards(id), post_id text REFERENCES posts(id),
  kind text NOT NULL CHECK (kind IN ('CHECK_IN','CHECK_OUT','PRESENCE_PING','QR_CONFIRM')),
  method text NOT NULL CHECK (method IN ('GPS','QR','SUPERVISOR','SIM')),
  lat double precision, lon double precision, accuracy_m real, device_uid text,
  sim_ts timestamptz NOT NULL, real_ts timestamptz NOT NULL DEFAULT clock_timestamp(),
  accepted boolean NOT NULL, reject_reason text
);
CREATE TABLE site_state (site_id text PRIMARY KEY, mode text NOT NULL DEFAULT 'NORMAL' CHECK (mode IN ('NORMAL','EMERGENCY')),
                         version int NOT NULL DEFAULT 0, since timestamptz);
CREATE TABLE post_state (
  post_id text PRIMARY KEY REFERENCES posts(id), status post_status NOT NULL,
  guard_id bigint REFERENCES guards(id), since timestamptz NOT NULL,
  deadline_at timestamptz, version int NOT NULL DEFAULT 0
);
CREATE TABLE state_events (               -- append-only: REVOKE UPDATE, DELETE
  id bigserial PRIMARY KEY, site_id text NOT NULL, post_id text,
  from_status post_status, to_status post_status, cause text NOT NULL,
  actor_id bigint, payload jsonb NOT NULL DEFAULT '{}',
  sim_ts timestamptz NOT NULL, real_ts timestamptz NOT NULL DEFAULT clock_timestamp(),
  idem_key text UNIQUE
);
CREATE TABLE incidents (
  id bigserial PRIMARY KEY, kind text NOT NULL,      -- VACANCY, VIOLATION, MOTION, FIRE, ...
  post_id text, guard_id bigint, severity text NOT NULL, opened_at timestamptz NOT NULL, closed_at timestamptz,
  vacant_seconds int, details jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE dispatch_orders (
  id bigserial PRIMARY KEY, shift_key text NOT NULL, kind text NOT NULL,   -- COVER_POST, MERGE_POST, EARLY_CALL_IN, REVIEW_MOTION, MEAL_RELIEF
  to_guard_id bigint REFERENCES guards(id), from_post text, to_post text,
  status text NOT NULL DEFAULT 'SENT' CHECK (status IN ('PROPOSED','SENT','ACKED','DECLINED','EXPIRED','CANCELLED')),
  explain jsonb NOT NULL,                  -- why this candidate: ranked list + reasons + rejected-by-legal
  sent_at timestamptz, ack_at timestamptz, idem_key text UNIQUE
);
CREATE TABLE break_plans (
  id bigserial PRIMARY KEY, shift_key text NOT NULL, post_id text NOT NULL, original_guard_id bigint,
  float_guard_id bigint, slot tstzrange NOT NULL, status text NOT NULL DEFAULT 'PLANNED'
);
CREATE TABLE staffing_requests (
  id bigserial PRIMARY KEY, created_at timestamptz NOT NULL, shift shift_code, qty int NOT NULL,
  reason text NOT NULL, status text NOT NULL DEFAULT 'OPEN'
);
CREATE TABLE outbox (id bigserial PRIMARY KEY, topic text NOT NULL, payload jsonb NOT NULL, created_at timestamptz DEFAULT clock_timestamp(), sent_at timestamptz);
CREATE TABLE audit_log (id bigserial PRIMARY KEY, actor_id bigint, action text NOT NULL, entity text, before jsonb, after jsonb, at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE post_travel (from_post text, to_post text, minutes int NOT NULL, PRIMARY KEY (from_post,to_post));
```
Hardening: `REVOKE UPDATE, DELETE ON state_events, audit_log FROM app_role;`

## 4. Config / policies (keys in `policies`, read via `ConfigService`)

| Key | Default value (JSON) | Notes |
|---|---|---|
| `headcount.fixed` | `{"MORNING":14,"AFTERNOON":14,"NIGHT":6}` | |
| `headcount.float_t1` | `{"MORNING":2,"AFTERNOON":2,"NIGHT":0}` | |
| `headcount.float_gen` | `{"MORNING":1,"AFTERNOON":1,"NIGHT":1}` | |
| `headcount.sup` | `{"MORNING":1,"AFTERNOON":1,"NIGHT":1}` | |
| `relief.k_weekly_rest` | `1.1667` (=7/6) | |
| `relief.leave_sick_ratio` | `0.15` | |
| `relief.k_override` | `1.35` or null | if set, wins over computed K |
| `relief.k_sensitivity_range` | `[1.25,1.40]` | for sensitivity report |
| `meal.window` | `{"MORNING":["10:00","12:45"],"AFTERNOON":["16:00","18:45"]}` | ASSUMPTION for afternoon |
| `meal.handover_buffer_min` | `5` | |
| `meal.break_not_at_edges_min` | `60` | break not within first/last 60 min of shift (Decree 145/2020) |
| `attendance.gps_accuracy_max_m` | `30` | drop worse samples |
| `attendance.out_samples_required` | `3` | consecutive outside samples |
| `attendance.uncertain_after_sec` | `45` | → status UNCERTAIN |
| `attendance.tier1_escalate_after_sec` | `120` | → VACANT_ALERT for Tier 1 |
| `attendance.violation_after_sec` | `600` | → incident VIOLATION (the "10 min grace") |
| `attendance.nonce_ttl_sec` | `45` | QR challenge |
| `legal.min_rest_hours` | `12` | Labor Code 2019 Art.110 |
| `legal.max_work_days_week` | `6` | |
| `legal.ot_cap_month_min` | `2400` | **VERIFY** (40 h) |
| `legal.ot_cap_year_min` | `12000` | **VERIFY** (200 h) |
| `legal.night_start/end` | `"22:00"/"06:00"` | |
| `dispatch.ack_timeout_sec` | `60` | then escalate |
| `dispatch.rank_weights` | `{"distance":1,"ot":2,"load":1.5}` | |
| `event.overrides` | list of `{from,to,shift,delta}` | scenario C3: +1 fixed for 3 days |

`ConfigService.get(key, atTime)` must resolve by `valid_from <= atTime < valid_to` using the **Clock** time, so a virtual-clock jump automatically expires event overrides (C3 needs no "restore" job). `PUT /policies/:key` validates (zod), writes a new version row + `audit_log`, emits `policy.changed`; `POST /policies/preview` returns dry-run results (new N_total, gap) without persisting.

## 5. Staffing calculator (`modules/staffing`)

```ts
type Shift = 'MORNING'|'AFTERNOON'|'NIGHT';
interface StaffingResult { perShift: Record<Shift,{fixed:number;floatT1:number;floatGen:number;sup:number;total:number}>;
  slotsPerDay:number; k:number; required:number; present:number; gap:number; gapPct:number;
  sensitivity: {k:number; required:number; gap:number}[]; }
```
- `slotsPerDay = Σ perShift.total`.
- `k = relief.k_override ?? relief.k_weekly_rest × (1 + relief.leave_sick_ratio)`.
- `required = ceil(slotsPerDay × k)`; `gap = max(0, required − present)`; `present` = active guards count.
- Sensitivity: K from range lower to upper step 0.05.
- **Golden test:** defaults → perShift totals 18/18/8, slots 44, k 1.35, required 60, present 45, gap 15, gapPct 25.
- A derived-K helper `computeKFromAnnualDays({workDaysMax:313, leave:12, sick:6, training:2})` = 365/293 ≈ 1.2457 (for the sensitivity report; document as illustrative).

## 6. State machine (`modules/dispatch/state-machine`)

Per-post statuses: `NOT_ACTIVE, OCCUPIED, HANDOVER_PENDING, RELIEVED_FOR_MEAL, VACANT_ALERT, VACANT_PLANNED, COVERED_BY_PAIR, UNCERTAIN`.
Site mode (`site_state.mode`) is separate; while `EMERGENCY`, per-post rules, meal timers and presence alerts are suspended.

### 6.1 Transition table (implement as data; unknown (from,event) → reject with `InvalidTransition`)

| From | Event | Guard (must hold) | To | Effects |
|---|---|---|---|---|
| NOT_ACTIVE | SHIFT_START | post active this shift | VACANT_ALERT | open expectation; await check-in (grace = shift start tolerance policy) |
| VACANT_ALERT | CHECKIN_ACCEPTED | guard assigned/valid (LegalGuard) | OCCUPIED | close VACANCY incident if any; set guard_id |
| OCCUPIED | MEAL_WINDOW_OPEN | break_plan exists for post | HANDOVER_PENDING | lock original guard's "break" button; send MEAL_RELIEF order to float; set `deadline_at` = slot start + handover buffer |
| HANDOVER_PENDING | FLOAT_CHECKIN | float === planned float, at post | RELIEVED_FOR_MEAL | unlock break for original; set deadline = slot end |
| HANDOVER_PENDING | HANDOVER_TIMEOUT | now ≥ deadline_at | VACANT_ALERT | call `fillVacancy(post)` |
| RELIEVED_FOR_MEAL | ORIGINAL_BACK | original guard check-in | OCCUPIED | float released to pool, `break_plans.status=DONE` |
| RELIEVED_FOR_MEAL | MEAL_OVERRUN | now ≥ deadline_at + tolerance | RELIEVED_FOR_MEAL (no status change) | warning only: notify original guard, open LOW incident; float stays on post |
| OCCUPIED | PRESENCE_UNCERTAIN | GPS lost/outside < thresholds | UNCERTAIN | send QR challenge push; set `deadline_at` (tier1_escalate) |
| UNCERTAIN | QR_CONFIRMED | nonce valid | OCCUPIED | clear |
| UNCERTAIN | ESCALATE_TIMEOUT | Tier 1 and now ≥ deadline | VACANT_ALERT | `fillVacancy(post)` (pre-warmed candidate); schedule VIOLATION timer |
| UNCERTAIN | ESCALATE_TIMEOUT | Tier 2 and vacant ≥ max_vacant_sec | VACANT_ALERT | fillVacancy or merge |
| OCCUPIED | ABSENCE_REPORTED | — | VACANT_ALERT | `fillVacancy(post)` |
| VACANT_ALERT | REPLACEMENT_ASSIGNED | LegalGuard OK | VACANT_ALERT (stays) | create order; await check-in (ack timeout) |
| VACANT_ALERT | CHECKIN_ACCEPTED (replacement) | — | OCCUPIED | close incident, record `vacant_seconds` |
| VACANT_ALERT | ACCEPT_PLANNED_GAP | Tier 2 only | VACANT_PLANNED | log risk |
| VACANT_ALERT | MERGE_WITH_PAIR | Tier 2, pair post OCCUPIED | COVERED_BY_PAIR | order MERGE_POST to pair guard |
| VACANT_PLANNED / COVERED_BY_PAIR | REPLACEMENT_ASSIGNED+CHECKIN | — | OCCUPIED | |
| any (except NOT_ACTIVE) | SHIFT_END | — | NOT_ACTIVE or next shift's expectation | |

Note: `MEAL_OVERRUN` is a self-transition (warning only); still record it in `state_events`.

### 6.2 Implementation rules
- `apply(tx, event)` loads `post_state ... FOR UPDATE` (single post row), validates via table, performs `UPDATE post_state SET ..., version = version + 1 WHERE post_id=$1 AND version=$2` (0 rows ⇒ concurrent change ⇒ throw retryable), inserts `state_events` (with `idem_key`), inserts `outbox` rows. Idempotent: same `idem_key` → return previous result.
- Tier 1 invariant (checked after every commit in tests): **a TIER1 post is never in VACANT_ALERT/VACANT_PLANNED/COVERED_BY_PAIR for longer than the time needed by the dispatch engine to act**, and `VACANT_PLANNED/COVERED_BY_PAIR` are **never** reachable for Tier 1 (reject).
- **Two-way handshake lock:** the guard's "start break" action is rejected by API unless post status is `RELIEVED_FOR_MEAL` or (status `HANDOVER_PENDING` and float check-in accepted). If the original leaves anyway (presence lost) → `PRESENCE_UNCERTAIN` → normal vacancy path.
- Emergency: event `FIRE_ALARM` sets `site_state.mode='EMERGENCY'`, cancels pending pg-boss meal/presence jobs for the site, writes one `state_events` row with `post_id NULL`; event `EMERGENCY_CLEARED` restores per-post logic by re-evaluating each post from `post_state` + current attendance.

## 7. Meal-relief planner (`modules/dispatch/meal-planner`)

Pure function (no DB, no clock) so it is trivially testable:
```ts
planMealRelief(input: {
  posts: {id:string; tier:'TIER1'|'TIER2'}[];          // posts that need relief (Tier 1 for MORNING/AFTERNOON)
  floats: {id:string; available:{from:Date;to:Date}}[];
  window: {start:Date; end:Date}; breakMinutes:number; handoverBufferMin:number;
  travel: (a:string,b:string)=>number;                  // minutes
  baseLocation: string; order?: string[];               // optional explicit priority order
}): { feasible:boolean; plan:{postId:string; floatId:string; start:Date; end:Date}[]; violations:{postId:string; reason:string}[]; suggestions:string[] }
```
Algorithm (deterministic): iterate posts in `order` (default: Tier 1 sorted by id; the golden order is `G1,P1,G4,P6,G5,P7,P8`); for each choose the float with the earliest `ready = max(cursor[f] + travel(loc[f],post) + handoverBuffer, window.start + stagger)` where stagger = 20 min × index for the first 2 posts only (so both floats start immediately), then `end = ready + breakMinutes`; if `end > window.end` → violation `WINDOW_EXCEEDED`; assign, update cursor/loc. No float is ever in two places (includes travel). Break must not start within `meal.break_not_at_edges_min` of shift start/end (validated by caller).
- **Golden tests**
  1. `validatePlan(sourceDocPlan)` must report feasible, where the doc plan is: G1/A 10:00–10:30, P1/B 10:20–10:50, G4/A 10:45–11:15, P6/B 11:05–11:35, G5/A 11:30–12:00, P7/B 11:50–12:20, P8/A 12:15–12:45.
  2. `planMealRelief` with 2 floats and the default travel matrix returns `feasible: true`, all 7 posts covered, within 10:00–12:45, no overlaps; float usage alternates (each float 3–4 posts).
  3. With 1 float → `feasible:false` (7×30 = 210 min > 165 min window) and `suggestions` includes at least: `EXTEND_WINDOW`, `USE_TIER2_RELIEF`, `CALL_IN_EXTRA_GUARD`.
- `meal-planner` output is persisted in `break_plans`; a pg-boss job per slot fires `MEAL_WINDOW_OPEN` at slot start − handover buffer (time from Clock).
- Re-plan on any change in available floats (e.g., float on sick leave) → new plan version; if infeasible, create `dispatch_orders` proposals (kind `EARLY_CALL_IN` etc.) and `staffing_requests` when the shortfall is structural.

## 8. Dispatch engine (`modules/dispatch`)

### 8.1 Queue and transaction shape
All inputs (absence, presence loss, motion, fire, policy change) become `DispatchTask {siteId, shiftKey, priority, createdAt, kind, payload, idemKey}` enqueued in a per-(site,shiftKey) queue (pg-boss with `singletonKey` per shift, or one in-process worker consuming Postgres-ordered tasks — either way **one task at a time per shift**). Priority: `EMERGENCY=0`, `TIER1_VACANCY=1`, `MEAL=2`, `TIER2_VACANCY=3`, `OTHER=4`; ties by oldest first. Each task = one DB transaction starting with `pg_advisory_xact_lock(hashtextextended('<site>:<shiftKey>',0))`.

For a batch arriving at the same moment (scenario A1: three absences at 07:30), the worker **drains and sorts** pending tasks first, so Tier 1 is solved before Tier 2 regardless of arrival order.

### 8.2 `fillVacancy(post)` cascade (cheapest → most expensive)
Candidates are evaluated in this order; the first feasible wins; each rejected candidate is recorded in `dispatch_orders.explain.rejected[]` with reason.
1. **FLOAT_T1** currently free (not committed to a `break_plans` slot starting within travel+buffer; and if committed later, re-plan must remain feasible — otherwise skip).
2. **FLOAT_GEN** free.
3. **Tier-2 pull** (only when vacancy is Tier 1): nearest Tier 2 post guard whose post allows vacancy (`max_vacant_sec>0`) or is mergeable via `pair_with`; the pulled-from post becomes `COVERED_BY_PAIR`/`VACANT_PLANNED`.
4. **Supervisor** (last resort, flagged).
5. **Off-shift call-in** (`EARLY_CALL_IN`/`STAY_OVER`): candidates from adjacent shift pool or day-off pool; must pass LegalGuard (§9); creates a **proposal** (status `SENT`, requires ack from guard) with estimated OT cost; if declined/expired (`dispatch.ack_timeout_sec`) → next candidate.
6. **Escalate** to dispatcher (`incident` severity HIGH) and create `staffing_requests` if shortage is structural.
Tier 2 vacancy: first try `pair_with` merge (`COVERED_BY_PAIR`), else accept `VACANT_PLANNED` while under `max_vacant_sec`; when over → treat like Tier 1 cascade steps 1–2.

Candidate ranking inside a step: `score = w.distance×travel_min + w.ot×ot_minutes_month/60 + w.load×dispatches_today`, lower is better, ties by `guard.id`.

Output of each task: list of actions `{action, guardId, fromPost?, toPost?, reason}` stored in `dispatch_orders.explain` — the dashboard shows it ("why this person").

### 8.3 Concurrency acceptance (must be automated: `npm run test:race`)
- Fire the 3 A1 absences simultaneously (`Promise.all`, 1,000 rounds, randomized order, fresh DB state per round): invariants — no guard has overlapping ACTIVE assignments (also enforced by EXCLUDE), Tier 1 handled before Tier 2, number of `state_events` equals expectation, no unhandled retry loops.
- Run with 2 API processes against the same DB and repeat.
- Injected failure test: kill the worker between steps → after restart, the task is retried and ends in the same final state (idempotency by `idem_key`).

### 8.4 Event handlers
- `ABSENCE_REPORTED` → mark assignment CANCELLED (guard absent) → `fillVacancy(post)` if guard was FIXED; if guard was a FLOAT → re-plan meal matrix (§7) then possibly propose call-in.
- `CAMERA_MOTION(post)` (scenario D1) → choose nearest on-duty guard *not on a Tier 1 post that would become vacant* (night: G1 guard for G5 only if G1 can be covered or policy allows) → `dispatch_orders` kind `REVIEW_MOTION` to that guard only (room `guard:{id}`) + dashboard alert + incident MOTION.
- `FIRE_ALARM` → emergency mode (§6.2).
- `POLICY_CHANGED` → recompute staffing + re-plan meal matrix for the current/next shift.

## 9. LegalGuard (`modules/dispatch/legal-guard`)

Pure + DB-backed checks; returns `{ok:boolean; violations:string[]}`:
1. **Min rest:** `start(candidate shift/segment) − end(previous ACTIVE assignment) ≥ legal.min_rest_hours`; and same for the next assignment. (With the given shifts: AFTERNOON→next MORNING = 8 h ✗; NIGHT→next AFTERNOON = 8 h ✗; NIGHT→next MORNING overlaps ✗.)
2. **Weekly days:** ≤ `legal.max_work_days_week` distinct working dates in the ISO week.
3. **OT caps:** projected `ot_minutes_month/year` ≤ caps. Any minutes beyond the guard's regular 8 h shift are OT.
4. **Certificate:** valid `certifications.expires_on ≥ date`.
5. **Double booking:** no overlapping ACTIVE assignment (DB enforces; LegalGuard pre-checks to give friendly reasons).
6. Cost estimate helper (for ranking/report only): night work ×1.3, OT ×1.5 (day) / ×2.0 night-OT **ASSUMPTION — mark VERIFY**.

Unit-test each rule with boundary cases (11h59 vs 12h00).

## 10. Attendance & presence (`modules/attendance`)

### 10.1 Check-in/out API
1. `POST /attendance/nonce {postId}` → `{nonce, expiresAt}` (TTL `attendance.nonce_ttl_sec`, bound to guard+device+post, single-use, stored in DB).
2. `POST /attendance/check {kind, postId, nonce, qrToken, deviceUid, gps?}`:
   - Verify `deviceUid` is the guard's active device; nonce valid & unused; `qrToken` = `HMAC(secret, qr_code_id)` matches the post; shift/time window plausible; **impossible-speed check** (two posts farther apart than travel time allows → reject `IMPOSSIBLE_TRAVEL`); optional GPS inside geofence if `accuracy ≤ gps_accuracy_max_m`.
   - Log every attempt in `attendance_logs` (accepted or rejected with reason).
   - On accept, emit `CHECKIN_ACCEPTED`/`FLOAT_CHECKIN`/`ORIGINAL_BACK` as appropriate.
3. Offline: mobile queues check-ins with local timestamp; server accepts if within clock-skew tolerance, flagging `late_sync`.

### 10.2 Presence monitor (debounce) — two-stage
`POST /attendance/ping` (or `GpsStreamPort` samples in simulation) → filter: drop `accuracy_m > attendance.gps_accuracy_max_m`; window of last 5 samples, median position; guard is "outside" only when `out_samples_required` consecutive samples are outside the geofence (hysteresis: leave radius = 1.5 × enter radius).
Timeline per guard on a post (all durations from policies; each step is a durable job reading `Clock`):
```
t0                  presence lost / outside        → OCCUPIED → UNCERTAIN, push QR challenge
t0 + uncertain_after_sec (45)   still no QR_CONFIRM → pre-warm: choose candidate (no order sent yet), notify dispatcher (info)
t0 + tier1_escalate_after_sec (120)  Tier 1       → VACANT_ALERT + fillVacancy
t0 + max_vacant_sec            Tier 2             → VACANT_ALERT + fillVacancy/merge
t0 + violation_after_sec (600)  no confirmation   → incident VIOLATION (record), regardless of tier
QR_CONFIRMED at any point      → back to OCCUPIED, cancel jobs, no violation
```
(Scenario A2 expects Tier 1 post refilled within 5 minutes of the absence — satisfied by the 120 s escalation + dispatch time.) Brief GPS noise (< `uncertain_after_sec`) must produce **no** alert.

## 11. Realtime (`apps/api/src/gateway`)

Socket.IO. Auth: JWT in handshake; server joins sockets only to rooms allowed by role.
| Room | Who | Messages |
|---|---|---|
| `dashboard:{siteId}` | dispatcher, manager | `post.state_changed` deltas, `kpi.updated`, `incident.opened/closed`, `dispatch.proposed/executed`, `site.mode_changed`, `staffing.updated` |
| `guard:{guardId}` | that guard only | `dispatch.order`, `schedule.updated`, `break.locked/unlocked`, `qr.challenge` |
| `shift:{siteId}:{shiftKey}` | all in shift | `announcement` |
| `emergency:{siteId}` | everyone | `emergency.started/cleared` — highest priority; client switches to full-screen evacuation UI and ignores other UI events |
Envelope: `{v:1, type, seq, ts, payload}`; `seq` monotonic per site (from a DB sequence at outbox insert). Client keeps last `seq`; on gap or reconnect calls `GET /state/snapshot` and resumes. Orders require app-level `ack` (`dispatch.ack` event or `POST /dispatch/orders/:id/ack`); no ack within `dispatch.ack_timeout_sec` → `EXPIRED` + next candidate + `NotifyPort` fallback (mock SMS/Zalo).
Delivery rule: outbox poller (or LISTEN/NOTIFY) publishes **after commit**, marks `sent_at`.

## 12. REST API (OpenAPI generated from zod; errors = RFC 7807 `application/problem+json`)

| Area | Endpoints |
|---|---|
| Auth | `POST /auth/login`, `POST /auth/refresh`, `GET /auth/me` |
| Guards | `GET/POST /guards`, `GET/PATCH /guards/:id`, `POST /guards/:id/certifications`, `POST /guards/:id/devices` |
| Posts | `GET /posts`, `GET /posts/:id`, `PATCH /posts/:id/rules` |
| Policies | `GET /policies`, `GET /policies/:key`, `PUT /policies/:key`, `POST /policies/preview` |
| Staffing | `GET /staffing/calc`, `POST /staffing/simulate` (body: param overrides), `GET /staffing/requests` |
| Schedule | `POST /schedules/generate`, `GET /schedules/:id`, `PATCH /schedules/:id/assignments/:aid`, `POST /schedules/:id/publish`, `POST /schedules/validate` |
| Absence | `POST /absences` (Idempotency-Key header), `GET /absences`, `POST /absences/:id/decision` |
| Attendance | `POST /attendance/nonce`, `POST /attendance/check`, `POST /attendance/ping` |
| State | `GET /state/snapshot` (posts + site mode + last seq), `POST /state/break/start` (guard; enforces handshake lock) |
| Dispatch | `GET /dispatch/orders`, `POST /dispatch/orders/:id/ack`, `POST /dispatch/orders/:id/decline`, `POST /dispatch/override` (dispatcher) |
| Break plan | `GET /break-plans?shift=…`, `POST /break-plans/replan` |
| Incidents/Reports | `GET /incidents`, `GET /reports/kpi?from&to`, `GET /reports/coverage` |
| Sim (only `SIM_MODE=true`) | `POST /sim/clock/jump {to}`, `POST /sim/clock/speed {x}`, `GET /sim/clock`, `POST /sim/scenario/:id/run`, `POST /sim/reset`, `POST /api/mock/camera-ai`, `POST /api/mock/fire-alarm`, `POST /api/mock/fire-alarm/clear`, `POST /api/mock/gps-stream` |

RBAC roles: `ADMIN, HR, MANAGER, DISPATCHER, SUPERVISOR, FLOAT, GUARD`. Guards can only act on themselves. `/sim/*` and `/api/mock/*` are not mounted unless `SIM_MODE=true`.

## 13. Simulation harness (`apps/api/src/sim`, `scenarios/`)

### 13.1 Clock
```ts
interface Clock { now(): Date; schedule(at: Date, fn: ()=>Promise<void>|void, key?: string): Cancel; }
class RealClock {...}
class VirtualClock {          // deterministic discrete-event
  jumpTo(to: Date): Promise<void>   // run every due timer in time order up to `to`, advancing now() to each timer's time
  advance(ms: number): Promise<void>
  setSpeed(x: number): void         // 1 real s = x system s (demo mode, uses a real ticker)
}
```
pg-boss jobs created through a `ScheduledJobs` wrapper that, in SIM_MODE, registers the due time on the VirtualClock instead of waiting wall time (store `run_at` in DB, VirtualClock polls due jobs on `jumpTo`). All `now()` used for `sim_ts` come from the Clock. ESLint `no-restricted-globals`/custom rule forbids `Date.now`, `new Date()` without args, `setTimeout`, `setInterval` outside `core/clock`.

### 13.2 Mock adapters
`/api/mock/camera-ai {postId, confidence}`, `/api/mock/fire-alarm {zone}`, `/api/mock/gps-stream {guardId, lat, lon, accuracy, atOffsetSec?}` call the same Port handlers a real adapter would.

### 13.3 Scenario file format (`packages/contracts` zod schema)
```yaml
id: A1
title: Three guards call in sick, Saturday morning
seed: { date: "2026-11-07", present: 45, fixtureSet: "full-roster", policyOverrides: {} }
timeline:
  - at: "2026-11-07T07:30:00+07:00"
    do: absence.report
    with: { guards: [ "owner:G4:MORNING", "owner:P3:MORNING", "float:TIER1_RELIEF#1" ] }
expect:
  - { within: "15m", after: 0, assert: post.status, post: G4, equals: OCCUPIED }
  - { assert: tier1.vacant_seconds, lte: 0 }
  ...
```
Runner: `npm run sim -- <ID> [--speed=1|60|max] [--json]`; resets DB to the fixture, drives `VirtualClock`, injects timeline actions via the same public services/REST (not by writing tables), evaluates `expect`, prints a PASS/FAIL table, stores a `sim_runs` row and a JSON report in `sim-reports/`.

### 13.4 The 8 scenarios (implement all; each with explicit assertions)
| ID | Setup / trigger | Must be true afterwards |
|---|---|---|
| **A1** | Sat morning. 07:30 three absences: owner of G4 (Tier 1), owner of P3 (Tier 2), one TIER1_RELIEF float. | G4 `OCCUPIED` by the remaining relief float within 15 min; P3 `COVERED_BY_PAIR` with P2; meal-plan replan with 1 float is infeasible → an `EARLY_CALL_IN` proposal to an AFTERNOON guard that **passes LegalGuard** (and one that fails rest rule is listed in `rejected`); Tier 1 vacant seconds = 0; no guard double-assigned. |
| **A2** | 14:30 guard at P8 stops sending valid presence (GPS outside by >10 min-equivalent, no QR). | UNCERTAIN → (≥120 s) VACANT_ALERT → nearest relief fills P8 and P8 `OCCUPIED` within 5 min of the loss; at +10 min a VIOLATION incident exists; a control run with only 30 s of GPS noise yields **no** alert. |
| **B1** | Present 45 of 60 across the week. | 7 Tier-1 posts fully staffed in every shift of a simulated week; 3 Tier-2 pairs merged (e.g., P3→P2, P4→P5, +1 configurable); `staffing_requests` created with qty = gap (15, or per K range); dashboard KPI shows gap 15 / 25%. |
| **C1** | Full morning (18 present), normal day. | Break plan generated for 7 Tier-1 posts, executes via state machine (HANDOVER_PENDING → RELIEVED_FOR_MEAL → OCCUPIED for each), zero alerts, zero incidents. |
| **C2** | Peak weekend; load data (mock "footfall" per zone) doubles in event zone. | System proposes moving Tier-2 guards from low-load posts to the high-load zone (kind `REINFORCE`), never touching Tier 1, accepted by dispatcher → assignments updated with `source=DISPATCH`. |
| **C3** | Policy override `headcount.fixed.MORNING = 15` valid for 3 days (so N_shift 19). | During the window `GET /staffing/calc` shows 19; after the VirtualClock jumps past `valid_to` it shows 18 again with **no code path restoring it**; audit log has the change. |
| **D1** | 02:00 camera AI motion at G5. | Only the guard at G1 (night) receives `REVIEW_MOTION` on `guard:{id}`; other guards' sockets receive nothing; dashboard shows alert; G1 remains covered per rules (or supervisor covers) — assertion on Tier 1 policy; incident MOTION opened; ack recorded. |
| **D2** | Fire alarm on Floor 1. | `site_state.mode=EMERGENCY` within 1 s (sim time), all meal/presence jobs cancelled, `emergency.started` reaches every connected socket, mobile test client shows evacuation state, no VACANT alerts fire during emergency; after `EMERGENCY_CLEARED` per-post logic resumes correctly. |

### 13.5 Quantitative experiments (script `npm run experiment`)
1. **Monte Carlo absenteeism:** for present ∈ {45,50,55,60} and per-guard-per-shift absence prob p ∈ {0.02,0.04,0.06}, run ≥ 2,000 simulated days headless using the pure planner/dispatch logic (no HTTP). Output CSV: probability of ≥1 Tier-1 vacancy, mean/95th percentile Tier-1 vacant minutes, number of call-ins, OT hours.
2. **Strategy comparison:** baseline `manual-random` vs `fifo` vs `swms-priority-cascade` on identical seeded absence streams.
3. **Latency:** p50/p95/p99 from `state_events.real_ts` to WS client receipt (test client).
All experiments seeded (`--seed`) and reproducible; results written to `experiments/*.csv` + a summary markdown.

## 14. Milestones (do in order; each ends with acceptance criteria)

**M0 – Scaffold.** Monorepo, TS strict, ESLint (incl. no-restricted Date/timers), Prettier, Vitest, Docker Compose (postgres, api, web), CI workflow, npm scripts from AGENTS §6, README with life-safety disclaimer.
*Accept:* `docker compose up` boots; `npm test` runs a placeholder; lint rule demonstrably fails on `Date.now()` in business code.

**M1 – DB + seed + auth + CRUD.** Migrations §3, seed §2 (fictional), JWT auth + RBAC, CRUD for guards/certs/devices/posts/post_rules.
*Accept:* migration up/down clean; seed yields 14 posts, 45 guards; EXCLUDE constraint rejects overlapping assignment (test); Tier-1 CHECK rejects `max_vacant_sec>0` (test).

**M2 – Clock, ConfigService, audit.** `Clock` (Real/Virtual), `ScheduledJobs` wrapper, `ConfigService` time-versioned reads, `PUT /policies`, `POST /policies/preview`, audit log, `policy.changed`.
*Accept:* tests: virtual clock jump fires timers in order; policy with `valid_to` expires after a jump; changing K via API changes next calc without restart.

**M3 – Staffing calculator + endpoints.** §5.
*Accept:* golden test (18/18/8, 44, 1.35, 60, gap 15, 25%); sensitivity output; endpoint contract tests.

**M4 – State machine + events + outbox.** §6 with table-driven tests: every valid transition, every invalid pair rejected, idempotent replay, optimistic-lock conflict retry, Tier-1 cannot enter PLANNED/PAIR states.
*Accept:* ≥ 95% branch coverage on `state-machine/`.

**M5 – LegalGuard + meal planner.** §9, §7 (pure functions) + `break_plans` persistence + slot jobs.
*Accept:* all three meal-planner golden tests; LegalGuard boundary tests; replan with 1 float returns suggestions.

**M6 – Dispatch engine + concurrency.** §8 incl. per-shift serialization, cascade, explain, ack/expire flow.
*Accept:* `npm run test:race` passes (1,000 rounds, 2 API processes); kill/restart idempotency test passes.

**M7 – Attendance & presence.** §10: nonce/QR/device checks, impossible-travel, debounce filter, two-stage escalation jobs.
*Accept:* tests for replayed QR (reject), wrong device (reject), 30 s GPS noise (no alert), full A2 timeline at unit level.

**M8 – Realtime + Web dashboard + mobile PWA.** §11, §15.
*Accept:* e2e test: client receives `post.state_changed` < 1 s (sim); reconnect with seq gap triggers snapshot; role-based room isolation test; Playwright smoke: dispatcher sees post turn red then green; mobile "break" button locked until relief checks in.

**M9 – Simulation harness + mocks + 8 scenarios.** §13.
*Accept:* `npm run sim:all` → 8/8 PASS; JSON reports written; each scenario also runs from the dashboard's Simulation panel.

**M10 – Roster generation.** `POST /schedules/generate` + `validate`. Step 1 (required): deterministic rotating generator with forward rotation (MORNING→AFTERNOON→NIGHT with a rest day between changes), ≤ 6 days/week, certificates, approved leave; plus `validate`. Step 2 (optional if time): `apps/solver` CP-SAT per the model: Boolean `x[g,d,s]`, demand with shortage slack variables (heavy weight Tier 1), forbidden consecutive pairs for <12 h rest, ≤ 6 days/week, night-streak cap, fairness of nights; objective minimise weighted shortage + OT + unfairness.
*Accept:* generated 4-week roster has zero hard-constraint violations per `validate`; with 45 guards, shortages occur only in Tier-2/float slots and are reported per day/shift.

**M11 – Reports, experiments, hardening.** §13.5 experiments, KPI endpoints, coverage report, security pass (RBAC tests, rate limiting on `/attendance/*`), docs (SRS-lite, ADRs, run guide), demo script `docs/DEMO.md` (step-by-step defense demo with scenario order and expected visuals).
*Accept:* experiments produce CSV + summary; demo script reproducible from a clean clone in < 10 minutes.

## 15. UI requirements

### Web dashboard (React, Vietnamese strings)
- **Floor map (SVG):** 14 post markers; fill colour by status: OCCUPIED green, HANDOVER_PENDING/RELIEVED_FOR_MEAL amber, UNCERTAIN yellow-hatched, VACANT_ALERT red pulsing, VACANT_PLANNED/COVERED_BY_PAIR orange, NOT_ACTIVE grey; Tier 1 thick outline; label shows guard code; click → drawer with state history from `state_events`. Colour is never the only cue (also icon/shape + text).
- **Incident & proposal queue:** shows `explain` (why this guard, who was rejected and why), buttons Approve / Override.
- **KPI bar:** present/required, gap, Tier-1 vacant minutes today, open incidents, p95 WS latency.
- **Policy page:** edit parameters, "Preview impact" (calls `/policies/preview`), history.
- **Roster page:** week/month grid with validation errors inline; generate/publish.
- **Break matrix page:** timeline (Gantt-like) of the relief plan per float.
- **Simulation panel (SIM_MODE only):** scenario picker, run/step, clock controls (jump to 07:30, 10:00, 14:30, 02:00; speed), buttons to fire mock events.
- **Emergency view:** full-screen banner and evacuation checklist/headcount.
### Mobile PWA (guards)
Minimalism for low-tech users: main screen = current post & shift, **one huge Check-in/Check-out button (≥ 64 px tall)**, break button (disabled with explanation until relief arrives), incident/dispatch card with two huge buttons (Accept / Cannot), vibration + sound on new order, offline queue indicator, font ≥ 18 px, high contrast, Vietnamese. Emergency mode replaces entire UI with evacuation instructions.

## 16. Testing requirements
- **Unit:** staffing calculator, meal planner, LegalGuard, transition table, debounce filter, ranking function.
- **Property-based (fast-check):** random event sequences never violate: (a) a guard is on ≤ 1 post at a time; (b) a Tier-1 post is never `VACANT_PLANNED`/`COVERED_BY_PAIR`; (c) every Tier-1 `VACANT_ALERT` has either an order, a pending proposal, or an open HIGH incident.
- **Integration (real Postgres):** locks, transactions, outbox, idempotency, retry on 40001/40P01.
- **Concurrency:** §8.3.
- **Scenario/E2E:** §13.4 all eight.
- **Security:** RBAC matrix tests, WS room isolation, replay/nonce tests.
- **Coverage gate (CI):** ≥ 70% overall, ≥ 90% on state-machine, meal-planner, legal-guard, staffing.
- Seeded randomness everywhere (`--seed`).

## 17. Definition of done (whole project)
1. All milestones accepted; `docker compose up` + `npm run db:seed` gives a working demo.
2. `npm run sim:all` → 8/8 PASS; `npm run test:race` PASS; CI green.
3. No `Date.now/new Date()/setTimeout` in business code; no hard-coded business constants (lint + grep check in CI).
4. `docs/DEMO.md`, `docs/OPEN_QUESTIONS.md` (all ASSUMPTIONs listed), ADRs for stack choices, README with architecture diagram (Mermaid) and life-safety disclaimer.
5. Experiments CSV + summary produced.

## Appendix A — Event type catalogue (contracts)
`SHIFT_START, SHIFT_END, CHECKIN_ACCEPTED, FLOAT_CHECKIN, ORIGINAL_BACK, MEAL_WINDOW_OPEN, HANDOVER_TIMEOUT, MEAL_OVERRUN, PRESENCE_UNCERTAIN, QR_CONFIRMED, ESCALATE_TIMEOUT, ABSENCE_REPORTED, REPLACEMENT_ASSIGNED, ACCEPT_PLANNED_GAP, MERGE_WITH_PAIR, CAMERA_MOTION, FIRE_ALARM, EMERGENCY_CLEARED, POLICY_CHANGED, DISPATCH_ACKED, DISPATCH_DECLINED, DISPATCH_EXPIRED`.

## Appendix B — Suggested folder skeleton for `apps/api/src/modules/dispatch`
```
state-machine/{transitions.ts,apply.ts,types.ts}
meal-planner/{plan.ts,validate.ts}
legal-guard/{rules.ts,index.ts}
engine/{queue.ts,fill-vacancy.ts,ranking.ts,handlers/*.ts}
dispatch.service.ts  dispatch.controller.ts
```

## Appendix C — Prompts you can give the agent per milestone
> "Implement milestone M{n} from docs/SWMS_BUILD_SPEC.md §14. First read the referenced sections. Write the tests listed in the acceptance criteria before the implementation, then implement until `npm run typecheck && npm run lint && npm test` pass. Log any assumption you make in docs/OPEN_QUESTIONS.md. Do not touch unrelated modules."

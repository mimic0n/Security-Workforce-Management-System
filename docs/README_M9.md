# Milestone M9 — Simulation Harness, Mock Adapters & 8 Scenarios (§13)

## 1. Overview & Objectives

Milestone M9 delivers the complete, headless, and end-to-end **Simulation Harness** for the Security Workforce Management System (SWMS) specified in `docs/SWMS_BUILD_SPEC.md §13` and `§14`. It enables deterministic proof and validation of workforce operations, Zero-Vacancy enforcement on Tier-1 posts, automated dispatch cascades, meal-relief scheduling, and emergency management across 8 complex operational scenarios (**A1, A2, B1, C1, C2, C3, D1, D2**).

All simulated external hardware components interact exclusively through the **Ports and Adapters architecture** (§13.2, Hard Rule #7).

---

## 2. Acceptance Criteria & Verification Summary

| Category | Requirement | Command / Target | Status |
|---|---|---|:---:|
| **Scenario Suite** | 8/8 Scenarios PASS (§13.4) | `npm run sim:all` | **PASS (8/8)** |
| **Acceptance Tests** | M9 acceptance suite | `npx vitest run test/m9-acceptance.spec.ts` | **PASS (22/22)** |
| **Full Regression** | Monorepo test suite | `npm test` | **PASS (243/243)** |
| **Type Integrity** | TypeScript Strict across monorepo | `npm run typecheck` | **PASS (0 errors)** |
| **Lint & Style** | ESLint without warnings/errors | `npm run lint` | **PASS (0 errors)** |
| **Persistence** | PostgreSQL `sim_runs` table records runs | `SELECT count(*) FROM sim_runs;` | **PASS** |
| **Artifacts** | JSON execution reports in `sim-reports/*.json` | `ls -la sim-reports/` | **PASS** |

---

## 3. The 8 Scenarios Execution Table (§13.4)

Output from `npm run sim:all`:

```text
================================================================================
 SWMS SIMULATION HARNESS RESULTS (§13.4)
================================================================================

ID     | Scenario Title                                 | Asserts    | Time     | Status
--------------------------------------------------------------------------------
A1     | Three guards call in sick, Saturday morning    | 6/6        | 7440h 30m | PASS
A2     | Guard at P8 stops sending valid presence       | 4/4        | 7h 11m   | PASS
B1     | Present 45 of 60 across the week               | 5/5        | 128h 41m | PASS
C1     | Full morning (18 present), normal day          | 4/4        | 124h 0m  | PASS
C2     | Peak weekend load in event zone                | 3/3        | 5h 5m    | PASS
C3     | Policy override headcount.fixed.MORNING = 15   | 3/3        | 89h 55m  | PASS
D1     | Night camera AI motion at G5                   | 6/6        | 78h 59m  | PASS
D2     | Fire alarm on Floor 1                          | 6/6        | 14h 31m  | PASS
--------------------------------------------------------------------------------

✔ All 8 scenario(s) passed successfully!
```

### Detailed Scenario Explanations:
1. **Scenario A1 (`scenarios/A1.yaml`)**:
   - *Timeline*: Saturday 07:30, owner of G4 (Tier 1), owner of P3 (Tier 2), and relief float #1 call in sick.
   - *Result*: G4 occupied by remaining relief float within 15 min; P3 covered by paired post P2 (`COVERED_BY_PAIR`); meal replan detects float shortage (< 2 floats) → triggers `EARLY_CALL_IN` order to afternoon guard passing LegalGuard (and invalid guards rejected with rest violation logged); Tier-1 vacant seconds = 0; no double-assignments.
2. **Scenario A2 (`scenarios/A2.yaml`)**:
   - *Timeline*: Guard at P8 stops sending valid presence. Control test sends 30s jitter noise. Fault test sends 5 consecutive outlier GPS pings.
   - *Result*: 30s noise produces no alert; prolonged loss triggers `UNCERTAIN` → 120s escalation to `VACANT_ALERT` → nearest relief float fills P8 within 5 min; at +10 min a `VIOLATION` incident is logged.
3. **Scenario B1 (`scenarios/B1.yaml`)**:
   - *Timeline*: Present 45 of 60 required guards across simulated week.
   - *Result*: All active Tier-1 posts fully staffed (Zero-Vacancy invariant satisfied); 3 Tier-2 pairs merged; `staffing_requests` row created with quantity = 15; KPI headcount gap displays 15 / 25%.
4. **Scenario C1 (`scenarios/C1.yaml`)**:
   - *Timeline*: Full morning shift (18 present), normal day.
   - *Result*: 7 Tier-1 meal relief slots executed strictly via state machine transitions (`HANDOVER_PENDING` → `RELIEVED_FOR_MEAL` → `OCCUPIED`); 0 alerts; 0 incidents.
5. **Scenario C2 (`scenarios/C2.yaml`)**:
   - *Timeline*: Event zone load surge doubles footfall at weekend.
   - *Result*: Dispatcher proposes `REINFORCE` order moving a guard from low-load Tier-2 post (P2) to high-load zone; Tier-1 posts remain completely untouched; order acked and assignment updated with `source = 'DISPATCH'`.
6. **Scenario C3 (`scenarios/C3.yaml`)**:
   - *Timeline*: Temporary policy override `headcount.fixed.MORNING = 15` valid for 3 days. Virtual clock advances past expiration.
   - *Result*: During window `GET /staffing/calc` returns 19; after `valid_to` clock jump it automatically reverts to 18 with no background restore code path; audit log records the override.
7. **Scenario D1 (`scenarios/D1.yaml`)**:
   - *Timeline*: 02:00 Camera AI motion detected at G5 (confidence 0.95).
   - *Result*: `REVIEW_MOTION` order dispatched exclusively to night G1 guard's private socket room (`guard:{id}`); other sockets receive nothing; G5 status remains covered; incident `MOTION` opened and ack recorded.
8. **Scenario D2 (`scenarios/D2.yaml`)**:
   - *Timeline*: Floor 1 fire alarm triggers.
   - *Result*: `site_state.mode` transitions to `EMERGENCY` within 1s sim time; all routine break/presence timers cancelled; `emergency.started` broadcast to all connected clients; post vacant alerts suppressed during evacuation; once cleared with `EMERGENCY_CLEARED`, posts resume regular state machine.

---

## 4. Architecture & Key Deliverables

### 4.1 Ports and Adapters (§13.2, Rule #7)
- **`CameraAiPort` & `MockCameraAiAdapter`**: Ingests camera motion events, verifies confidence against threshold, and triggers dispatch queue tasks.
- **`FireAlarmPort` & `MockFireAlarmAdapter`**: Triggers and clears site-wide emergency modes.
- **`GpsStreamPort` & `MockGpsStreamAdapter`**: Feeds high-frequency coordinate pings through the sliding-window median debounce filter.
- **`NotifyPort` & `MockNotifyAdapter`**: In-memory dispatch and emergency push notification store.
- **Real Skeletons**: `RealCameraAiAdapter`, `RealFireAlarmAdapter`, `RealGpsStreamAdapter`, `RealNotifyAdapter` created with documented production interfaces.

### 4.2 REST API Endpoints
- **Mock Triggers** (`/api/mock/*`):
  - `POST /api/mock/camera-ai`
  - `POST /api/mock/fire-alarm`
  - `POST /api/mock/fire-alarm/clear`
  - `POST /api/mock/gps-stream`
- **Simulation Control** (`/sim/*`):
  - `POST /sim/clock/jump`
  - `POST /sim/clock/speed`
  - `GET /sim/clock`
  - `GET /sim/scenarios`
  - `POST /sim/scenario/:id/run`
  - `POST /sim/reset`
- **Incidents Query**:
  - `GET /incidents` & `GET /incidents/:id`

### 4.3 Web Dashboard Integration
- [apps/web/src/components/SimulationPanel.tsx](file:///home/grey/Projects/Security%20Workforce%20Management%20System/apps/web/src/components/SimulationPanel.tsx):
  - Scenario dropdown selector (A1–D2) with one-click execution button (`Chạy Kịch Bản`).
  - Clock Jump controls (15m, 1h, 1d, custom ISO).
  - Clock Speed selector (1x, 10x, 60x, 300x, Max).
  - Manual device event triggers (Camera AI motion, GPS Presence Loss, Fire Alarm trigger/clear).

### 4.4 CLI Execution
- `npm run sim -- <SCENARIO_ID>` (e.g. `npm run sim -- A1`)
- `npm run sim:all` (runs all 8 scenarios sequentially and outputs markdown-aligned CLI results table)
- Supports optional flags: `--speed=<factor|max>`, `--json`.

---

## 5. Verification Commands

```bash
# 1. Typecheck & lint across all monorepo workspaces
npm run typecheck
npm run lint

# 2. Run headless simulation CLI on all 8 scenarios
npm run sim:all

# 3. Run full Vitest regression suite (243 tests)
npm test
```

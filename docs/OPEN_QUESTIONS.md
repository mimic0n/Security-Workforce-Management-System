# Open Questions & Assumptions Log — SWMS

> This document tracks all explicit assumptions, ambiguities, and potential contradictions identified in `docs/SWMS_BUILD_SPEC.md` and `AGENTS.md`, along with the chosen defaults for implementation.

---

## 1. Explicit Assumptions Marked in Specification

| Item | Section | Assumption in Spec | Chosen Implementation Default | Notes / Impact |
|---|---|---|---|---|
| **Tier-2 Vacancy Tolerance** | §2.1 | All Tier 2 posts have `max_vacant_sec = 900` (15 min). Only G2 was explicitly mentioned in source material. | Set default `max_vacant_sec = 900` in `post_rules` for all Tier-2 posts (`G2, G3, G6, P2, P3, P4, P5`). Configurable per post. | Zero-Vacancy invariant applies strictly to Tier 1 (`max_vacant_sec = 0`). |
| **Night Shift Active Posts** | §2.2 | Source states "6 fixed posts at night" without naming them. Spec assumes: `night_posts = [G1, G3, G4, G5, G6, P8]`. | Implement `night_posts = [G1, G3, G4, G5, G6, P8]` in seed data `post_rules.active_shifts`. Inactive posts have status `NOT_ACTIVE`. | Notice only 4 Tier-1 posts (G1, G4, G5, P8) are active at night; P1, P6, P7 are `NOT_ACTIVE`. |
| **Afternoon & Night Meal Windows** | §2.4 | Morning meal window is `10:00–12:45`. Afternoon window assumed `16:00–18:45`. Night has no relief float; supervisor/float_gen covers. | Configure `meal.window` in `policies` for MORNING and AFTERNOON. For NIGHT, if break is needed (shift template specifies 45m), relief is handled ad-hoc by `FLOAT_GEN` or `SUPERVISOR`. | Night shifts (22:00–06:00) require ≥ 45 min break per Labor Code 2019 Art. 109. |
| **Post Travel Matrix** | §2.5 | 5 min travel within zone group, 10 min across zone groups. Handover buffer = 5 min. | Pre-populate `post_travel` table with 5 min intra-group, 10 min inter-group. | Exactly fits the 15-minute staggered intervals in Golden Meal Plan. |
| **Overtime Cost Multipliers** | §9 | Overtime multipliers for cost calculation: Night work ×1.3, Day OT ×1.5, Night OT ×2.0. | Implement multipliers in `LegalGuard.costEstimate` helper function, configurable via policies. | Used for candidate ranking and reporting only; does not block dispatches. |

---

## 2. Ambiguities & Inconsistencies Requiring Clarification

### 2.1 Night Shift Tier-1 Headcount vs Scenario B1 Invariant
- **Issue**: §1 states there are 7 Tier-1 posts (`G1, G4, G5, P1, P6, P7, P8`). In §2.2, night shift only activates 6 posts (`G1, G3, G4, G5, G6, P8`), of which only 4 are Tier 1 (`G1, G4, G5, P8`), while `P1, P6, P7` are `NOT_ACTIVE`. However, Scenario B1 acceptance says: *"7 Tier-1 posts fully staffed in every shift of a simulated week"*.
- **Default Resolution**: For MORNING and AFTERNOON, all 7 Tier-1 posts are active and must be staffed. For NIGHT, only the 4 active Tier-1 posts must be staffed (inactive posts are in `NOT_ACTIVE` state and do not count as vacancies). In Scenario B1, assert 100% Zero-Vacancy on all *active* Tier-1 posts per shift.

### 2.2 Tier-2 Pairing in Seed Data vs Scenario B1 Requirements
- **Issue**: Scenario B1 specifies: *"3 Tier-2 pairs merged (e.g., P3→P2, P4→P5, +1 configurable)"*. However, in §2.1 seed data, only two pairs are defined: `P2 ↔ P3` and `P4 ↔ P5`. Gates `G2`, `G3`, `G6` have empty `pair_with = []`.
- **Default Resolution**: Define an optional third pair in seed configuration: `G2 ↔ G3` (both in adjacent gate zones) to allow merging 3 pairs under heavy understaffing (reducing daily required fixed slots from 14 to 11 in morning/afternoon), or configure `+1 pair` via policy override for Scenario B1.

### 2.3 Scenario A1 Float Depletion vs Meal Plan Infeasibility
- **Issue**: In Scenario A1 (Saturday 07:30), three guards call in sick: owner of G4 (Tier 1), owner of P3 (Tier 2), and 1 of the 2 `TIER1_RELIEF` floats. The dispatch cascade assigns the *remaining* `TIER1_RELIEF` float to fill the vacancy at G4. If the only remaining relief float is permanently stationed at G4, there are 0 relief floats left for meal breaks. Yet Scenario A1 states: *"meal-plan replan with 1 float is infeasible → an EARLY_CALL_IN proposal to an AFTERNOON guard..."*.
- **Default Resolution**: When the remaining float is pulled to cover G4, the meal planner is invoked for the remaining pool. If the pulled float is committed to G4, available floats for meal relief = 0 (which is definitely infeasible). Alternatively, if the float covers G4 temporarily until an early call-in guard arrives, or if an afternoon guard is called in to take over the relief float duties, the meal planner evaluates feasibility. We will support both: re-plan detects shortage (< 2 floats) → flags infeasible → suggests `EARLY_CALL_IN` or `USE_TIER2_RELIEF`.

### 2.4 Early Call-in for Afternoon Guards vs Daily Consecutive Working Hours
- **Issue**: Scenario A1 triggers an `EARLY_CALL_IN` proposal to an afternoon guard. Afternoon shift runs 14:00–22:00 (8h). If called in for morning meal relief (e.g. 10:00–12:45) or to start early (e.g. 08:00), the guard works both shifts or an extended shift:
  - If working 10:00–22:00 = 12h (meets Decree 145/2020 limit of max 12h work/day including OT).
  - If working 07:30–22:00 = 14.5h (exceeds statutory 12h daily limit).
  - Furthermore, LegalGuard §9 specifies minimum 12h rest between shifts (`start - end >= 12h`), which applies between consecutive days, but does not explicitly define whether an early call-in merges into a single lengthened shift or counts as two separate assignments on the same day.
- **Default Resolution**: An `EARLY_CALL_IN` creates an assignment segment extending the scheduled shift (e.g. starting at 10:00 instead of 14:00, or covering a 10:00–13:00 float slot). LegalGuard will check: (1) min 12h rest from previous day's shift, (2) monthly/yearly OT caps, (3) max daily total hours ≤ 12h.

### 2.5 GPS Debounce vs Immediate UNCERTAIN Transition
- **Issue**: §10.2 timeline says: `t0: presence lost / outside → OCCUPIED → UNCERTAIN, push QR challenge`. Then line 351 states: *"Brief GPS noise (< uncertain_after_sec) must produce no alert"*. If status transitions to `UNCERTAIN` immediately at `t0`, WebSocket emits `post.state_changed`, which is visible to the dashboard as a status change.
- **Default Resolution**: Distinguish between raw GPS loss/outside event and filtered status transition:
  - The 5-sample median filter and `out_samples_required = 3` consecutive outside readings must be met before `t0` is declared.
  - Brief GPS noise (< 3 samples or jitter within 30s) is suppressed by the debounce filter and does NOT trigger `UNCERTAIN`.
  - Once debounce filter confirms presence loss (`t0`), post enters `UNCERTAIN`, sends QR challenge push to guard, and sets timer `deadline_at = t0 + tier1_escalate_after_sec (120s)`.
  - "No alert" means no audible/urgent `VACANT_ALERT` or incident is triggered if guard confirms QR within the grace period.

### 2.6 QR Verification Mechanism (Nonce vs Physical Token)
- **Issue**: §10.1 specifies `POST /attendance/check` checks `qrToken = HMAC(secret, qr_code_id)`. If `qrToken` is a static HMAC of the post's QR code, guards could photograph the QR code and reuse it.
- **Default Resolution**: Use two-factor verification:
  1. The mobile client first calls `POST /attendance/nonce { postId }` to get a short-lived nonce (TTL 45s) tied to `(guard_id, device_uid, post_id)`.
  2. Mobile scans the physical QR code (containing `qr_code_id`).
  3. Mobile submits `{ postId, nonce, scannedCode, deviceUid, gps }`. The server validates the active nonce, verifies the scanned code against `posts.qr_code_id`, verifies device binding, and marks the nonce used.

### 2.7 Policy Time-Versioning & In-Memory Caching (M2)
- **Issue**: §4 and §13.4 (Scenario C3) require temporary policy overrides (e.g. `headcount.fixed.MORNING = 15` for 3 days) to automatically expire when the VirtualClock jumps past `valid_to` without any code path restoring it.
- **Default Resolution**:
  - `ConfigService` evaluates `valid_from <= atTime AND (valid_to IS NULL OR valid_to > atTime) ORDER BY valid_from DESC LIMIT 1`.
  - Temporary override rows keep their finite `valid_to`, while the base configuration keeps `valid_to = NULL`.
  - When time passes `valid_to`, the query naturally resolves the base row.
  - The cache maintains the policy versions in memory, and is invalidated on `policy.changed` events.
  - Audit logs record both `before` and `after` states along with `actor_id` and timestamp from the injected `Clock`.
  - `ScheduledJobsService` integrates with `Clock.schedule` in `SIM_MODE`, guaranteeing that jobs execute deterministically during `VirtualClock.jumpTo()`.


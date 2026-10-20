# AGENTS.md — SWMS (Security Workforce Management System)

> Entry file for the coding agent. Keep it short. The full specification is in `docs/SWMS_BUILD_SPEC.md` — **read the section named by the current milestone before coding it.** Do not try to hold the whole spec in context.

## 1. What we are building
A real-time web + mobile system that manages security guards at **AEON Mall Thanh Khê, Floor 1** (university thesis; **simulation-only, never deployed to a real site**). It solves *understaffing* (45 guards present vs ≈60 required) by: computing required headcount, enforcing **Zero-Vacancy on Tier 1 posts**, auto-dispatching replacements under concurrency locks, verifying presence (GPS+QR), and proving it all with a **simulation harness** (virtual clock + mock devices) over 8 scenarios (A1, A2, B1, C1, C2, C3, D1, D2).

Domain: 14 fixed posts (G1–G6 gates, P1–P8 stands). Tier 1 (never empty): G1, G4, G5, P1, P6, P7, P8. Tier 2 (others). Shifts: MORNING 06–14, AFTERNOON 14–22, NIGHT 22–06. Per-shift headcount N_shift = fixed + float_tier1 + float_gen + supervisor (18/18/8 = 44 slots/day); N_total = 44 × K_relief ≈ 60.

## 2. Stack (decided — do not change without writing an ADR in docs/adr/)
- Monorepo, npm workspaces, **TypeScript strict**, Node 20+.
- `apps/api`: **NestJS** modular monolith, **PostgreSQL 16**, plain SQL migrations (`node-pg-migrate`) + `pg` (thin repositories; raw SQL for locking code), **Socket.IO**, **pg-boss** for durable timers/jobs, `zod` for validation.
- `apps/web`: React + Vite + TanStack Query + Zustand; floor map is **SVG**.
- `apps/mobile`: **PWA first** (React + Vite, mobile-first, huge buttons). Native only if time remains.
- `apps/solver` (optional, last): Python FastAPI + OR-Tools CP-SAT for monthly rosters.
- `packages/contracts`: shared zod schemas + TS types for REST, WS events, scenario files.
- Tests: **Vitest**, Postgres via Docker Compose (or testcontainers). `docker compose up` must start everything.

## 3. Hard rules (violating any of these is a bug)
1. **Never call `Date.now()`, `new Date()`, `setTimeout`, `setInterval` in business code.** Use the injected `Clock` (`packages/contracts` interface, impl in `apps/api/src/core/clock`). Lint rule enforces it.
2. **No business constants in code** (K_relief, float counts, break minutes, grace seconds, tier, pair_with, OT caps, window times…). They live in DB tables `policies`, `post_rules`, `shift_templates` and are read through `ConfigService` (cached; invalidated by `policy.changed`).
3. **State is data, not memory.** Post state lives in `post_state`; every transition writes `state_events` **in the same transaction** (append-only). Timers are rows (`deadline_at`) + pg-boss jobs, never in-process timers. A server restart must lose nothing.
4. **Single entry point for transitions:** `DispatchService.apply(tx, event)` → transition table (data, in `state-machine/transitions.ts`). Invalid transitions are rejected and tested.
5. **Concurrency:** every dispatch decision runs in ONE transaction that first takes `pg_advisory_xact_lock(hashtextextended('<site>:<shiftKey>',0))`, processes by priority (EMERGENCY > Tier-1 vacancy > meal relief > Tier-2 vacancy), uses an `idem_key`, retries on SQLSTATE `40001`/`40P01`. Do **not** use `SKIP LOCKED` for dispatch (it inverts priority). DB safety net: `EXCLUDE USING gist (guard_id WITH =, period WITH &&)` on `assignments`.
6. **Broadcast only after COMMIT** (outbox table or post-commit hook). Every WS message has `v`, `seq` (monotonic per site), `ts`.
7. **All devices go through Ports/Adapters** (`CameraAiPort`, `FireAlarmPort`, `GpsStreamPort`, `NotifyPort`). Only `Mock*` adapters are implemented; real ones are empty skeletons.
8. **Legal rules are code-checked, values are config:** `LegalGuard` must reject any assignment/dispatch that breaks min rest between shifts (12 h), max 6 working days/week, OT caps, or expired security certificate.
9. **Emergency (fire) is a site-wide mode**, not a per-post state: `site_state.mode = NORMAL | EMERGENCY`.
10. No real personal data anywhere; seed with fictional names. Never log GPS traces beyond what a test needs.
11. Life-safety disclaimer in README: SWMS is a support layer; real fire-alarm/PCCC procedures are independent of it.

## 4. Repo layout
```
apps/{api,web,mobile,solver}/   packages/contracts/   db/{migrations,seed}/
scenarios/*.yaml   docs/{SWMS_BUILD_SPEC.md,adr/,OPEN_QUESTIONS.md}   docker-compose.yml
apps/api/src/{core/{clock,events,locks,audit},modules/{guards,posts,rules,staffing,schedule,attendance,dispatch,incident,notify,recruit},gateway,adapters,sim}
```

## 5. Workflow for you (the agent)
- Work **milestone by milestone** in the order of `docs/SWMS_BUILD_SPEC.md §14`. Before starting: read that milestone's spec sections; write/adjust tests first when the spec gives golden values.
- A milestone is done only when its **Acceptance criteria** pass: `npm run typecheck && npm run lint && npm test` all green, and any scenario/CLI command named in the milestone runs.
- Small commits, Conventional Commits (`feat(dispatch): …`). One milestone ≈ one PR/branch.
- If the spec is ambiguous or a value is marked **ASSUMPTION**, pick the documented default, make it configurable, and append a line to `docs/OPEN_QUESTIONS.md`. **Do not stop to ask** unless a decision would be irreversible.
- Never "make tests pass" by weakening assertions, skipping tests or hard-coding scenario outcomes.
- Prefer boring, readable code. Explain non-obvious choices in short comments, especially around locks and transitions.

## 6. Commands (create these in M0)
`npm run dev` (api+web) · `npm run db:migrate` · `npm run db:seed` · `npm test` · `npm run test:race` · `npm run sim -- A1` (run one scenario headless) · `npm run sim:all` · `npm run typecheck` · `npm run lint` · `docker compose up`

## 7. Language
Code, identifiers, comments, commit messages: **English**. User-facing UI strings: **Vietnamese** (via i18n file `vi.json`; keys in English). Domain glossary: *bảo vệ*=guard, *vị trí trực*=post, *tiếp viên cơ động*=float guard, *giám sát ca*=supervisor, *điều phối viên*=dispatcher, *định biên*=headcount standard, *nghỉ ăn*=meal break.

# Báo Cáo Nghiệm Thu Milestone M4: State Machine, Events & Outbox

> **Dự án**: Security Workforce Management System (SWMS)  
> **Địa điểm mô phỏng**: AEON Mall Thanh Khê, Tầng 1  
> **Milestone**: M4 – Máy trạng thái vị trí trực (State Machine), Bảng chuyển dịch dữ liệu (§6.1 Transition Table), Outbox Pattern với Sequence đơn điệu, Khóa bắt tay hai chiều (Two-Way Handshake Lock) & REST Endpoints  
> **Tham chiếu tài liệu**: `docs/SWMS_BUILD_SPEC.md §6, §11, §12, §14, §16`  
> **Hard Rules tuân thủ**: `AGENTS.md` Rules #1, #2, #3, #4, #5, #6, #8, #9  

---

## 1. Mục tiêu Milestone M4

Milestone M4 xây dựng lõi vận hành trạng thái của toàn bộ hệ thống SWMS cho 14 vị trí trực (G1–G6, P1–P8) và chế độ hiện trường (`site_state.mode`):
1. **Bảng chuyển dịch trạng thái dạng dữ liệu (Data-Driven Transition Table §6.1)**:
   - Quản lý 8 trạng thái vị trí: `NOT_ACTIVE, OCCUPIED, HANDOVER_PENDING, RELIEVED_FOR_MEAL, VACANT_ALERT, VACANT_PLANNED, COVERED_BY_PAIR, UNCERTAIN`.
   - Quản lý đầy đủ các sự kiện kích hoạt: `SHIFT_START, SHIFT_END, CHECKIN_ACCEPTED, FLOAT_CHECKIN, ORIGINAL_BACK, MEAL_WINDOW_OPEN, HANDOVER_TIMEOUT, MEAL_OVERRUN, PRESENCE_UNCERTAIN, QR_CONFIRMED, ESCALATE_TIMEOUT, ABSENCE_REPORTED, REPLACEMENT_ASSIGNED, ACCEPT_PLANNED_GAP, MERGE_WITH_PAIR, FIRE_ALARM, EMERGENCY_CLEARED...`
   - Bất kỳ cặp `(trạng thái hiện tại, sự kiện)` không nằm trong bảng đều bị từ chối với lỗi [`InvalidTransitionError`](file:///home/grey/Projects/Security%20Workforce%20Management%20System/apps/api/src/modules/dispatch/state-machine/invalid-transition.error.ts#L1-L18).
2. **Bảo toàn tuyệt đối bất biến Zero-Vacancy trên vị trí Tier 1**:
   - Các vị trí Tier 1 (`G1, G4, G5, P1, P6, P7, P8`) **tuyệt đối không bao giờ được phép** rơi vào trạng thái `VACANT_PLANNED` hoặc `COVERED_BY_PAIR`.
   - Mọi hành vi `ACCEPT_PLANNED_GAP` hoặc `MERGE_WITH_PAIR` nhắm vào Tier 1 đều bị chặn cứng và ném [`Tier1InvariantError`](file:///home/grey/Projects/Security%20Workforce%20Management%20System/apps/api/src/modules/dispatch/state-machine/tier1-invariant.error.ts#L1-L16).
3. **Khóa bắt tay hai chiều (Two-Way Handshake Lock §6.2, §12)**:
   - Nghiêm cấm bảo vệ tự ý bấm "Bắt đầu nghỉ ăn" khi chưa có tiếp viên cơ động (float) đến tiếp quản vị trí.
   - Hành động `POST /state/break/start` chỉ được chấp thuận khi vị trí đạt trạng thái `RELIEVED_FOR_MEAL` (hoặc `HANDOVER_PENDING` kèm float check-in đã xác nhận).
4. **Chế độ khẩn cấp toàn trang (Site-wide EMERGENCY Mode §6.2)**:
   - Sự kiện `FIRE_ALARM` kích hoạt `site_state.mode = 'EMERGENCY'`.
   - Toàn bộ các quy tắc per-post, bộ hẹn giờ ăn ca và cảnh báo hiện diện đều bị đình chỉ (ngoại trừ chuyển ca `SHIFT_END`).
   - Sự kiện `EMERGENCY_CLEARED` khôi phục `NORMAL` và cho phép tái đánh giá hiện trường.
5. **Idempotent Replay & Append-Only State Events**:
   - Mọi chuyển dịch hợp lệ đều ghi vào bảng append-only `state_events` kèm khóa định danh duy nhất `idem_key`.
   - Khi cùng một `idem_key` gửi lại, hệ thống trả về kết quả đã ghi nhận trước đó (`isReplay: true`), không lặp lại chuyển trạng thái, không tăng version, không ghi log trùng lặp.
6. **Kiểm soát đồng thời & Optimistic Locking**:
   - `DispatchService.apply(tx, event)` khóa dòng dữ liệu `FOR UPDATE` trong giao dịch và cập nhật có điều kiện `WHERE post_id = $1 AND version = $2`.
   - Nếu version bị xung đột (0 dòng được cập nhật), ném [`OptimisticLockError`](file:///home/grey/Projects/Security%20Workforce%20Management%20System/apps/api/src/modules/dispatch/state-machine/optimistic-lock.error.ts#L1-L14).
   - Wrapper [`applyWithRetry`](file:///home/grey/Projects/Security%20Workforce%20Management%20System/apps/api/src/modules/dispatch/dispatch.service.ts#L290-L321) tự động bắt và thử lại (tối đa 3 lần) đối với xung đột optimistic lock và SQLSTATE `40001`/`40P01`.
7. **Outbox Pattern với Monotonic Sequence per Site (§11)**:
   - Sử dụng PostgreSQL sequence `site_event_seq` cấp phát `seq` tăng đơn điệu cho mỗi sự kiện.
   - Đóng gói phong bì WS: `{ v: 1, type, seq, ts, payload }`.
   - Chỉ xuất bản (`publishPending`) ra [`EventBusService`](file:///home/grey/Projects/Security%20Workforce%20Management%20System/apps/api/src/core/events/event-bus.service.ts#L7) và đánh dấu `sent_at` **sau khi giao dịch đã COMMIT thành công**.
8. **Độ phủ kiểm thử nhánh (Branch Coverage Gate)**:
   - Tiêu chí nghiệm thu: $\ge 95\%$ branch coverage trên thư mục `state-machine/`.

---

## 2. Danh Sách Tệp Triển Khai & Thay Đổi

```
packages/contracts/src/
├── state-machine.ts                         # Zod schemas & types: EventType, StateTransitionEvent, OutboxEnvelope, Snapshots
└── index.ts                                 # Re-export state-machine contracts

apps/api/src/modules/dispatch/
├── state-machine/
│   ├── invalid-transition.error.ts          # Lỗi chuyển trạng thái không hợp lệ
│   ├── tier1-invariant.error.ts             # Lỗi vi phạm bất biến Zero-Vacancy trên Tier 1
│   ├── optimistic-lock.error.ts             # Lỗi xung đột phiên bản đồng thời
│   ├── transitions.ts                       # Bảng dữ liệu TRANSITION_TABLE (§6.1) & guards
│   ├── state-machine.service.ts             # Logic đánh giá chuyển trạng thái post/site & Handshake Lock
│   └── index.ts                             # Public barrel export
├── outbox.service.ts                        # Enqueue outbox với sequence đơn điệu & publishPending post-commit
├── dispatch.service.ts                      # Core apply(tx, event), applyWithRetry, canStartBreak, getStateSnapshot
├── state.controller.ts                      # REST Endpoints: GET /state/snapshot, POST /state/break/start, POST /state/events
└── dispatch.module.ts                       # NestJS Module đăng ký providers, controller & exports

apps/api/
├── src/app.module.ts                        # Đăng ký DispatchModule vào App Monolith
└── test/
    ├── m4-state-machine-table.spec.ts       # Table-driven unit tests, matrix rejection & 97.14% branch coverage
    └── m4-acceptance.spec.ts                # Acceptance integration tests với PostgreSQL thực tế
```

---

## 3. Bảng Ma Trận Chuyển Trạng Thái (§6.1 Triển khai)

| From Status | Event Trigger | Guard Điều kiện | To Status | Tác vụ & Outbox Topic |
|---|---|---|---|---|
| `NOT_ACTIVE` | `SHIFT_START` | Vị trí hoạt động trong ca (`postActive`) | `VACANT_ALERT` | Mở chỉ tiêu trực ca; chờ check-in; outbox `post.state_changed` |
| `VACANT_ALERT` | `CHECKIN_ACCEPTED` | Bảo vệ hợp lệ (`guardId`, `legalGuardOk`) | `OCCUPIED` | Đóng incident trống ca; gán `guard_id`; outbox `post.state_changed` |
| `OCCUPIED` | `MEAL_WINDOW_OPEN` | Có kế hoạch ăn ca (`breakPlanExists`) | `HANDOVER_PENDING` | Khóa nút nghỉ ăn của bảo vệ gốc; phát lệnh `MEAL_RELIEF` cho float; đặt `deadline_at` bàn giao |
| `HANDOVER_PENDING` | `FLOAT_CHECKIN` | Đúng float theo lịch (`plannedFloatId`) | `RELIEVED_FOR_MEAL` | Mở khóa nghỉ ăn cho bảo vệ gốc; đặt `deadline_at` kết thúc slot ăn |
| `HANDOVER_PENDING` | `HANDOVER_TIMEOUT` | Quá hạn bàn giao (`now >= deadline_at`) | `VACANT_ALERT` | Kích hoạt cascade `fillVacancy(post)` |
| `RELIEVED_FOR_MEAL` | `ORIGINAL_BACK` | Bảo vệ gốc hoàn thành ăn ca check-in lại | `OCCUPIED` | Giải phóng float về pool; đặt `break_plans.status = 'DONE'` |
| `RELIEVED_FOR_MEAL` | `MEAL_OVERRUN` | Quá hạn ăn ca + dung sai | `RELIEVED_FOR_MEAL` | Cảnh báo quá hạn (self-transition); mở LOW incident; float giữ vị trí |
| `OCCUPIED` | `PRESENCE_UNCERTAIN` | Mất GPS / ngoài geofence qua bộ lọc | `UNCERTAIN` | Đẩy QR challenge push; đặt `deadline_at` leo thang (120s Tier 1 / 900s Tier 2) |
| `UNCERTAIN` | `QR_CONFIRMED` | Nonce hợp lệ (`nonceValid: true`) | `OCCUPIED` | Xóa cảnh báo hiện diện, bảo vệ tiếp tục ca |
| `UNCERTAIN` | `ESCALATE_TIMEOUT` | Hết hạn giải trình (Tier 1: 120s / Tier 2: 900s) | `VACANT_ALERT` | Kích hoạt `fillVacancy(post)`; lên lịch xử lý vi phạm |
| `OCCUPIED` | `ABSENCE_REPORTED` | Báo ốm / rời ca đột xuất | `VACANT_ALERT` | Kích hoạt `fillVacancy(post)` |
| `VACANT_ALERT` | `REPLACEMENT_ASSIGNED` | Bảo vệ thay thế đạt LegalGuard | `VACANT_ALERT` | Giữ trạng thái chờ check-in; cấp lệnh điều động |
| `VACANT_ALERT` | `ACCEPT_PLANNED_GAP` | **Chỉ áp dụng Tier 2** (Tier 1 cấm tuyệt đối) | `VACANT_PLANNED` | Chấp nhận khuyết vị trí có chủ đích; ghi nhận rủi ro |
| `VACANT_ALERT` | `MERGE_WITH_PAIR` | **Chỉ áp dụng Tier 2**, vị trí cặp `OCCUPIED` | `COVERED_BY_PAIR` | Lệnh gộp vị trí sang bảo vệ kế bên |
| `VACANT_PLANNED` | `CHECKIN_ACCEPTED` | Bảo vệ thay thế check-in | `OCCUPIED` | Vị trí có người trực |
| `COVERED_BY_PAIR` | `CHECKIN_ACCEPTED` | Bảo vệ thay thế check-in | `OCCUPIED` | Hủy gộp cặp, vị trí có người trực riêng |
| `VACANT_PLANNED` | `REPLACEMENT_ASSIGNED` | Đã tìm được người thay thế | `VACANT_ALERT` | Chờ bảo vệ thay thế đến check-in |
| `COVERED_BY_PAIR` | `REPLACEMENT_ASSIGNED` | Đã tìm được người thay thế | `VACANT_ALERT` | Chờ bảo vệ thay thế đến check-in |
| *(Tất cả trừ NOT_ACTIVE)* | `SHIFT_END` | Kết thúc ca làm việc | `NOT_ACTIVE` | Xóa vị trí trực, xóa deadline, chờ ca kế tiếp |

---

## 4. Báo Cáo Kết Quả Kiểm Thử Thực Tế

### 4.1 Kết quả chạy kiểm thử toàn bộ dự án (`npm test`)

```
 RUN  v2.1.9 /home/grey/Projects/Security Workforce Management System

 ✓ apps/api/test/m4-state-machine-table.spec.ts (69 tests)
 ✓ apps/api/test/m4-acceptance.spec.ts (13 tests)
 ✓ apps/api/test/m3-acceptance.spec.ts (15 tests)
 ✓ apps/api/test/m3-staffing-unit.spec.ts (6 tests)
 ✓ apps/api/test/m2-acceptance.spec.ts (3 tests)
 ✓ apps/api/test/m2-clock-config-audit.spec.ts (9 tests)
 ✓ apps/api/test/m1-acceptance.spec.ts (4 tests)
 ✓ apps/api/test/m1-auth-crud.spec.ts (11 tests)

 Test Files  8 passed (8)
      Tests  130 passed (130)
   Duration  5.13s
```
**Tổng số: 130/130 tests PASS (100%).**

### 4.2 Chi tiết kiểm thử nghiệm thu M4 ([`m4-acceptance.spec.ts`](file:///home/grey/Projects/Security%20Workforce%20Management%20System/apps/api/test/m4-acceptance.spec.ts))

| Nhóm kiểm thử | Trường hợp kiểm thử | Kết quả | Ghi chú |
|---|---|:---:|---|
| **1. DB Lifecycle** | Vòng đời hoàn chỉnh Tier 1: `NOT_ACTIVE` $\to$ `VACANT_ALERT` $\to$ `OCCUPIED` $\to$ `HANDOVER_PENDING` $\to$ `RELIEVED_FOR_MEAL` $\to$ `OCCUPIED` $\to$ `UNCERTAIN` $\to$ `OCCUPIED` $\to$ `VACANT_ALERT` $\to$ `NOT_ACTIVE` | **PASS** | Kiểm tra chính xác trạng thái và phiên bản tăng dần trong PostgreSQL |
| **2. Idempotent Replay** | Chạy lại `apply` với cùng `idem_key` | **PASS** | Trả về `isReplay: true`, không tăng version, không ghi thêm bản ghi `state_events` |
| **3. Optimistic Lock** | Bắt lỗi `OptimisticLockError` khi sai version | **PASS** | Kiểm tra câu truy vấn cập nhật 0 dòng do lệch phiên bản |
| **3. Concurrency Retry** | Thử lại tự động qua `applyWithRetry` | **PASS** | Tự động đọc lại phiên bản mới và hoàn thành thành công |
| **4. Tier 1 Invariant** | Cấm `ACCEPT_PLANNED_GAP` trên vị trí Tier 1 (`G1`) | **PASS** | Bị từ chối với `Tier1InvariantError` |
| **4. Tier 1 Invariant** | Cấm `MERGE_WITH_PAIR` trên vị trí Tier 1 (`G4`) | **PASS** | Bị từ chối với `Tier1InvariantError` |
| **4. Tier 2 Allowance** | Cho phép `ACCEPT_PLANNED_GAP` trên Tier 2 (`G2`) | **PASS** | Chuyển dịch thành công sang `VACANT_PLANNED` |
| **4. Tier 2 Allowance** | Cho phép `MERGE_WITH_PAIR` trên Tier 2 (`P2` ghép `P3`) | **PASS** | Chuyển dịch thành công sang `COVERED_BY_PAIR` khi `P3` là `OCCUPIED` |
| **5. Outbox Monotonic** | Chuỗi `seq` trong bảng outbox tăng đơn điệu | **PASS** | Khai thác PostgreSQL sequence `site_event_seq`, phong bì WS chuẩn `v:1` |
| **6. REST Snapshot** | `GET /state/snapshot` | **PASS** | Trả về đủ 14 vị trí, mode hiện trường và sequence cuối |
| **6. Handshake Lock** | `POST /state/break/start` | **PASS** | Chặn HTTP 400 khi chưa có float; chấp thuận HTTP 201 khi `RELIEVED_FOR_MEAL` |
| **6. Event Endpoint** | `POST /state/events` | **PASS** | Thực hiện chuyển trạng thái qua API có bảo vệ RBAC |
| **7. Emergency Mode** | `FIRE_ALARM` $\to$ đình chỉ per-post $\to$ `EMERGENCY_CLEARED` | **PASS** | Đình chỉ chuyển dịch per-post trong khẩn cấp; phục hồi khi an toàn |

### 4.3 Kết quả đo lường độ phủ kiểm thử (Coverage Report trên `state-machine/`)

```
-------------------|---------|----------|---------|---------|-------------------
File               | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s 
-------------------|---------|----------|---------|---------|-------------------
 .../state-machine |     100 |    97.14 |     100 |     100 |                   
  index.ts         |     100 |      100 |     100 |     100 |                   
  ...tion.error.ts |     100 |      100 |     100 |     100 |                   
  ...lock.error.ts |     100 |      100 |     100 |     100 |                   
  ...ne.service.ts |     100 |    98.11 |     100 |     100 |                   
  ...iant.error.ts |     100 |      100 |     100 |     100 |                   
  transitions.ts   |     100 |    96.42 |     100 |     100 |                   
-------------------|---------|----------|---------|---------|-------------------
```
> **Độ phủ nhánh (Branch Coverage) đạt 97.14%** (vượt chỉ tiêu $\ge 95\%$ đề ra trong tiêu chí nghiệm thu của spec §14).  
> **Độ phủ câu lệnh (Statements) & dòng lệnh (Lines) đạt 100%**.

### 4.4 Kiểm tra chất lượng mã nguồn (Typecheck & Lint)

- `npm run typecheck`: **PASS** (100% sạch trên cả 2 workspaces `@swms/contracts` và `@swms/api`).
- `npm run lint`: **PASS** (100% sạch, không vi phạm ESLint rule).

---

## 5. Danh Mục Công Việc Chưa Thực Hiện / Thuộc Milestone Tiếp Theo

1. **Milestone M5 – LegalGuard + Meal Planner (§7, §9)**:
   - Thuật toán sắp lịch ăn ca thuần túy `planMealRelief` (hỗ trợ 2 floats luân phiên 7 vị trí Tier 1 theo golden order).
   - Kiểm tra ranh giới pháp lý lao động thuần túy `LegalGuard.check`: nghỉ tối thiểu 12h giữa 2 ca, giới hạn 6 ngày làm việc/tuần, giới hạn giờ OT tháng/năm, kiểm tra chứng chỉ hành nghề còn hạn.
   - Lưu trữ `break_plans` và khởi tạo các pg-boss timer kích hoạt sự kiện `MEAL_WINDOW_OPEN`.
2. **Milestone M6 – Dispatch Engine & Concurrency Serialization (§8)**:
   - Serialization theo từng ca với advisory transaction lock `pg_advisory_xact_lock`.
   - Cascade điều động 6 cấp độ `fillVacancy(post)` (từ Float Tier 1 $\to$ Float Gen $\to$ Kéo Tier 2 $\to$ Supervisor $\to$ Gọi ca ngoài $\to$ Escalate).
   - Kiểm thử chạy đua `npm run test:race` (1.000 vòng lặp đồng thời).
3. **Milestone M7 – Attendance & Presence Detection (§10)**:
   - Cặp xác thực hai yếu tố QR Nonce + Geofence GPS.
   - Bộ lọc rung nhiễu GPS (5-sample median filter + 3 consecutive outside readings).
   - Quy trình leo thang 2 giai đoạn: gửi QR challenge push $\to$ 120s timeout $\to$ chuyển `VACANT_ALERT`.

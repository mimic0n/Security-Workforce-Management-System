# Báo Cáo Nghiệm Thu Milestone M5: LegalGuard & Meal Planner

> **Dự án**: Security Workforce Management System (SWMS) — AEON Mall Thanh Khê, Floor 1  
> **Milestone**: M5 — LegalGuard + Meal Planner (§7, §9, §14)  
> **Thời gian thực hiện**: 2026-10-23  
> **Trạng thái**: Hoàn thành (PASS 100%, 177/177 unit & integration tests)

---

## 1. Mục Tiêu & Phạm Vi Milestone M5

Milestone M5 chịu trách nhiệm xây dựng tầng nghiệp vụ thuần (pure functions) và tầng tích hợp cơ sở dữ liệu cho hai thành phần cốt lõi:
1. **Meal-relief Planner (§7)**: Lập kế hoạch nghỉ ăn cho các vị trí trực Tier 1 (7 vị trí cố định) sử dụng các nhân viên cơ động hỗ trợ (`FLOAT` với `float_kind = 'TIER1_RELIEF'`), đảm bảo nguyên tắc Zero-Vacancy, bàn giao luân phiên, không trùng lịch, đúng ma trận di chuyển.
2. **`break_plans` Persistence & Slot Jobs (§7)**: Lưu trữ lịch nghỉ ăn vào bảng PostgreSQL `break_plans` (kiểu `tstzrange`), tự động lập lịch công việc đếm giờ thông qua `ScheduledJobsService` (tích hợp `Clock` / `VirtualClock`) để bắn sự kiện `MEAL_WINDOW_OPEN` tại thời điểm `slot.start - handoverBufferMin`.
3. **LegalGuard (§9)**: Kiểm soát tuân thủ Bộ luật Lao động 2019 và Nghị định 145/2020:
   - Nghỉ giữa ca tối thiểu 12 giờ (`legal.min_rest_hours`).
   - Tối đa 6 ngày làm việc trong tuần ISO (`legal.max_work_days_week`).
   - Giới hạn giờ làm thêm tháng (40 giờ / 2400 phút) và năm (200 giờ / 12000 phút).
   - Kiểm tra hiệu lực chứng chỉ bảo vệ (`certifications.expires_on`).
   - Kiểm tra chống trùng lịch (Double booking).
   - Hàm trợ giúp ước tính chi phí phụ trội (ca đêm ×1.3, làm thêm ngày ×1.5, làm thêm đêm ×2.0).

---

## 2. Danh Sách File Tạo Mới & Chỉnh Sửa

### 2.1 Contracts (`packages/contracts`)
- [`packages/contracts/src/meal-planner.ts`](file:///home/grey/Projects/Security%20Workforce%20Management%20System/packages/contracts/src/meal-planner.ts): Khai báo Zod schemas và kiểu dữ liệu `MealReliefPlanInput`, `MealReliefSlot`, `MealReliefPlanResult`, `BreakPlanRecord`, `MealReliefSuggestionEnum`.
- [`packages/contracts/src/legal-guard.ts`](file:///home/grey/Projects/Security%20Workforce%20Management%20System/packages/contracts/src/legal-guard.ts): Khai báo Zod schemas và kiểu dữ liệu `CandidateAssignment`, `LegalGuardResult`, `CostEstimateResult`, `LegalViolationCodeEnum`.
- [`packages/contracts/src/index.ts`](file:///home/grey/Projects/Security%20Workforce%20Management%20System/packages/contracts/src/index.ts): Export các hợp đồng meal-planner và legal-guard.

### 2.2 Tầng Nghiệp Vụ API (`apps/api/src/modules/dispatch`)
- [`apps/api/src/modules/dispatch/meal-planner/plan.ts`](file:///home/grey/Projects/Security%20Workforce%20Management%20System/apps/api/src/modules/dispatch/meal-planner/plan.ts): Hàm thuần `planMealRelief` tính toán thuật toán chia ca nghỉ so le, tính sẵn sàng của float và đề xuất khi thiếu quân số.
- [`apps/api/src/modules/dispatch/meal-planner/validate.ts`](file:///home/grey/Projects/Security%20Workforce%20Management%20System/apps/api/src/modules/dispatch/meal-planner/validate.ts): Hàm thuần `validatePlan` thẩm định kế hoạch nghỉ ăn so với khung giờ, khoảng cách di chuyển, đệm bàn giao, độ dài tối thiểu, biên ca.
- [`apps/api/src/modules/dispatch/meal-planner/meal-planner.service.ts`](file:///home/grey/Projects/Security%20Workforce%20Management%20System/apps/api/src/modules/dispatch/meal-planner/meal-planner.service.ts): Service tích hợp PostgreSQL (`break_plans`), `ConfigService`, `ScheduledJobsService`, lập lịch slot jobs và xử lý tái lập kế hoạch (`replan`).
- [`apps/api/src/modules/dispatch/meal-planner/index.ts`](file:///home/grey/Projects/Security%20Workforce%20Management%20System/apps/api/src/modules/dispatch/meal-planner/index.ts): Module index re-export các tiện ích meal planner.
- [`apps/api/src/modules/dispatch/legal-guard/rules.ts`](file:///home/grey/Projects/Security%20Workforce%20Management%20System/apps/api/src/modules/dispatch/legal-guard/rules.ts): Bộ hàm kiểm tra biên luật thuần túy (`checkMinRest`, `checkMaxWorkDays`, `checkOtCaps`, `checkCertificates`, `checkDoubleBooking`, `estimateAssignmentCost`, `validateLegalAssignment`).
- [`apps/api/src/modules/dispatch/legal-guard/legal-guard.service.ts`](file:///home/grey/Projects/Security%20Workforce%20Management%20System/apps/api/src/modules/dispatch/legal-guard/legal-guard.service.ts): Service truy vấn DB, đọc cấu hình chính sách từ `ConfigService` và xác thực nhân sự thực tế.
- [`apps/api/src/modules/dispatch/legal-guard/legal-guard.controller.ts`](file:///home/grey/Projects/Security%20Workforce%20Management%20System/apps/api/src/modules/dispatch/legal-guard/legal-guard.controller.ts): REST API `POST /dispatch/legal-guard/validate` & `POST /dispatch/legal-guard/cost`.
- [`apps/api/src/modules/dispatch/break-plans.controller.ts`](file:///home/grey/Projects/Security%20Workforce%20Management%20System/apps/api/src/modules/dispatch/break-plans.controller.ts): REST API `GET /break-plans?shift=...`, `POST /break-plans/generate`, `POST /break-plans/replan`.
- [`apps/api/src/modules/dispatch/dispatch.module.ts`](file:///home/grey/Projects/Security%20Workforce%20Management%20System/apps/api/src/modules/dispatch/dispatch.module.ts): Đăng ký các controller và service mới vào DI container.

### 2.3 Tài Liệu & Nhật Ký Giả Định
- [`docs/OPEN_QUESTIONS.md`](file:///home/grey/Projects/Security%20Workforce%20Management%20System/docs/OPEN_QUESTIONS.md): Ghi nhận các giả định mục §2.10 liên quan đến giới hạn quân số float theo ca, cơ chế tính giờ OT lũy kế, và việc kích hoạt job hẹn giờ.

---

## 3. Bộ Kiểm Thử Nghiệm Thu & Kết Quả Chi Tiết

Đã xây dựng 3 bộ kiểm thử độc lập tương ứng với các tiêu chí nghiệm thu của Milestone M5:

### 3.1 `apps/api/test/m5-meal-planner-golden.spec.ts` (8 tests — PASS)
- **Golden Test 1**: `validatePlan(sourceDocPlan)` trả về `feasible: true` đối với lịch tài liệu mẫu:
  - G1/A 10:00–10:30, P1/B 10:20–10:50, G4/A 10:45–11:15, P6/B 11:05–11:35, G5/A 11:30–12:00, P7/B 11:50–12:20, P8/A 12:15–12:45.
- **Golden Test 2**: `planMealRelief` với 2 floats và ma trận di chuyển mặc định:
  - Phủ đủ 7 vị trí Tier 1 trong khoảng 10:00–12:45.
  - Phân bổ luân phiên Float A (4 slot) và Float B (3 slot), không vi phạm thời gian đệm và di chuyển.
- **Golden Test 3**: `planMealRelief` với 1 float:
  - Trả về `feasible: false` (tổng thời gian 210 min vượt khung 165 min).
  - Trả về đầy đủ 3 đề xuất giải pháp: `EXTEND_WINDOW`, `USE_TIER2_RELIEF`, `CALL_IN_EXTRA_GUARD`.
- **Re-plan Test**: Tái lập kế hoạch khi 1 float vắng mặt (kịch bản A1) trả về các giải pháp gợi ý.
- **Edge Rule Tests**: Kiểm tra bắt lỗi khi slot trùng nhau cho cùng một float, vi phạm quy định loại trừ biên ca (Decree 145/2020), thời lượng không đủ 30 phút, hoặc float không hợp lệ.

### 3.2 `apps/api/test/m5-legal-guard-boundary.spec.ts` (27 tests — PASS)
- **Min Rest Boundary**:
  - 11 giờ 59 phút nghỉ: BỊ TỪ CHỐI (`MIN_REST_HOURS_VIOLATED`).
  - 12 giờ 00 phút nghỉ: ĐƯỢC CHẤP THUẬN.
  - Xoay ca chiều 14–22h sang sáng 06–14h hôm sau (8h nghỉ): BỊ TỪ CHỐI.
  - Xoay ca đêm 22–06h sang chiều 14–22h (8h nghỉ): BỊ TỪ CHỐI.
  - Xoay ca đêm 22–06h sang sáng 06–14h (0h nghỉ / trùng ca): BỊ TỪ CHỐI.
- **Weekly Days Boundary**:
  - 6 ngày làm việc riêng biệt trong tuần ISO: ĐƯỢC CHẤP THUẬN.
  - Ngày thứ 7 riêng biệt trong tuần ISO: BỊ TỪ CHỐI (`MAX_WORK_DAYS_WEEK_EXCEEDED`).
- **Overtime Caps Boundary**:
  - Đúng hạn mức tháng 2400 phút (40h): ĐƯỢC CHẤP THUẬN.
  - Vượt hạn mức 2401 phút: BỊ TỪ CHỐI (`MONTHLY_OT_CAP_EXCEEDED`).
  - Đúng hạn mức năm 12000 phút (200h): ĐƯỢC CHẤP THUẬN.
  - Vượt hạn mức 12001 phút: BỊ TỪ CHỐI (`YEARLY_OT_CAP_EXCEEDED`).
- **Certificate Validity**:
  - Chứng chỉ hết hạn 1 ngày trước ca: BỊ TỪ CHỐI (`CERTIFICATE_EXPIRED`).
  - Chứng chỉ còn hạn trong ngày làm: ĐƯỢC CHẤP THUẬN.
- **Double Booking**:
  - 2 ca liền kề sát mép (tiếp giáp lúc 14:00): ĐƯỢC CHẤP THUẬN.
  - Trùng 1 phút (13:59 vs 14:00): BỊ TỪ CHỐI (`DOUBLE_BOOKING`).
- **Cost Estimation**:
  - Ca ngày: hệ số 1.0.
  - Ca đêm (22:00–06:00): hệ số 1.3.
  - Làm thêm ngày: hệ số 1.5.
  - Làm thêm đêm: hệ số 2.0.

### 3.3 `apps/api/test/m5-acceptance.spec.ts` (9 tests — PASS)
- **Database Persistence**: Lưu bảng phân ca vào `break_plans` (kiểu dữ liệu PostgreSQL `tstzrange`), trạng thái `PLANNED`.
- **Scheduled Slot Jobs**: Cài đặt timer qua `ScheduledJobsService`. Khi `VirtualClock` nhảy đến thời điểm `09:55:00` (10:00 trừ 5 phút đệm bàn giao), job tự động chạy `DispatchService.applyWithRetry()` kích hoạt chuyển trạng thái vị trí G1 từ `OCCUPIED` sang `HANDOVER_PENDING`, đồng thời ghi outbox monotonic.
- **Tái lập lịch (Re-plan API)**: Gọi `POST /break-plans/replan` khi 1 float báo ốm → trả về `feasible: false`, đề xuất điều động và tạo bản ghi vào `staffing_requests`.
- **DB-backed Validation**: Kiểm tra thực tế trên cơ sở dữ liệu Postgres: bảo vệ hợp lệ được duyệt; bảo vệ có chứng chỉ hết hạn cố ý (seed data) bị từ chối; bảo vệ bị trùng ca bị chặn bởi `LegalGuardService`.
- **REST Contracts**: Kiểm tra hợp đồng API `POST /dispatch/legal-guard/validate`, `POST /dispatch/legal-guard/cost`, `POST /break-plans/generate`, `GET /break-plans`.

---

## 4. Kết Quả Chạy Lệnh Nghiệm Thu

| Lệnh | Kết Quả Thực Tế | Ghi Chú |
|---|---|---|
| `npm run typecheck` | **PASS (code 0)** | Strict mode TypeScript qua toàn bộ monorepo (`@swms/contracts`, `@swms/api`) |
| `npm run lint` | **PASS (code 0)** | ESLint không có cảnh báo. Đảm bảo quy tắc cấm `Date.now()`, `new Date()`, `setTimeout` trong business code |
| `npm test` | **PASS (code 0)** | **11/11 test files, 177/177 tests pass** |
| `Code Coverage` | **PASS (≥ 90%)** | `meal-planner`: **94.18%**, `legal-guard`: **92.62%** (vượt ngưỡng yêu cầu 90% ở §16) |

---

## 5. Các Hạng Mục Tiếp Theo (Chưa Thực Hiện Ngoài Phạm Vi M5)

1. **M6 – Dispatch Engine & Concurrency (§8)**: Xử lý hàng đợi tập trung per-shift, advisory lock `pg_advisory_xact_lock`, thuật toán cascade bù đắp vị trí trống theo thứ tự ưu tiên, kiểm thử tải `test:race` 1000 rounds.
2. **M7 – Attendance & Presence (§10)**: Quét QR HMAC, vị trí GPS và bộ lọc chống rung (debounce filter), phát hiện di chuyển phi lý (`IMPOSSIBLE_TRAVEL`).
3. **M8 – Realtime & Dashboards (§11, §15)**: WebSocket gateway Socket.IO, bản đồ SVG sàn F1, Mobile PWA cho nhân viên bảo vệ.
4. **M9 – Simulation Harness (§13)**: Bộ giả lập chạy 8 kịch bản (A1, A2, B1, C1, C2, C3, D1, D2).
5. **M10 – Roster Generation**: Bộ sinh lịch xoay ca 4 tuần.
6. **M11 – Báo cáo, KPI & Hardening**.

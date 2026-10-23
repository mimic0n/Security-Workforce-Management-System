# Báo Cáo Nghiệm Thu Milestone M6: Dispatch Engine & Concurrency Serialization

> **Dự án**: Security Workforce Management System (SWMS)  
> **Địa điểm mô phỏng**: AEON Mall Thanh Khê, Tầng 1 (Đà Nẵng, Việt Nam)  
> **Milestone**: M6 – Động cơ điều phối (Dispatch Engine), Tuần tự hóa đồng thời (§8 Concurrency), Phân bổ 6 bước Cascade (§8.2), Xếp hạng ứng viên đa tiêu chí (§8.2), Vòng đời lệnh điều phối (Orders Lifecycle §11) & Báo cáo vắng mặt (Absences API §12)  
> **Tham chiếu tài liệu**: `docs/SWMS_BUILD_SPEC.md §8, §11, §12, §14`  
> **Hard Rules tuân thủ**: `AGENTS.md` Rules #1, #2, #3, #4, #5, #6, #7, #8, #9, #10  

---

## 1. Mục tiêu & Phạm vi Milestone M6

Milestone M6 hiện thực hóa động cơ điều phối thông minh trung tâm của SWMS, giải quyết bài toán cốt lõi của đề tài: **thiếu hụt nhân lực (45 bảo vệ so với định biên ≈60)** và **bảo vệ tuyệt đối bất biến Zero-Vacancy trên 7 vị trí Tier 1 (`G1, G4, G5, P1, P6, P7, P8`)** dưới các áp lực đồng thời khắc nghiệt:

1. **Tuần tự hóa đồng thời theo ca trực (Per-Shift Concurrency Serialization §8.1)**:
   - Nghiêm cấm sử dụng `SKIP LOCKED` cho điều phối (vì đảo lộn thứ tự ưu tiên).
   - Mọi quyết định điều phối trong một ca trực phải được tuần tự hóa thông qua khóa giao dịch PostgreSQL:
     ```sql
     SELECT pg_advisory_xact_lock(hashtextextended('<site>:<shiftKey>', 0));
     ```
   - Tự động bắt và retry (tối đa 3 lần) khi gặp lỗi serialization / deadlock (`40001`, `40P01`).
2. **Hàng đợi xả và phân loại theo độ ưu tiên (Drain-and-Sort Priority Queue §8.1)**:
   - Khi có nhiều sự kiện phát sinh đồng thời (ví dụ: Kịch bản A1 có 3 bảo vệ báo ốm cùng lúc 07:30 sáng Thứ Bảy), các tác vụ được lưu vào `dispatch_tasks` và sắp xếp xử lý nghiêm ngặt theo thứ tự ưu tiên:
     $$\text{EMERGENCY (0)} > \text{TIER1\_VACANCY (1)} > \text{MEAL (2)} > \text{TIER2\_VACANCY (3)} > \text{OTHER (4)}$$
3. **Thuật toán Cascade 6 bước lấp chỗ trống cho vị trí Tier 1 (§8.2)**:
   - **Bước 1**: Tiếp viên cơ động chuyên trách Tier 1 rảnh việc (`FLOAT_T1` / `TIER1_RELIEF`).
   - **Bước 2**: Tiếp viên cơ động chung rảnh việc (`FLOAT_GEN` / `GENERAL`).
   - **Bước 3**: Kéo bảo vệ từ vị trí Tier 2 (`TIER2_PULL`), với điều kiện vị trí nguồn có phương án an toàn:
     - Ghép cặp với vị trí đối ứng đang có người (`COVERED_BY_PAIR`), hoặc
     - Chấp nhận khoảng trống kế hoạch trong giới hạn cho phép (`VACANT_PLANNED` với `max_vacant_sec = 900s`).
   - **Bước 4**: Giám sát ca trực (`SUPERVISOR`) lấp chỗ khẩn cấp nếu rảnh việc.
   - **Bước 5**: Gọi bảo vệ ngoài ca làm thêm (`EARLY_CALL_IN` ca sau hoặc `STAY_OVER` ca trước), bắt buộc kiểm duyệt qua [`LegalGuardService`](file:///home/grey/Projects/Security%20Workforce%20Management%20System/apps/api/src/modules/dispatch/legal-guard/legal-guard.service.ts) (nghỉ tối thiểu 12h, không vượt trần OT tháng/năm, chứng chỉ bảo vệ hợp lệ) kèm dự toán chi phí.
   - **Bước 6**: Leo thang cho điều phối viên nhân sự (`ESCALATE_DISPATCHER`).
4. **Hàm xếp hạng ứng viên đa tiêu chí (Candidate Ranking §8.2)**:
   - Điểm số ưu tiên:
     $$\text{score} = w_{\text{distance}} \cdot \text{travel\_min} + w_{\text{ot}} \cdot \frac{\text{ot\_minutes\_month}}{60} + w_{\text{load}} \cdot \text{dispatches\_today}$$
   - Trọng số $w$ được cấu hình động từ DB table `policies` (`dispatch.rank_weights`), mặc định `{ distance: 1.0, ot: 2.0, load: 1.5 }`.
   - Ứng viên có điểm thấp hơn được ưu tiên; trường hợp bằng điểm giải quyết dứt khoát bằng `guard.id ASC`.
5. **Cấu trúc giải trình chi tiết (Explain Structure §8.2, §11)**:
   - Mỗi lệnh điều phối và phân bổ đều ghi nhận đầy đủ: người thắng cuộc (`winner`), danh sách ứng viên bị loại kèm lý do (`rejected: [{ guardId, reason, score }]`), và các bước hành động (`actions`).
6. **Vòng đời lệnh điều phối & Tự động hết hạn (Orders Lifecycle §11, §12)**:
   - Quản lý trạng thái: `PROPOSED`, `SENT`, `ACKED`, `DECLINED`, `EXPIRED`, `CANCELLED`.
   - Xác nhận (`POST /dispatch/orders/:id/ack`): bảo vệ nhận lệnh, tự động gán vị trí (`OCCUPIED`) và tạo assignment trong cùng transaction.
   - Từ chối (`POST /dispatch/orders/:id/decline`): chuyển `DECLINED`, tự động kích hoạt điều phối ứng viên kế tiếp.
   - Hết hạn (`checkExpiredOrders`): quét lệnh `SENT` quá thời gian chờ phản hồi `dispatch.ack_timeout_sec` (mặc định 60s), chuyển `EXPIRED` và kích hoạt re-fill.
   - Can thiệp thủ công (`POST /dispatch/override`): điều phối viên can thiệp chỉ định bảo vệ.
7. **Báo cáo vắng mặt (Absences API §12)**:
   - `POST /absences` hỗ trợ header `Idempotency-Key` (hoặc body `idemKey`), hủy bỏ assignment của bảo vệ, chuyển post sang `VACANT_ALERT` (với vị trí cố định) hoặc kích hoạt re-plan ăn ca (với float), và đưa tác vụ vào hàng đợi ưu tiên.
8. **Kiểm thử bất biến đồng thời & Race condition (`test:race`)**:
   - 1,000 vòng lặp kịch bản A1 vắng mặt đồng thời 3 vị trí với thứ tự ngẫu nhiên.
   - Đảm bảo không trùng lịch (`EXCLUDE USING gist`), vị trí Tier 1 luôn xử lý trước Tier 2, và khôi phục sự cố (crash recovery) có tính lũy kế (idempotent).

---

## 2. Danh Sách Tệp Triển Khai & Cập Nhật

```
packages/contracts/src/
├── dispatch.ts                              # Contracts & Zod schemas: DispatchTask, DispatchOrder, DispatchExplain, Absence, DispatchOverride, RankWeights
└── index.ts                                 # Re-export dispatch contracts

db/
├── migrations/
│   ├── 001_initial_schema.sql               # Bổ sung Bảng 24: dispatch_tasks kèm index (site_id, shift_key, status, priority, id)
│   └── 001_initial_schema_down.sql          # Down migration tương ứng
└── seed/
    └── seed.ts                              # Dữ liệu chính sách dispatch.ack_timeout_sec, dispatch.rank_weights

apps/api/src/modules/dispatch/
├── engine/
│   ├── types.ts                             # Kiểu nội bộ: CandidateGuard, CandidateScore, CascadeResult
│   ├── ranking.service.ts                   # Thuật toán tính điểm xếp hạng & truy vấn ma trận post_travel
│   ├── fill-vacancy.service.ts              # Cascade 6 bước cho Tier 1 & Ghép cặp/dung sai cho Tier 2
│   ├── queue.service.ts                     # DispatchQueueService: Khóa advisory xact lock, drain-and-sort theo độ ưu tiên
│   └── handlers/
│       ├── absence.handler.ts               # Xử lý ABSENCE_REPORTED: hủy assignment, kích hoạt fill-vacancy / meal replan
│       └── motion.handler.ts                # Xử lý CAMERA_MOTION (Kịch bản D1): điều bảo vệ on-duty rà soát
├── dispatch.service.ts                      # Vòng đời lệnh ackOrder, declineOrder, expireOrder, overrideDispatch
├── dispatch.controller.ts                   # REST API: GET /dispatch/orders, POST /dispatch/orders/:id/ack, decline, override
├── absences.service.ts                      # Nghiệp vụ tiếp nhận vắng mặt, idempotency replay
├── absences.controller.ts                   # REST API: POST /absences, GET /absences, POST /absences/:id/decision
└── dispatch.module.ts                       # Đăng ký controllers và providers vào NestJS Monolith

apps/api/
├── src/core/database/database.service.ts    # Hỗ trợ constructor nhận custom Pool cho test pools
├── test/
│   ├── m6-dispatch-engine.spec.ts           # 13 tests: xếp hạng, cascade 6 bước, Tier 2 merge/gap, order lifecycle, absences API
│   └── m6-dispatch-race.spec.ts             # 3 tests: 1,000 vòng đồng thời A1, 2 tiến trình độc lập, phục hồi sự cố idempotent
├── vitest.config.ts                         # Cấu hình test singleFork, node environment
└── vitest.setup.ts                          # Tự động gán DATABASE_URL mặc định vào swms_test cho test suite

package.json                                 # Bổ sung script: "test:race": "vitest run race"
docs/
├── OPEN_QUESTIONS.md                        # Ghi nhận các quyết định thiết kế M6 (§2.11)
└── M6_README.md                             # Báo cáo tổng kết nghiệm thu M6
```

---

## 3. Chi Tiết Hiện Thực Kỹ Thuật

### 3.1 Khóa Tuần Tự Hóa Cấp Ca Trực (`pg_advisory_xact_lock`)

Theo quy tắc cứng #5 (`AGENTS.md`) và §8.1, mọi quyết định điều phối trong cùng một ca trực phải được tuần tự hóa:

```typescript
// apps/api/src/modules/dispatch/engine/queue.service.ts
await client.query("BEGIN;");
const lockResource = `${siteId}:${shiftKey}`;
await client.query(
  `SELECT pg_advisory_xact_lock(hashtextextended($1, 0));`,
  [lockResource]
);
```

- Khóa tồn tại cho đến khi kết thúc transaction (`COMMIT` hoặc `ROLLBACK`).
- Các transaction khác cùng truy cập `siteId:shiftKey` sẽ phải chờ theo hàng đợi của database, loại bỏ hoàn toàn race condition hay xung đột phân bổ kép.
- Mạng lưới an toàn cuối cùng ở DB là ràng buộc `EXCLUDE USING gist (guard_id WITH =, period WITH &&)` trên bảng `assignments`.

### 3.2 Hàng Đợi Drain-and-Sort Phân Định Thứ Tự Ưu Tiên

Hàm `drainShiftQueue` truy vấn toàn bộ các task đang ở trạng thái `PENDING` của ca trực, sắp xếp theo độ ưu tiên:

```sql
SELECT id, site_id, shift_key, priority, kind, payload, idem_key 
FROM dispatch_tasks 
WHERE site_id = $1 AND shift_key = $2 AND status = 'PENDING'
ORDER BY priority ASC, id ASC;
```

Khi 3 sự kiện vắng mặt của Kịch bản A1 đến cùng lúc:
1. `G4` (Tier 1) có priority = 1 (`TIER1_VACANCY`)
2. `F01` (Relief Float) có priority = 2 (`MEAL`)
3. `P3` (Tier 2) có priority = 3 (`TIER2_VACANCY`)

Bất kể thứ tự bản ghi đến (arrival order) bị xáo trộn thế nào, `drainShiftQueue` luôn xử lý `G4` trước, sau đó đến `F01`, và cuối cùng là `P3`.

### 3.3 Cascade 6 Bước Lấp Chỗ Trống Tier 1

Triển khai tại [`FillVacancyService.fillVacancy()`](file:///home/grey/Projects/Security%20Workforce%20Management%20System/apps/api/src/modules/dispatch/engine/fill-vacancy.service.ts):
- **Bước 1 (`FLOAT_T1`)**: Truy vấn bảo vệ có vai trò `FLOAT` và `float_kind = 'TIER1_RELIEF'` đang có assignment `ACTIVE` trong ca trực nhưng chưa được gán vào vị trí cố định (`currentPostId IS NULL`).
- **Bước 2 (`FLOAT_GEN`)**: Nếu không có `FLOAT_T1`, lấy tiếp viên cơ động chung `FLOAT_GEN`.
- **Bước 3 (`TIER2_PULL`)**: Lấy danh sách bảo vệ đang trực tại các vị trí Tier 2 (`G2, G3, G6, P2, P3, P4, P5`). Vị trí nguồn phải thỏa mãn một trong hai điều kiện an toàn:
  - Có vị trí ghép cặp đang có người trực (`COVERED_BY_PAIR`), hoặc
  - Cho phép khoảng trống tạm thời (`VACANT_PLANNED` với `max_vacant_sec > 0`). Vị trí nguồn được cập nhật trạng thái tương ứng trong cùng giao dịch.
- **Bước 4 (`SUPERVISOR`)**: Lấy giám sát viên ca trực đang rảnh việc làm giải pháp dự phòng cuối cùng tại chỗ.
- **Bước 5 (`EARLY_CALL_IN`)**: Tìm kiếm bảo vệ đang ngoài ca trực, gọi xác thực qua [`LegalGuardService.validate()`](file:///home/grey/Projects/Security%20Workforce%20Management%20System/apps/api/src/modules/dispatch/legal-guard/legal-guard.service.ts). Ứng viên vi phạm thời gian nghỉ 12h, quá trần OT hoặc hết hạn chứng chỉ bảo vệ bị loại ngay lập tức và ghi nhận vào danh sách `rejected`. Ứng viên đạt yêu cầu được tính toán chi phí dự kiến qua `estimateCost()`. Hệ thống tạo đề xuất `dispatch_orders` dạng `EARLY_CALL_IN` ở trạng thái `SENT`.
- **Bước 6 (`ESCALATE_DISPATCHER`)**: Nếu toàn bộ các bước trên đều không tìm được ứng viên khả thi, tạo cảnh báo khẩn cấp chuyển giao quyền quyết định cho điều phối viên.

### 3.4 Vòng Đời Lệnh Điều Phối & API Vắng Mặt

1. **Xác nhận (`POST /dispatch/orders/:id/ack`)**:
   - Chuyển `dispatch_orders.status = 'ACKED'`.
   - Cập nhật vị trí sang `OCCUPIED`.
   - Ghi nhận `state_events` với nguyên nhân `DISPATCH_ACKED`.
   - Cập nhật hoặc tạo mới `assignments` với nguồn `DISPATCH`.
   - Đưa thông báo `dispatch.acked` vào `outbox`.
2. **Từ chối (`POST /dispatch/orders/:id/decline`)**:
   - Chuyển `dispatch_orders.status = 'DECLINED'`.
   - Tự động enqueue task `FILL_VACANCY` để thử ứng viên tiếp theo.
3. **Quét hết hạn (`checkExpiredOrders`)**:
   - Truy vấn các lệnh `SENT` có `sent_at <= now - dispatch.ack_timeout_sec`.
   - Chuyển thành `EXPIRED` và tự động re-fill.
4. **Báo cáo vắng mặt (`POST /absences`)**:
   - Tiếp nhận báo cáo ốm/vắng đột xuất.
   - Hỗ trợ cơ chế idempotent replay bằng header `Idempotency-Key`.
   - Hủy bỏ ca trực đang phân công, chuyển post sang `VACANT_ALERT` và kích hoạt chuỗi xử lý tự động.

---

## 4. Kết Quả Nghiệm Thu (Acceptance Verification)

Tất cả các tiêu chí nghiệm thu của Milestone M6 đều đã được kiểm tra và đạt kết quả xanh 100%:

### 4.1 Kiểm thử Concurrency & Race Condition (`npm run test:race`)
- **Lệnh chạy**: `npm run test:race`
- **Kết quả**: **PASS (3/3 tests)** trong **34.66s**:
  1. `1,000 rounds of simultaneous A1 absences under randomized drain-and-sort queue`: **PASS** (34.39s)
     - Duyệt qua 1,000 vòng lặp kịch bản A1. Mỗi vòng lặp xáo trộn ngẫu nhiên thứ tự gửi 3 sự kiện vắng mặt (Tier 1 G4, Meal Float F01, Tier 2 P3).
     - **Bất biến 1**: Không có bất kỳ bảo vệ nào bị trùng lịch active assignment (`overlapRes = 0`).
     - **Bất biến 2**: Vị trí Tier 1 (G4) luôn luôn có sự kiện chuyển đổi trạng thái trước vị trí Tier 2 (P3) trong DB (`g4EventIdx < p3EventIdx`).
  2. `Multi-process concurrency: 2 independent API client pools against the same DB`: **PASS**
     - Mô phỏng 2 tiến trình API độc lập với 2 connection pool riêng biệt cùng thực thi đồng thời các tác vụ trên cùng 1 ca trực.
     - Toàn bộ 10 tác vụ hoàn thành đồng thời đạt trạng thái `COMPLETED` mà không xảy ra deadlock.
  3. `Injected failure test: worker crash between steps, restarted task finishes idempotently`: **PASS**
     - Mô phỏng tiến trình bị dừng/crash giữa chừng (giao dịch bị abort). Khi tiến trình phục hồi khởi động lại, tác vụ được retry thành công đến trạng thái `COMPLETED` và các lượt replay tiếp theo được nhận diện chính xác (`isReplay = true`).

### 4.2 Kiểm thử Động cơ Điều phối (`apps/api/test/m6-dispatch-engine.spec.ts`)
- **Lệnh chạy**: `npx vitest run apps/api/test/m6-dispatch-engine.spec.ts`
- **Kết quả**: **PASS (13/13 tests)** trong **2.21s**:
  - `Candidate Ranking Function`: Tính điểm chính xác theo trọng số và giải quyết tie-break theo `guard.id ASC`.
  - `The 6-Step FillVacancy Cascade`: Kiểm thử đầy đủ Step 1 (Float T1), Step 2 (Float Gen), Step 3 (Tier 2 pull kèm cập nhật post nguồn), Step 5 (Early call-in có LegalGuard loại bỏ bảo vệ hết hạn chứng chỉ).
  - `Tier 2 Vacancy Merge & Gap Tolerance`: Ghép cặp vị trí đối ứng (`COVERED_BY_PAIR`) và chấp nhận khoảng trống có deadline (`VACANT_PLANNED`).
  - `Dispatch Orders Lifecycle`: Kiểm thử luồng Ack, Decline (tự động re-fill), Expire (tự động chuyển EXPIRED khi quá 60s), và Override của Dispatcher.
  - `Absence Reporting API`: Báo cáo vắng mặt qua REST API kèm kiểm tra Idempotency-Key.

### 4.3 Kiểm thử Toàn bộ Hệ Thống (`npm test`)
- **Lệnh chạy**: `npm test`
- **Kết quả**: **PASS 100%** (13 test suites, 193/193 tests passed):
  ```
   Test Files  13 passed (13)
        Tests  193 passed (193)
     Start at  22:42:59
     Duration  40.22s
  ```
  Bao gồm toàn bộ các suite từ Milestone M1 đến M6:
  - `m1-acceptance.spec.ts` (4 tests)
  - `m1-auth-crud.spec.ts` (11 tests)
  - `m2-acceptance.spec.ts` (3 tests)
  - `m2-clock-config-audit.spec.ts` (9 tests)
  - `m3-acceptance.spec.ts` (15 tests)
  - `m3-staffing-unit.spec.ts` (6 tests)
  - `m4-acceptance.spec.ts` (16 tests)
  - `m4-state-machine-table.spec.ts` (69 tests)
  - `m5-acceptance.spec.ts` (9 tests)
  - `m5-legal-guard-boundary.spec.ts` (27 tests)
  - `m5-meal-planner-golden.spec.ts` (8 tests)
  - `m6-dispatch-engine.spec.ts` (13 tests)
  - `m6-dispatch-race.spec.ts` (3 tests)

### 4.4 Kiểm tra Định dạng & Kiểu dữ liệu
- `npm run typecheck`: **PASS** (Zero TypeScript errors)
- `npm run lint`: **PASS** (Zero ESLint warnings/errors, tuân thủ nghiêm ngặt Rule #1 không dùng `Date.now()` / `setTimeout` trong business logic)

---

## 5. Danh Sách Việc Chưa Thực Hiện / Bước Kế Tiếp

Milestone M6 đã hoàn thành trọn vẹn toàn bộ các yêu cầu của §8, §11, §12.
Các công việc sẽ triển khai ở các Milestone tiếp theo theo lộ trình `SWMS_BUILD_SPEC.md §14`:
- **Milestone M7 (Incident & Attendance Engine §10)**:
  - Bộ lọc median GPS 5 mẫu + phát hiện ra ngoài ranh giới geofence.
  - Quản lý thử thách QR có giới hạn thời gian (nonce 45s).
  - Bộ hẹn giờ leo thang `UNCERTAIN → VACANT_ALERT` (120s cho Tier 1, 300s cho Tier 2).
  - Tự động ghi nhận sự cố (`incidents`).
- **Milestone M8 (Harness & Scenario Runner §13)**:
  - Bộ giả lập thiết bị mock (`MockGpsStream`, `MockCameraAi`, `MockFireAlarm`).
  - Trình thực thi tự động 8 kịch bản luận văn (A1, A2, B1, C1, C2, C3, D1, D2).

# Báo Cáo Nghiệm Thu Milestone M2: Clock, ConfigService, Audit Log & Policies

> **Dự án**: Security Workforce Management System (SWMS)  
> **Địa điểm mô phỏng**: AEON Mall Thanh Khê, Tầng 1  
> **Milestone**: M2 – Hệ thống Đồng hồ (Clock), Dịch vụ Cấu hình thời gian thực (ConfigService), Kiểm toán (Audit Log) & Quản lý Chính sách (Policies)  
> **Tham chiếu tài liệu**: `docs/SWMS_BUILD_SPEC.md §3, §4, §5, §11, §12, §13.1, §14`

---

## 1. Mục tiêu Milestone M2

Milestone M2 thiết lập hạ tầng cốt lõi cho việc quản lý thời gian mô phỏng, lưu trữ - phân giải cấu hình nghiệp vụ theo dòng thời gian (time-versioning), ghi vết kiểm toán (audit trail), và xử lý tác vụ nền định thời (scheduled jobs).

Các thành phần hoàn thành đảm bảo tuyệt đối các **Hard Rules** của dự án:
1. **Rule #1**: Không sử dụng `Date.now()`, `new Date()`, `setTimeout()`, `setInterval()` trong mã nguồn nghiệp vụ. Tất cả phải thông qua interface `Clock` được inject.
2. **Rule #2**: Không hardcode hằng số nghiệp vụ ($K_{relief}$, số lượng bảo vệ cơ động, thời gian nghỉ ăn, dung sai GPS...). Toàn bộ được lưu trong cơ sở dữ liệu và truy xuất qua `ConfigService` (có cache in-memory và tự động làm mới khi nhận sự kiện `policy.changed`).
3. **Rule #3**: Trạng thái là dữ liệu (State is data, not memory). Timer định thời được lưu trữ và điều phối có kiểm soát.
4. **Rule #6**: Event được đồng bộ qua bảng `outbox` trước khi phát sóng ra ngoài.

---

## 2. Kiến trúc & Các thành phần đã triển khai

```
apps/api/src/
├── core/
│   ├── clock/
│   │   ├── clock.interface.ts     # CLOCK_TOKEN và interface Clock
│   │   ├── real-clock.ts          # Triển khai Clock cho môi trường chạy thực tế
│   │   ├── virtual-clock.ts       # Discrete-event Clock cho môi trường mô phỏng (jumpTo, advance, setSpeed)
│   │   └── clock.module.ts        # Global Module tự động inject Clock tùy thuộc SIM_MODE
│   ├── jobs/
│   │   ├── scheduled-jobs.service.ts # Wrapper xử lý định thời/job nền, tương thích VirtualClock
│   │   └── scheduled-jobs.module.ts
│   ├── audit/
│   │   ├── audit.service.ts       # Ghi vết thay đổi vào bảng audit_log
│   │   └── audit.module.ts
│   └── events/
│       └── event-bus.service.ts   # In-process Event Emitter & lưu trữ outbox
└── modules/
    └── policies/
        ├── config.service.ts      # Đọc time-versioned policies, cache in-memory, hàm tính toán sơ bộ
        ├── policies.service.ts    # Nghiệp vụ cập nhật policy, ghi audit_log, emit policy.changed
        ├── policies.controller.ts # REST API: GET, PUT /policies/:key, POST /policies/preview
        └── policies.module.ts
```

### 2.1 Hệ thống Đồng hồ (Clock Subsystem)
- **`RealClock`**: Dành cho môi trường sản xuất thực tế, đo thời gian thực và lên lịch bằng timer hệ điều hành.
- **`VirtualClock`**: Đồng hồ mô phỏng đơn định (deterministic discrete-event):
  - Quản lý hàng đợi ưu tiên cho các tác vụ được hẹn giờ (`schedule(at, fn, key)`).
  - Phương thức `jumpTo(to: Date)`: Tua thời gian mô phỏng đến mốc tương lai, tuần tự kích hoạt các tác vụ đến hạn theo đúng thứ tự thời gian tăng dần; tại thời điểm mỗi callback thực thi, `clock.now()` luôn phản ánh chính xác mốc thời gian đã lên lịch của tác vụ đó. Hỗ trợ việc callback tự lên lịch thêm các tác vụ con kế tiếp và cho phép hủy bỏ tác vụ (`cancel()`).
  - Phương thức `advance(ms: number)`: Tua nhanh một khoảng thời gian nhất định.
  - Phương thức `setSpeed(x: number)`: Chế độ tăng tốc demo (1 giây thực = $x$ giây hệ thống).

### 2.2 Wrapper Tác vụ Định thời (`ScheduledJobsService`)
- Trong chế độ mô phỏng (`SIM_MODE=true`): Tự động định tuyến các job cần chạy trong tương lai qua `Clock.schedule()`. Khi VirtualClock thực hiện `jumpTo()`, các job được kích hoạt chính xác mà không cần chờ thời gian thực tế.
- Trong môi trường thực tế: Sẵn sàng kết nối với `pg-boss` cho các job bền vững (durable background jobs).

### 2.3 Phân giải Cấu hình theo Thời gian (`ConfigService`)
- **Nguyên lý phân giải**:
  $$\text{valid\_from} \le t_{\text{current}} < \text{valid\_to}$$
  Truy vấn SQL lấy bản ghi có `valid_from` mới nhất:
  ```sql
  SELECT value, valid_from, valid_to
  FROM policies
  WHERE key = $1
    AND valid_from <= $2
    AND (valid_to IS NULL OR valid_to > $2)
  ORDER BY valid_from DESC
  LIMIT 1;
  ```
- **Hết hạn tự nhiên (Zero-Restore-Job)**: Đối với các cấu hình tạm thời (ví dụ: sự kiện điều chỉnh quân số trong 3 ngày như Scenario C3), bản ghi override có giá trị `valid_to` cụ thể. Khi `VirtualClock` nhảy vượt qua `valid_to`, truy vấn tự động trả về cấu hình cơ sở (`valid_to IS NULL`) mà không cần bất kỳ tiến trình nền hay cron job nào phải can thiệp để khôi phục.
- **Cache in-memory**: Bộ đệm lưu trữ danh sách phiên bản của từng policy, tự động vô hiệu hóa (`invalidate`) khi có sự kiện `policy.changed`.

### 2.4 Kiểm toán & Outbox (`AuditService`, `EventBusService`)
- Mọi thao tác cập nhật cấu hình qua `PUT /policies/:key` đều tự động ghi lại bản ghi vào bảng `audit_log`:
  - `actor_id`: ID của người dùng thực hiện (lấy từ JWT qua `@CurrentUser("sub")`).
  - `action`: `'POLICY_UPDATE'`.
  - `entity`: `'policies'`.
  - `before`: Giá trị cấu hình trước khi sửa.
  - `after`: Giá trị cấu hình mới.
  - `at`: Mốc thời gian logic lấy từ `Clock.now()`.
- Phát sinh sự kiện `policy.changed` ghi đồng thời vào bảng `outbox` và bắn qua EventEmitter trong tiến trình để làm mới bộ nhớ đệm.

### 2.5 REST Endpoints & Phân quyền (RBAC)
| Method | Endpoint | RBAC Roles | Mô tả |
|---|---|---|---|
| `GET` | `/policies` | Tất cả roles hợp lệ | Lấy danh sách tất cả policy đang kích hoạt (hỗ trợ `?at=ISO`) |
| `GET` | `/policies/:key` | Tất cả roles hợp lệ | Lấy giá trị policy cụ thể đang kích hoạt (hỗ trợ `?at=ISO`) |
| `PUT` | `/policies/:key` | `ADMIN`, `MANAGER` | Cập nhật/tạo phiên bản policy mới, ghi audit log, bắn event |
| `POST` | `/policies/preview` | `ADMIN`, `HR`, `MANAGER`, `DISPATCHER` | Tính toán thử nghiệm nhu cầu nhân sự dựa trên tham số override mà không lưu DB |

---

## 3. Kết quả Kiểm thử & Tiêu chí Nghiệm thu

Bộ kiểm thử được viết trước theo phương pháp TDD, tập trung kiểm chứng toàn bộ tiêu chuẩn nghiệm thu của Milestone M2 trong `docs/SWMS_BUILD_SPEC.md §14`:

### 3.1 Tiêu chuẩn Nghiệm thu Milestone M2 (Acceptance Criteria)

Tất cả 3/3 tiêu chí nghiệm thu đều vượt qua trong [`apps/api/test/m2-acceptance.spec.ts`](file:///home/grey/Projects/Security Workforce Management System/apps/api/test/m2-acceptance.spec.ts):

1. **Virtual clock jump fires timers in order**:
   - Khởi tạo đồng hồ tại $T_0$.
   - Lên lịch các Timer A (+10s), Timer B (+5s), Timer C (+15s). Trong quá trình chạy, Timer B tiếp tục lên lịch Timer D (+8s). Timer X (+7s) được hẹn giờ rồi bị huỷ ngay sau đó.
   - Khi gọi `clock.jumpTo(T0 + 20s)`, các timer thực thi chính xác theo thứ tự thời gian: B (+5s) $\rightarrow$ D (+8s) $\rightarrow$ A (+10s) $\rightarrow$ C (+15s).
   - Khẳng định giá trị `clock.now()` tại thời điểm mỗi callback chạy khớp tuyệt đối với mốc hẹn giờ của nó. Timer X bị huỷ không chạy.

2. **Policy with `valid_to` expires after a jump**:
   - Cấu hình chuẩn: `headcount.fixed` có MORNING = 14.
   - Chèn cấu hình tạm thời với `valid_from = 2026-11-01` và `valid_to = 2026-11-04` (MORNING = 15).
   - Khi đồng hồ nhảy vào khoảng hiệu lực (`2026-11-02`): `ConfigService` và endpoint `GET /policies/headcount.fixed` trả về giá trị override (15).
   - Khi đồng hồ nhảy vượt mốc hết hạn (`2026-11-05`): `ConfigService` và endpoint `GET /policies/headcount.fixed` tự động trả về giá trị gốc (14) mà không cần tác vụ khôi phục nào.

3. **Changing K via API changes next calc without restart**:
   - Trạng thái ban đầu: $K = 1.35 \implies \text{required} = 60$, $\text{gap} = 15$.
   - Gửi yêu cầu `PUT /policies/relief.k_override` với giá trị $1.40$ kèm token xác thực.
   - Kiểm tra bảng `audit_log` ghi nhận đầy đủ bản ghi (`before: 1.35`, `after: 1.40`).
   - Lần tính toán tiếp theo ngay lập tức nhận $K = 1.40 \implies \text{required} = 62$, $\text{gap} = 17$ mà **không cần khởi động lại ứng dụng**.
   - Kiểm tra `POST /policies/preview` cho phép tính thử nghiệm ($K = 1.50 \implies \text{required} = 66$) mà không làm ảnh hưởng đến cấu hình đã lưu.

### 3.2 Bảng Thống kê Kiểm thử Toàn hệ thống

| Bộ kiểm thử | Số lượng bài test | Trạng thái |
|---|---|---|
| `apps/api/test/m2-acceptance.spec.ts` | 3 |  PASS |
| `apps/api/test/m2-clock-config-audit.spec.ts` | 9 |  PASS |
| `apps/api/test/m1-acceptance.spec.ts` | 4 |  PASS |
| `apps/api/test/m1-auth-crud.spec.ts` | 11 |  PASS |
| **Tổng cộng** | **27 / 27** | ** 100% PASS** |

### 3.3 Lệnh Nghiệm thu Thực tế

```bash
# 1. Kiểm tra tĩnh kiểu dữ liệu TypeScript (Strict mode)
npm run typecheck
# Output: Exit code 0 (No errors)

# 2. Kiểm tra quy tắc Lint và cấm hàm thời gian tự do (Rule #1)
npm run lint
# Output: Exit code 0 (Clean)

# 3. Chạy toàn bộ các bộ test tích hợp và kiểm thử nghiệm thu
npm test
# Output: Test Files  4 passed (4) | Tests 27 passed (27)
```

---

## 4. Các Giả định & Ghi chú Kỹ thuật (Open Questions)

Đã ghi nhận mục **§2.7** trong tài liệu [`docs/OPEN_QUESTIONS.md`](file:///home/grey/Projects/Security Workforce Management System/docs/OPEN_QUESTIONS.md#L55-L66):
- **Phân giải cấu hình có thứ tự**: Mọi truy vấn sử dụng mệnh đề `ORDER BY valid_from DESC LIMIT 1` kết hợp điều kiện `valid_from <= atTime AND (valid_to IS NULL OR valid_to > atTime)` đảm bảo ưu tiên cấu hình ghi đè mới nhất và tự động quay về cấu hình cơ bản khi mốc hết hạn trôi qua.
- **An toàn Concurrency trong kiểm thử DB**: Cấu hình `fileParallelism: false` trong `vitest.config.ts` để các file test tích hợp thao tác với Postgres không bị xung đột seed/migration lẫn nhau.
- **Tuân thủ quy chuẩn mã lỗi HTTP**: Endpoint tính thử nghiệm `POST /policies/preview` trả về mã `200 OK` (thay vì `201 Created` mặc định của NestJS) vì không sinh mới tài nguyên bền vững trong database.

---

## 5. Lịch sử Git Commit

- **Commit**: `92dbd30`
- **Thông điệp**: `feat(config): implement clock, ConfigService, audit log, and policy endpoints (M2)`
- **Số lượng thay đổi**: 23 files changed, 1436 insertions(+), 1 deletion(-).

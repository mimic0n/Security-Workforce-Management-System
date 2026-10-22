# Báo Cáo Nghiệm Thu Milestone M3: Staffing Calculator & Endpoints

> **Dự án**: Security Workforce Management System (SWMS)  
> **Địa điểm mô phỏng**: AEON Mall Thanh Khê, Tầng 1  
> **Milestone**: M3 – Công cụ tính toán định biên (Staffing Calculator), Phân tích độ nhạy (Sensitivity Analysis), Tính toán hệ số cứu trợ theo năm (Derived-K Helper), Quản lý yêu cầu nhân sự (Staffing Requests) & REST Endpoints  
> **Tham chiếu tài liệu**: `docs/SWMS_BUILD_SPEC.md §1, §2, §4, §5, §12, §14, §16`

---

## 1. Mục tiêu Milestone M3

Milestone M3 tập trung xây dựng toàn bộ mô hình toán học và API tính toán định biên quân số bảo vệ cho mục tiêu bảo đảm tuyệt đối **Zero-Vacancy trên các vị trí Tier 1** tại AEON Mall Thanh Khê Tầng 1:
1. **Tính toán định biên per-shift & per-day**: Phân tách nhu cầu nhân sự theo từng ca (Sáng, Chiều, Đêm) và từng vai trò (`FIXED`, `FLOAT_T1`, `FLOAT_GEN`, `SUPERVISOR`).
2. **Xác định hệ số cứu trợ ca & nghỉ bù ($K_{relief}$)**: Tính toán dựa trên chính sách cấu hình thời gian thực (`relief.k_override`, hoặc công thức dựa trên số ngày nghỉ tuần và tỷ lệ nghỉ phép/nghỉ ốm).
3. **Phân tích độ nhạy (Sensitivity Analysis)**: Dự báo nhu cầu nhân sự và độ hụt quân (`gap`) tương ứng với các biến thiên của $K$ (bước nhảy 0.05).
4. **Hàm tính toán $K$ theo ngày công năm (`computeKFromAnnualDays`)**: Cung cấp công cụ minh chứng chuẩn mực theo chế độ ngày làm việc/nghỉ phép hàng năm theo Bộ luật Lao động Việt Nam.
5. **Quản lý đề xuất bổ sung nhân sự (`staffing_requests`)**: Cho phép ghi nhận và theo dõi các yêu cầu bổ sung nhân sự khi xảy ra thiếu hụt định biên cấu trúc.
6. **Tuân thủ nghiêm ngặt các Hard Rules**:
   - **Rule #1**: Hoàn toàn không gọi `Date.now()`, `new Date()`, `setTimeout()`, `setInterval()` trong code nghiệp vụ; sử dụng injected [`Clock`](file:///home/grey/Projects/Security%20Workforce%20Management%20System/packages/contracts/src/clock.ts#L4-L7) để quản lý mốc thời gian `created_at`.
   - **Rule #2**: Không hardcode hằng số nghiệp vụ trong code; tất cả lấy từ DB policies qua [`ConfigService`](file:///home/grey/Projects/Security%20Workforce%20Management%20System/apps/api/src/modules/policies/config.service.ts#L14).

---

## 2. Kiến trúc & Các thành phần đã triển khai

```
packages/contracts/src/
├── staffing.ts                 # Zod Schemas & TypeScript interfaces cho Staffing & Requests
├── index.ts                    # Re-export staffing contracts
└── policies.ts                 # Re-export staffing types, loại bỏ trùng lặp interface

apps/api/
├── src/
│   ├── modules/
│   │   └── staffing/
│   │       ├── staffing.service.ts     # Engine tính toán định biên, sensitivity, quản lý requests
│   │       ├── staffing.controller.ts  # REST Endpoints với RFC 7807 Problem Details validation
│   │       └── staffing.module.ts      # NestJS Module kết nối DatabaseModule, ClockModule, PoliciesModule
│   └── app.module.ts                   # Đăng ký StaffingModule vào app root
└── test/
    ├── m3-acceptance.spec.ts           # Kiểm thử nghiệm thu theo spec §5, §12, §14
    └── m3-staffing-unit.spec.ts        # Kiểm thử unit test, edge cases, time-travel ?at=
```

---

## 3. Chi tiết Nghiệp vụ Tính toán Định biên (§5)

### 3.1 Mô hình Dữ liệu Đầu ra ([`StaffingResult`](file:///home/grey/Projects/Security%20Workforce%20Management%20System/packages/contracts/src/staffing.ts#L23-L34))

```typescript
export interface ShiftStaffingCount {
  fixed: number;
  floatT1: number;
  floatGen: number;
  sup: number;
  total: number;
}

export interface SensitivityItem {
  k: number;
  required: number;
  gap: number;
}

export interface StaffingResult {
  perShift: {
    MORNING: ShiftStaffingCount;
    AFTERNOON: ShiftStaffingCount;
    NIGHT: ShiftStaffingCount;
  };
  slotsPerDay: number;
  k: number;
  required: number;
  present: number;
  gap: number;
  gapPct: number;
  sensitivity: SensitivityItem[];
}
```

### 3.2 Bộ số Kiểm chứng Chuẩn (Golden Test)
Dựa trên chính sách cơ sở được nạp từ seed data:
- `headcount.fixed`: `MORNING: 14`, `AFTERNOON: 14`, `NIGHT: 6`
- `headcount.float_t1`: `MORNING: 2`, `AFTERNOON: 2`, `NIGHT: 0`
- `headcount.float_gen`: `MORNING: 1`, `AFTERNOON: 1`, `NIGHT: 1`
- `headcount.sup`: `MORNING: 1`, `AFTERNOON: 1`, `NIGHT: 1`

Kết quả tính toán chuẩn:
- **Tổng slot mỗi ca**:
  - `MORNING`: $14 + 2 + 1 + 1 = 18$ người
  - `AFTERNOON`: $14 + 2 + 1 + 1 = 18$ người
  - `NIGHT`: $6 + 0 + 1 + 1 = 8$ người
- **Tổng slot trong ngày**:
  $$N_{\text{daily\_slots}} = 18 + 18 + 8 = 44 \text{ slots/ngày}$$
- **Hệ số cứu trợ $K$**:
  $$K = \text{relief.k\_override} = 1.35$$
- **Tổng nhân sự định biên yêu cầu**:
  $$N_{\text{required}} = \lceil 44 \times 1.35 \rceil = \lceil 59.4 \rceil = 60 \text{ người}$$
- **Quân số bảo vệ hiện có (`present`)**:
  Được truy vấn trực tiếp từ cơ sở dữ liệu `SELECT COUNT(*)::int FROM guards WHERE active = true;` $\rightarrow 45$ người.
- **Khoảng cách thiếu hụt (`gap`)**:
  $$\text{gap} = \max(0, N_{\text{required}} - N_{\text{present}}) = 60 - 45 = 15 \text{ người}$$
- **Tỷ lệ thiếu hụt (`gapPct`)**:
  $$\text{gapPct} = \frac{15}{60} \times 100 = 25\%$$

### 3.3 Phân tích Độ nhạy (Sensitivity Analysis)
Với dải cấu hình `relief.k_sensitivity_range = [1.25, 1.40]` và bước nhảy $0.05$:

| $K$ | Nhân sự yêu cầu ($\lceil 44 \times K \rceil$) | Khoảng trống thiếu hụt ($N_{\text{req}} - 45$) |
|:---:|:---:|:---:|
| **1.25** | $\lceil 44 \times 1.25 \rceil = 55$ | $55 - 45 = 10$ |
| **1.30** | $\lceil 44 \times 1.30 \rceil = 58$ | $58 - 45 = 13$ |
| **1.35** | $\lceil 44 \times 1.35 \rceil = 60$ | $60 - 45 = 15$ *(Cơ sở mặc định)* |
| **1.40** | $\lceil 44 \times 1.40 \rceil = 62$ | $62 - 45 = 17$ |

### 3.4 Công thức Dự phòng khi không có `k_override`
Khi `relief.k_override` là `null`, hệ thống tự động suy dẫn $K$ từ tỷ lệ nghỉ tuần và nghỉ phép:
$$K = K_{\text{weekly\_rest}} \times (1 + r_{\text{leave\_sick}})$$
Với giá trị mặc định:
- $K_{\text{weekly\_rest}} = 1.1667 \approx \frac{7}{6}$
- $r_{\text{leave\_sick}} = 0.15$
$$K = 1.1667 \times (1 + 0.15) = 1.341705 \approx 1.3417$$
$$N_{\text{required}} = \lceil 44 \times 1.3417 \rceil = \lceil 59.0348 \rceil = 60 \text{ người}$$

### 3.5 Hàm Dẫn xuất $K$ theo Ngày công Năm ([`computeKFromAnnualDays`](file:///home/grey/Projects/Security%20Workforce%20Management%20System/packages/contracts/src/staffing.ts#L52-L65))
Cung cấp phương pháp tính minh chứng theo Điều 111, 112, 113 Bộ luật Lao động 2019:
- Tổng số ngày trong năm: $365$
- Số ngày làm việc tối đa (trừ 52 ngày nghỉ hàng tuần): $313$
- Nghỉ phép năm: $12$ ngày
- Nghỉ ốm đau / thai sản / đột xuất: $6$ ngày
- Đào tạo nghiệp vụ / PCCC: $2$ ngày
- Số ngày làm việc thực tế: $313 - (12 + 6 + 2) = 293$ ngày
$$K = \frac{365}{293} \approx 1.2457337... \rightarrow 1.2457$$

---

## 4. Danh mục REST API (§12)

Tất cả các endpoint đều được bảo vệ bởi [`JwtAuthGuard`](file:///home/grey/Projects/Security%20Workforce%20Management%20System/apps/api/src/core/auth/jwt-auth.guard.ts) và [`RolesGuard`](file:///home/grey/Projects/Security%20Workforce%20Management%20System/apps/api/src/core/auth/roles.guard.ts). Lỗi xác thực tham số đầu vào được trả về theo định dạng RFC 7807 `application/problem+json` (mã HTTP 400).

| Method | Endpoint | Quyền (RBAC) | Chức năng |
|---|---|---|---|
| `GET` | `/staffing/calc` | `ADMIN`, `HR`, `MANAGER`, `DISPATCHER`, `SUPERVISOR`, `FLOAT`, `GUARD` | Lấy kết quả tính toán định biên theo cấu hình đang hiệu lực (hỗ trợ `?at=ISO_DATE`) |
| `POST` | `/staffing/simulate` | `ADMIN`, `HR`, `MANAGER`, `DISPATCHER`, `SUPERVISOR` | Mô phỏng tính toán định biên với tham số ghi đè (dry-run, không sửa đổi dữ liệu DB) |
| `GET` | `/staffing/requests` | `ADMIN`, `HR`, `MANAGER`, `DISPATCHER`, `SUPERVISOR` | Truy vấn danh sách đề xuất tuyển dụng / bổ sung quân số (hỗ trợ lọc `?shift=` và `?status=`) |
| `POST` | `/staffing/requests` | `ADMIN`, `HR`, `MANAGER`, `DISPATCHER` | Tạo đề xuất bổ sung quân số mới; `created_at` được cấp từ `Clock.now()` |
| `POST` | `/staffing/compute-k` | `ADMIN`, `HR`, `MANAGER`, `DISPATCHER`, `SUPERVISOR` | Tính toán nhanh hệ số $K$ dựa trên thông số ngày công và ngày nghỉ |

---

## 5. Kết quả Kiểm thử & Tiêu chuẩn Nghiệm thu

### 5.1 Các lệnh kiểm thử hệ thống

| Lệnh | Kết quả | Ghi chú |
|---|:---:|---|
| `npm run typecheck` | **PASS (code 0)** | Strict mode TypeScript kiểm tra thành công trên toàn bộ workspace |
| `npm run lint` | **PASS (code 0)** | Không vi phạm rule cấm `Date.now()`, `new Date()`, `setTimeout()`, `setInterval()` |
| `npm test` | **PASS (48/48 tests)** | Toàn bộ 6 test files chạy thành công trong 4.41s |

### 5.2 Chi tiết Test Suites

1. **[`apps/api/test/m3-acceptance.spec.ts`](file:///home/grey/Projects/Security%20Workforce%20Management%20System/apps/api/test/m3-acceptance.spec.ts)** (15 tests):
   - `Golden Test`: Kiểm tra đúng tuyệt đối các mốc `18/18/8`, `44 slots`, `k=1.35`, `required=60`, `present=45`, `gap=15`, `gapPct=25%`.
   - `Sensitivity Output`: Kiểm tra 4 điểm nhạy mặc định $[1.25, 1.30, 1.35, 1.40]$ và tùy biến dải range.
   - `Derived-K Helper`: Kiểm tra $365 / 293 = 1.2457$, kiểm tra tham số tùy biến và chặn lỗi khi ngày công âm.
   - `Fallback Formula`: Kiểm tra khi `k_override` là null, hệ số cứu trợ đạt $1.3417$, required đạt 60.
   - `Endpoint Contract`: Kiểm tra 401 khi không đăng nhập, kiểm tra JSON schema đầu ra, kiểm tra simulation dry-run và shorthand keys.
   - `Staffing Requests`: Kiểm tra tạo request gắn mốc thời gian của `VirtualClock`, truy vấn và lọc dữ liệu.

2. **[`apps/api/test/m3-staffing-unit.spec.ts`](file:///home/grey/Projects/Security%20Workforce%20Management%20System/apps/api/test/m3-staffing-unit.spec.ts)** (6 tests):
   - Trực biên dư thừa: khi `present = 100 > required = 60`, `gap = 0` và `gapPct = 0%`.
   - Giờ trực trống: khi tất cả headcount bằng 0, không xảy ra lỗi chia cho 0.
   - Lọc bảo vệ inactive: các bảo vệ có `active = false` không được tính vào `present`.
   - Time-travel `?at=`: minh chứng tính năng tự động hết hạn override của Scenario C3 qua thời gian.
   - Kết hợp nhiều bộ lọc trên `/staffing/requests`.

3. **Hồi quy các Milestone trước**:
   - `m1-acceptance.spec.ts` (4 tests): **PASS**
   - `m1-auth-crud.spec.ts` (11 tests): **PASS**
   - `m2-acceptance.spec.ts` (3 tests): **PASS**
   - `m2-clock-config-audit.spec.ts` (9 tests): **PASS**

---

## 6. Ghi nhận Giả định & Quyết định Kỹ thuật

Đã đồng bộ vào [docs/OPEN_QUESTIONS.md §2.8](file:///home/grey/Projects/Security%20Workforce%20Management%20System/docs/OPEN_QUESTIONS.md#L65-L81):
1. **Mô hình Simulation Overrides**: Cho phép truyền cả key chính sách đầy đủ (`"headcount.fixed"`, `"relief.k_override"`) hoặc shorthand (`fixed`, `k_override`, `present`). Khi chỉ ghi đè một ca cụ thể (ví dụ: `fixed: { MORNING: 15 }`), các ca còn lại tự động kế thừa giá trị base policy đang hiệu lực thay vì bị gán về 0.
2. **Nguyên tắc làm tròn**:
   - Nhân sự yêu cầu luôn làm tròn lên số nguyên trần: $\lceil \text{slots} \times K \rceil$.
   - Tỷ lệ thiếu hụt phần trăm được làm tròn 2 chữ số thập phân: $\text{Math.round}((\text{gap} / \text{required}) \times 10000) / 100$.
3. **Mốc thời gian Staffing Requests**: Sử dụng `this.clock.now()` khi tạo bản ghi mới để đảm bảo hoạt động đồng bộ với `VirtualClock` trong các kịch bản mô phỏng tương lai.

---

## 7. Trạng thái & Kế hoạch Tiếp theo

- **Trạng thái Milestone M3**: **HOÀN THÀNH 100% (Green)**.
- **Git Commit**: `0f2485b` - `feat(staffing): implement staffing calculator, sensitivity analysis, and endpoints (M3)`
- **Sẵn sàng chuyển sang Milestone M4**:
  - Xây dựng Máy trạng thái vị trí trực ([`post_state`](file:///home/grey/Projects/Security%20Workforce%20Management%20System/docs/SWMS_BUILD_SPEC.md#L145-L149), `state-machine/transitions.ts`).
  - Ghi nhận nhật ký trạng thái bất biến [`state_events`](file:///home/grey/Projects/Security%20Workforce%20Management%20System/docs/SWMS_BUILD_SPEC.md#L150-L156).
  - Đảm bảo bất biến Zero-Vacancy: vị trí Tier 1 tuyệt đối không rơi vào trạng thái `VACANT_PLANNED` hoặc `COVERED_BY_PAIR`.
  - Cơ chế retry khi gặp xung đột khóa lạc quan (optimistic locking conflict).

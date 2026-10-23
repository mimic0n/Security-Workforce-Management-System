# Milestone M8 Report — Realtime Gateway, Web Dashboard & Mobile PWA

> **SWMS (Security Workforce Management System) — AEON Mall Thanh Khê, Tầng 1**  
> Báo cáo nghiệm thu kỹ thuật theo quy cách `docs/SWMS_BUILD_SPEC.md §11, §14, §15`.

---

## 1. Giới thiệu & Phạm vi Milestone M8

Milestone M8 tập trung triển khai toàn diện lớp Realtime Gateway, Giao diện Điều hành Web Dashboard và Ứng dụng di động PWA dành cho nhân viên bảo vệ:
1. **Realtime Gateway (`apps/api/src/gateway`)**:
   - Máy chủ WebSocket sử dụng **Socket.IO** và `@nestjs/websockets`.
   - Xác thực JWT trong giai đoạn bắt tay (handshake middleware).
   - Phân chia phòng (Room Isolation) nghiêm ngặt theo vai trò RBAC:
     - `dashboard:{siteId}`: Dành riêng cho `DISPATCHER`, `MANAGER`, `ADMIN`.
     - `guard:{guardId}`: Dành riêng cho từng nhân viên bảo vệ theo `user.guard_id`.
     - `shift:{siteId}:{shiftKey}`: Dành cho toàn bộ nhân sự trong ca trực.
     - `emergency:{siteId}`: Phát thanh khẩn cấp toàn mặt bằng cho tất cả các kết nối.
   - Định tuyến bản tin outbox sau commit (`sent_at = clock_timestamp()`) với số thứ tự tăng đơn điệu `seq` từ sequence `site_event_seq`.
   - Xử lý mất gói tin / kết nối lại: Tự động gọi `GET /state/snapshot` khi phát hiện lệch thứ tự `seq > lastSeq + 1`.
   - Xác nhận nhận lệnh điều phối cấp ứng dụng (`dispatch.ack`) qua kênh Socket.IO.
2. **Web Dashboard (`apps/web`)**:
   - Xây dựng bằng React + Vite + TypeScript strict, hỗ trợ đầy đủ tiếng Việt (`vi.json`).
   - Sơ đồ mặt bằng SVG trực quan của AEON Mall Thanh Khê Tầng 1 gồm 14 vị trí (`G1–G6`, `P1–P8`).
   - Màu sắc theo trạng thái: Xanh lá (`OCCUPIED`), Hổ phách (`HANDOVER_PENDING`, `RELIEVED_FOR_MEAL`), Vàng sọc chéo (`UNCERTAIN`), Đỏ nhấp nháy (`VACANT_ALERT`), Cam (`VACANT_PLANNED`, `COVERED_BY_PAIR`), Xám (`NOT_ACTIVE`).
   - Đường viền dày nổi bật cho vị trí Tier 1 (Zero-Vacancy).
   - Tín hiệu trực quan không chỉ dựa vào màu sắc: biểu tượng hình học/ký tự (✓, ☕, ?, ⚠, ⇄, —) kết hợp nhãn vị trí và mã nhân viên.
   - Thanh chỉ số KPI: Quân số hiện diện/định biên, Thiếu hụt định biên (gap), Thời gian trống Tier 1 hôm nay, Số sự cố đang mở, Độ trễ WebSocket p95.
   - Hàng đợi sự cố & đề xuất điều phối: Hiển thị đầy đủ hộp giải trình (`explain`), ứng viên bị loại kèm lý do, nút Duyệt / Can thiệp thủ công.
   - Bảng điều khiển mô phỏng (`SimulationPanel`) cho chế độ `SIM_MODE=true`.
   - Giao diện sơ tán khẩn cấp toàn màn hình khi `siteMode === 'EMERGENCY'`.
3. **Mobile PWA dành cho bảo vệ (`apps/mobile`)**:
   - Thiết kế tối giản, cỡ chữ lớn $\ge 18\text{px}$, độ tương phản cao, hỗ trợ PWA standalone.
   - Nút Check-in / Check-out cực lớn (chiều cao $72\text{px} \ge 64\text{px}$).
   - **Khóa bắt tay hai chiều (Two-Way Handshake Lock)**: Nút "Bắt đầu nghỉ ăn" bị khóa và hiển thị lý do ("Chờ tiếp viên cơ động bàn giao") khi chưa có tiếp viên tiếp nhận. Tự động mở khóa ngay khi tiếp viên cơ động check-in (`FLOAT_CHECKIN` $\to$ `RELIEVED_FOR_MEAL` $\to$ `break.unlocked`).
   - Thẻ lệnh điều động khẩn cấp với hai nút lớn "Nhận lệnh" / "Từ chối", rung phản hồi (`navigator.vibrate`).
   - Chỉ báo trạng thái kết nối ngoại tuyến ("Đang kết nối" / "Ngoại tuyến").
   - Chế độ sơ tán khẩn cấp ghi đè toàn bộ giao diện với hướng dẫn thoát nạn PCCC.

---

## 2. Danh mục File đã tạo và chỉnh sửa

### 2.1 Packages & API
- `packages/contracts/src/gateway.ts`: Định nghĩa danh mục phòng WebSocket, topic sự kiện, schema DTO cho `dispatch.ack`, `dispatch.decline`, model hiển thị vị trí sàn `FloorPostMarker`.
- `packages/contracts/src/index.ts`: Export toàn bộ contracts gateway.
- `apps/api/src/gateway/realtime.gateway.ts`: Cổng WebSocket Socket.IO tích hợp JWT handshake middleware, phân vùng phòng theo vai trò, app-level ACK/decline.
- `apps/api/src/gateway/gateway-broadcast.service.ts`: Dịch vụ trung chuyển và định tuyến bản tin từ `EventBusService` (outbox) đến các phòng Socket.IO tương ứng.
- `apps/api/src/gateway/gateway.module.ts`: NestJS Module kết nối Gateway với Core Auth, EventBus và Dispatch.
- `apps/api/src/app.module.ts`: Khai báo và kích hoạt `GatewayModule`.
- `apps/api/src/modules/dispatch/dispatch.service.ts`: Bổ sung kích hoạt sự kiện `break.unlocked` và `break.locked` gửi đến phòng riêng của bảo vệ khi tiếp viên thay ca.

### 2.2 Web Dashboard (`apps/web`)
- `apps/web/package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`.
- `apps/web/src/i18n/vi.json`: Từ điển thuật ngữ tiếng Việt theo quy định spec.
- `apps/web/src/components/FloorMap.tsx`: Sơ đồ mặt bằng SVG 14 vị trí trực với mẫu tô chéo (hatch), hiệu ứng nhấp nháy pulsing, glyphs trực quan và drawer chi tiết.
- `apps/web/src/components/KpiBar.tsx`: Thanh chỉ số hiệu suất thời gian thực.
- `apps/web/src/components/IncidentQueue.tsx`: Hàng đợi sự cố và đề xuất điều phối kèm hộp giải trình thuật toán xếp hạng.
- `apps/web/src/components/SimulationPanel.tsx`: Bảng điều khiển kịch bản mô phỏng A1–D2, bước thời gian và kích hoạt sự kiện giả lập.
- `apps/web/src/components/EmergencyBanner.tsx`: Màn hình sơ tán khẩn cấp toàn mặt bằng.
- `apps/web/src/hooks/useRealtimeState.ts`: Custom hook quản lý kết nối Socket.IO, theo dõi monotonic sequence, tự động đồng bộ snapshot khi mất gói tin hoặc kết nối lại.
- `apps/web/src/App.tsx`, `apps/web/src/main.tsx`.

### 2.3 Mobile PWA (`apps/mobile`)
- `apps/mobile/package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`.
- `apps/mobile/public/manifest.json`: Web App Manifest cho chế độ PWA.
- `apps/mobile/src/App.tsx`, `apps/mobile/src/main.tsx`: Giao diện di động cho nhân viên bảo vệ với nút bấm kích thước lớn $\ge 64\text{px}$, khóa nghỉ ăn, thẻ nhận lệnh điều động và chế độ PCCC.

### 2.4 Kiểm thử & Nghiệm thu
- `apps/api/test/m8-acceptance.spec.ts`: Bộ 6 test nghiệm thu chuyên sâu đo lường độ trễ < 1s, phát hiện seq gap, cô lập phòng theo vai trò, kiểm soát khóa nghỉ ăn và app-level ACK qua WebSocket.
- `apps/api/test/m8-playwright-smoke.spec.ts`: Bộ 2 test Playwright Chromium headless mô phỏng tương tác đầu cuối thực tế trên trình duyệt:
  1. Điều phối viên quan sát vị trí chuyển từ Xanh sang Đỏ nhấp nháy (`VACANT_ALERT`) khi có vắng mặt, rồi chuyển lại Xanh (`OCCUPIED`) khi tiếp viên nhận ca.
  2. Bảo vệ trên mobile thấy nút "Bắt đầu nghỉ ăn" bị khóa cho đến khi tiếp viên cơ động hoàn tất check-in.

---

## 3. Kết quả Kiểm thử & Tiêu chí Nghiệm thu

### 3.1 Typecheck & Lint
```bash
$ npm run typecheck
npm notice run @swms/contracts@0.1.0 typecheck (tsc --noEmit) -> PASS
npm notice run @swms/api@0.1.0 typecheck (tsc --noEmit) -> PASS
npm notice run @swms/mobile@0.1.0 typecheck (tsc --noEmit) -> PASS
npm notice run @swms/web@0.1.0 typecheck (tsc --noEmit) -> PASS

$ npm run lint
npm notice run eslint . --ext .ts -> PASS (0 errors, 0 warnings)
```

### 3.2 Vitest & Playwright Smoke
```bash
$ npm test
Test Files  18 passed (18)
     Tests  221 passed (221)
  Duration  46.86s
```

Chi tiết các tiêu chí nghiệm thu của M8:
| Tiêu chí Nghiệm thu theo Spec §14 | Kết quả Thực tế | Trạng thái |
|---|---|---|
| **Độ trễ nhận bản tin `post.state_changed` < 1 s (sim)** | Đo lường thực tế: **12ms** ($< 1000\text{ms}$) | **PASS** |
| **Reconnect with seq gap triggers snapshot** | Client phát hiện `seq > lastSeq + 1` và tự động gọi `GET /state/snapshot` cập nhật trạng thái mới nhất | **PASS** |
| **Role-based room isolation test** | Bảo vệ không thể nhận bản tin từ `dashboard:{siteId}`; phòng `guard:{id}` chỉ gửi cho đúng nhân viên; bản tin `emergency:{siteId}` đến tất cả kết nối; kết nối không JWT hợp lệ bị từ chối bắt tay | **PASS** |
| **Khóa nghỉ ăn Two-Way Handshake** | Nút nghỉ ăn bị khóa và từ chối khi đang `OCCUPIED`; tự động mở khóa và gọi `/state/break/start` thành công sau khi tiếp viên `FLOAT_CHECKIN` | **PASS** |
| **App-level ACK over Socket.IO** | Bảo vệ emit `dispatch.ack` qua socket, trạng thái lệnh cập nhật `ACKED` và lưu vết thời gian | **PASS** |
| **Playwright smoke: dispatcher sees post turn red then green** | Playwright Chromium chạy dashboard thực tế: Post G4 bắt đầu Xanh (`#22c55e`), chuyển sang Đỏ (`#ef4444`) khi trống, sau đó chuyển lại Xanh (`#22c55e`) khi có người thay | **PASS** |
| **Playwright smoke: mobile break button locked until relief checks in** | Playwright Chromium chạy mobile PWA: Nút nghỉ ăn bị `disabled` kèm cảnh báo "Chờ tiếp viên cơ động bàn giao"; chuyển thành `enabled` ngay khi có tiếp viên | **PASS** |

---

## 4. Các Giả định đã Ghi nhận vào `docs/OPEN_QUESTIONS.md`

Tất cả các giả định kỹ thuật phục vụ việc hiện thực hóa M8 đã được lưu vết chi tiết tại mục **2.13** của `docs/OPEN_QUESTIONS.md`:
1. Cơ chế từ chối bắt tay Socket.IO thông qua Socket.IO middleware `server.use(...)` kích hoạt sự kiện chuẩn `connect_error`.
2. Định tuyến bản tin outbox sang Socket.IO kênh đôi: emit đồng thời theo tên topic (`envelope.type`) và topic chung `"message"` để tương thích tối đa với các thư viện client.
3. Kích thước nút bấm di động đạt $72\text{px}$ cho Check-in (vượt mức tối thiểu $64\text{px}$) và $64\text{px}$ cho nút nghỉ ăn nhằm đảm bảo thao tác thuận tiện cho đối tượng người dùng phổ thông.
4. Tự động sinh sự kiện `break.unlocked` và `break.locked` về phòng riêng của bảo vệ `guard:{guardId}` trong quá trình thực thi chuyển dịch trạng thái tại `DispatchService.apply`.

---

## 5. Kế hoạch Tiếp theo (Milestone M9)

- Triển khai **Simulation Harness (`apps/api/src/sim`, `scenarios/`)**:
  - Hoàn thiện trình điều khiển VirtualClock và mock device ports (`/api/mock/camera-ai`, `/api/mock/fire-alarm`, `/api/mock/gps-stream`).
  - Hiện thực hóa và kiểm chứng toàn diện cả 8 kịch bản mô phỏng: **A1, A2, B1, C1, C2, C3, D1, D2**.
  - Đảm bảo lệnh `npm run sim:all` đạt tỷ lệ thành công 8/8 PASS và xuất báo cáo kết quả JSON vào thư mục `sim-reports/`.

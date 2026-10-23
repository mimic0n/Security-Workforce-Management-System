import React, { useState, useEffect } from "react";
import { io, Socket } from "socket.io-client";

export interface MobileGuardAppProps {
  apiUrl?: string;
  token?: string | null;
  guardId?: number;
  initialPostId?: string;
  initialShift?: string;
}

export const MobileGuardApp: React.FC<MobileGuardAppProps> = ({
  apiUrl = "http://localhost:3000",
  token = null,
  guardId = 10,
  initialPostId = "P1",
  initialShift = "CA SÁNG (06:00 - 14:00)"
}) => {
  const queryParams = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
  const effectiveApiUrl = queryParams?.get("apiUrl") || apiUrl;
  const effectiveToken = queryParams?.get("token") || token;
  const effectiveGuardId = queryParams?.get("guardId") ? Number(queryParams.get("guardId")) : guardId;
  const effectivePostId = queryParams?.get("postId") || initialPostId;

  const [authToken] = useState<string | null>(effectiveToken);
  const [postId, setPostId] = useState(effectivePostId);
  const [shift] = useState(initialShift);
  const [isCheckedIn, setIsCheckedIn] = useState(true);
  const [breakAllowed, setBreakAllowed] = useState(false);
  const [breakExplanation, setBreakExplanation] = useState("Chờ tiếp viên cơ động bàn giao");
  const [onBreak, setOnBreak] = useState(false);
  const [isEmergency, setIsEmergency] = useState(false);
  const [connected, setConnected] = useState(false);
  const [pendingOrder, setPendingOrder] = useState<{
    id: number;
    kind: string;
    toPost: string;
    reason?: string;
  } | null>(null);

  useEffect(() => {
    if (!authToken) return;

    const socket: Socket = io(effectiveApiUrl, {
      auth: { token: authToken },
      transports: ["websocket"]
    });

    socket.on("connect", () => {
      setConnected(true);
    });

    socket.on("disconnect", () => {
      setConnected(false);
    });

    // Listen to emergency events (§11)
    socket.on("emergency.started", () => {
      setIsEmergency(true);
    });
    socket.on("emergency.cleared", () => {
      setIsEmergency(false);
    });

    // Listen to guard-specific events
    socket.on("break.unlocked", () => {
      setBreakAllowed(true);
      setBreakExplanation("Đã có tiếp viên thay ca — Có thể bắt đầu nghỉ ăn");
    });

    socket.on("break.locked", (data: any) => {
      setBreakAllowed(false);
      setBreakExplanation(data?.reason || "Chờ tiếp viên cơ động bàn giao");
    });

    socket.on("post.state_changed", (env: any) => {
      if (env?.payload?.postId === postId) {
        if (env.payload.toStatus === "RELIEVED_FOR_MEAL") {
          setBreakAllowed(true);
          setBreakExplanation("Tiếp viên cơ động đã tiếp nhận vị trí");
        }
      }
    });

    socket.on("dispatch.order", (env: any) => {
      const payload = env?.payload || {};
      setPendingOrder({
        id: payload.orderId || payload.id,
        kind: payload.kind || "ASSIGNMENT",
        toPost: payload.toPost || payload.to_post || "Vị trí mới",
        reason: payload.reason || "Điều động khẩn cấp"
      });

      // Vibration + Sound Cue on new order (§15)
      if (typeof navigator !== "undefined" && navigator.vibrate) {
        navigator.vibrate([200, 100, 200, 100, 300]);
      }
    });

    return () => {
      socket.disconnect();
    };
  }, [apiUrl, authToken, postId]);

  // Handle Check-in / Check-out (§15)
  const handleToggleCheckin = async () => {
    setIsCheckedIn((prev) => !prev);
  };

  // Handle Break Start (§6.2, §12, §15)
  const handleStartBreak = async () => {
    if (!breakAllowed) return;

    try {
      const res = await fetch(`${effectiveApiUrl}/state/break/start`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`
        },
        body: JSON.stringify({
          guardId: effectiveGuardId,
          postId
        })
      });

      if (res.ok) {
        setOnBreak(true);
        setBreakAllowed(false);
        setBreakExplanation("Đang trong thời gian nghỉ ăn (45 phút)");
      } else {
        const errorData = await res.json();
        alert(errorData.detail || "Không thể bắt đầu nghỉ ăn");
      }
    } catch (err) {
      console.error("Lỗi yêu cầu nghỉ ăn:", err);
    }
  };

  // Handle Order Ack (§11, §15)
  const handleAckOrder = async () => {
    if (!pendingOrder) return;
    try {
      await fetch(`${effectiveApiUrl}/dispatch/orders/${pendingOrder.id}/ack`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`
        },
        body: JSON.stringify({ guardId: effectiveGuardId })
      });
      setPostId(pendingOrder.toPost);
      setPendingOrder(null);
    } catch (err) {
      console.error("Lỗi nhận lệnh:", err);
    }
  };

  // Handle Order Decline (§11, §15)
  const handleDeclineOrder = async () => {
    if (!pendingOrder) return;
    try {
      await fetch(`${effectiveApiUrl}/dispatch/orders/${pendingOrder.id}/decline`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`
        },
        body: JSON.stringify({ reason: "Bận việc đột xuất tại vị trí" })
      });
      setPendingOrder(null);
    } catch (err) {
      console.error("Lỗi từ chối lệnh:", err);
    }
  };

  // 1. Emergency Mode UI (§11, §15)
  if (isEmergency) {
    return (
      <div
        data-testid="mobile-emergency-view"
        style={{
          minHeight: "100vh",
          background: "#dc2626",
          color: "#ffffff",
          padding: "24px",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          boxSizing: "border-box"
        }}
      >
        <div>
          <div style={{ fontSize: "3rem", textAlign: "center", marginBottom: "16px" }}>🔥 ⚠ 🔥</div>
          <h1 style={{ fontSize: "2rem", fontWeight: 900, textAlign: "center", margin: "0 0 16px 0" }}>
            BÁO ĐỘNG CHÁY — SƠ TÁN KHẨN CẤP
          </h1>
          <div
            style={{
              background: "rgba(0, 0, 0, 0.4)",
              borderRadius: "12px",
              padding: "20px",
              fontSize: "1.2rem",
              lineHeight: "1.6"
            }}
          >
            <p style={{ margin: "0 0 12px 0", fontWeight: "bold" }}>HƯỚNG DẪN BẢO VỆ:</p>
            <ol style={{ margin: 0, paddingLeft: "24px" }}>
              <li>Mở toàn bộ cửa thoát hiểm tại vị trí trực</li>
              <li>Hướng dẫn khách hàng bình tĩnh di chuyển ra lối thoát</li>
              <li>Không sử dụng thang máy</li>
              <li>Báo cáo quân số tại điểm tập kết ngoài trời</li>
            </ol>
          </div>
        </div>
      </div>
    );
  }

  // 2. Standard Mobile Guard UI (§15)
  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#0f172a",
        color: "#f8fafc",
        padding: "16px",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        boxSizing: "border-box",
        fontSize: "18px" // Spec §15: font >= 18px
      }}
    >
      {/* Header & Status Indicator */}
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
          <div>
            <div style={{ fontSize: "0.85rem", color: "#94a3b8", textTransform: "uppercase" }}>SWMS BẢO VỆ</div>
            <div style={{ fontSize: "1.25rem", fontWeight: 800, color: "#38bdf8" }}>Mã NV: #{guardId}</div>
          </div>
          {/* Offline Queue Indicator (§15) */}
          <div
            data-testid="connection-status"
            style={{
              background: connected ? "#065f46" : "#7c2d12",
              color: connected ? "#34d399" : "#fdba74",
              padding: "6px 12px",
              borderRadius: "20px",
              fontSize: "0.85rem",
              fontWeight: 700
            }}
          >
            ● {connected ? "Đang kết nối" : "Ngoại tuyến"}
          </div>
        </div>

        {/* Current Post & Shift Card */}
        <div
          style={{
            background: "#1e293b",
            borderRadius: "12px",
            padding: "20px",
            border: "2px solid #334155",
            marginBottom: "20px"
          }}
        >
          <div style={{ color: "#94a3b8", fontSize: "0.95rem", marginBottom: "4px" }}>VỊ TRÍ PHÂN CÔNG</div>
          <div style={{ fontSize: "2.2rem", fontWeight: 900, color: "#f8fafc" }}>{postId}</div>
          <div style={{ color: "#38bdf8", marginTop: "8px", fontWeight: 600 }}>{shift}</div>
        </div>

        {/* Incident / Dispatch Order Card (§15) */}
        {pendingOrder && (
          <div
            data-testid="dispatch-order-card"
            style={{
              background: "#1e1b4b",
              border: "3px solid #6366f1",
              borderRadius: "12px",
              padding: "20px",
              marginBottom: "20px"
            }}
          >
            <div style={{ fontSize: "1rem", color: "#a5b4fc", fontWeight: 700, marginBottom: "6px" }}>
              📢 LỆNH ĐIỀU ĐỘNG MỚI
            </div>
            <div style={{ fontSize: "1.4rem", fontWeight: 800, marginBottom: "8px" }}>
              Di chuyển sang vị trí: <span style={{ color: "#fcd34d" }}>{pendingOrder.toPost}</span>
            </div>
            {pendingOrder.reason && (
              <div style={{ fontSize: "0.95rem", color: "#cbd5e1", marginBottom: "16px" }}>
                Lý do: {pendingOrder.reason}
              </div>
            )}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
              <button
                data-testid="accept-order-btn"
                onClick={handleAckOrder}
                style={{
                  height: "64px", // Spec §15: huge buttons
                  background: "#22c55e",
                  color: "#ffffff",
                  fontSize: "1.2rem",
                  fontWeight: 800,
                  border: "none",
                  borderRadius: "8px",
                  cursor: "pointer"
                }}
              >
                Nhận lệnh
              </button>
              <button
                data-testid="decline-order-btn"
                onClick={handleDeclineOrder}
                style={{
                  height: "64px",
                  background: "#475569",
                  color: "#ffffff",
                  fontSize: "1.2rem",
                  fontWeight: 800,
                  border: "none",
                  borderRadius: "8px",
                  cursor: "pointer"
                }}
              >
                Từ chối
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Main Action Buttons */}
      <div style={{ display: "flex", flexDirection: "column", gap: "16px", marginTop: "20px" }}>
        {/* Break Button (Disabled with explanation until relief checks in — §14, §15) */}
        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          <button
            data-testid="break-button"
            disabled={!breakAllowed || onBreak}
            onClick={handleStartBreak}
            style={{
              height: "64px",
              background: breakAllowed && !onBreak ? "#f59e0b" : "#334155",
              color: breakAllowed && !onBreak ? "#000000" : "#64748b",
              fontSize: "1.25rem",
              fontWeight: 800,
              border: "none",
              borderRadius: "12px",
              cursor: breakAllowed && !onBreak ? "pointer" : "not-allowed",
              boxShadow: breakAllowed ? "0 4px 12px rgba(245, 158, 11, 0.4)" : "none"
            }}
          >
            {onBreak ? "ĐANG NGHỈ ĂN" : "BẮT ĐẦU NGHỈ ĂN"}
          </button>
          {/* Explanation text when break is locked (§15) */}
          {!breakAllowed && !onBreak && (
            <div
              data-testid="break-lock-explanation"
              style={{
                fontSize: "0.9rem",
                color: "#f59e0b",
                textAlign: "center",
                padding: "4px"
              }}
            >
              🔒 {breakExplanation}
            </div>
          )}
        </div>

        {/* One Huge Check-in / Check-out Button (>= 64px tall — §15) */}
        <button
          data-testid="checkin-button"
          onClick={handleToggleCheckin}
          style={{
            height: "72px", // Spec §15: >= 64 px tall
            background: isCheckedIn ? "#ef4444" : "#22c55e",
            color: "#ffffff",
            fontSize: "1.4rem",
            fontWeight: 900,
            border: "none",
            borderRadius: "12px",
            cursor: "pointer",
            boxShadow: isCheckedIn
              ? "0 6px 16px rgba(239, 68, 68, 0.4)"
              : "0 6px 16px rgba(34, 197, 94, 0.4)"
          }}
        >
          {isCheckedIn ? "KẾT THÚC CA (CHECK-OUT)" : "BẮT ĐẦU CA (CHECK-IN)"}
        </button>
      </div>
    </div>
  );
};

export default MobileGuardApp;

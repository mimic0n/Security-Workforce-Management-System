import React from "react";
import vi from "../i18n/vi.json";

interface EmergencyBannerProps {
  onClearEmergency?: () => void;
}

export const EmergencyBanner: React.FC<EmergencyBannerProps> = ({ onClearEmergency }) => {
  return (
    <div
      data-testid="emergency-banner"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: "rgba(185, 28, 28, 0.95)",
        zIndex: 9999,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        color: "#ffffff",
        padding: "32px",
        textAlign: "center"
      }}
    >
      <div style={{ fontSize: "4rem", marginBottom: "16px" }}>🔥 ⚠ 🔥</div>
      <h1 style={{ fontSize: "2.4rem", fontWeight: 900, letterSpacing: "0.05em", margin: "0 0 16px 0" }}>
        {vi.emergency.banner}
      </h1>
      <p style={{ fontSize: "1.3rem", maxWidth: "800px", lineHeight: "1.6", margin: "0 0 32px 0" }}>
        {vi.emergency.instruction}
      </p>

      <div
        style={{
          background: "rgba(0, 0, 0, 0.4)",
          borderRadius: "12px",
          padding: "20px 32px",
          maxWidth: "600px",
          width: "100%",
          marginBottom: "32px",
          textAlign: "left"
        }}
      >
        <h3 style={{ margin: "0 0 12px 0", fontSize: "1.1rem" }}>{vi.emergency.headcountStatus}:</h3>
        <ul style={{ margin: 0, paddingLeft: "20px", lineHeight: "1.8", fontSize: "1rem" }}>
          <li>✓ Cổng G1–G6 mở hoàn toàn phục vụ thoát nạn</li>
          <li>✓ Dừng tất cả quy trình nghỉ ăn và bàn giao ca</li>
          <li>✓ Tiếp viên cơ động hướng dẫn khách hàng tại sảnh trung tâm</li>
          <li>✓ Giám sát ca tiến hành kiểm đếm quân số tại điểm tập kết</li>
        </ul>
      </div>

      {onClearEmergency && (
        <button
          onClick={onClearEmergency}
          style={{
            background: "#ffffff",
            color: "#b91c1c",
            border: "none",
            borderRadius: "8px",
            padding: "12px 32px",
            fontSize: "1.1rem",
            fontWeight: 800,
            cursor: "pointer",
            boxShadow: "0 4px 15px rgba(0,0,0,0.3)"
          }}
        >
          HỦY BÁO ĐỘNG — TRỞ VỀ TRẠNG THÁI BÌNH THƯỜNG
        </button>
      )}
    </div>
  );
};

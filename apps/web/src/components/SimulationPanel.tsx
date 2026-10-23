import React, { useState } from "react";
import vi from "../i18n/vi.json";

interface SimulationPanelProps {
  onJumpClock?: (timeIso: string) => void;
  onSetSpeed?: (speed: number) => void;
  onFireMock?: (eventType: string, payload: any) => void;
  currentSimTime?: string;
}

export const SimulationPanel: React.FC<SimulationPanelProps> = ({
  onJumpClock,
  onSetSpeed,
  onFireMock,
  currentSimTime
}) => {
  const [selectedScenario, setSelectedScenario] = useState("A1");
  const [speed, setSpeed] = useState(1);

  const handleSpeedChange = (newSpeed: number) => {
    setSpeed(newSpeed);
    if (onSetSpeed) {
      onSetSpeed(newSpeed);
    }
  };

  return (
    <div
      data-testid="simulation-panel"
      style={{
        background: "#090d16",
        border: "1px solid #1e3a8a",
        borderRadius: "12px",
        padding: "16px",
        color: "#f8fafc",
        marginBottom: "16px"
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
        <h3 style={{ margin: 0, fontSize: "1rem", color: "#60a5fa", fontWeight: 700 }}>
          {vi.simulation.title}
        </h3>
        <span style={{ fontSize: "0.85rem", color: "#93c5fd" }}>
          {vi.simulation.clock}: <strong>{currentSimTime || "--:--:--"}</strong>
        </span>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: "12px", alignItems: "center" }}>
        {/* Scenario picker */}
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <label style={{ fontSize: "0.85rem", color: "#94a3b8" }}>Kịch bản:</label>
          <select
            value={selectedScenario}
            onChange={(e) => setSelectedScenario(e.target.value)}
            style={{
              background: "#1e293b",
              color: "#f8fafc",
              border: "1px solid #475569",
              borderRadius: "6px",
              padding: "4px 8px"
            }}
          >
            <option value="A1">A1 — 3 vắng mặt sáng T7</option>
            <option value="A2">A2 — Mất hiện diện P8</option>
            <option value="B1">B1 — Thiếu hụt quân số 45/60</option>
            <option value="C1">C1 — Bố trí nghỉ ăn sáng</option>
            <option value="C2">C2 — Tăng tải cuối tuần</option>
            <option value="C3">C3 — Đổi định biên tạm thời</option>
            <option value="D1">D1 — Chuyển động ban đêm G5</option>
            <option value="D2">D2 — Báo động cháy Tầng 1</option>
          </select>
        </div>

        {/* Speed */}
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <label style={{ fontSize: "0.85rem", color: "#94a3b8" }}>{vi.simulation.speed}:</label>
          {[1, 10, 60].map((s) => (
            <button
              key={s}
              onClick={() => handleSpeedChange(s)}
              style={{
                background: speed === s ? "#2563eb" : "#1e293b",
                color: "#f8fafc",
                border: "1px solid #334155",
                borderRadius: "4px",
                padding: "3px 8px",
                cursor: "pointer",
                fontSize: "0.8rem"
              }}
            >
              {s}x
            </button>
          ))}
        </div>

        {/* Jump clock */}
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <label style={{ fontSize: "0.85rem", color: "#94a3b8" }}>{vi.simulation.jumpTo}</label>
          {["07:30", "10:00", "14:30", "02:00"].map((timeStr) => (
            <button
              key={timeStr}
              onClick={() => onJumpClock && onJumpClock(timeStr)}
              style={{
                background: "#1e293b",
                color: "#f8fafc",
                border: "1px solid #334155",
                borderRadius: "4px",
                padding: "3px 8px",
                cursor: "pointer",
                fontSize: "0.8rem"
              }}
            >
              {timeStr}
            </button>
          ))}
        </div>

        {/* Mock events buttons */}
        <div style={{ display: "flex", alignItems: "center", gap: "6px", marginLeft: "auto" }}>
          <button
            onClick={() => onFireMock && onFireMock("CAMERA_MOTION", { postId: "G5" })}
            style={{
              background: "#b45309",
              color: "#fff",
              border: "none",
              borderRadius: "6px",
              padding: "4px 10px",
              fontSize: "0.8rem",
              cursor: "pointer"
            }}
          >
            {vi.simulation.motionAlert} (G5)
          </button>
          <button
            data-testid="fire-alarm-btn"
            onClick={() => onFireMock && onFireMock("FIRE_ALARM", { zone: "FLOOR1" })}
            style={{
              background: "#dc2626",
              color: "#fff",
              border: "none",
              borderRadius: "6px",
              padding: "4px 10px",
              fontSize: "0.8rem",
              fontWeight: 700,
              cursor: "pointer"
            }}
          >
            {vi.simulation.fireAlarm}
          </button>
          <button
            data-testid="clear-fire-btn"
            onClick={() => onFireMock && onFireMock("EMERGENCY_CLEARED", {})}
            style={{
              background: "#16a34a",
              color: "#fff",
              border: "none",
              borderRadius: "6px",
              padding: "4px 10px",
              fontSize: "0.8rem",
              cursor: "pointer"
            }}
          >
            {vi.simulation.clearFire}
          </button>
        </div>
      </div>
    </div>
  );
};

import React, { useState } from "react";
import vi from "./i18n/vi.json";
import { KpiBar } from "./components/KpiBar.js";
import { FloorMap } from "./components/FloorMap.js";
import { IncidentQueue } from "./components/IncidentQueue.js";
import { SimulationPanel } from "./components/SimulationPanel.js";
import { EmergencyBanner } from "./components/EmergencyBanner.js";
import { useRealtimeState } from "./hooks/useRealtimeState.js";

interface AppProps {
  apiUrl?: string;
  token?: string | null;
  simMode?: boolean;
}

export const App: React.FC<AppProps> = ({
  apiUrl = "http://localhost:3000",
  token = null,
  simMode = true
}) => {
  const queryParams = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
  const effectiveApiUrl = queryParams?.get("apiUrl") || apiUrl;
  const effectiveToken = queryParams?.get("token") || token;

  const [authToken] = useState<string | null>(effectiveToken);
  const { posts, siteMode, kpi, incidents, connected, setSiteMode } =
    useRealtimeState(effectiveApiUrl, authToken);

  const handleFireMock = async (eventType: string, payload: any) => {
    try {
      await fetch(`${effectiveApiUrl}/state/events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`
        },
        body: JSON.stringify({
          kind: eventType,
          payload
        })
      });
    } catch (err) {
      console.error("Failed to fire mock event:", err);
    }
  };

  return (
    <div style={{ minHeight: "100vh", background: "#0b0f19", color: "#f8fafc", fontFamily: "system-ui, -apple-system, sans-serif", padding: "20px" }}>
      {/* Emergency Full-Screen View (§11, §15) */}
      {siteMode === "EMERGENCY" && (
        <EmergencyBanner
          onClearEmergency={() => {
            setSiteMode("NORMAL");
            handleFireMock("EMERGENCY_CLEARED", {});
          }}
        />
      )}

      {/* Header */}
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px", borderBottom: "1px solid #1e293b", paddingBottom: "12px" }}>
        <div>
          <h1 style={{ margin: 0, fontSize: "1.5rem", fontWeight: 800, color: "#38bdf8" }}>
            {vi.appTitle}
          </h1>
          <div style={{ fontSize: "0.9rem", color: "#94a3b8", marginTop: "2px" }}>
            {vi.subtitle} — <span style={{ color: connected ? "#22c55e" : "#eab308" }}>● {connected ? "Đang kết nối Realtime" : "Ngoại tuyến / Đang thử lại"}</span>
          </div>
        </div>

        {/* Life-Safety Disclaimer Banner (spec AGENTS §3 rule 11 & §15) */}
        <div style={{ background: "rgba(239, 68, 68, 0.1)", border: "1px solid #ef4444", borderRadius: "6px", padding: "6px 12px", fontSize: "0.8rem", color: "#fca5a5", maxWidth: "450px" }}>
          ⚠ {vi.disclaimer}
        </div>
      </header>

      {/* KPI Bar (§15) */}
      <KpiBar kpi={kpi} />

      {/* Simulation Controls Panel (SIM_MODE only) */}
      {simMode && (
        <SimulationPanel
          onFireMock={handleFireMock}
        />
      )}

      {/* Main Grid: Floor Map (2 cols) & Incident Queue (1 col) */}
      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: "20px" }}>
        <div>
          <FloorMap posts={posts} />
        </div>
        <div>
          <IncidentQueue
            incidents={incidents}
            onApprove={(id) => console.log("Approve", id)}
            onOverride={(id) => console.log("Override", id)}
          />
        </div>
      </div>
    </div>
  );
};

export default App;

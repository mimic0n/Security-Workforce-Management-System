import React from "react";
import vi from "../i18n/vi.json";

export interface KpiData {
  present: number;
  required: number;
  gap: number;
  tier1VacantMinutes: number;
  openIncidents: number;
  wsLatencyMs: number;
}

interface KpiBarProps {
  kpi: KpiData;
}

export const KpiBar: React.FC<KpiBarProps> = ({ kpi }) => {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
        gap: "12px",
        marginBottom: "16px"
      }}
    >
      {/* 1. Present vs Required */}
      <div style={cardStyle}>
        <div style={titleStyle}>{vi.kpi.presentRequired}</div>
        <div style={valueStyle}>
          {kpi.present} <span style={{ fontSize: "1rem", color: "#94a3b8" }}>/ {kpi.required}</span>
        </div>
      </div>

      {/* 2. Gap */}
      <div style={{ ...cardStyle, borderLeft: kpi.gap > 0 ? "4px solid #f59e0b" : "4px solid #22c55e" }}>
        <div style={titleStyle}>{vi.kpi.headcountGap}</div>
        <div style={{ ...valueStyle, color: kpi.gap > 0 ? "#f59e0b" : "#22c55e" }}>
          {kpi.gap} <span style={{ fontSize: "0.9rem" }}>({Math.round((kpi.gap / (kpi.required || 1)) * 100)}%)</span>
        </div>
      </div>

      {/* 3. Tier 1 Vacant Minutes */}
      <div style={{ ...cardStyle, borderLeft: kpi.tier1VacantMinutes > 0 ? "4px solid #ef4444" : "4px solid #22c55e" }}>
        <div style={titleStyle}>{vi.kpi.tier1VacantMinutes}</div>
        <div style={{ ...valueStyle, color: kpi.tier1VacantMinutes > 0 ? "#ef4444" : "#22c55e" }}>
          {kpi.tier1VacantMinutes.toFixed(1)} <span style={{ fontSize: "0.9rem" }}>phút</span>
        </div>
      </div>

      {/* 4. Open Incidents */}
      <div style={{ ...cardStyle, borderLeft: kpi.openIncidents > 0 ? "4px solid #ef4444" : "4px solid #22c55e" }}>
        <div style={titleStyle}>{vi.kpi.openIncidents}</div>
        <div style={{ ...valueStyle, color: kpi.openIncidents > 0 ? "#ef4444" : "#22c55e" }}>
          {kpi.openIncidents}
        </div>
      </div>

      {/* 5. WS Latency */}
      <div style={cardStyle}>
        <div style={titleStyle}>{vi.kpi.wsLatency}</div>
        <div style={valueStyle}>
          {kpi.wsLatencyMs} <span style={{ fontSize: "0.9rem", color: "#94a3b8" }}>ms</span>
        </div>
      </div>
    </div>
  );
};

const cardStyle: React.CSSProperties = {
  background: "#1e293b",
  border: "1px solid #334155",
  borderRadius: "8px",
  padding: "12px 16px",
  color: "#f8fafc"
};

const titleStyle: React.CSSProperties = {
  fontSize: "0.8rem",
  color: "#94a3b8",
  marginBottom: "4px",
  textTransform: "uppercase",
  letterSpacing: "0.05em"
};

const valueStyle: React.CSSProperties = {
  fontSize: "1.6rem",
  fontWeight: 700
};

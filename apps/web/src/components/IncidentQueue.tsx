import React from "react";
import vi from "../i18n/vi.json";

export interface IncidentItem {
  id: number;
  type: string;
  severity: string;
  postId?: string | null;
  status: string;
  openedAt: string;
  description?: string;
  explain?: {
    winner?: { guardId: number; guardCode?: string; score: number; reason: string };
    rejected?: Array<{ guardId: number; guardCode?: string; reason: string }>;
  } | null;
}

interface IncidentQueueProps {
  incidents: IncidentItem[];
  onApprove?: (id: number) => void;
  onOverride?: (id: number) => void;
}

export const IncidentQueue: React.FC<IncidentQueueProps> = ({
  incidents,
  onApprove,
  onOverride
}) => {
  return (
    <div style={{ background: "#1e293b", borderRadius: "12px", padding: "16px", color: "#f8fafc", border: "1px solid #334155" }}>
      <h3 style={{ margin: "0 0 12px 0", fontSize: "1.1rem", fontWeight: 600 }}>
        {vi.incidents.title} ({incidents.length})
      </h3>

      {incidents.length === 0 ? (
        <div style={{ padding: "24px", textAlign: "center", color: "#94a3b8", fontSize: "0.95rem" }}>
          {vi.incidents.empty}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "12px", maxHeight: "400px", overflowY: "auto" }}>
          {incidents.map((item) => (
            <div
              key={item.id}
              style={{
                background: "#0f172a",
                border: "1px solid #475569",
                borderRadius: "8px",
                padding: "12px 16px"
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
                <span style={{ fontWeight: 700, color: item.severity === "HIGH" ? "#ef4444" : "#f59e0b" }}>
                  [{item.severity}] {item.type} {item.postId ? `— Vị trí: ${item.postId}` : ""}
                </span>
                <span style={{ fontSize: "0.8rem", color: "#94a3b8" }}>
                  {new Date(item.openedAt).toLocaleTimeString()}
                </span>
              </div>

              {item.description && (
                <p style={{ margin: "4px 0 8px 0", fontSize: "0.9rem", color: "#cbd5e1" }}>
                  {item.description}
                </p>
              )}

              {/* Explain box (§15) */}
              {item.explain && (
                <div style={{ background: "#1e293b", padding: "8px 12px", borderRadius: "6px", margin: "8px 0", fontSize: "0.85rem" }}>
                  <div style={{ fontWeight: 600, color: "#60a5fa" }}>{vi.incidents.explain}</div>
                  {item.explain.winner && (
                    <div style={{ color: "#86efac", marginTop: "2px" }}>
                      ✓ Chọn: Bảo vệ #{item.explain.winner.guardId} (Điểm: {item.explain.winner.score}) — {item.explain.winner.reason}
                    </div>
                  )}
                  {item.explain.rejected && item.explain.rejected.length > 0 && (
                    <div style={{ marginTop: "4px", color: "#fca5a5" }}>
                      ✕ {vi.incidents.rejectedGuards}{" "}
                      {item.explain.rejected.map((r) => `#${r.guardId} (${r.reason})`).join(", ")}
                    </div>
                  )}
                </div>
              )}

              {/* Action buttons */}
              <div style={{ display: "flex", gap: "8px", marginTop: "8px" }}>
                <button
                  onClick={() => onApprove && onApprove(item.id)}
                  style={{
                    background: "#22c55e",
                    color: "#fff",
                    border: "none",
                    borderRadius: "6px",
                    padding: "6px 14px",
                    cursor: "pointer",
                    fontWeight: 600
                  }}
                >
                  {vi.incidents.approve}
                </button>
                <button
                  onClick={() => onOverride && onOverride(item.id)}
                  style={{
                    background: "#334155",
                    color: "#e2e8f0",
                    border: "1px solid #64748b",
                    borderRadius: "6px",
                    padding: "6px 14px",
                    cursor: "pointer"
                  }}
                >
                  {vi.incidents.override}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

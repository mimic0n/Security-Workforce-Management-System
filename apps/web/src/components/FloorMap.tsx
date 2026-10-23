import React, { useState } from "react";
import vi from "../i18n/vi.json";

export interface PostDisplay {
  id: string;
  name: string;
  tier: "TIER1" | "TIER2";
  zone: string;
  x: number;
  y: number;
  status: string;
  guardId?: number | null;
  guardCode?: string | null;
  guardName?: string | null;
  since?: string | null;
  version?: number;
}

interface FloorMapProps {
  posts: PostDisplay[];
  onSelectPost?: (post: PostDisplay) => void;
}

export const FloorMap: React.FC<FloorMapProps> = ({ posts, onSelectPost }) => {
  const [selectedPost, setSelectedPost] = useState<PostDisplay | null>(null);

  const getStatusColor = (status: string) => {
    switch (status) {
      case "OCCUPIED":
        return "#22c55e"; // green
      case "HANDOVER_PENDING":
      case "RELIEVED_FOR_MEAL":
        return "#f59e0b"; // amber
      case "UNCERTAIN":
        return "url(#yellow-hatch)"; // yellow-hatched
      case "VACANT_ALERT":
        return "#ef4444"; // red pulsing
      case "VACANT_PLANNED":
      case "COVERED_BY_PAIR":
        return "#f97316"; // orange
      case "NOT_ACTIVE":
      default:
        return "#6b7280"; // grey
    }
  };

  const getStatusGlyph = (status: string) => {
    switch (status) {
      case "OCCUPIED":
        return "✓";
      case "HANDOVER_PENDING":
      case "RELIEVED_FOR_MEAL":
        return "☕";
      case "UNCERTAIN":
        return "?";
      case "VACANT_ALERT":
        return "⚠";
      case "VACANT_PLANNED":
      case "COVERED_BY_PAIR":
        return "⇄";
      case "NOT_ACTIVE":
      default:
        return "—";
    }
  };

  const handlePostClick = (p: PostDisplay) => {
    setSelectedPost(p);
    if (onSelectPost) {
      onSelectPost(p);
    }
  };

  return (
    <div style={{ position: "relative", width: "100%", background: "#0f172a", borderRadius: "12px", padding: "16px", color: "#f8fafc" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
        <h3 style={{ margin: 0, fontSize: "1.1rem", fontWeight: 600 }}>{vi.floorMap.title}</h3>
        <div style={{ display: "flex", gap: "12px", fontSize: "0.85rem", alignItems: "center" }}>
          <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
            <span style={{ width: 14, height: 14, borderRadius: "50%", border: "3px solid #f8fafc", display: "inline-block" }}></span>
            {vi.floorMap.tier1Label}
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
            <span style={{ width: 14, height: 14, borderRadius: "50%", border: "1px solid #94a3b8", display: "inline-block" }}></span>
            {vi.floorMap.tier2Label}
          </span>
        </div>
      </div>

      <svg
        viewBox="0 0 980 640"
        style={{ width: "100%", height: "auto", background: "#1e293b", borderRadius: "8px", border: "1px solid #334155" }}
      >
        <defs>
          {/* Yellow diagonal hatching for UNCERTAIN state */}
          <pattern id="yellow-hatch" width="8" height="8" patternTransform="rotate(45 0 0)" patternUnits="userSpaceOnUse">
            <line x1="0" y1="0" x2="0" y2="8" stroke="#eab308" strokeWidth="4" />
            <line x1="4" y1="0" x2="4" y2="8" stroke="#713f12" strokeWidth="4" />
          </pattern>
          {/* Pulsing animation style for VACANT_ALERT */}
          <style>
            {`
              @keyframes pulseRed {
                0% { r: 24px; opacity: 1; }
                50% { r: 30px; opacity: 0.6; }
                100% { r: 24px; opacity: 1; }
              }
              .pulsing-alert {
                animation: pulseRed 1.2s infinite ease-in-out;
              }
            `}
          </style>
        </defs>

        {/* Floor Zones Architecture Outlines */}
        <rect x="40" y="40" width="880" height="540" rx="16" fill="#1e293b" stroke="#475569" strokeWidth="3" />
        {/* Mall Corridors & Departments */}
        <rect x="70" y="70" width="220" height="480" rx="8" fill="#334155" stroke="#64748b" strokeDasharray="4,4" opacity="0.6" />
        <text x="180" y="310" textAnchor="middle" fill="#94a3b8" fontSize="13" fontWeight="bold">KHU BÁCH HÓA (AEON DEPT)</text>

        <rect x="330" y="70" width="560" height="480" rx="8" fill="#1e293b" stroke="#64748b" strokeDasharray="4,4" opacity="0.6" />
        <text x="610" y="110" textAnchor="middle" fill="#94a3b8" fontSize="13" fontWeight="bold">SẢNH TRUNG TÂM & GIAN HÀNG THƯƠNG MẠI</text>

        {/* 14 Post Markers */}
        {posts.map((p) => {
          const isTier1 = p.tier === "TIER1";
          const isAlert = p.status === "VACANT_ALERT";
          const fillColor = getStatusColor(p.status);
          const glyph = getStatusGlyph(p.status);

          return (
            <g
              key={p.id}
              data-testid={`post-marker-${p.id}`}
              style={{ cursor: "pointer" }}
              onClick={() => handlePostClick(p)}
            >
              {/* Pulsing ring for alerts */}
              {isAlert && (
                <circle
                  cx={p.x}
                  cy={p.y}
                  r="30"
                  fill="#ef4444"
                  opacity="0.3"
                  className="pulsing-alert"
                />
              )}

              {/* Base Marker Circle */}
              <circle
                cx={p.x}
                cy={p.y}
                r="22"
                fill={fillColor}
                stroke={isTier1 ? "#f8fafc" : "#94a3b8"}
                strokeWidth={isTier1 ? 4 : 1.5}
                data-status={p.status}
              />

              {/* Status Glyph Icon */}
              <text
                x={p.x}
                y={p.y + 5}
                textAnchor="middle"
                fill={p.status === "UNCERTAIN" ? "#000" : "#ffffff"}
                fontSize="14"
                fontWeight="900"
                pointerEvents="none"
              >
                {glyph}
              </text>

              {/* Post Label: ID + Guard Code */}
              <text
                x={p.x}
                y={p.y + 36}
                textAnchor="middle"
                fill="#f1f5f9"
                fontSize="12"
                fontWeight="bold"
                style={{ textShadow: "0 1px 3px rgba(0,0,0,0.8)" }}
              >
                {p.id} {p.guardCode ? `(${p.guardCode})` : ""}
              </text>
            </g>
          );
        })}
      </svg>

      {/* Post Details Drawer / Modal */}
      {selectedPost && (
        <div
          data-testid="post-drawer"
          style={{
            position: "absolute",
            right: 20,
            bottom: 20,
            width: 320,
            background: "#1e293b",
            border: "2px solid #3b82f6",
            borderRadius: "8px",
            padding: "16px",
            boxShadow: "0 10px 25px rgba(0,0,0,0.5)",
            zIndex: 10
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
            <h4 style={{ margin: 0, color: "#60a5fa" }}>
              {selectedPost.id} — {selectedPost.name}
            </h4>
            <button
              onClick={() => setSelectedPost(null)}
              style={{ background: "none", border: "none", color: "#94a3b8", cursor: "pointer", fontSize: "16px" }}
            >
              ✕
            </button>
          </div>
          <p style={{ margin: "4px 0", fontSize: "0.9rem" }}>
            <strong>Cấp bậc:</strong> {selectedPost.tier === "TIER1" ? "Tier 1 (Không được phép trống)" : "Tier 2"}
          </p>
          <p style={{ margin: "4px 0", fontSize: "0.9rem" }}>
            <strong>Khu vực:</strong> {selectedPost.zone}
          </p>
          <p style={{ margin: "4px 0", fontSize: "0.9rem" }}>
            <strong>Trạng thái:</strong>{" "}
            <span style={{ color: selectedPost.status === "VACANT_ALERT" ? "#ef4444" : "#22c55e", fontWeight: "bold" }}>
              {(vi.statuses as Record<string, string>)[selectedPost.status] || selectedPost.status}
            </span>
          </p>
          <p style={{ margin: "4px 0", fontSize: "0.9rem" }}>
            <strong>Bảo vệ đảm nhiệm:</strong> {selectedPost.guardName || selectedPost.guardCode || "Chưa có"}
          </p>
          {selectedPost.since && (
            <p style={{ margin: "4px 0", fontSize: "0.8rem", color: "#94a3b8" }}>
              Từ lúc: {new Date(selectedPost.since).toLocaleTimeString()}
            </p>
          )}
        </div>
      )}
    </div>
  );
};

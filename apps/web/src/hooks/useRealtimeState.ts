import { useState, useEffect, useRef, useCallback } from "react";
import { io, Socket } from "socket.io-client";
import { PostDisplay } from "../components/FloorMap.js";
import { KpiData } from "../components/KpiBar.js";
import { IncidentItem } from "../components/IncidentQueue.js";

const DEFAULT_POSTS: PostDisplay[] = [
  { id: "G1", name: "Cổng Võ Văn Tân", zone: "north gate", tier: "TIER1", x: 100, y: 100, status: "OCCUPIED", guardCode: "G01" },
  { id: "G2", name: "Cổng Hải Phòng", zone: "east gate", tier: "TIER2", x: 800, y: 300, status: "OCCUPIED", guardCode: "G02" },
  { id: "G3", name: "Cổng Điện Biên Phủ", zone: "main facade", tier: "TIER2", x: 500, y: 550, status: "OCCUPIED", guardCode: "G03" },
  { id: "G4", name: "Cổng Bách hóa góc dưới", zone: "south dept gate", tier: "TIER1", x: 200, y: 550, status: "OCCUPIED", guardCode: "G04" },
  { id: "G5", name: "Cổng Bách hóa góc trên", zone: "north dept gate", tier: "TIER1", x: 200, y: 100, status: "OCCUPIED", guardCode: "G05" },
  { id: "G6", name: "Cổng Hầm giữ xe", zone: "basement ramp", tier: "TIER2", x: 850, y: 500, status: "OCCUPIED", guardCode: "G06" },
  { id: "P1", name: "Sảnh Mặt Trời", zone: "AEON Delica", tier: "TIER1", x: 300, y: 250, status: "OCCUPIED", guardCode: "G07" },
  { id: "P2", name: "Khu vực Langfarm", zone: "specialty", tier: "TIER2", x: 450, y: 250, status: "OCCUPIED", guardCode: "G08" },
  { id: "P3", name: "Sảnh Mặt Trăng", zone: "event hall", tier: "TIER2", x: 600, y: 250, status: "OCCUPIED", guardCode: "G09" },
  { id: "P4", name: "AEON Bakery", zone: "bakery exit", tier: "TIER2", x: 650, y: 400, status: "OCCUPIED", guardCode: "G10" },
  { id: "P5", name: "Cụm Cafe", zone: "Starbucks/Phê La", tier: "TIER2", x: 500, y: 400, status: "OCCUPIED", guardCode: "G11" },
  { id: "P6", name: "Thang cuốn Bách hóa", zone: "dept escalator", tier: "TIER1", x: 350, y: 400, status: "OCCUPIED", guardCode: "G12" },
  { id: "P7", name: "Cụm Thang máy", zone: "dept elevators", tier: "TIER1", x: 350, y: 150, status: "OCCUPIED", guardCode: "G13" },
  { id: "P8", name: "Quầy Thu ngân/Thông tin", zone: "cashier/info", tier: "TIER1", x: 250, y: 350, status: "OCCUPIED", guardCode: "G14" }
];

export function useRealtimeState(apiUrl: string, token: string | null) {
  const [posts, setPosts] = useState<PostDisplay[]>(DEFAULT_POSTS);
  const [siteMode, setSiteMode] = useState<"NORMAL" | "EMERGENCY">("NORMAL");
  const [kpi, setKpi] = useState<KpiData>({
    present: 45,
    required: 60,
    gap: 15,
    tier1VacantMinutes: 0.0,
    openIncidents: 0,
    wsLatencyMs: 12
  });
  const [incidents, setIncidents] = useState<IncidentItem[]>([]);
  const [connected, setConnected] = useState(false);

  const lastSeqRef = useRef<number>(0);
  const socketRef = useRef<Socket | null>(null);

  // Fetch full state snapshot on gap or reconnect (§11)
  const fetchSnapshot = useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetch(`${apiUrl}/state/snapshot`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        lastSeqRef.current = data.lastSeq || 0;
        if (data.site?.mode) {
          setSiteMode(data.site.mode);
        }
        if (Array.isArray(data.posts)) {
          setPosts((prev) =>
            prev.map((p) => {
              const updated = data.posts.find((sp: any) => sp.post_id === p.id);
              if (updated) {
                return {
                  ...p,
                  status: updated.status,
                  guardId: updated.guard_id,
                  since: updated.since,
                  version: updated.version
                };
              }
              return p;
            })
          );
        }
      }
    } catch (err) {
      console.error("Failed to fetch state snapshot:", err);
    }
  }, [apiUrl, token]);

  useEffect(() => {
    if (!token) return;

    fetchSnapshot();

    const socket = io(apiUrl, {
      auth: { token },
      transports: ["websocket"]
    });
    socketRef.current = socket;

    socket.on("connect", () => {
      setConnected(true);
      fetchSnapshot();
    });

    socket.on("disconnect", () => {
      setConnected(false);
    });

    // Handle incoming envelopes with sequence tracking (§11)
    const handleEnvelope = (envelope: any) => {
      if (!envelope || typeof envelope.seq !== "number") return;

      // Gap detection: if missed any messages, request state snapshot
      if (lastSeqRef.current > 0 && envelope.seq > lastSeqRef.current + 1) {
        fetchSnapshot();
        return;
      }
      lastSeqRef.current = envelope.seq;

      const { type, payload } = envelope;

      if (type === "post.state_changed" && payload?.postId) {
        setPosts((prev) =>
          prev.map((p) => {
            if (p.id === payload.postId) {
              return {
                ...p,
                status: payload.toStatus || p.status,
                guardId: payload.guardId !== undefined ? payload.guardId : p.guardId,
                since: payload.since || envelope.ts
              };
            }
            return p;
          })
        );
      } else if (type === "emergency.started") {
        setSiteMode("EMERGENCY");
      } else if (type === "emergency.cleared") {
        setSiteMode("NORMAL");
      } else if (type === "kpi.updated" && payload) {
        setKpi((prev) => ({ ...prev, ...payload }));
      } else if (type === "incident.opened" && payload) {
        setIncidents((prev) => [payload, ...prev]);
      } else if (type === "incident.closed" && payload?.id) {
        setIncidents((prev) => prev.filter((inc) => inc.id !== payload.id));
      }
    };

    socket.on("post.state_changed", handleEnvelope);
    socket.on("emergency.started", handleEnvelope);
    socket.on("emergency.cleared", handleEnvelope);
    socket.on("kpi.updated", handleEnvelope);
    socket.on("incident.opened", handleEnvelope);
    socket.on("incident.closed", handleEnvelope);
    socket.on("message", handleEnvelope);

    return () => {
      socket.disconnect();
    };
  }, [apiUrl, token, fetchSnapshot]);

  return {
    posts,
    siteMode,
    kpi,
    incidents,
    connected,
    setSiteMode,
    refreshSnapshot: fetchSnapshot
  };
}

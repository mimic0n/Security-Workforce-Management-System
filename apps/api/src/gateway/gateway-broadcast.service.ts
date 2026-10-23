import { Injectable, Inject, OnModuleInit } from "@nestjs/common";
import { Server } from "socket.io";
import { EventBusService } from "../core/events/event-bus.service.js";
import { OutboxEnvelope, WebSocketRooms, WebSocketTopics } from "@swms/contracts";

@Injectable()
export class GatewayBroadcastService implements OnModuleInit {
  private server: Server | null = null;

  constructor(
    @Inject(EventBusService) private readonly eventBus: EventBusService
  ) {}

  onModuleInit() {
    // Listen to all outbox topic events emitted on EventBusService
    const allTopics = [
      WebSocketTopics.POST_STATE_CHANGED,
      WebSocketTopics.KPI_UPDATED,
      WebSocketTopics.INCIDENT_OPENED,
      WebSocketTopics.INCIDENT_CLOSED,
      WebSocketTopics.DISPATCH_PROPOSED,
      WebSocketTopics.DISPATCH_EXECUTED,
      WebSocketTopics.DISPATCH_ACKED,
      WebSocketTopics.DISPATCH_DECLINED,
      WebSocketTopics.DISPATCH_EXPIRED,
      WebSocketTopics.DISPATCH_OVERRIDE,
      WebSocketTopics.SITE_MODE_CHANGED,
      WebSocketTopics.STAFFING_UPDATED,
      WebSocketTopics.DISPATCH_ORDER,
      WebSocketTopics.SCHEDULE_UPDATED,
      WebSocketTopics.BREAK_LOCKED,
      WebSocketTopics.BREAK_UNLOCKED,
      WebSocketTopics.QR_CHALLENGE,
      WebSocketTopics.ANNOUNCEMENT,
      WebSocketTopics.EMERGENCY_STARTED,
      WebSocketTopics.EMERGENCY_CLEARED
    ];

    for (const topic of allTopics) {
      this.eventBus.on(topic, (envelope: OutboxEnvelope) => {
        this.broadcast(topic, envelope);
      });
    }
  }

  /**
   * Set the active Socket.IO server instance
   */
  setServer(server: Server) {
    this.server = server;
  }

  /**
   * Route an outbox envelope to appropriate Socket.IO room(s) based on topic & payload (§11)
   */
  broadcast(topic: string, envelope: OutboxEnvelope) {
    if (!this.server) {
      return;
    }

    const payload = envelope.payload || {};
    const siteId = payload.siteId || "AEON_THANH_KHE_F1";

    // 1. Emergency room: everyone connected receives emergency messages
    if (
      topic === WebSocketTopics.EMERGENCY_STARTED ||
      topic === WebSocketTopics.EMERGENCY_CLEARED ||
      payload.siteMode === "EMERGENCY"
    ) {
      const emergencyRoom = WebSocketRooms.emergency(siteId);
      this.server.to(emergencyRoom).emit(envelope.type, envelope);
      this.server.to(emergencyRoom).emit("message", envelope);
      return;
    }

    // 2. Guard private room: only that guard receives guard-targeted messages
    if (
      topic === WebSocketTopics.DISPATCH_ORDER ||
      topic === WebSocketTopics.SCHEDULE_UPDATED ||
      topic === WebSocketTopics.BREAK_LOCKED ||
      topic === WebSocketTopics.BREAK_UNLOCKED ||
      topic === WebSocketTopics.QR_CHALLENGE
    ) {
      const guardId = payload.guardId || payload.to_guard_id || payload.toGuardId;
      if (guardId) {
        const guardRoom = WebSocketRooms.guard(Number(guardId));
        this.server.to(guardRoom).emit(envelope.type, envelope);
        this.server.to(guardRoom).emit("message", envelope);
      }
      return;
    }

    // 3. Shift room: all guards in a particular shift
    if (topic === WebSocketTopics.ANNOUNCEMENT && payload.shiftKey) {
      const shiftRoom = WebSocketRooms.shift(siteId, payload.shiftKey);
      this.server.to(shiftRoom).emit(envelope.type, envelope);
      this.server.to(shiftRoom).emit("message", envelope);
      return;
    }

    // 4. Dashboard room: dispatcher, manager (deltas, incidents, KPI, dispatch lifecycle)
    const dashboardRoom = WebSocketRooms.dashboard(siteId);
    this.server.to(dashboardRoom).emit(envelope.type, envelope);
    this.server.to(dashboardRoom).emit("message", envelope);

    // If a dispatch order was acked/declined, also notify the respective guard room if available
    if (
      (topic === WebSocketTopics.DISPATCH_ACKED || topic === WebSocketTopics.DISPATCH_DECLINED) &&
      payload.guardId
    ) {
      const guardRoom = WebSocketRooms.guard(Number(payload.guardId));
      this.server.to(guardRoom).emit(envelope.type, envelope);
    }
  }
}

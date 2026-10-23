import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket
} from "@nestjs/websockets";
import { Server, Socket } from "socket.io";
import { Inject, forwardRef } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { GatewayBroadcastService } from "./gateway-broadcast.service.js";
import { DispatchService } from "../modules/dispatch/dispatch.service.js";
import { WebSocketRooms, ClientDispatchAckSchema, ClientDispatchDeclineSchema } from "@swms/contracts";
import { JwtPayload } from "../core/auth/jwt-payload.interface.js";

@WebSocketGateway({
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
})
export class RealtimeGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server!: Server;

  constructor(
    @Inject(JwtService) private readonly jwtService: JwtService,
    @Inject(GatewayBroadcastService) private readonly broadcastService: GatewayBroadcastService,
    @Inject(forwardRef(() => DispatchService)) private readonly dispatchService: DispatchService
  ) {}

  afterInit(server: Server) {
    this.broadcastService.setServer(server);

    // Handshake authentication middleware (§11)
    server.use((socket, next) => {
      let rawToken =
        socket.handshake.auth?.token ||
        socket.handshake.headers?.authorization ||
        (socket.handshake.query?.token as string);

      if (!rawToken) {
        return next(new Error("Authentication token missing"));
      }

      if (rawToken.startsWith("Bearer ")) {
        rawToken = rawToken.slice(7).trim();
      }

      try {
        const payload: JwtPayload = this.jwtService.verify(rawToken);
        if (!payload || !payload.sub || !payload.role) {
          return next(new Error("Invalid token payload"));
        }
        socket.data.user = payload;
        next();
      } catch (err: any) {
        return next(new Error("Unauthorized: " + (err.message || "Invalid token")));
      }
    });
  }

  async handleConnection(client: Socket) {
    const payload = client.data.user as JwtPayload | undefined;
    if (!payload) {
      client.disconnect(true);
      return;
    }

    const siteId = (client.handshake.query?.siteId as string) || "AEON_THANH_KHE_F1";

    // 3. Role-based Room Isolation (§11):
    // emergency:{siteId} — everyone connected joins
    client.join(WebSocketRooms.emergency(siteId));

    // dashboard:{siteId} — only dispatcher and manager (and admin)
    if (
      payload.role === "DISPATCHER" ||
      payload.role === "MANAGER" ||
      payload.role === "ADMIN"
    ) {
      client.join(WebSocketRooms.dashboard(siteId));
    }

    // guard:{guardId} — that guard only
    if (payload.guard_id) {
      client.join(WebSocketRooms.guard(Number(payload.guard_id)));
    }

    // shift:{siteId}:{shiftKey} — if provided or user active in shift
    const shiftKey = client.handshake.query?.shiftKey as string;
    if (shiftKey) {
      client.join(WebSocketRooms.shift(siteId, shiftKey));
    }
  }

  handleDisconnect(client: Socket) {
    // Cleanup if necessary
    client.data = {};
  }

  /**
   * App-level ACK for dispatch orders over Socket.IO (§11)
   */
  @SubscribeMessage("dispatch.ack")
  async handleDispatchAck(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: any
  ) {
    const parse = ClientDispatchAckSchema.safeParse(body);
    if (!parse.success) {
      return { success: false, error: "Invalid ACK payload" };
    }

    const { orderId } = parse.data;
    const user = client.data.user as JwtPayload | undefined;
    const effectiveGuardId = parse.data.guardId || user?.guard_id || undefined;

    try {
      const order = await this.dispatchService.ackOrder(orderId, effectiveGuardId);
      return { success: true, orderId: order.id, status: order.status };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  /**
   * App-level Decline for dispatch orders over Socket.IO (§11)
   */
  @SubscribeMessage("dispatch.decline")
  async handleDispatchDecline(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: any
  ) {
    const parse = ClientDispatchDeclineSchema.safeParse(body);
    if (!parse.success) {
      return { success: false, error: "Invalid Decline payload" };
    }

    const { orderId, reason } = parse.data;

    try {
      const order = await this.dispatchService.declineOrder(orderId, reason);
      return { success: true, orderId: order.id, status: order.status };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }
}

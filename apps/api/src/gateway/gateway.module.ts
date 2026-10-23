import { Module, forwardRef } from "@nestjs/common";
import { RealtimeGateway } from "./realtime.gateway.js";
import { GatewayBroadcastService } from "./gateway-broadcast.service.js";
import { AuthModule } from "../core/auth/auth.module.js";
import { DispatchModule } from "../modules/dispatch/dispatch.module.js";
import { EventsModule } from "../core/events/event-bus.service.js";

@Module({
  imports: [
    AuthModule,
    EventsModule,
    forwardRef(() => DispatchModule)
  ],
  providers: [
    RealtimeGateway,
    GatewayBroadcastService
  ],
  exports: [
    RealtimeGateway,
    GatewayBroadcastService
  ]
})
export class GatewayModule {}

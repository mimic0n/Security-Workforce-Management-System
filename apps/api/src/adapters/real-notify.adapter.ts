import { Injectable } from "@nestjs/common";
import { NotifyPort, NotificationMessage } from "./ports/notify.port.js";

/**
 * Real Notify Adapter (skeleton).
 * Real integration with SMS gateway (e.g. eSMS, SpeedSMS) / Zalo ZNS.
 * Simulation-only thesis environment; real devices not deployed.
 */
@Injectable()
export class RealNotifyAdapter implements NotifyPort {
  async sendNotification(_msg: NotificationMessage): Promise<void> {
    throw new Error("Real SMS/Zalo gateway not configured in simulation environment");
  }
}

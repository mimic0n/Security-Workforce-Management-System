import { Injectable } from "@nestjs/common";
import { FireAlarmPort } from "./ports/fire-alarm.port.js";

/**
 * Real Fire Alarm Adapter (skeleton).
 * Real integration with site addressable fire alarm panel (BACnet/Modbus).
 * Simulation-only thesis environment; real devices not deployed.
 */
@Injectable()
export class RealFireAlarmAdapter implements FireAlarmPort {
  async triggerAlarm(_zone?: string): Promise<any> {
    throw new Error("Real fire alarm panel not connected in simulation environment");
  }

  async clearAlarm(): Promise<any> {
    throw new Error("Real fire alarm panel not connected in simulation environment");
  }
}

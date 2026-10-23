import { Injectable, Inject } from "@nestjs/common";
import { FireAlarmPort } from "./ports/fire-alarm.port.js";
import { DispatchService } from "../modules/dispatch/dispatch.service.js";
import { CLOCK_TOKEN, type Clock } from "../core/clock/clock.interface.js";

@Injectable()
export class MockFireAlarmAdapter implements FireAlarmPort {
  constructor(
    @Inject(DispatchService) private readonly dispatchService: DispatchService,
    @Inject(CLOCK_TOKEN) private readonly clock: Clock
  ) {}

  async triggerAlarm(zone = "FLOOR1"): Promise<any> {
    const now = this.clock.now();
    return this.dispatchService.applyWithRetry({
      kind: "FIRE_ALARM",
      payload: { zone },
      siteId: "AEON_THANH_KHE_F1",
      simTs: now
    });
  }

  async clearAlarm(): Promise<any> {
    const now = this.clock.now();
    return this.dispatchService.applyWithRetry({
      kind: "EMERGENCY_CLEARED",
      payload: {},
      siteId: "AEON_THANH_KHE_F1",
      simTs: now
    });
  }
}

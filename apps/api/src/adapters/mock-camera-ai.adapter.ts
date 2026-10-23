import { Injectable, Inject } from "@nestjs/common";
import { CameraAiPort, CameraAiEvent } from "./ports/camera-ai.port.js";
import { DispatchQueueService } from "../modules/dispatch/engine/queue.service.js";
import { CLOCK_TOKEN, type Clock } from "../core/clock/clock.interface.js";

export function getShiftKeyFromDate(date: Date): string {
  const vnTime = new Date(date.getTime() + 7 * 60 * 60 * 1000);
  const hour = vnTime.getUTCHours();
  let shift: "MORNING" | "AFTERNOON" | "NIGHT" = "MORNING";
  let shiftDate = vnTime;

  if (hour >= 6 && hour < 14) {
    shift = "MORNING";
  } else if (hour >= 14 && hour < 22) {
    shift = "AFTERNOON";
  } else {
    shift = "NIGHT";
    if (hour < 6) {
      shiftDate = new Date(vnTime.getTime() - 24 * 60 * 60 * 1000);
    }
  }

  const y = shiftDate.getUTCFullYear();
  const m = String(shiftDate.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shiftDate.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}:${shift}`;
}

@Injectable()
export class MockCameraAiAdapter implements CameraAiPort {
  constructor(
    @Inject(DispatchQueueService) private readonly queueService: DispatchQueueService,
    @Inject(CLOCK_TOKEN) private readonly clock: Clock
  ) {}

  async reportMotion(event: CameraAiEvent): Promise<any> {
    const at = event.atTime || this.clock.now();
    const shiftKey = getShiftKeyFromDate(at);

    return this.queueService.enqueue({
      siteId: "AEON_THANH_KHE_F1",
      shiftKey,
      kind: "CAMERA_MOTION",
      payload: {
        postId: event.postId,
        shiftKey,
        confidence: event.confidence ?? 0.95,
        atTime: at.toISOString()
      }
    });
  }
}

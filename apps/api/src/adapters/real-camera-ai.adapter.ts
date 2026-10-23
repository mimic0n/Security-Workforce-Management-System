import { Injectable } from "@nestjs/common";
import { CameraAiPort, CameraAiEvent } from "./ports/camera-ai.port.js";

/**
 * Real Camera AI Adapter (skeleton).
 * Real integration with vendor RTSP / ONVIF AI edge appliances.
 * Simulation-only thesis environment; real devices not deployed.
 */
@Injectable()
export class RealCameraAiAdapter implements CameraAiPort {
  async reportMotion(_event: CameraAiEvent): Promise<any> {
    throw new Error("Real camera AI hardware not connected in simulation environment");
  }
}

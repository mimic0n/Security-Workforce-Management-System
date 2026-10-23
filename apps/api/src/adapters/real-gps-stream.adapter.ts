import { Injectable } from "@nestjs/common";
import { GpsStreamPort, GpsSample } from "./ports/gps-stream.port.js";

/**
 * Real GPS Stream Adapter (skeleton).
 * Real integration with live guard body-worn GPS tracker / mobile telemetry socket.
 * Simulation-only thesis environment; real devices not deployed.
 */
@Injectable()
export class RealGpsStreamAdapter implements GpsStreamPort {
  async sendGpsSample(_sample: GpsSample): Promise<void> {
    throw new Error("Real guard tracker stream not connected in simulation environment");
  }
}

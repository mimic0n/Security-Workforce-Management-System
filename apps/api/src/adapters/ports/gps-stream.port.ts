export interface GpsSample {
  guardId: number;
  postId: string;
  lat: number;
  lon: number;
  accuracy: number;
  atOffsetSec?: number;
  timestamp?: Date;
}

export const GPS_STREAM_PORT = Symbol("GPS_STREAM_PORT");

export interface GpsStreamPort {
  sendGpsSample(sample: GpsSample): Promise<void>;
}

export interface GpsCoordinate {
  lat: number;
  lon: number;
  accuracy_m?: number;
  timestamp?: Date;
}

export interface DebounceConfig {
  geofenceM: number;
  gpsAccuracyMaxM: number;
  outSamplesRequired: number;
  leaveRadiusMultiplier?: number; // default 1.5
}

export interface DebounceResult {
  accepted: boolean;
  filtered: boolean;
  state: "INSIDE" | "OUTSIDE";
  distance_m: number;
  consecutiveOutside: number;
  transitionedToOutside: boolean;
  transitionedToInside: boolean;
  reason?: string;
  median?: { lat: number; lon: number };
}

/**
 * Pure Haversine formula to calculate great-circle distance between two GPS coordinates in meters.
 */
export function calculateHaversineDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371000; // Earth radius in meters
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Calculates the median of a numeric array.
 */
export function calculateMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

/**
 * State tracking for a single guard-post pair.
 */
export class DebounceFilter {
  private window: GpsCoordinate[] = [];
  private state: "INSIDE" | "OUTSIDE" = "INSIDE";
  private consecutiveOutside: number = 0;

  constructor(private readonly config: DebounceConfig) {}

  public getState(): "INSIDE" | "OUTSIDE" {
    return this.state;
  }

  public getConsecutiveOutside(): number {
    return this.consecutiveOutside;
  }

  public reset(state: "INSIDE" | "OUTSIDE" = "INSIDE"): void {
    this.window = [];
    this.state = state;
    this.consecutiveOutside = 0;
  }

  /**
   * Process an incoming GPS sample for the post center coordinates.
   */
  public processSample(sample: GpsCoordinate, postCenter: { lat: number; lon: number }): DebounceResult {
    const accuracy = sample.accuracy_m ?? 0;

    // 1. Accuracy filter: drop samples with accuracy worse than threshold
    if (accuracy > this.config.gpsAccuracyMaxM) {
      return {
        accepted: false,
        filtered: true,
        state: this.state,
        distance_m: 0,
        consecutiveOutside: this.consecutiveOutside,
        transitionedToOutside: false,
        transitionedToInside: false,
        reason: `Sample accuracy ${accuracy}m exceeds max threshold ${this.config.gpsAccuracyMaxM}m`
      };
    }

    // 2. Sliding window of last 5 valid samples
    this.window.push(sample);
    if (this.window.length > 5) {
      this.window.shift();
    }

    // 3. Compute median lat and median lon across window
    const medianLat = calculateMedian(this.window.map((s) => s.lat));
    const medianLon = calculateMedian(this.window.map((s) => s.lon));
    const medianPos = { lat: medianLat, lon: medianLon };

    // 4. Calculate distance from post center
    const distance = calculateHaversineDistance(
      postCenter.lat,
      postCenter.lon,
      medianLat,
      medianLon
    );

    // 5. Hysteresis thresholds
    const enterRadius = this.config.geofenceM;
    const leaveMultiplier = this.config.leaveRadiusMultiplier ?? 1.5;
    const leaveRadius = enterRadius * leaveMultiplier;

    let transitionedToOutside = false;
    let transitionedToInside = false;

    if (this.state === "INSIDE") {
      if (distance > leaveRadius) {
        this.consecutiveOutside += 1;
        if (this.consecutiveOutside >= this.config.outSamplesRequired) {
          this.state = "OUTSIDE";
          transitionedToOutside = true;
        }
      } else {
        this.consecutiveOutside = 0;
      }
    } else {
      // Current state is OUTSIDE
      if (distance <= enterRadius) {
        this.state = "INSIDE";
        this.consecutiveOutside = 0;
        transitionedToInside = true;
      } else {
        this.consecutiveOutside += 1;
      }
    }

    return {
      accepted: true,
      filtered: false,
      state: this.state,
      distance_m: Math.round(distance * 100) / 100,
      consecutiveOutside: this.consecutiveOutside,
      transitionedToOutside,
      transitionedToInside,
      median: medianPos
    };
  }
}

import { describe, it, expect } from "vitest";
import {
  DebounceFilter,
  calculateHaversineDistance,
  calculateMedian
} from "../src/modules/attendance/debounce-filter.js";

describe("Milestone M7 Unit Tests — GPS Debounce Filter & Median Smoothing (§10.2)", () => {
  const postCenter = { lat: 16.065, lon: 108.202 }; // P8 / AEON Thanh Khê

  it("1. Haversine distance and median calculations", () => {
    // 0 distance at center
    const d0 = calculateHaversineDistance(postCenter.lat, postCenter.lon, postCenter.lat, postCenter.lon);
    expect(d0).toBe(0);

    // Approximate 111m for 0.001 deg lat change
    const d1 = calculateHaversineDistance(postCenter.lat, postCenter.lon, postCenter.lat + 0.001, postCenter.lon);
    expect(d1).toBeGreaterThan(100);
    expect(d1).toBeLessThan(120);

    // Median of odd / even arrays
    expect(calculateMedian([10, 20, 30])).toBe(20);
    expect(calculateMedian([10, 40, 20, 30])).toBe(25);
    expect(calculateMedian([])).toBe(0);
  });

  it("2. Drops samples when accuracy exceeds attendance.gps_accuracy_max_m (30m)", () => {
    const filter = new DebounceFilter({
      geofenceM: 25,
      gpsAccuracyMaxM: 30,
      outSamplesRequired: 3,
      leaveRadiusMultiplier: 1.5
    });

    // Sample with accuracy 45m (> 30m)
    const noisySample = {
      lat: postCenter.lat + 0.002, // ~220m away
      lon: postCenter.lon,
      accuracy_m: 45
    };

    const res = filter.processSample(noisySample, postCenter);
    expect(res.accepted).toBe(false);
    expect(res.filtered).toBe(true);
    expect(res.state).toBe("INSIDE");
    expect(res.consecutiveOutside).toBe(0);
    expect(res.reason).toContain("exceeds max threshold");
  });

  it("3. Sliding window of last 5 samples uses median position to filter outliers", () => {
    const filter = new DebounceFilter({
      geofenceM: 25,
      gpsAccuracyMaxM: 30,
      outSamplesRequired: 3,
      leaveRadiusMultiplier: 1.5
    });

    // Feed 4 samples inside (< 5m away)
    for (let i = 0; i < 4; i++) {
      filter.processSample(
        { lat: postCenter.lat, lon: postCenter.lon, accuracy_m: 10 },
        postCenter
      );
    }

    // 5th sample is a momentary GPS glitch (~60m away, outside leaveRadius 37.5m)
    const glitch = filter.processSample(
      { lat: postCenter.lat + 0.0006, lon: postCenter.lon, accuracy_m: 15 },
      postCenter
    );

    // Median of [0, 0, 0, 0, 0.0006] is 0! The glitch is completely smoothed out!
    expect(glitch.accepted).toBe(true);
    expect(glitch.filtered).toBe(false);
    expect(glitch.state).toBe("INSIDE");
    expect(glitch.distance_m).toBe(0);
    expect(glitch.consecutiveOutside).toBe(0);
  });

  it("4. Hysteresis & out_samples_required: requires 3 consecutive outside readings to transition", () => {
    const filter = new DebounceFilter({
      geofenceM: 25,
      gpsAccuracyMaxM: 30,
      outSamplesRequired: 3,
      leaveRadiusMultiplier: 1.5 // leaveRadius = 37.5m
    });

    // Post center: lat: 16.065, lon: 108.202
    // Offset lat by +0.0005 deg ≈ 55m (> 37.5m leave radius)
    const outsideSample = {
      lat: postCenter.lat + 0.0005,
      lon: postCenter.lon,
      accuracy_m: 10
    };

    // 1st outside reading
    const r1 = filter.processSample(outsideSample, postCenter);
    expect(r1.state).toBe("INSIDE");
    expect(r1.consecutiveOutside).toBe(1);
    expect(r1.transitionedToOutside).toBe(false);

    // 2nd outside reading
    const r2 = filter.processSample(outsideSample, postCenter);
    expect(r2.state).toBe("INSIDE");
    expect(r2.consecutiveOutside).toBe(2);
    expect(r2.transitionedToOutside).toBe(false);

    // 3rd outside reading -> triggers transition to OUTSIDE!
    const r3 = filter.processSample(outsideSample, postCenter);
    expect(r3.state).toBe("OUTSIDE");
    expect(r3.consecutiveOutside).toBe(3);
    expect(r3.transitionedToOutside).toBe(true);

    // 4th outside reading -> stays OUTSIDE
    const r4 = filter.processSample(outsideSample, postCenter);
    expect(r4.state).toBe("OUTSIDE");
    expect(r4.consecutiveOutside).toBe(4);
    expect(r4.transitionedToOutside).toBe(false);

    // Returning inside: reading at 30m is <= 37.5m but > 25m (enterRadius).
    // Hysteresis requires distance <= enterRadius (25m) to re-enter!
    const borderSample = {
      lat: postCenter.lat + 0.00028, // ~31m away
      lon: postCenter.lon,
      accuracy_m: 10
    };
    const r5 = filter.processSample(borderSample, postCenter);
    expect(r5.state).toBe("OUTSIDE"); // Still outside due to hysteresis

    // Truly inside sample (< 25m, e.g. at post center)
    // Send enough inside samples to shift the median
    filter.processSample({ lat: postCenter.lat, lon: postCenter.lon, accuracy_m: 5 }, postCenter);
    filter.processSample({ lat: postCenter.lat, lon: postCenter.lon, accuracy_m: 5 }, postCenter);
    const r6 = filter.processSample({ lat: postCenter.lat, lon: postCenter.lon, accuracy_m: 5 }, postCenter);
    expect(r6.state).toBe("INSIDE");
    expect(r6.transitionedToInside).toBe(true);
    expect(r6.consecutiveOutside).toBe(0);
  });
});

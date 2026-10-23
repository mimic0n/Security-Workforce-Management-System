import { describe, it, expect } from "vitest";
import {
  checkMinRest,
  checkMaxWorkDays,
  checkOtCaps,
  checkCertificates,
  checkDoubleBooking,
  estimateAssignmentCost,
  validateLegalAssignment
} from "../src/modules/dispatch/legal-guard/index.js";

describe("Milestone M5 — LegalGuard Boundary & Rule Tests (§9)", () => {
  describe("1. Min Rest Rule (12 hours per Labor Code 2019 Art. 110)", () => {
    const candidate = {
      guardId: 101,
      startTime: new Date("2026-10-25T14:00:00+07:00"),
      endTime: new Date("2026-10-25T22:00:00+07:00")
    };

    it("accepts candidate when previous assignment ended exactly 12h00m before start", () => {
      const prevAssignment = {
        startTime: new Date("2026-10-24T18:00:00+07:00"),
        endTime: new Date("2026-10-25T02:00:00+07:00") // 02:00 to 14:00 = 12h00m
      };

      const result = checkMinRest(candidate, prevAssignment, null, 12);
      expect(result.ok).toBe(true);
      expect(result.violations).toHaveLength(0);
    });

    it("rejects candidate when previous assignment ended 11h59m before start (boundary)", () => {
      const prevAssignment = {
        startTime: new Date("2026-10-24T18:00:00+07:00"),
        endTime: new Date("2026-10-25T02:01:00+07:00") // 02:01 to 14:00 = 11h59m
      };

      const result = checkMinRest(candidate, prevAssignment, null, 12);
      expect(result.ok).toBe(false);
      expect(result.violations).toContain("MIN_REST_HOURS_VIOLATED");
    });

    it("rejects candidate when next assignment starts 11h59m after end", () => {
      const nextAssignment = {
        startTime: new Date("2026-10-26T09:59:00+07:00"), // 22:00 to 09:59 = 11h59m
        endTime: new Date("2026-10-26T18:00:00+07:00")
      };

      const result = checkMinRest(candidate, null, nextAssignment, 12);
      expect(result.ok).toBe(false);
      expect(result.violations).toContain("MIN_REST_HOURS_VIOLATED");
    });

    it("accepts candidate when next assignment starts exactly 12h00m after end", () => {
      const nextAssignment = {
        startTime: new Date("2026-10-26T10:00:00+07:00"), // 22:00 to 10:00 = 12h00m
        endTime: new Date("2026-10-26T18:00:00+07:00")
      };

      const result = checkMinRest(candidate, null, nextAssignment, 12);
      expect(result.ok).toBe(true);
      expect(result.violations).toHaveLength(0);
    });

    it("rejects standard AFTERNOON -> next MORNING rotation (8 h rest)", () => {
      // AFTERNOON: 14:00 - 22:00; Next MORNING: 06:00 - 14:00 (rest = 8h < 12h)
      const afternoon = {
        startTime: new Date("2026-10-24T14:00:00+07:00"),
        endTime: new Date("2026-10-24T22:00:00+07:00")
      };
      const morningNext = {
        guardId: 101,
        startTime: new Date("2026-10-25T06:00:00+07:00"),
        endTime: new Date("2026-10-25T14:00:00+07:00")
      };

      const res = checkMinRest(morningNext, afternoon, null, 12);
      expect(res.ok).toBe(false);
      expect(res.violations).toContain("MIN_REST_HOURS_VIOLATED");
    });

    it("rejects standard NIGHT -> next AFTERNOON rotation (8 h rest)", () => {
      // NIGHT: 22:00 - 06:00; Next AFTERNOON: 14:00 - 22:00 (rest = 8h < 12h)
      const night = {
        startTime: new Date("2026-10-24T22:00:00+07:00"),
        endTime: new Date("2026-10-25T06:00:00+07:00")
      };
      const afternoonNext = {
        guardId: 101,
        startTime: new Date("2026-10-25T14:00:00+07:00"),
        endTime: new Date("2026-10-25T22:00:00+07:00")
      };

      const res = checkMinRest(afternoonNext, night, null, 12);
      expect(res.ok).toBe(false);
      expect(res.violations).toContain("MIN_REST_HOURS_VIOLATED");
    });

    it("rejects standard NIGHT -> next MORNING rotation (0 h rest / overlap)", () => {
      // NIGHT: 22:00 - 06:00; Next MORNING: 06:00 - 14:00 (rest = 0h)
      const night = {
        startTime: new Date("2026-10-24T22:00:00+07:00"),
        endTime: new Date("2026-10-25T06:00:00+07:00")
      };
      const morningSame = {
        guardId: 101,
        startTime: new Date("2026-10-25T06:00:00+07:00"),
        endTime: new Date("2026-10-25T14:00:00+07:00")
      };

      const res = checkMinRest(morningSame, night, null, 12);
      expect(res.ok).toBe(false);
      expect(res.violations).toContain("MIN_REST_HOURS_VIOLATED");
    });
  });

  describe("2. Weekly Days Rule (<= 6 distinct working days per ISO week)", () => {
    // Week of Mon Oct 19 to Sun Oct 25, 2026
    const existingDates6 = [
      "2026-10-19",
      "2026-10-20",
      "2026-10-21",
      "2026-10-22",
      "2026-10-23",
      "2026-10-24"
    ];

    it("accepts candidate on an already-worked date when guard has worked 6 days", () => {
      // Adding another shift on 2026-10-24 (distinct days remains 6)
      const candidateDate = new Date("2026-10-24T14:00:00+07:00");
      const res = checkMaxWorkDays(candidateDate, existingDates6, 6);
      expect(res.ok).toBe(true);
      expect(res.violations).toHaveLength(0);
    });

    it("rejects candidate on a 7th distinct date in the same ISO week (boundary)", () => {
      // 2026-10-25 is Sunday (7th distinct day of the week)
      const candidateDate = new Date("2026-10-25T14:00:00+07:00");
      const res = checkMaxWorkDays(candidateDate, existingDates6, 6);
      expect(res.ok).toBe(false);
      expect(res.violations).toContain("MAX_WORK_DAYS_WEEK_EXCEEDED");
    });

    it("accepts candidate on Sunday when guard only worked 5 previous days", () => {
      const existingDates5 = [
        "2026-10-19",
        "2026-10-20",
        "2026-10-21",
        "2026-10-22",
        "2026-10-23"
      ];
      const candidateDate = new Date("2026-10-25T14:00:00+07:00");
      const res = checkMaxWorkDays(candidateDate, existingDates5, 6);
      expect(res.ok).toBe(true);
    });

    it("correctly separates dates across different ISO weeks", () => {
      // Guard worked Mon-Sat in previous week (Oct 12-17). Working on Mon Oct 19 is week reset.
      const prevWeekDates = [
        "2026-10-12",
        "2026-10-13",
        "2026-10-14",
        "2026-10-15",
        "2026-10-16",
        "2026-10-17"
      ];
      const candidateDate = new Date("2026-10-19T06:00:00+07:00");
      const res = checkMaxWorkDays(candidateDate, prevWeekDates, 6);
      expect(res.ok).toBe(true);
    });
  });

  describe("3. Overtime Caps Rule (Monthly 2400 min / 40h, Yearly 12000 min / 200h)", () => {
    it("accepts candidate when projected monthly OT exactly equals cap (2400 min)", () => {
      // current 2280 min + additional 120 min = 2400 min
      const res = checkOtCaps(2280, 5000, 120, 2400, 12000);
      expect(res.ok).toBe(true);
      expect(res.violations).toHaveLength(0);
    });

    it("rejects candidate when projected monthly OT exceeds cap by 1 minute (2401 min) (boundary)", () => {
      // current 2280 min + additional 121 min = 2401 min
      const res = checkOtCaps(2280, 5000, 121, 2400, 12000);
      expect(res.ok).toBe(false);
      expect(res.violations).toContain("MONTHLY_OT_CAP_EXCEEDED");
    });

    it("accepts candidate when projected yearly OT exactly equals cap (12000 min)", () => {
      // current yearly 11880 + 120 = 12000
      const res = checkOtCaps(1000, 11880, 120, 2400, 12000);
      expect(res.ok).toBe(true);
      expect(res.violations).toHaveLength(0);
    });

    it("rejects candidate when projected yearly OT exceeds cap by 1 minute (12001 min) (boundary)", () => {
      // current yearly 11880 + 121 = 12001
      const res = checkOtCaps(1000, 11880, 121, 2400, 12000);
      expect(res.ok).toBe(false);
      expect(res.violations).toContain("YEARLY_OT_CAP_EXCEEDED");
    });
  });

  describe("4. Certification Validity Rule", () => {
    const shiftDate = new Date("2026-10-24T08:00:00+07:00");

    it("accepts guard whose certificate expires on or after the shift date", () => {
      const validCerts = [
        {
          id: 1,
          cert_no: "SEC-001",
          issued_on: "2025-01-01",
          expires_on: "2026-10-24" // expires on shift date
        }
      ];

      const res = checkCertificates(validCerts, shiftDate);
      expect(res.ok).toBe(true);
    });

    it("rejects guard whose certificate expired 1 day before the shift date (boundary)", () => {
      const expiredCerts = [
        {
          id: 1,
          cert_no: "SEC-001",
          issued_on: "2024-01-01",
          expires_on: "2026-10-23" // expired yesterday
        }
      ];

      const res = checkCertificates(expiredCerts, shiftDate);
      expect(res.ok).toBe(false);
      expect(res.violations).toContain("CERTIFICATE_EXPIRED");
    });

    it("rejects guard with no certifications", () => {
      const res = checkCertificates([], shiftDate);
      expect(res.ok).toBe(false);
      expect(res.violations).toContain("CERTIFICATE_EXPIRED");
    });
  });

  describe("5. Double Booking Rule", () => {
    const existing = [
      {
        startTime: new Date("2026-10-24T06:00:00+07:00"),
        endTime: new Date("2026-10-24T14:00:00+07:00")
      }
    ];

    it("accepts candidate that is exactly contiguous (adjacent) without overlap", () => {
      // Starts right when existing ends at 14:00
      const candidate = {
        startTime: new Date("2026-10-24T14:00:00+07:00"),
        endTime: new Date("2026-10-24T22:00:00+07:00")
      };

      const res = checkDoubleBooking(candidate, existing);
      expect(res.ok).toBe(true);
    });

    it("rejects candidate with 1-minute overlap (boundary)", () => {
      // Starts at 13:59 while previous ends at 14:00
      const candidate = {
        startTime: new Date("2026-10-24T13:59:00+07:00"),
        endTime: new Date("2026-10-24T22:00:00+07:00")
      };

      const res = checkDoubleBooking(candidate, existing);
      expect(res.ok).toBe(false);
      expect(res.violations).toContain("DOUBLE_BOOKING");
    });

    it("rejects candidate fully contained within existing assignment", () => {
      const candidate = {
        startTime: new Date("2026-10-24T08:00:00+07:00"),
        endTime: new Date("2026-10-24T12:00:00+07:00")
      };

      const res = checkDoubleBooking(candidate, existing);
      expect(res.ok).toBe(false);
      expect(res.violations).toContain("DOUBLE_BOOKING");
    });
  });

  describe("6. Cost Estimate Helper (§9 rule 6: Night ×1.3, Day-OT ×1.5, Night-OT ×2.0)", () => {
    it("computes cost for standard 8h day shift (no OT, no night)", () => {
      // 06:00 to 14:00
      const start = new Date("2026-10-24T06:00:00+07:00");
      const end = new Date("2026-10-24T14:00:00+07:00");
      const cost = estimateAssignmentCost(start, end, false, 100);

      expect(cost.regularDayHours).toBe(8);
      expect(cost.regularNightHours).toBe(0);
      expect(cost.otDayHours).toBe(0);
      expect(cost.otNightHours).toBe(0);
      expect(cost.totalCost).toBe(8 * 100); // 800
      expect(cost.effectiveMultiplier).toBe(1.0);
    });

    it("computes cost for night shift (22:00 to 06:00, all 8h night x1.3)", () => {
      const start = new Date("2026-10-24T22:00:00+07:00");
      const end = new Date("2026-10-25T06:00:00+07:00");
      const cost = estimateAssignmentCost(start, end, false, 100);

      expect(cost.regularNightHours).toBe(8);
      expect(cost.regularDayHours).toBe(0);
      expect(cost.totalCost).toBeCloseTo(8 * 100 * 1.3, 2); // 1040
      expect(cost.effectiveMultiplier).toBeCloseTo(1.3, 2);
    });

    it("computes cost for day overtime (4h OT day x1.5)", () => {
      // 14:00 to 18:00 overtime
      const start = new Date("2026-10-24T14:00:00+07:00");
      const end = new Date("2026-10-24T18:00:00+07:00");
      const cost = estimateAssignmentCost(start, end, true, 100);

      expect(cost.otDayHours).toBe(4);
      expect(cost.otNightHours).toBe(0);
      expect(cost.totalCost).toBeCloseTo(4 * 100 * 1.5, 2); // 600
      expect(cost.effectiveMultiplier).toBeCloseTo(1.5, 2);
    });

    it("computes cost for night overtime (4h OT night x2.0)", () => {
      // 22:00 to 02:00 overtime
      const start = new Date("2026-10-24T22:00:00+07:00");
      const end = new Date("2026-10-25T02:00:00+07:00");
      const cost = estimateAssignmentCost(start, end, true, 100);

      expect(cost.otNightHours).toBe(4);
      expect(cost.otDayHours).toBe(0);
      expect(cost.totalCost).toBeCloseTo(4 * 100 * 2.0, 2); // 800
      expect(cost.effectiveMultiplier).toBeCloseTo(2.0, 2);
    });
  });

  describe("7. Combined validateLegalAssignment function", () => {
    it("aggregates all checks and passes when all criteria are satisfied", () => {
      const candidate = {
        guardId: 10,
        startTime: new Date("2026-10-24T06:00:00+07:00"),
        endTime: new Date("2026-10-24T14:00:00+07:00"),
        isOvertime: false
      };

      const result = validateLegalAssignment(candidate, {
        previousAssignment: {
          startTime: new Date("2026-10-23T06:00:00+07:00"),
          endTime: new Date("2026-10-23T14:00:00+07:00")
        },
        nextAssignment: null,
        existingAssignments: [],
        existingDatesInWeek: ["2026-10-23"],
        certifications: [
          {
            id: 1,
            cert_no: "SEC-1",
            issued_on: "2025-01-01",
            expires_on: "2027-01-01"
          }
        ],
        currentOtMonthMin: 100,
        currentOtYearMin: 500,
        policies: {
          minRestHours: 12,
          maxWorkDaysWeek: 6,
          otCapMonthMin: 2400,
          otCapYearMin: 12000
        }
      });

      expect(result.ok).toBe(true);
      expect(result.violations).toHaveLength(0);
    });

    it("returns multiple violations when both rest and certificate fail", () => {
      const candidate = {
        guardId: 10,
        startTime: new Date("2026-10-24T06:00:00+07:00"),
        endTime: new Date("2026-10-24T14:00:00+07:00")
      };

      const result = validateLegalAssignment(candidate, {
        previousAssignment: {
          startTime: new Date("2026-10-23T18:00:00+07:00"),
          endTime: new Date("2026-10-24T00:00:00+07:00") // 6h rest < 12h
        },
        certifications: [], // No cert
        existingDatesInWeek: []
      });

      expect(result.ok).toBe(false);
      expect(result.violations).toContain("MIN_REST_HOURS_VIOLATED");
      expect(result.violations).toContain("CERTIFICATE_EXPIRED");
    });
  });
});

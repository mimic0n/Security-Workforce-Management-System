export interface CandidateGuard {
  id: number;
  code: string;
  role: string;
  floatKind: string | null;
  currentPostId?: string | null;
  otMinutesMonth: number;
  dispatchesToday: number;
}

export interface CandidateScore {
  guardId: number;
  score: number;
  travelMin: number;
  otMinutesMonth: number;
  dispatchesToday: number;
}

export interface CascadeStepResult {
  step: number;
  stepName: string;
  success: boolean;
  winner?: CandidateGuard;
  score?: number;
  orderKind?: "ASSIGNMENT" | "MERGE_POST" | "EARLY_CALL_IN" | "STAY_OVER" | "REVIEW_MOTION" | "OVERRIDE";
  orderStatus?: "PROPOSED" | "SENT" | "ACKED" | "DECLINED" | "EXPIRED" | "CANCELLED";
  fromPost?: string | null;
  toPost: string;
  actions: Array<{
    action: string;
    guardId?: number;
    fromPost?: string;
    toPost?: string;
    reason: string;
  }>;
  rejected: Array<{
    guardId: number;
    role?: string;
    reason: string;
    score?: number;
  }>;
  estimatedCost?: number;
  details?: Record<string, any>;
}

export interface CascadeResult {
  success: boolean;
  step: number;
  stepName: string;
  winner?: CandidateGuard;
  score?: number;
  orderKind?: "ASSIGNMENT" | "MERGE_POST" | "EARLY_CALL_IN" | "STAY_OVER" | "REVIEW_MOTION" | "OVERRIDE";
  orderStatus?: "PROPOSED" | "SENT" | "ACKED" | "DECLINED" | "EXPIRED" | "CANCELLED";
  fromPost?: string | null;
  toPost: string;
  actions: Array<{
    action: string;
    guardId?: number;
    fromPost?: string;
    toPost?: string;
    reason: string;
  }>;
  rejected: Array<{
    guardId: number;
    role?: string;
    reason: string;
    score?: number;
  }>;
  estimatedCost?: number;
  orderId?: number;
  incidentId?: number;
  staffingRequestId?: number;
  details?: Record<string, any>;
}

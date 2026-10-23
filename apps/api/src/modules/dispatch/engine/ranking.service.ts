import { Injectable, Inject, Optional } from "@nestjs/common";
import { PoolClient } from "pg";
import { DatabaseService } from "../../../core/database/database.service.js";
import { ConfigService } from "../../policies/config.service.js";
import { CandidateGuard, CandidateScore } from "./types.js";
import { RankWeights } from "@swms/contracts";

@Injectable()
export class RankingService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Optional() @Inject(ConfigService) private readonly configService?: ConfigService
  ) {}

  /**
   * Resolve active ranking weights from policy or fallback to defaults
   */
  async getWeights(atTime?: Date): Promise<RankWeights> {
    const defaultWeights: RankWeights = { distance: 1, ot: 2, load: 1.5 };
    if (!this.configService) return defaultWeights;

    try {
      const policyVal = await this.configService.get<any>("dispatch.rank_weights", atTime);
      if (policyVal && typeof policyVal === "object") {
        return {
          distance: typeof policyVal.distance === "number" ? policyVal.distance : 1,
          ot: typeof policyVal.ot === "number" ? policyVal.ot : 2,
          load: typeof policyVal.load === "number" ? policyVal.load : 1.5
        };
      }
    } catch {
      // ignore
    }
    return defaultWeights;
  }

  /**
   * Look up travel time between two posts in minutes
   */
  async getTravelTime(
    fromPost: string | null | undefined,
    toPost: string,
    client?: PoolClient
  ): Promise<number> {
    if (!fromPost || fromPost === toPost) {
      return 0;
    }

    const res = client
      ? await client.query(
          `SELECT minutes FROM post_travel WHERE from_post = $1 AND to_post = $2;`,
          [fromPost, toPost]
        )
      : await this.db.query(
          `SELECT minutes FROM post_travel WHERE from_post = $1 AND to_post = $2;`,
          [fromPost, toPost]
        );

    if (res.rows.length > 0) {
      return Number(res.rows[0].minutes);
    }

    // Default fallback if not explicitly defined in post_travel
    return 5;
  }

  /**
   * Count dispatches for a guard today
   */
  async getDispatchesToday(guardId: number, forDate: string, client?: PoolClient): Promise<number> {
    const res = client
      ? await client.query(
          `SELECT COUNT(*)::int as count 
           FROM dispatch_orders 
           WHERE to_guard_id = $1 
             AND shift_key LIKE $2 
             AND status IN ('ACKED', 'SENT', 'PROPOSED');`,
          [guardId, `${forDate}%`]
        )
      : await this.db.query(
          `SELECT COUNT(*)::int as count 
           FROM dispatch_orders 
           WHERE to_guard_id = $1 
             AND shift_key LIKE $2 
             AND status IN ('ACKED', 'SENT', 'PROPOSED');`,
          [guardId, `${forDate}%`]
        );

    return res.rows.length > 0 ? Number(res.rows[0].count) : 0;
  }

  /**
   * Score and rank candidate guards
   * Formula: score = w.distance * travel_min + w.ot * ot_minutes_month/60 + w.load * dispatches_today
   * Lower is better, ties broken by guard.id ASC.
   */
  async rankCandidates(
    candidates: CandidateGuard[],
    targetPostId: string,
    options?: {
      weights?: RankWeights;
      client?: PoolClient;
      atTime?: Date;
    }
  ): Promise<Array<{ candidate: CandidateGuard; scoreData: CandidateScore }>> {
    if (candidates.length === 0) return [];

    const weights = options?.weights || (await this.getWeights(options?.atTime));
    const scored: Array<{ candidate: CandidateGuard; scoreData: CandidateScore }> = [];

    for (const c of candidates) {
      const travelMin = await this.getTravelTime(c.currentPostId, targetPostId, options?.client);
      const otHours = (c.otMinutesMonth || 0) / 60;
      const load = c.dispatchesToday || 0;

      const score =
        weights.distance * travelMin +
        weights.ot * otHours +
        weights.load * load;

      scored.push({
        candidate: c,
        scoreData: {
          guardId: c.id,
          score,
          travelMin,
          otMinutesMonth: c.otMinutesMonth || 0,
          dispatchesToday: load
        }
      });
    }

    // Sort: lowest score first, tie-break by guard.id ASC
    scored.sort((a, b) => {
      if (Math.abs(a.scoreData.score - b.scoreData.score) > 1e-6) {
        return a.scoreData.score - b.scoreData.score;
      }
      return a.candidate.id - b.candidate.id;
    });

    return scored;
  }
}

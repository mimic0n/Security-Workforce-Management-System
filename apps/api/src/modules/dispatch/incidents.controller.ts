import {
  Controller,
  Get,
  Query,
  Param,
  ParseIntPipe,
  NotFoundException,
  Inject
} from "@nestjs/common";
import { DatabaseService } from "../../core/database/database.service.js";

@Controller("incidents")
export class IncidentsController {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService
  ) {}

  @Get()
  async getIncidents(
    @Query("kind") kind?: string,
    @Query("postId") postId?: string,
    @Query("guardId") guardId?: string,
    @Query("severity") severity?: string,
    @Query("openOnly") openOnly?: string
  ) {
    const conditions: string[] = [];
    const params: any[] = [];
    let idx = 1;

    if (kind) {
      conditions.push(`kind = $${idx++}`);
      params.push(kind);
    }
    if (postId) {
      conditions.push(`post_id = $${idx++}`);
      params.push(postId);
    }
    if (guardId) {
      conditions.push(`guard_id = $${idx++}`);
      params.push(parseInt(guardId, 10));
    }
    if (severity) {
      conditions.push(`severity = $${idx++}`);
      params.push(severity);
    }
    if (openOnly === "true") {
      conditions.push(`closed_at IS NULL`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const res = await this.db.query(
      `SELECT id, kind, post_id, guard_id, severity, opened_at, closed_at, details
       FROM incidents
       ${where}
       ORDER BY opened_at DESC;`,
      params
    );

    return res.rows.map((r) => ({
      id: Number(r.id),
      kind: r.kind,
      postId: r.post_id,
      guardId: r.guard_id ? Number(r.guard_id) : null,
      severity: r.severity,
      openedAt: r.opened_at,
      closedAt: r.closed_at,
      details: r.details
    }));
  }

  @Get(":id")
  async getIncidentById(@Param("id", ParseIntPipe) id: number) {
    const res = await this.db.query(
      `SELECT id, kind, post_id, guard_id, severity, opened_at, closed_at, details
       FROM incidents
       WHERE id = $1;`,
      [id]
    );

    if (res.rows.length === 0) {
      throw new NotFoundException(`Incident #${id} not found`);
    }

    const r = res.rows[0];
    return {
      id: Number(r.id),
      kind: r.kind,
      postId: r.post_id,
      guardId: r.guard_id ? Number(r.guard_id) : null,
      severity: r.severity,
      openedAt: r.opened_at,
      closedAt: r.closed_at,
      details: r.details
    };
  }
}

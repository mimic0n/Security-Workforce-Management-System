import { Injectable, Inject, NotFoundException, BadRequestException } from "@nestjs/common";
import { Clock, CreateAbsenceDto, AbsenceDecisionDto } from "@swms/contracts";
import { CLOCK_TOKEN } from "../../core/clock/clock.interface.js";
import { DatabaseService } from "../../core/database/database.service.js";
import { DispatchQueueService } from "./engine/queue.service.js";

@Injectable()
export class AbsencesService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(DispatchQueueService) private readonly queueService: DispatchQueueService,
    @Inject(CLOCK_TOKEN) private readonly clock: Clock
  ) {}

  async createAbsence(dto: CreateAbsenceDto, idemKey?: string | null): Promise<any> {
    const effectiveIdemKey = idemKey || dto.idemKey || null;
    const now = this.clock.now();
    const reportedAt = dto.reportedAt ? new Date(dto.reportedAt) : now;

    // Check idempotency first
    if (effectiveIdemKey) {
      const existing = await this.db.query(
        `SELECT id, guard_id, reported_at, for_shift, for_date, reason, status, idem_key 
         FROM absences 
         WHERE idem_key = $1;`,
        [effectiveIdemKey]
      );
      if (existing.rows.length > 0) {
        return existing.rows[0];
      }
    }

    // Verify guard exists
    const guardRes = await this.db.query(
      `SELECT id, role, float_kind FROM guards WHERE id = $1;`,
      [dto.guardId]
    );
    if (guardRes.rows.length === 0) {
      throw new NotFoundException(`Guard #${dto.guardId} not found`);
    }
    const guard = guardRes.rows[0];

    // Insert absence row
    const insRes = await this.db.query(
      `INSERT INTO absences (guard_id, reported_at, for_shift, for_date, reason, status, idem_key)
       VALUES ($1, $2, $3, $4, $5, 'REPORTED', $6)
       RETURNING id, guard_id, reported_at, for_shift, for_date, reason, status, idem_key;`,
      [dto.guardId, reportedAt, dto.forShift, dto.forDate, dto.reason || "Absence reported", effectiveIdemKey]
    );
    const absence = insRes.rows[0];

    // Enqueue dispatch task to process this absence through the dispatch engine
    const shiftKey = `${dto.forDate}:${dto.forShift}`;
    const isFloat = guard.role === "FLOAT";
    const floatKind = guard.float_kind;

    await this.queueService.enqueue({
      shiftKey,
      kind: "ABSENCE_REPORTED",
      payload: {
        guardId: dto.guardId,
        shiftKey,
        date: dto.forDate,
        shift: dto.forShift,
        reason: dto.reason,
        reportedAt: reportedAt.toISOString(),
        isFloat,
        floatKind
      },
      idemKey: effectiveIdemKey ? `task_${effectiveIdemKey}` : null
    });

    const updatedAbs = await this.db.query(
      `SELECT id, guard_id, reported_at, for_shift, for_date, reason, status, idem_key 
       FROM absences WHERE id = $1;`,
      [absence.id]
    );

    return updatedAbs.rows[0] || absence;
  }

  async getAbsences(filter?: {
    guardId?: number;
    forShift?: string;
    forDate?: string;
    status?: string;
  }): Promise<any[]> {
    let query = `
      SELECT id, guard_id, reported_at, for_shift, for_date, reason, status, idem_key 
      FROM absences 
      WHERE 1=1
    `;
    const params: any[] = [];
    let pIdx = 1;

    if (filter?.guardId) {
      query += ` AND guard_id = $${pIdx++}`;
      params.push(filter.guardId);
    }
    if (filter?.forShift) {
      query += ` AND for_shift = $${pIdx++}`;
      params.push(filter.forShift);
    }
    if (filter?.forDate) {
      query += ` AND for_date = $${pIdx++}`;
      params.push(filter.forDate);
    }
    if (filter?.status) {
      query += ` AND status = $${pIdx++}`;
      params.push(filter.status);
    }

    query += ` ORDER BY id DESC;`;

    const res = await this.db.query(query, params);
    return res.rows;
  }

  async makeDecision(id: number, dto: AbsenceDecisionDto): Promise<any> {
    const res = await this.db.query(
      `UPDATE absences 
       SET status = $1 
       WHERE id = $2 
       RETURNING id, guard_id, reported_at, for_shift, for_date, reason, status, idem_key;`,
      [dto.status, id]
    );

    if (res.rows.length === 0) {
      throw new NotFoundException(`Absence record #${id} not found`);
    }

    return res.rows[0];
  }
}

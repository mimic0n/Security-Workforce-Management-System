import { Injectable, Inject } from "@nestjs/common";
import { DatabaseService } from "../database/database.service.js";
import { CLOCK_TOKEN, type Clock } from "../clock/clock.interface.js";
import type { AuditLog } from "@swms/contracts";

@Injectable()
export class AuditService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(CLOCK_TOKEN) private readonly clock: Clock
  ) {}

  async log(params: {
    actor_id?: number | null;
    action: string;
    entity?: string | null;
    before?: any;
    after?: any;
    at?: Date;
  }): Promise<AuditLog> {
    const timestamp = params.at ?? this.clock.now();

    const res = await this.db.query<AuditLog>(
      `INSERT INTO audit_log (actor_id, action, entity, before, after, at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *;`,
      [
        params.actor_id ?? null,
        params.action,
        params.entity ?? null,
        params.before !== undefined ? JSON.stringify(params.before) : null,
        params.after !== undefined ? JSON.stringify(params.after) : null,
        timestamp.toISOString()
      ]
    );

    return res.rows[0];
  }

  async getRecent(limit = 50, entity?: string): Promise<AuditLog[]> {
    if (entity) {
      const res = await this.db.query<AuditLog>(
        `SELECT * FROM audit_log WHERE entity = $1 ORDER BY id DESC LIMIT $2;`,
        [entity, limit]
      );
      return res.rows;
    }

    const res = await this.db.query<AuditLog>(
      `SELECT * FROM audit_log ORDER BY id DESC LIMIT $1;`,
      [limit]
    );
    return res.rows;
  }
}

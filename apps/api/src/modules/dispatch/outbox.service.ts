import { Injectable, Inject } from "@nestjs/common";
import { PoolClient } from "pg";
import { Clock, OutboxEnvelope } from "@swms/contracts";
import { CLOCK_TOKEN } from "../../core/clock/clock.interface.js";
import { DatabaseService } from "../../core/database/database.service.js";
import { EventBusService } from "../../core/events/event-bus.service.js";

@Injectable()
export class OutboxService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(EventBusService) private readonly eventBus: EventBusService,
    @Inject(CLOCK_TOKEN) private readonly clock: Clock
  ) {}

  /**
   * Enqueue a message to outbox within an existing database transaction client.
   * Assigns a strictly monotonic sequence per site from `site_event_seq`.
   */
  async enqueue(
    client: PoolClient,
    topic: string,
    payload: Record<string, any>
  ): Promise<{ id: number; seq: number; envelope: OutboxEnvelope }> {
    const seqRes = await client.query(`SELECT nextval('site_event_seq') AS seq;`);
    const seq = Number(seqRes.rows[0].seq);

    const envelope: OutboxEnvelope = {
      v: 1,
      type: topic,
      seq,
      ts: this.clock.now().toISOString(),
      payload
    };

    const insertRes = await client.query(
      `INSERT INTO outbox (topic, payload, created_at)
       VALUES ($1, $2, clock_timestamp())
       RETURNING id;`,
      [topic, JSON.stringify(envelope)]
    );

    const id = Number(insertRes.rows[0].id);
    return { id, seq, envelope };
  }

  /**
   * Publish all pending outbox rows (where sent_at IS NULL).
   * Typically invoked after transaction commit or by an outbox poller.
   */
  async publishPending(): Promise<number> {
    const pendingRes = await this.db.query(
      `SELECT id, topic, payload FROM outbox WHERE sent_at IS NULL ORDER BY id ASC;`
    );

    if (pendingRes.rows.length === 0) {
      return 0;
    }

    const ids: number[] = [];
    for (const row of pendingRes.rows) {
      const payload = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
      this.eventBus.emit(row.topic, payload);
      ids.push(Number(row.id));
    }

    await this.db.query(
      `UPDATE outbox SET sent_at = clock_timestamp() WHERE id = ANY($1::bigint[]);`,
      [ids]
    );

    return ids.length;
  }

  /**
   * Retrieve the current sequence value of site_event_seq.
   */
  async getLastSeq(): Promise<number> {
    const res = await this.db.query(`SELECT last_value, is_called FROM site_event_seq;`);
    if (res.rows.length === 0 || !res.rows[0].is_called) {
      return 0;
    }
    return Number(res.rows[0].last_value);
  }
}

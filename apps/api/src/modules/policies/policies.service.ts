import { Injectable, Inject, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../../core/database/database.service.js";
import { ConfigService } from "./config.service.js";
import { AuditService } from "../../core/audit/audit.service.js";
import { EventBusService } from "../../core/events/event-bus.service.js";
import { CLOCK_TOKEN, type Clock } from "../../core/clock/clock.interface.js";
import type { Policy, UpdatePolicyDto, PolicyPreviewDto, StaffingResult } from "@swms/contracts";

@Injectable()
export class PoliciesService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(ConfigService) private readonly configService: ConfigService,
    @Inject(AuditService) private readonly auditService: AuditService,
    @Inject(EventBusService) private readonly eventBus: EventBusService,
    @Inject(CLOCK_TOKEN) private readonly clock: Clock
  ) {}

  async get(key: string, at?: Date): Promise<Policy> {
    const timestamp = at ? new Date(at.getTime()) : this.clock.now();

    const res = await this.db.query<Policy>(
      `SELECT key, value, valid_from, valid_to, created_by
       FROM policies
       WHERE key = $1
         AND valid_from <= $2
         AND (valid_to IS NULL OR valid_to > $2)
       ORDER BY valid_from DESC
       LIMIT 1;`,
      [key, timestamp.toISOString()]
    );

    if (res.rows.length === 0) {
      throw new NotFoundException(`Policy '${key}' not found or not active at ${timestamp.toISOString()}`);
    }

    return res.rows[0];
  }

  async getAll(at?: Date): Promise<Policy[]> {
    const timestamp = at ? new Date(at.getTime()) : this.clock.now();

    const res = await this.db.query<Policy>(
      `SELECT DISTINCT ON (key) key, value, valid_from, valid_to, created_by
       FROM policies
       WHERE valid_from <= $1
         AND (valid_to IS NULL OR valid_to > $1)
       ORDER BY key, valid_from DESC;`,
      [timestamp.toISOString()]
    );

    return res.rows;
  }

  async update(key: string, dto: UpdatePolicyDto, actorId?: number | null): Promise<Policy> {
    const validFrom = dto.valid_from ? new Date(dto.valid_from) : this.clock.now();
    const validTo = dto.valid_to ? new Date(dto.valid_to) : null;

    let beforeValue: any = null;
    try {
      beforeValue = await this.configService.get(key, validFrom);
    } catch {
      // Key may be new
    }

    const res = await this.db.query<Policy>(
      `INSERT INTO policies (key, value, valid_from, valid_to, created_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (key, valid_from) 
       DO UPDATE SET value = EXCLUDED.value, valid_to = EXCLUDED.valid_to, created_by = EXCLUDED.created_by
       RETURNING *;`,
      [
        key,
        JSON.stringify(dto.value),
        validFrom.toISOString(),
        validTo ? validTo.toISOString() : null,
        actorId ?? null
      ]
    );

    const savedPolicy = res.rows[0];

    // Audit log
    await this.auditService.log({
      actor_id: actorId,
      action: "POLICY_UPDATE",
      entity: "policies",
      before: beforeValue,
      after: dto.value,
      at: validFrom
    });

    // Invalidate local ConfigService cache
    this.configService.invalidate(key);

    // Publish to outbox & emit event
    await this.eventBus.publishToOutbox("policy.changed", {
      key,
      value: dto.value,
      valid_from: validFrom.toISOString(),
      valid_to: validTo ? validTo.toISOString() : null
    });

    return savedPolicy;
  }

  async preview(dto: PolicyPreviewDto, at?: Date): Promise<StaffingResult> {
    const timestamp = at ? new Date(at.getTime()) : this.clock.now();
    const overrides = { ...(dto.overrides || {}) };

    if (dto.key && dto.value !== undefined) {
      overrides[dto.key] = dto.value;
    }

    return this.configService.calculateStaffing(overrides, timestamp);
  }
}

import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../../core/database/database.service.js";
import { CreatePostDto, Post, PostRule, UpdatePostRuleDto } from "@swms/contracts";

@Injectable()
export class PostsService {
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  async findAll(): Promise<any[]> {
    const res = await this.db.query(`
      SELECT p.*, r.tier, r.max_vacant_sec, r.pair_with, r.active_shifts, r.needs_meal_cover,
             s.status as current_status, s.guard_id as current_guard_id
      FROM posts p
      LEFT JOIN post_rules r ON p.id = r.post_id
      LEFT JOIN post_state s ON p.id = s.post_id
      ORDER BY p.id ASC
    `);
    return res.rows.map(this.mapPostWithRules);
  }

  async findOne(id: string): Promise<any> {
    const res = await this.db.query(
      `SELECT p.*, r.tier, r.max_vacant_sec, r.pair_with, r.active_shifts, r.needs_meal_cover,
              s.status as current_status, s.guard_id as current_guard_id
       FROM posts p
       LEFT JOIN post_rules r ON p.id = r.post_id
       LEFT JOIN post_state s ON p.id = s.post_id
       WHERE p.id = $1`,
      [id]
    );

    if (res.rows.length === 0) {
      throw new NotFoundException(`Post with ID ${id} not found`);
    }

    return this.mapPostWithRules(res.rows[0]);
  }

  async create(dto: CreatePostDto): Promise<Post> {
    const res = await this.db.query(
      `INSERT INTO posts (id, site_id, name, zone, x, y, lat, lon, geofence_m, qr_code_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        dto.id,
        dto.site_id || "AEON_THANH_KHE_F1",
        dto.name,
        dto.zone,
        dto.x,
        dto.y,
        dto.lat ?? null,
        dto.lon ?? null,
        dto.geofence_m ?? 25,
        dto.qr_code_id
      ]
    );
    return res.rows[0];
  }

  async updateRules(postId: string, dto: UpdatePostRuleDto): Promise<PostRule> {
    const existing = await this.findOne(postId);

    const newTier = dto.tier ?? existing.tier;
    const newMaxVacant = dto.max_vacant_sec ?? existing.max_vacant_sec;

    // Hard Rule: Tier-1 CHECK (Zero-Vacancy invariant)
    if (newTier === "TIER1" && newMaxVacant > 0) {
      throw new BadRequestException("Tier 1 posts must have max_vacant_sec = 0 (Zero-Vacancy invariant)");
    }

    const fields: string[] = [];
    const params: any[] = [postId];

    if (dto.tier !== undefined) {
      params.push(dto.tier);
      fields.push(`tier = $${params.length}`);
    }
    if (dto.max_vacant_sec !== undefined) {
      params.push(dto.max_vacant_sec);
      fields.push(`max_vacant_sec = $${params.length}`);
    }
    if (dto.pair_with !== undefined) {
      params.push(dto.pair_with);
      fields.push(`pair_with = $${params.length}`);
    }
    if (dto.active_shifts !== undefined) {
      params.push(dto.active_shifts);
      fields.push(`active_shifts = $${params.length}`);
    }
    if (dto.needs_meal_cover !== undefined) {
      params.push(dto.needs_meal_cover);
      fields.push(`needs_meal_cover = $${params.length}`);
    }

    if (fields.length === 0) {
      return {
        post_id: postId,
        tier: existing.tier,
        max_vacant_sec: existing.max_vacant_sec,
        pair_with: existing.pair_with,
        active_shifts: existing.active_shifts,
        needs_meal_cover: existing.needs_meal_cover
      };
    }

    const query = `UPDATE post_rules SET ${fields.join(", ")} WHERE post_id = $1 RETURNING *`;
    const res = await this.db.query(query, params);
    return res.rows[0];
  }

  private mapPostWithRules(row: any) {
    return {
      id: row.id,
      site_id: row.site_id,
      name: row.name,
      zone: row.zone,
      x: Number(row.x),
      y: Number(row.y),
      lat: row.lat !== null ? Number(row.lat) : null,
      lon: row.lon !== null ? Number(row.lon) : null,
      geofence_m: Number(row.geofence_m),
      qr_code_id: row.qr_code_id,
      tier: row.tier,
      max_vacant_sec: Number(row.max_vacant_sec),
      pair_with: row.pair_with || [],
      active_shifts: row.active_shifts || [],
      needs_meal_cover: row.needs_meal_cover ?? true,
      current_status: row.current_status,
      current_guard_id: row.current_guard_id ? Number(row.current_guard_id) : null
    };
  }
}

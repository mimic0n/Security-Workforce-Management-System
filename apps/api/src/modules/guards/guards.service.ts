import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../../core/database/database.service.js";
import {
  CreateCertificationDto,
  CreateDeviceDto,
  CreateGuardDto,
  Guard,
  UpdateGuardDto
} from "@swms/contracts";

@Injectable()
export class GuardsService {
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  async findAll(role?: string, active?: boolean): Promise<Guard[]> {
    let query = "SELECT * FROM guards WHERE 1=1";
    const params: any[] = [];

    if (role) {
      params.push(role);
      query += ` AND role = $${params.length}`;
    }

    if (active !== undefined) {
      params.push(active);
      query += ` AND active = $${params.length}`;
    }

    query += " ORDER BY id ASC";
    const res = await this.db.query(query, params);
    return res.rows.map(this.mapGuard);
  }

  async findOne(id: number): Promise<any> {
    const guardRes = await this.db.query("SELECT * FROM guards WHERE id = $1", [id]);
    if (guardRes.rows.length === 0) {
      throw new NotFoundException(`Guard with ID ${id} not found`);
    }

    const certsRes = await this.db.query(
      "SELECT * FROM certifications WHERE guard_id = $1 ORDER BY id DESC",
      [id]
    );

    const devicesRes = await this.db.query(
      "SELECT * FROM devices WHERE guard_id = $1 ORDER BY id DESC",
      [id]
    );

    return {
      ...this.mapGuard(guardRes.rows[0]),
      certifications: certsRes.rows,
      devices: devicesRes.rows
    };
  }

  async create(dto: CreateGuardDto): Promise<Guard> {
    const res = await this.db.query(
      `INSERT INTO guards (code, full_name, role, float_kind, phone, active, hired_on, ot_minutes_month, ot_minutes_year)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        dto.code,
        dto.full_name,
        dto.role,
        dto.float_kind || null,
        dto.phone || null,
        dto.active ?? true,
        dto.hired_on || null,
        dto.ot_minutes_month ?? 0,
        dto.ot_minutes_year ?? 0
      ]
    );
    return this.mapGuard(res.rows[0]);
  }

  async update(id: number, dto: UpdateGuardDto): Promise<Guard> {
    await this.findOne(id); // Ensure exists

    const fields: string[] = [];
    const params: any[] = [id];

    if (dto.full_name !== undefined) {
      params.push(dto.full_name);
      fields.push(`full_name = $${params.length}`);
    }
    if (dto.role !== undefined) {
      params.push(dto.role);
      fields.push(`role = $${params.length}`);
    }
    if (dto.float_kind !== undefined) {
      params.push(dto.float_kind);
      fields.push(`float_kind = $${params.length}`);
    }
    if (dto.phone !== undefined) {
      params.push(dto.phone);
      fields.push(`phone = $${params.length}`);
    }
    if (dto.active !== undefined) {
      params.push(dto.active);
      fields.push(`active = $${params.length}`);
    }
    if (dto.ot_minutes_month !== undefined) {
      params.push(dto.ot_minutes_month);
      fields.push(`ot_minutes_month = $${params.length}`);
    }
    if (dto.ot_minutes_year !== undefined) {
      params.push(dto.ot_minutes_year);
      fields.push(`ot_minutes_year = $${params.length}`);
    }

    if (fields.length === 0) {
      return (await this.findOne(id)) as Guard;
    }

    const query = `UPDATE guards SET ${fields.join(", ")} WHERE id = $1 RETURNING *`;
    const res = await this.db.query(query, params);
    return this.mapGuard(res.rows[0]);
  }

  async addCertification(guardId: number, dto: CreateCertificationDto) {
    await this.findOne(guardId);
    const res = await this.db.query(
      `INSERT INTO certifications (guard_id, cert_no, issued_on, expires_on)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [guardId, dto.cert_no, dto.issued_on, dto.expires_on]
    );
    return res.rows[0];
  }

  async addDevice(guardId: number, dto: CreateDeviceDto) {
    await this.findOne(guardId);
    const res = await this.db.query(
      `INSERT INTO devices (guard_id, device_uid, active)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [guardId, dto.device_uid, dto.active ?? true]
    );
    return res.rows[0];
  }

  private mapGuard(row: any): Guard {
    return {
      id: Number(row.id),
      code: row.code,
      full_name: row.full_name,
      role: row.role,
      float_kind: row.float_kind,
      phone: row.phone,
      active: row.active,
      hired_on: row.hired_on ? new Date(row.hired_on).toISOString().split("T")[0] : null,
      ot_minutes_month: Number(row.ot_minutes_month),
      ot_minutes_year: Number(row.ot_minutes_year)
    };
  }
}

import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import pg, { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private pool!: Pool;

  constructor(pool?: Pool) {
    if (pool) {
      this.pool = pool;
    }
  }

  private ensurePool(): Pool {
    if (!this.pool) {
      const dbUrl = process.env.DATABASE_URL || "postgres://grey@localhost:5432/swms";
      this.pool = new pg.Pool({ connectionString: dbUrl });
    }
    return this.pool;
  }

  onModuleInit() {
    this.ensurePool();
  }

  async onModuleDestroy() {
    if (this.pool) {
      await this.pool.end();
    }
  }

  getPool(): Pool {
    return this.ensurePool();
  }

  async query<R extends QueryResultRow = any>(text: string, params?: any[]): Promise<QueryResult<R>> {
    return this.ensurePool().query<R>(text, params);
  }

  async getClient(): Promise<PoolClient> {
    return this.ensurePool().connect();
  }

  async transaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.getClient();
    try {
      await client.query("BEGIN;");
      const result = await callback(client);
      await client.query("COMMIT;");
      return result;
    } catch (error) {
      await client.query("ROLLBACK;");
      throw error;
    } finally {
      client.release();
    }
  }
}

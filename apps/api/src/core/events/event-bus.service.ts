import { Injectable, Global, Module, Inject } from "@nestjs/common";
import { EventEmitter } from "node:events";
import { DatabaseService } from "../database/database.service.js";
import { DatabaseModule } from "../database/database.module.js";

@Injectable()
export class EventBusService {
  private readonly emitter = new EventEmitter();

  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {
    this.emitter.setMaxListeners(100);
  }

  on(event: string, listener: (...args: any[]) => void): void {
    this.emitter.on(event, listener);
  }

  off(event: string, listener: (...args: any[]) => void): void {
    this.emitter.off(event, listener);
  }

  emit(event: string, payload: any): void {
    this.emitter.emit(event, payload);
  }

  async publishToOutbox(topic: string, payload: any): Promise<void> {
    await this.db.query(
      `INSERT INTO outbox (topic, payload) VALUES ($1, $2);`,
      [topic, JSON.stringify(payload)]
    );
    this.emit(topic, payload);
  }
}

@Global()
@Module({
  imports: [DatabaseModule],
  providers: [EventBusService],
  exports: [EventBusService]
})
export class EventsModule {}

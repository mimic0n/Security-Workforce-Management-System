import { Global, Module } from "@nestjs/common";
import { AuditService } from "./audit.service.js";
import { DatabaseModule } from "../database/database.module.js";
import { ClockModule } from "../clock/clock.module.js";

@Global()
@Module({
  imports: [DatabaseModule, ClockModule],
  providers: [AuditService],
  exports: [AuditService]
})
export class AuditModule {}

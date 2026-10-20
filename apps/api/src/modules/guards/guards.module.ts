import { Module } from "@nestjs/common";
import { GuardsService } from "./guards.service.js";
import { GuardsController } from "./guards.controller.js";
import { AuthModule } from "../../core/auth/auth.module.js";

@Module({
  imports: [AuthModule],
  providers: [GuardsService],
  controllers: [GuardsController],
  exports: [GuardsService]
})
export class GuardsModule {}

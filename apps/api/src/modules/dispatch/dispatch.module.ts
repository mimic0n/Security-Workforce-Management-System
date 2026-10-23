import { Module } from "@nestjs/common";
import { DatabaseModule } from "../../core/database/database.module.js";
import { ClockModule } from "../../core/clock/clock.module.js";
import { EventsModule } from "../../core/events/event-bus.service.js";
import { PoliciesModule } from "../policies/policies.module.js";
import { StateMachineService } from "./state-machine/state-machine.service.js";
import { OutboxService } from "./outbox.service.js";
import { DispatchService } from "./dispatch.service.js";
import { StateController } from "./state.controller.js";
import { MealPlannerService } from "./meal-planner/meal-planner.service.js";
import { LegalGuardService } from "./legal-guard/legal-guard.service.js";
import { BreakPlansController } from "./break-plans.controller.js";
import { LegalGuardController } from "./legal-guard/legal-guard.controller.js";

@Module({
  imports: [DatabaseModule, ClockModule, EventsModule, PoliciesModule],
  providers: [
    StateMachineService,
    OutboxService,
    DispatchService,
    MealPlannerService,
    LegalGuardService
  ],
  controllers: [StateController, BreakPlansController, LegalGuardController],
  exports: [
    DispatchService,
    StateMachineService,
    OutboxService,
    MealPlannerService,
    LegalGuardService
  ]
})
export class DispatchModule {}

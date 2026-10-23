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
import { RankingService } from "./engine/ranking.service.js";
import { FillVacancyService } from "./engine/fill-vacancy.service.js";
import { AbsenceHandler } from "./engine/handlers/absence.handler.js";
import { MotionHandler } from "./engine/handlers/motion.handler.js";
import { DispatchQueueService } from "./engine/queue.service.js";
import { DispatchController } from "./dispatch.controller.js";
import { AbsencesService } from "./absences.service.js";
import { AbsencesController } from "./absences.controller.js";
import { IncidentsController } from "./incidents.controller.js";

@Module({
  imports: [DatabaseModule, ClockModule, EventsModule, PoliciesModule],
  providers: [
    StateMachineService,
    OutboxService,
    DispatchService,
    MealPlannerService,
    LegalGuardService,
    RankingService,
    FillVacancyService,
    AbsenceHandler,
    MotionHandler,
    DispatchQueueService,
    AbsencesService
  ],
  controllers: [
    StateController,
    BreakPlansController,
    LegalGuardController,
    DispatchController,
    AbsencesController,
    IncidentsController
  ],
  exports: [
    DispatchService,
    StateMachineService,
    OutboxService,
    MealPlannerService,
    LegalGuardService,
    RankingService,
    FillVacancyService,
    AbsenceHandler,
    MotionHandler,
    DispatchQueueService,
    AbsencesService
  ]
})
export class DispatchModule {}


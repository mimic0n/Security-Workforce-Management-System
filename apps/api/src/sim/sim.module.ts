import { Module } from "@nestjs/common";
import { DatabaseModule } from "../core/database/database.module.js";
import { ClockModule } from "../core/clock/clock.module.js";
import { DispatchModule } from "../modules/dispatch/dispatch.module.js";
import { AttendanceModule } from "../modules/attendance/attendance.module.js";
import { PoliciesModule } from "../modules/policies/policies.module.js";
import { StaffingModule } from "../modules/staffing/staffing.module.js";
import { AdaptersModule } from "../adapters/adapters.module.js";

import { ScenarioLoader } from "./scenario-loader.js";
import { FixtureManager } from "./fixture-manager.js";
import { ActionDispatcher } from "./action-dispatcher.js";
import { AssertionEvaluator } from "./assertion-evaluator.js";
import { SimRunner } from "./sim-runner.js";
import { SimController } from "./sim.controller.js";

@Module({
  imports: [
    DatabaseModule,
    ClockModule,
    DispatchModule,
    AttendanceModule,
    PoliciesModule,
    StaffingModule,
    AdaptersModule
  ],
  controllers: [SimController],
  providers: [
    ScenarioLoader,
    {
      provide: FixtureManager,
      useFactory: () => {
        const dbUrl =
          process.env.DATABASE_URL ||
          process.env.TEST_DATABASE_URL ||
          "postgres://grey@localhost:5432/swms_test";
        return new FixtureManager(dbUrl);
      }
    },
    ActionDispatcher,
    AssertionEvaluator,
    SimRunner
  ],
  exports: [
    ScenarioLoader,
    FixtureManager,
    ActionDispatcher,
    AssertionEvaluator,
    SimRunner
  ]
})
export class SimModule {}

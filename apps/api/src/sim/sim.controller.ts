import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Inject,
  BadRequestException
} from "@nestjs/common";
import { CLOCK_TOKEN, type Clock } from "../core/clock/clock.interface.js";
import { VirtualClock } from "../core/clock/virtual-clock.js";
import { SimRunner } from "./sim-runner.js";
import { ScenarioLoader } from "./scenario-loader.js";
import { FixtureManager } from "./fixture-manager.js";
import {
  SimClockJumpSchema,
  SimClockSpeedSchema,
  SimResetSchema
} from "@swms/contracts";

@Controller("sim")
export class SimController {
  private currentSpeed = 1;

  constructor(
    @Inject(CLOCK_TOKEN) private readonly clock: Clock,
    @Inject(SimRunner) private readonly runner: SimRunner,
    @Inject(ScenarioLoader) private readonly loader: ScenarioLoader,
    @Inject(FixtureManager) private readonly fixtureManager: FixtureManager
  ) {}

  @Get("clock")
  getClock() {
    return {
      now: this.clock.now().toISOString(),
      speed: this.currentSpeed,
      isVirtual: this.clock instanceof VirtualClock
    };
  }

  @Post("clock/jump")
  async jumpClock(@Body() body: unknown) {
    const parsed = SimClockJumpSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.errors);
    }

    const targetDate = new Date(parsed.data.to);
    if (this.clock instanceof VirtualClock) {
      await this.clock.jumpTo(targetDate);
    }
    return {
      now: this.clock.now().toISOString()
    };
  }

  @Post("clock/speed")
  setClockSpeed(@Body() body: unknown) {
    const parsed = SimClockSpeedSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.errors);
    }

    this.currentSpeed = parsed.data.speed;
    if (this.clock instanceof VirtualClock) {
      this.clock.setSpeed(parsed.data.speed);
    }
    return {
      speed: this.currentSpeed
    };
  }

  @Get("scenarios")
  async listScenarios() {
    const scenarios = await this.loader.list();
    return { scenarios };
  }

  @Post("scenario/:id/run")
  async runScenario(
    @Param("id") id: string,
    @Body("speed") speed?: number
  ) {
    const result = await this.runner.runScenario(id, { speed });
    return result;
  }

  @Post("reset")
  async resetSim(@Body() body?: unknown) {
    const parsed = SimResetSchema.safeParse(body || {});
    const fixtureSet = parsed.success ? (parsed.data.fixtureSet || "full-roster") : "full-roster";
    const date = parsed.success ? (parsed.data.date || "2026-11-07") : "2026-11-07";

    await this.fixtureManager.resetDatabase();
    await this.fixtureManager.setupFixture({
      date,
      present: 45,
      fixtureSet,
      policyOverrides: {}
    }, this.clock);

    return {
      ok: true,
      message: `Reset complete with fixtureSet '${fixtureSet}' on date '${date}'`
    };
  }
}

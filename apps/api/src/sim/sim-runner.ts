import fs from "node:fs/promises";
import path from "node:path";
import { Injectable, Inject } from "@nestjs/common";
import { DatabaseService } from "../core/database/database.service.js";
import { CLOCK_TOKEN, type Clock } from "../core/clock/clock.interface.js";
import { VirtualClock } from "../core/clock/virtual-clock.js";
import { ScenarioLoader } from "./scenario-loader.js";
import { FixtureManager } from "./fixture-manager.js";
import { ActionDispatcher } from "./action-dispatcher.js";
import { AssertionEvaluator } from "./assertion-evaluator.js";
import {
  type SimRunResult,
  type AssertionResult,
  type ScenarioDefinition
} from "@swms/contracts";

export interface SimRunnerOptions {
  speed?: number | "max";
  reportsDir?: string;
}

@Injectable()
export class SimRunner {
  private readonly reportsDir: string;

  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(CLOCK_TOKEN) private readonly clock: Clock,
    @Inject(ScenarioLoader) private readonly loader: ScenarioLoader,
    @Inject(FixtureManager) private readonly fixtureManager: FixtureManager,
    @Inject(ActionDispatcher) private readonly dispatcher: ActionDispatcher,
    @Inject(AssertionEvaluator) private readonly evaluator: AssertionEvaluator
  ) {
    this.reportsDir = path.resolve(process.cwd(), "sim-reports");
  }

  async runScenario(
    scenarioId: string,
    options?: SimRunnerOptions
  ): Promise<SimRunResult> {
    const startedAt = this.clock.now();
    const startTimeMs = startedAt.getTime();

    let scenario: ScenarioDefinition;
    try {
      scenario = await this.loader.load(scenarioId);
    } catch (err: any) {
      const finishedAt = this.clock.now();
      return {
        id: scenarioId,
        title: `Unknown scenario ${scenarioId}`,
        passed: false,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startTimeMs,
        assertions: [],
        error: err.message
      };
    }

    // 1. Reset Database and apply fixture
    await this.fixtureManager.resetDatabase();
    await this.fixtureManager.setupFixture(scenario.seed, this.clock);

    // 2. Set VirtualClock initial time
    if (this.clock instanceof VirtualClock) {
      const initialIso = scenario.timeline.length > 0
        ? scenario.timeline[0].at
        : `${scenario.seed.date}T06:00:00+07:00`;
      this.clock.reset(new Date(initialIso));

      if (options?.speed && typeof options.speed === "number") {
        this.clock.setSpeed(options.speed);
      }
    }

    // 3. Step through timeline actions
    for (const action of scenario.timeline) {
      await this.dispatcher.executeAction(action, scenario.seed);
    }

    // 4. Evaluate assertions
    const assertionResults: AssertionResult[] = [];
    for (const exp of scenario.expect) {
      const res = await this.evaluator.evaluate(exp, scenario.seed);
      assertionResults.push(res);
    }

    const passed = assertionResults.every((a) => a.passed);
    const finishedAt = this.clock.now();
    const durationMs = finishedAt.getTime() - startTimeMs;

    const result: SimRunResult = {
      id: scenario.id,
      title: scenario.title,
      passed,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs,
      assertions: assertionResults
    };

    // 5. Store in Postgres sim_runs table
    try {
      await this.db.query(
        `INSERT INTO sim_runs (scenario_id, started_at, finished_at, passed, details)
         VALUES ($1, $2, $3, $4, $5);`,
        [
          scenario.id,
          startedAt,
          finishedAt,
          passed,
          JSON.stringify({
            title: scenario.title,
            durationMs,
            assertions: assertionResults
          })
        ]
      );
    } catch (dbErr) {
      console.warn("Failed to write to sim_runs table:", dbErr);
    }

    // 6. Write JSON report to sim-reports/<id>.json
    try {
      const dir = options?.reportsDir || this.reportsDir;
      await fs.mkdir(dir, { recursive: true });
      const reportFile = path.join(dir, `${scenario.id}.json`);
      await fs.writeFile(reportFile, JSON.stringify(result, null, 2), "utf-8");
    } catch (fsErr) {
      console.warn("Failed to write JSON report:", fsErr);
    }

    return result;
  }

  async runAll(options?: SimRunnerOptions): Promise<SimRunResult[]> {
    const scenarioIds = await this.loader.list();
    const results: SimRunResult[] = [];

    for (const id of scenarioIds) {
      const res = await this.runScenario(id, options);
      results.push(res);
    }

    return results;
  }
}

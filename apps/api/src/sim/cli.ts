import { NestFactory } from "@nestjs/core";
import { AppModule } from "../app.module.js";
import { SimRunner } from "./sim-runner.js";
import { type SimRunResult } from "@swms/contracts";

async function main() {
  process.env.SIM_MODE = "true";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ||
    process.env.TEST_DATABASE_URL ||
    "postgres://grey@localhost:5432/swms_test";

  const args = process.argv.slice(2);
  const isAll = args.includes("--all");
  const isJson = args.includes("--json");

  let speedArg: number | undefined = undefined;
  for (const arg of args) {
    if (arg.startsWith("--speed=")) {
      const val = arg.split("=")[1];
      speedArg = val === "max" ? 999999 : parseInt(val, 10);
    }
  }

  // Filter out flags to get the scenario ID
  const positional = args.filter((a) => !a.startsWith("-"));
  const targetId = positional[0] || (isAll ? null : "A1");

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false
  });

  const runner = app.get(SimRunner);

  let results: SimRunResult[] = [];

  try {
    if (isAll || !targetId) {
      results = await runner.runAll({ speed: speedArg });
    } else {
      const single = await runner.runScenario(targetId, { speed: speedArg });
      results = [single];
    }
  } catch (err: any) {
    console.error("Simulation run error:", err);
    await app.close();
    process.exit(1);
  }

  await app.close();

  if (isJson) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    console.log("\n================================================================================");
    console.log(" SWMS SIMULATION HARNESS RESULTS (§13.4)");
    console.log("================================================================================\n");

    const header = [
      "ID".padEnd(6),
      "Scenario Title".padEnd(46),
      "Asserts".padEnd(10),
      "Time".padEnd(8),
      "Status"
    ].join(" | ");

    console.log(header);
    console.log("-".repeat(80));

    let allPassed = true;

    for (const r of results) {
      if (!r.passed) allPassed = false;
      const passedCount = r.assertions.filter((a) => a.passed).length;
      const totalCount = r.assertions.length;
      const statusStr = r.passed ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";

      const simSec = Math.round(Math.abs(r.durationMs) / 1000);
      const timeStr = simSec > 3600
        ? `${Math.floor(simSec / 3600)}h ${Math.floor((simSec % 3600) / 60)}m`
        : simSec > 60
          ? `${Math.floor(simSec / 60)}m ${simSec % 60}s`
          : `${simSec}s`;

      const row = [
        r.id.padEnd(6),
        r.title.slice(0, 44).padEnd(46),
        `${passedCount}/${totalCount}`.padEnd(10),
        timeStr.padEnd(8),
        statusStr
      ].join(" | ");

      console.log(row);

      // Print failed assertions if any
      const failed = r.assertions.filter((a) => !a.passed);
      for (const f of failed) {
        console.log(`   \x1b[31m✖\x1b[0m [${f.assert}] ${f.description || ""}`);
        console.log(`     Expected: ${JSON.stringify(f.expected)} | Actual: ${JSON.stringify(f.actual)}`);
        if (f.message) {
          console.log(`     Message: ${f.message}`);
        }
      }
    }

    console.log("-".repeat(80));
    console.log(
      allPassed
        ? `\n\x1b[32m✔ All ${results.length} scenario(s) passed successfully!\x1b[0m\n`
        : `\n\x1b[31m✖ Some scenarios failed.\x1b[0m\n`
    );

    if (!allPassed) {
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error("Fatal simulation CLI error:", err);
  process.exit(1);
});

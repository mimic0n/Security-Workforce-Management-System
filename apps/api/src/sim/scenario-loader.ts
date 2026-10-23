import fs from "node:fs/promises";
import path from "node:path";
import { load } from "js-yaml";
import {
  ScenarioDefinitionSchema,
  type ScenarioDefinition
} from "@swms/contracts";

export class ScenarioLoader {
  private readonly defaultDir: string;

  constructor(scenariosDir?: string) {
    this.defaultDir =
      scenariosDir ||
      path.resolve(process.cwd(), "scenarios");
  }

  async load(scenarioId: string): Promise<ScenarioDefinition> {
    const filename = scenarioId.endsWith(".yaml") || scenarioId.endsWith(".yml")
      ? scenarioId
      : `${scenarioId}.yaml`;
    const filePath = path.join(this.defaultDir, filename);

    let rawContent: string;
    try {
      rawContent = await fs.readFile(filePath, "utf-8");
    } catch {
      throw new Error(`Scenario file not found at ${filePath}`);
    }

    const parsed = load(rawContent);
    const validated = ScenarioDefinitionSchema.parse(parsed);
    return validated;
  }

  async list(): Promise<string[]> {
    try {
      const files = await fs.readdir(this.defaultDir);
      return files
        .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
        .map((f) => f.replace(/\.ya?ml$/, ""))
        .sort();
    } catch {
      return [];
    }
  }
}

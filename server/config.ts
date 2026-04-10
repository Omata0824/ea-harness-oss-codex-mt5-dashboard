import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { EnvironmentConfig } from "./types.js";

const DEFAULT_CONFIG_PATH = path.resolve(process.cwd(), "environment.yaml");

export function resolveRoot(...segments: string[]): string {
  return path.resolve(process.cwd(), ...segments);
}

function normalizeConfig(config: EnvironmentConfig): EnvironmentConfig {
  const confirmPoints = Array.isArray(config.pipeline?.confirm_points)
    ? config.pipeline.confirm_points.filter((point) => point !== "optimization_complete")
    : [];

  return {
    ...config,
    pipeline: {
      ...config.pipeline,
      confirm_points: confirmPoints.length ? confirmPoints : ["spec_approved", "analysis_complete"],
    },
  };
}

export async function loadConfig(configPath = DEFAULT_CONFIG_PATH): Promise<EnvironmentConfig> {
  const raw = await fs.readFile(configPath, "utf8");
  return normalizeConfig(YAML.parse(raw) as EnvironmentConfig);
}

export async function saveConfig(
  config: EnvironmentConfig,
  configPath = DEFAULT_CONFIG_PATH,
): Promise<void> {
  await fs.writeFile(configPath, YAML.stringify(normalizeConfig(config)), "utf8");
}

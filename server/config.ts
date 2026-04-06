import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { EnvironmentConfig } from "./types.js";

const DEFAULT_CONFIG_PATH = path.resolve(process.cwd(), "environment.yaml");

export function resolveRoot(...segments: string[]): string {
  return path.resolve(process.cwd(), ...segments);
}

export async function loadConfig(configPath = DEFAULT_CONFIG_PATH): Promise<EnvironmentConfig> {
  const raw = await fs.readFile(configPath, "utf8");
  return YAML.parse(raw) as EnvironmentConfig;
}

export async function saveConfig(
  config: EnvironmentConfig,
  configPath = DEFAULT_CONFIG_PATH,
): Promise<void> {
  await fs.writeFile(configPath, YAML.stringify(config), "utf8");
}

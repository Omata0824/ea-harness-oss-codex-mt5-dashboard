import { constants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { EnvironmentConfig } from "../types.js";

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function detectMt5Paths(): Promise<Partial<EnvironmentConfig["mt5"]>> {
  const candidates = [
    "C:/Program Files/OANDA MT5",
    "C:/Program Files/MetaTrader 5",
    "C:/Program Files/MetaTrader5",
    "C:/Program Files/IC Markets - MetaTrader 5",
  ];

  for (const base of candidates) {
    const terminal = path.join(base, "terminal64.exe");
    const editor = path.join(base, "metaeditor64.exe");
    if ((await pathExists(terminal)) && (await pathExists(editor))) {
      return {
        terminal_path: terminal,
        metaeditor_path: editor,
        data_folder: path.join(os.homedir(), "AppData", "Roaming", "MetaQuotes", "Terminal"),
      };
    }
  }

  return {};
}

export async function validateMt5Paths(config: EnvironmentConfig["mt5"]): Promise<{
  ok: boolean;
  details: Record<string, boolean>;
}> {
  const details = {
    terminal_path: await pathExists(config.terminal_path),
    metaeditor_path: await pathExists(config.metaeditor_path),
    data_folder: await pathExists(config.data_folder),
  };

  return {
    ok: Object.values(details).every(Boolean),
    details,
  };
}

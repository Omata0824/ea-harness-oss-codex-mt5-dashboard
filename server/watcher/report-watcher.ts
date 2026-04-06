import chokidar from "chokidar";

export async function waitForReport(filePath: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const watcher = chokidar.watch(filePath, {
      ignoreInitial: false,
      awaitWriteFinish: {
        stabilityThreshold: 1000,
        pollInterval: 100,
      },
    });

    const finish = async () => {
      clearTimeout(timer);
      await watcher.close();
      resolve(filePath);
    };

    const timer = setTimeout(() => {
      void watcher.close();
      reject(new Error(`Report timeout: ${filePath}`));
    }, timeoutMs);

    watcher.on("add", () => {
      void finish();
    });
    watcher.on("change", () => {
      void finish();
    });
    watcher.on("error", (error) => {
      clearTimeout(timer);
      void watcher.close();
      reject(error);
    });
  });
}

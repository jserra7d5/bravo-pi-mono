import { existsSync, mkdirSync, writeFileSync, unlinkSync, statSync } from "node:fs";
import { join } from "node:path";

export class FileLock {
  private lockPath: string;

  constructor(lockPath: string) {
    this.lockPath = lockPath;
  }

  acquire(): boolean {
    try {
      mkdirSync(this.lockPath, { recursive: true });
      const marker = join(this.lockPath, "lock.pid");
      writeFileSync(marker, String(process.pid), { flag: "wx" });
      return true;
    } catch {
      return false;
    }
  }

  release(): void {
    try {
      const marker = join(this.lockPath, "lock.pid");
      if (existsSync(marker)) unlinkSync(marker);
      if (existsSync(this.lockPath)) unlinkSync(this.lockPath);
    } catch {
      // ignore
    }
  }

  isStale(maxAgeMs = 60000): boolean {
    try {
      const marker = join(this.lockPath, "lock.pid");
      if (!existsSync(marker)) return true;
      const stat = statSync(marker);
      return Date.now() - stat.mtimeMs > maxAgeMs;
    } catch {
      return true;
    }
  }
}

import fs from "node:fs/promises";
import { config } from "./config.js";

/** Per-asset processing record so re-runs only handle new/changed assets. */
export interface AssetState {
  id: string;
  processedAt: string;
  /** True once coordinates are known (so we can list what still needs placing). */
  geolocated: boolean;
}

interface StateFile {
  assets: Record<string, AssetState>;
}

export class State {
  private data: StateFile = { assets: {} };

  static async load(): Promise<State> {
    const s = new State();
    try {
      const raw = await fs.readFile(config.statePath, "utf8");
      s.data = JSON.parse(raw) as StateFile;
    } catch {
      // No state yet — start fresh.
    }
    return s;
  }

  has(id: string): boolean {
    return id in this.data.assets;
  }

  get(id: string): AssetState | undefined {
    return this.data.assets[id];
  }

  set(record: AssetState): void {
    this.data.assets[record.id] = record;
  }

  async save(): Promise<void> {
    await fs.mkdir(config.dataDir, { recursive: true });
    await fs.writeFile(config.statePath, JSON.stringify(this.data, null, 2));
  }
}

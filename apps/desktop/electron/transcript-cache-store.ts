import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { TranscriptMessage } from "../src/desktop-state";

export class TranscriptCacheStore {
  private readonly rootDir: string;

  constructor(userDataDir: string) {
    this.rootDir = join(userDataDir, "transcripts");
  }

  async read(sessionKey: string): Promise<TranscriptMessage[] | undefined> {
    const filePath = this.filePath(sessionKey);
    try {
      const raw = await readFile(filePath, "utf8");
      return JSON.parse(raw) as TranscriptMessage[];
    } catch {
      return undefined;
    }
  }

  async write(sessionKey: string, transcript: readonly TranscriptMessage[]): Promise<void> {
    const filePath = this.filePath(sessionKey);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(transcript, null, 2)}\n`, "utf8");
  }

  private filePath(sessionKey: string): string {
    return join(this.rootDir, `${encodeURIComponent(sessionKey)}.json`);
  }
}

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ComposerImageAttachment } from "../src/desktop-state";

export class AttachmentStore {
  private readonly rootDir: string;

  constructor(userDataDir: string) {
    this.rootDir = join(userDataDir, "attachments");
  }

  async read(sessionKey: string): Promise<readonly ComposerImageAttachment[] | undefined> {
    const filePath = this.filePath(sessionKey);
    try {
      const raw = await readFile(filePath, "utf8");
      return JSON.parse(raw) as readonly ComposerImageAttachment[];
    } catch {
      return undefined;
    }
  }

  async write(sessionKey: string, attachments: readonly ComposerImageAttachment[]): Promise<void> {
    const filePath = this.filePath(sessionKey);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(attachments, null, 2)}\n`, "utf8");
  }

  private filePath(sessionKey: string): string {
    return join(this.rootDir, `${encodeURIComponent(sessionKey)}.json`);
  }
}

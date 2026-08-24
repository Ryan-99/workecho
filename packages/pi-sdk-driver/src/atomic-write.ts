import { randomBytes } from "node:crypto";
import { mkdir, open, rename, rm, unlink } from "node:fs/promises";
import { dirname } from "node:path";

/** Suffix of the transient files writeFileAtomic creates before renaming into place. */
export const TMP_SUFFIX = ".tmp";

let tmpCounter = 0;

/**
 * F-01：Windows 上并发 rename 同一目标会间歇性 EPERM（目标被 AV/索引器/另一
 * 写入方短暂占用）。按路径串行化 + rename 失败时 unlink 目标后有限重试，
 * 与 apps/desktop/electron/atomic-file-write.ts 的策略保持一致。
 */
const writeQueueByPath = new Map<string, Promise<void>>();

const RENAME_RETRY_ATTEMPTS = 5;
const RENAME_RETRY_DELAY_MS = 15;

function isReplaceRenameError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "EEXIST" || error.code === "EPERM" || error.code === "EACCES" || error.code === "ENOTEMPTY")
  );
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function renameReplace(src: string, dest: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(src, dest);
      return;
    } catch (error) {
      if (!isReplaceRenameError(error) || attempt >= RENAME_RETRY_ATTEMPTS) {
        throw error;
      }
    }
    // Windows/占用方：目标短暂不可替换。移走目标后重试（ENOENT = 已被并发方处理）。
    try {
      await unlink(dest);
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
    await sleep(RENAME_RETRY_DELAY_MS * (attempt + 1));
  }
}

/**
 * Write `data` to `filePath` durably. A concurrent reader or a crash at any
 * point always observes either the previous file contents or the fully-written
 * new contents — never a missing, truncated, or partially-written file.
 *
 * Steps:
 * - Write to a uniquely-named temp file in the same directory and fsync it.
 * - rename() straight over the target (atomic replace on POSIX). There is no
 *   unlink first, so a crash in the write window cannot leave the target gone.
 * - fsync the containing directory so the rename entry itself survives power
 *   loss, not just the temp file's data blocks.
 *
 * Writes to the same path are serialized FIFO (last write wins); a failing
 * write never blocks later queued writes.
 */
export async function writeFileAtomic(filePath: string, data: string | Uint8Array): Promise<void> {
  await enqueueWrite(filePath, () => writeOnce(filePath, data));
}

async function writeOnce(filePath: string, data: string | Uint8Array): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });

  // Collision-safe temp name: a pid + monotonic counter + randomness so two
  // writers, or two writes within the same millisecond, never share a path
  // (Date.now() alone is not unique under concurrent writes).
  tmpCounter = (tmpCounter + 1) >>> 0;
  const tmpPath = `${filePath}.${process.pid}.${tmpCounter}.${randomBytes(6).toString("hex")}${TMP_SUFFIX}`;

  const handle = await open(tmpPath, "w");
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await renameReplace(tmpPath, filePath);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }

  await syncDirectory(dir);
}

/** Serialize `value` as pretty JSON with a trailing newline and write it atomically. */
export async function writeJsonFileAtomic(filePath: string, value: unknown): Promise<void> {
  await writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function syncDirectory(dir: string): Promise<void> {
  let handle;
  try {
    handle = await open(dir, "r");
  } catch {
    // Some platforms (notably Windows) reject opening a directory for fsync.
    // The rename above is still atomic; skip the extra durability step.
    return;
  }
  try {
    await handle.sync();
  } catch {
    // Best effort — a failed directory fsync must not fail the write.
  } finally {
    await handle.close();
  }
}

async function enqueueWrite(filePath: string, write: () => Promise<void>): Promise<void> {
  const previous = writeQueueByPath.get(filePath) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(write);
  writeQueueByPath.set(filePath, next);
  try {
    await next;
  } finally {
    if (writeQueueByPath.get(filePath) === next) {
      writeQueueByPath.delete(filePath);
    }
  }
}

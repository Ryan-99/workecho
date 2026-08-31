/**
 * composer 粘贴附件的公共收集逻辑（ChatPanel 与 WelcomeView 共用）。
 *
 * 两种来源：
 * 1. clipboardData.files —— 从资源管理器复制的真实文件；
 * 2. clipboardData.items —— 剪贴板截图位图（files 为空），需 getAsFile() 取出。
 *    此前只查 files，导致截图粘贴完全无反应。
 */
export function collectPastedFiles(dt: DataTransfer | null): readonly File[] {
  if (!dt) return [];
  // 混合剪贴板（Office/网页复制：图+文本并存）优先贴文本——返回空让默认粘贴走文本路径
  const text = dt.getData?.("text/plain") ?? "";
  if (text.trim()) return [];
  const fromFiles = Array.from(dt.files ?? []).filter((f) => f.size > 0);
  if (fromFiles.length > 0) return fromFiles;
  return Array.from(dt.items ?? [])
    .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
    .map((it) => it.getAsFile())
    .filter((f): f is File => f !== null && f.size > 0);
}

/** File[] → ComposerAttachment[]（图片转 base64 预览；文件经 webUtils 取真实路径） */
export async function filesToComposerAttachments(
  files: readonly File[],
  deps: {
    getPathForFile?: (file: File) => string | undefined;
    bytesToBase64: (bytes: Uint8Array) => string;
    maxImageBytes: number;
  },
): Promise<
  Array<
    | { id: string; kind: "image"; name: string; mimeType: string; data: string }
    | { id: string; kind: "file"; name: string; mimeType: string; fsPath: string; sizeBytes?: number }
  >
> {
  const out: Array<
    | { id: string; kind: "image"; name: string; mimeType: string; data: string }
    | { id: string; kind: "file"; name: string; mimeType: string; fsPath: string; sizeBytes?: number }
  > = [];
  for (const file of files) {
    if (file.type.startsWith("image/")) {
      if (file.size > deps.maxImageBytes) continue;
      try {
        const buf = new Uint8Array(await file.arrayBuffer());
        out.push({
          id: crypto.randomUUID(),
          kind: "image",
          name: file.name || "pasted-image.png",
          mimeType: file.type,
          data: deps.bytesToBase64(buf),
        });
      } catch { /* 单个失败跳过 */ }
    } else {
      const fsPath = deps.getPathForFile?.(file);
      if (fsPath) {
        out.push({
          id: crypto.randomUUID(),
          kind: "file",
          name: file.name,
          mimeType: file.type || "application/octet-stream",
          fsPath,
          sizeBytes: file.size,
        });
      }
    }
  }
  return out;
}

/** 人类可读的文件大小（KB/MB），<1KB 显示 B */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 文件扩展名（大写展示，无扩展名返回 "FILE"） */
export function fileExtension(name: string): string {
  const m = name.match(/\.([^.]+)$/);
  return m?.[1] ? m[1].toUpperCase().slice(0, 5) : "FILE";
}

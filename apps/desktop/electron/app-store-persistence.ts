import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
export interface PersistedUiState {
  readonly version?: 2;
  readonly selectedWorkspaceId?: string;
  readonly selectedSessionId?: string;
  readonly composerDraft?: string;
  readonly composerDraftsBySession?: Record<string, string>;
}

export interface LegacyPersistedUiState extends PersistedUiState {
  readonly composerAttachmentsBySession?: Record<string, readonly unknown[]>;
  readonly transcripts?: Record<string, readonly unknown[]>;
}

export async function readPersistedUiState(uiStateFilePath: string): Promise<LegacyPersistedUiState> {
  try {
    const raw = await readFile(uiStateFilePath, "utf8");
    const parsed = JSON.parse(raw) as LegacyPersistedUiState;
    return {
      version: parsed.version === 2 ? 2 : undefined,
      selectedWorkspaceId: parsed.selectedWorkspaceId,
      selectedSessionId: parsed.selectedSessionId,
      composerDraft: parsed.composerDraft ?? "",
      composerDraftsBySession: parsed.composerDraftsBySession,
      composerAttachmentsBySession: parsed.composerAttachmentsBySession,
      transcripts: parsed.transcripts,
    };
  } catch {
    return {};
  }
}

export async function writePersistedUiState(
  uiStateFilePath: string,
  payload: PersistedUiState,
): Promise<void> {
  await mkdir(dirname(uiStateFilePath), { recursive: true });
  await writeFile(
    uiStateFilePath,
    `${JSON.stringify(
      {
        version: 2,
        ...payload,
      } satisfies PersistedUiState,
      null,
      2,
    )}\n`,
    "utf8",
  );
}

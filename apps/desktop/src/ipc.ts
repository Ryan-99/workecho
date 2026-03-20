import type { CreateSessionInput, DesktopAppState, WorkspaceSessionTarget } from "./desktop-state";

export const desktopIpc = {
  stateRequest: "pi-app:state-request",
  stateChanged: "pi-app:state-changed",
  addWorkspacePath: "pi-app:add-workspace-path",
  pickWorkspace: "pi-app:pick-workspace",
  selectWorkspace: "pi-app:select-workspace",
  selectSession: "pi-app:select-session",
  createSession: "pi-app:create-session",
  updateComposerDraft: "pi-app:update-composer-draft",
  submitComposerDraft: "pi-app:submit-composer-draft",
  ping: "app:ping",
  openExternal: "app:open-external",
} as const;

export type PiDesktopStateListener = (state: DesktopAppState) => void;

export interface PiDesktopApi {
  platform: NodeJS.Platform;
  versions: NodeJS.ProcessVersions;
  ping(): Promise<string>;
  getState(): Promise<DesktopAppState>;
  onStateChanged(listener: PiDesktopStateListener): () => void;
  addWorkspacePath(path: string): Promise<DesktopAppState>;
  pickWorkspace(): Promise<DesktopAppState>;
  selectWorkspace(workspaceId: string): Promise<DesktopAppState>;
  selectSession(target: WorkspaceSessionTarget): Promise<DesktopAppState>;
  createSession(input: CreateSessionInput): Promise<DesktopAppState>;
  updateComposerDraft(composerDraft: string): Promise<DesktopAppState>;
  submitComposerDraft(): Promise<DesktopAppState>;
  openExternal(url: string): Promise<void>;
}

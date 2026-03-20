import type { CatalogStorage } from "@pi-app/catalogs";
import type {
  CreateSessionOptions,
  SessionDriver,
  SessionEventListener,
  SessionRef,
  SessionSnapshot,
  SessionMessageInput,
  Unsubscribe,
  WorkspaceRef,
} from "@pi-app/session-driver";
import { SessionSupervisor, type PiSdkDriverOptions } from "./session-supervisor.js";

export interface PiSdkDriverConfig extends PiSdkDriverOptions {
  readonly catalogStorage?: CatalogStorage;
}

export class PiSdkDriver implements SessionDriver {
  private readonly supervisor: SessionSupervisor;

  constructor(options: PiSdkDriverConfig = {}) {
    this.supervisor = new SessionSupervisor(options);
  }

  createSession(workspace: WorkspaceRef, options?: CreateSessionOptions): Promise<SessionSnapshot> {
    return this.supervisor.createSession(workspace, options);
  }

  openSession(sessionRef: SessionRef): Promise<SessionSnapshot> {
    return this.supervisor.openSession(sessionRef);
  }

  sendUserMessage(sessionRef: SessionRef, input: SessionMessageInput): Promise<void> {
    return this.supervisor.sendUserMessage(sessionRef, input);
  }

  cancelCurrentRun(sessionRef: SessionRef): Promise<void> {
    return this.supervisor.cancelCurrentRun(sessionRef);
  }

  subscribe(sessionRef: SessionRef, listener: SessionEventListener): Unsubscribe {
    return this.supervisor.subscribe(sessionRef, listener);
  }

  closeSession(sessionRef: SessionRef): Promise<void> {
    return this.supervisor.closeSession(sessionRef);
  }
}

export function createPiSdkDriver(options?: PiSdkDriverConfig): PiSdkDriver {
  return new PiSdkDriver(options);
}

import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { promisify } from "node:util";
import type {
  CatalogStorage,
  WorktreeCatalogEntry,
  WorktreeCatalogSnapshot,
} from "@pi-app/catalogs";
import type { WorkspaceRef } from "@pi-app/session-driver";

const execFileAsync = promisify(execFile);

export interface GitWorktreeManagerOptions {
  readonly catalogStorage: CatalogStorage;
}

export interface CreateWorktreeOptions {
  readonly path: string;
  readonly branchName?: string;
  readonly startPoint?: string;
  readonly displayName?: string;
}

export interface RemoveWorktreeOptions {
  readonly force?: boolean;
}

export class GitWorktreeManager {
  constructor(private readonly options: GitWorktreeManagerOptions) {}

  async listWorktrees(workspace: WorkspaceRef): Promise<WorktreeCatalogSnapshot> {
    return this.options.catalogStorage.worktrees.listWorktrees(workspace.workspaceId);
  }

  async refreshWorktrees(workspace: WorkspaceRef): Promise<WorktreeCatalogSnapshot> {
    const repoRoot = await resolveRepositoryRoot(workspace.path);
    const existing = await this.options.catalogStorage.worktrees.listWorktrees(workspace.workspaceId);
    const discovered = await listGitWorktrees(repoRoot, workspace, existing.worktrees);
    await this.options.catalogStorage.worktrees.replaceWorkspaceWorktrees(workspace.workspaceId, discovered);
    return { worktrees: discovered.map((entry) => ({ ...entry })) };
  }

  async createWorktree(workspace: WorkspaceRef, input: CreateWorktreeOptions): Promise<WorktreeCatalogEntry> {
    const repoRoot = await resolveRepositoryRoot(workspace.path);
    const normalizedPath = input.path.trim();
    if (!normalizedPath) {
      throw new Error("Worktree path cannot be empty.");
    }
    const worktreePath = resolve(normalizedPath);

    await mkdir(dirname(worktreePath), { recursive: true });

    const args = ["-C", repoRoot, "worktree", "add"];
    if (input.branchName) {
      args.push("-b", input.branchName);
    }
    args.push(worktreePath, input.startPoint?.trim() || "HEAD");
    await runGit(args);

    const snapshot = await this.refreshWorktrees(workspace);
    const created = snapshot.worktrees.find((entry) => entry.worktreeId === worktreePath);
    if (!created) {
      throw new Error(`Worktree ${worktreePath} was created but is missing from the catalog.`);
    }
    if (input.displayName?.trim()) {
      const next = { ...created, displayName: input.displayName.trim() };
      await this.options.catalogStorage.worktrees.upsertWorktree(next);
      return next;
    }
    return created;
  }

  async removeWorktree(
    workspace: WorkspaceRef,
    worktreeId: string,
    options: RemoveWorktreeOptions = {},
  ): Promise<void> {
    const repoRoot = await resolveRepositoryRoot(workspace.path);
    const resolvedId = resolve(worktreeId);
    const existing = await this.options.catalogStorage.worktrees.getWorktree(resolvedId);
    const targetPath = existing?.path ? resolve(existing.path) : resolvedId;
    if (existing?.kind === "primary" || targetPath === resolve(workspace.path)) {
      throw new Error("The primary workspace cannot be removed as a git worktree.");
    }

    try {
      await runGit([
        "-C",
        repoRoot,
        "worktree",
        "remove",
        ...(options.force ? ["--force"] : []),
        targetPath,
      ]);
    } catch (error) {
      const refreshed = await this.refreshWorktrees(workspace);
      if (!refreshed.worktrees.some((entry) => entry.worktreeId === targetPath)) {
        return;
      }
      throw error;
    }

    await this.refreshWorktrees(workspace);
  }
}

async function resolveRepositoryRoot(workspacePath: string): Promise<string> {
  const output = await runGit(["-C", workspacePath, "rev-parse", "--show-toplevel"]);
  return resolve(output.trim());
}

async function listGitWorktrees(
  repoRoot: string,
  workspace: WorkspaceRef,
  existingEntries: readonly WorktreeCatalogEntry[],
): Promise<WorktreeCatalogEntry[]> {
  const output = await runGit(["-C", repoRoot, "worktree", "list", "--porcelain"]);
  const existing = new Map(existingEntries.map((entry) => [entry.worktreeId, entry]));
  const discovered = new Map<string, WorktreeCatalogEntry>();

  for (const block of output.split(/\n\s*\n/)) {
    const entry = parseWorktreeBlock(block, workspace, existing);
    if (entry) {
      discovered.set(entry.worktreeId, mergeWorktreeEntry(entry, existing.get(entry.worktreeId)));
    }
  }

  if (!discovered.has(resolve(workspace.path))) {
    const primaryPath = resolve(workspace.path);
    discovered.set(
      primaryPath,
      mergeWorktreeEntry(
        {
          worktreeId: primaryPath,
          workspaceId: workspace.workspaceId,
          path: primaryPath,
          displayName: workspace.displayName?.trim() || basename(primaryPath) || primaryPath,
          kind: "primary",
          status: "ready",
          createdAt: nowIso(),
          updatedAt: nowIso(),
        },
        existing.get(primaryPath),
      ),
    );
  }

  return [...discovered.values()].sort(compareWorktreeEntries);
}

function parseWorktreeBlock(
  block: string,
  workspace: WorkspaceRef,
  existing: ReadonlyMap<string, WorktreeCatalogEntry>,
): WorktreeCatalogEntry | undefined {
  const lines = block
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return undefined;
  }

  const worktreeLine = lines.find((line) => line.startsWith("worktree "));
  if (!worktreeLine) {
    return undefined;
  }

  const path = resolve(worktreeLine.slice("worktree ".length).trim());
  const kind: WorktreeCatalogEntry["kind"] = path === resolve(workspace.path) ? "primary" : "linked";
  const headLine = lines.find((line) => line.startsWith("HEAD "));
  const branchLine = lines.find((line) => line.startsWith("branch "));
  const status: WorktreeCatalogEntry["status"] = lines.includes("prunable") ? "missing" : "ready";
  const displayName = existing.get(path)?.displayName?.trim() || defaultWorktreeDisplayName(workspace, path, kind);
  const entry: WorktreeCatalogEntry = {
    worktreeId: path,
    workspaceId: workspace.workspaceId,
    path,
    displayName,
    kind,
    status,
    ...(headLine ? { headSha: headLine.slice("HEAD ".length).trim() } : {}),
    ...(branchLine ? { branchName: normalizeBranchName(branchLine.slice("branch ".length).trim()) } : {}),
    createdAt: existing.get(path)?.createdAt ?? nowIso(),
    updatedAt: nowIso(),
    ...(existing.get(path)?.pinned !== undefined ? { pinned: existing.get(path)?.pinned } : {}),
  };

  return entry;
}

function mergeWorktreeEntry(
  nextEntry: WorktreeCatalogEntry,
  existingEntry: WorktreeCatalogEntry | undefined,
): WorktreeCatalogEntry {
  return {
    ...nextEntry,
    displayName: existingEntry?.displayName?.trim() || nextEntry.displayName,
    createdAt: existingEntry?.createdAt ?? nextEntry.createdAt,
    pinned: existingEntry?.pinned ?? nextEntry.pinned,
  };
}

function compareWorktreeEntries(left: WorktreeCatalogEntry, right: WorktreeCatalogEntry): number {
  if (left.kind !== right.kind) {
    return left.kind === "primary" ? -1 : 1;
  }
  if (left.pinned && !right.pinned) return -1;
  if (!left.pinned && right.pinned) return 1;
  if (left.updatedAt !== right.updatedAt) {
    return right.updatedAt.localeCompare(left.updatedAt);
  }
  return left.displayName.localeCompare(right.displayName);
}

function defaultWorktreeDisplayName(workspace: WorkspaceRef, path: string, kind: WorktreeCatalogEntry["kind"]): string {
  if (kind === "primary") {
    return workspace.displayName?.trim() || basename(path) || path;
  }
  return basename(path) || path;
}

function normalizeBranchName(value: string): string | undefined {
  const branch = value.replace(/^refs\/heads\//, "").trim();
  return branch.length > 0 && branch !== "detached" ? branch : undefined;
}

async function runGit(args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

function nowIso(): string {
  return new Date().toISOString();
}

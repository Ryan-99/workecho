import type { SessionConfig } from "@pi-app/session-driver";

export interface ComposerSlashCommand {
  readonly command: string;
  readonly template: string;
  readonly title: string;
  readonly description: string;
  readonly submitMode?: "immediate" | "prefill" | "pick-option";
}

export interface ComposerSlashOption {
  readonly value: string;
  readonly label: string;
  readonly description: string;
}

export type ParsedComposerCommand =
  | { type: "model"; provider: string; modelId: string }
  | { type: "thinking"; thinkingLevel: string }
  | { type: "status" }
  | { type: "session" }
  | { type: "reload" }
  | { type: "compact"; customInstructions?: string }
  | { type: "name"; title: string };

export const SLASH_COMMANDS: readonly ComposerSlashCommand[] = [
  {
    command: "/model",
    template: "/model openai gpt-5.4",
    title: "Model",
    description: "Set provider and model for this session",
    submitMode: "prefill",
  },
  {
    command: "/thinking",
    template: "/thinking high",
    title: "Reasoning",
    description: "Set thinking level for this session",
    submitMode: "pick-option",
  },
  {
    command: "/status",
    template: "/status",
    title: "Status",
    description: "Show current session overrides in the timeline",
    submitMode: "immediate",
  },
  {
    command: "/session",
    template: "/session",
    title: "Session",
    description: "Show current session details in the timeline",
    submitMode: "immediate",
  },
  {
    command: "/name",
    template: "/name New thread title",
    title: "Rename",
    description: "Rename the current session",
    submitMode: "prefill",
  },
  {
    command: "/compact",
    template: "/compact",
    title: "Compact",
    description: "Compact session context now",
    submitMode: "immediate",
  },
  {
    command: "/reload",
    template: "/reload",
    title: "Reload",
    description: "Reload prompts, skills, and session resources",
    submitMode: "immediate",
  },
];

export const THINKING_OPTIONS: readonly ComposerSlashOption[] = [
  {
    value: "low",
    label: "Low",
    description: "Fast responses with lighter reasoning",
  },
  {
    value: "medium",
    label: "Medium",
    description: "Balances speed and reasoning depth for everyday tasks",
  },
  {
    value: "high",
    label: "High",
    description: "Greater reasoning depth for complex problems",
  },
  {
    value: "xhigh",
    label: "Extra High",
    description: "Extra high reasoning depth for complex problems",
  },
] as const;

export function formatSessionConfigStatus(config?: SessionConfig): string {
  const parts = [
    config?.provider && config?.modelId ? `Model ${config.provider}:${config.modelId}` : undefined,
    config?.thinkingLevel ? `Thinking ${config.thinkingLevel}` : undefined,
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(" · ") : "No session overrides set";
}

export function parseComposerCommand(value: string): ParsedComposerCommand | undefined {
  const trimmed = value.trim();
  if (trimmed === "/status") {
    return { type: "status" };
  }
  if (trimmed === "/session") {
    return { type: "session" };
  }
  if (trimmed === "/reload") {
    return { type: "reload" };
  }

  const [command, ...rest] = trimmed.split(/\s+/);
  if (command === "/compact") {
    return { type: "compact", customInstructions: rest.join(" ").trim() || undefined };
  }
  if (command === "/name") {
    const title = rest.join(" ").trim();
    return title ? { type: "name", title } : undefined;
  }
  if (command === "/thinking") {
    const thinkingLevel = rest[0]?.trim();
    if (!thinkingLevel) {
      return undefined;
    }
    return { type: "thinking", thinkingLevel };
  }

  if (command === "/model") {
    if (rest.length >= 2) {
      return {
        type: "model",
        provider: rest[0] ?? "",
        modelId: rest.slice(1).join(" "),
      };
    }

    const combined = rest[0];
    if (combined?.includes(":")) {
      const [provider, ...modelParts] = combined.split(":");
      const modelId = modelParts.join(":");
      if (provider && modelId) {
        return { type: "model", provider, modelId };
      }
    }
  }

  return undefined;
}

export function isExactSlashCommand(query: string, command: ComposerSlashCommand): boolean {
  return query.trim().toLowerCase() === command.command.toLowerCase();
}

export function slashOptionsForCommand(command?: ComposerSlashCommand): readonly ComposerSlashOption[] {
  if (!command) {
    return [];
  }

  if (command.command === "/thinking") {
    return THINKING_OPTIONS;
  }

  return [];
}

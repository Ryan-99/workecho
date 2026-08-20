import { useState, useEffect, useRef, type RefObject } from "react";

interface SlashCommand {
  command: string;
  description: string;
  source?: string;
}

const HOST_COMMANDS: SlashCommand[] = [
  { command: "/compact", description: "压缩会话上下文" },
  { command: "/thinking", description: "设置思考级别" },
  { command: "/tree", description: "浏览会话分支" },
  { command: "/status", description: "显示当前会话配置" },
  { command: "/reload", description: "重新加载资源（skills/prompts）" },
];

interface Props {
  text: string;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  runtimeCommands?: readonly { name: string; description?: string; source?: string }[];
}

/** 斜杠命令自动补全菜单（内置 + 运行时动态命令合并） */
export function SlashMenu({ text, textareaRef, runtimeCommands }: Props) {
  const [show, setShow] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const filteredRef = useRef<SlashCommand[]>([]);

  // 合并内置命令和运行时命令（skills/extensions 注册的）
  const allCommands: SlashCommand[] = [
    ...HOST_COMMANDS,
    ...(runtimeCommands ?? []).map((c) => ({
      command: `/${c.name}`,
      description: c.description ?? "",
      source: c.source,
    })),
  ];

  const trimmed = text.trim();
  const isSlash = trimmed.startsWith("/") && !trimmed.includes(" ");

  const filtered = isSlash
    ? allCommands.filter((c) => c.command.startsWith(trimmed) || c.command.includes(trimmed.slice(1)))
    : [];
  filteredRef.current = filtered;

  useEffect(() => {
    setShow(filtered.length > 0);
    setSelectedIndex(0);
  }, [text]);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const handler = (e: KeyboardEvent) => {
      if (!show) return;
      const cmds = filteredRef.current;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, cmds.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Tab" && cmds[selectedIndex]) {
        e.preventDefault();
        const cmd = cmds[selectedIndex];
        const inputEvent = new Event("input", { bubbles: true });
        ta.value = cmd.command + " ";
        ta.dispatchEvent(inputEvent);
        setShow(false);
      } else if (e.key === "Escape") {
        setShow(false);
      }
    };
    ta.addEventListener("keydown", handler);
    return () => ta.removeEventListener("keydown", handler);
  }, [show, selectedIndex, textareaRef]);

  if (!show || filtered.length === 0) return null;

  return (
    <div className="slash-menu">
      {filtered.map((cmd, i) => (
        <div
          key={cmd.command + (cmd.source ?? "")}
          className={`slash-menu__item ${i === selectedIndex ? "active" : ""}`}
          onMouseEnter={() => setSelectedIndex(i)}
          onMouseDown={(e) => {
            e.preventDefault();
            const ta = textareaRef.current;
            if (ta) {
              ta.value = cmd.command + " ";
              const inputEvent = new Event("input", { bubbles: true });
              ta.dispatchEvent(inputEvent);
              ta.focus();
            }
            setShow(false);
          }}
        >
          <span className="slash-menu__cmd">{cmd.command}</span>
          <span className="slash-menu__desc">{cmd.description}{cmd.source ? ` (${cmd.source})` : ""}</span>
        </div>
      ))}
    </div>
  );
}


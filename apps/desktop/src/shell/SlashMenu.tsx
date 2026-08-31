import { useEffect, useRef, useState, type RefObject } from "react";

interface CommandArgSpec {
  /** 参数名（菜单标题展示） */
  label: string;
  options: readonly string[];
}

interface SlashCommand {
  command: string;
  description: string;
  source?: string;
  args?: CommandArgSpec;
  /** 本地动作标识：选中/参数选齐后在应用内执行，不发送消息 */
  local?: "thinking" | "tree" | "compact";
}

/**
 * localAction：Workecho 本地执行（不发消息）。
 * thinking → 选级别后调 setSessionThinkingLevel；tree → 打开分支浏览；compact → 压缩确认。
 */
type LocalAction = { kind: "thinking"; level: string } | { kind: "tree" } | { kind: "compact" };

const HOST_COMMANDS: SlashCommand[] = [
  { command: "/compact", description: "压缩会话上下文", local: "compact" },
  { command: "/thinking", description: "设置思考级别", local: "thinking", args: { label: "思考级别", options: ["off", "low", "medium", "high", "max"] } },
  { command: "/tree", description: "浏览会话分支", local: "tree" },
  { command: "/status", description: "显示当前会话配置" },
  { command: "/reload", description: "重新加载资源（skills/prompts）" },
];

/** 命令来源的用户可见名（内部标识 pi 不外露） */
const SOURCE_LABELS: Record<string, string> = {
  pi: "Workecho",
};

interface Props {
  text: string;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  runtimeCommands?: readonly { name: string; description?: string; source?: string }[];
  /** runtime skills 快照（自学习沉淀/新装技能后 refreshRuntime 热刷新）——
   *  并入菜单让新 skill 立即可见，不必等下个会话 */
  runtimeSkills?: readonly { name: string; description?: string }[];
  /**
   * 选中后的落地回调（受控：由 ChatPanel setText，绝不直接改 DOM——
   * 直接赋 value 会被 React 的 value tracker 吞掉，表现为"点了没反应"）。
   * send=true 表示选择已完整（无参命令或参数已选齐），可直接执行。
   */
  onSelect: (insertText: string, opts: { send: boolean }) => void;
  /** 本地动作执行（thinking/tree/compact），由 ChatPanel 落地 */
  onLocalAction: (action: { kind: "thinking"; level: string } | { kind: "tree" } | { kind: "compact" }, commandText: string) => void;
  /** skill 类命令选中：渲染为输入框胶囊，等用户补充任务 */
  onSkillPick: (command: string, label: string) => void;
}

/**
 * 斜杠命令菜单（内置 + 运行时命令合并）。
 * 两级交互：命令列表 →（若声明了 args）参数选项列表；
 * 键盘 ↑↓ 移动、Tab/Enter/点击选中，Esc 退一级。
 */
export function SlashMenu({ text, textareaRef, runtimeCommands, runtimeSkills, onSelect, onLocalAction, onSkillPick }: Props) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [argsFor, setArgsFor] = useState<SlashCommand | null>(null);
  // Esc 收起后不再自动弹出，直到输入再次变化（U-03：此前 Esc 只对参数模式有效）
  const dismissedRef = useRef(false);
  const stateRef = useRef<{ filtered: SlashCommand[]; argOptions: string[] }>({ filtered: [], argOptions: [] });
  const itemRefs = useRef<(HTMLElement | null)[]>([]);
  // 键盘/悬停移动高亮时，把 active 项滚进可视区（菜单超高滚动时不跟焦问题）
  useEffect(() => {
    const el = argsFor
      ? document.querySelector(".slash-menu__item.active")
      : itemRefs.current[selectedIndex];
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex, argsFor]);

  const registered = [
    ...HOST_COMMANDS,
    ...(runtimeCommands ?? []).map((c) => ({
      command: `/${c.name}`,
      description: c.description ?? "",
      source: c.source,
    })),
  ];
  // 会话中途新装的 skill 不在 sessionCommands 快照里——用 runtime skills 补齐（按命令去重）
  const skillCommands = (runtimeSkills ?? [])
    .filter((sk) => !registered.some((c) => c.command === `/skill:${sk.name}`))
    .map((sk) => ({
      command: `/skill:${sk.name}`,
      description: sk.description ?? "",
      source: "skill" as const,
    }));
  const allCommands: SlashCommand[] = [...registered, ...skillCommands];

  const trimmed = text.trim();
  // 参数上下文必须用原始 text 判定（trim 会吃掉尾空格，"/thinking " 永远匹配不上
  // `${cmd} `——曾致参数菜单被立即关闭）
  const raw = text;
  const isCommandMode = trimmed.startsWith("/") && !trimmed.includes(" ") && !raw.endsWith(" ");
  // 手动输入 "/thinking " 也能进入参数选择（命令后跟空格即认为要填参数）
  const typedCommand = !isCommandMode && trimmed.startsWith("/")
    ? allCommands.find((c) => raw === `${c.command} ` || raw.startsWith(`${c.command} `))
    : undefined;

  const filtered = isCommandMode
    ? allCommands.filter((c) => c.command.startsWith(trimmed) || c.command.includes(trimmed.slice(1)))
    : [];
  const argOptions = argsFor?.args?.options ?? [];
  const menuOpen = !dismissedRef.current && ((isCommandMode && filtered.length > 0) || (argsFor !== null && argOptions.length > 0));
  // 参数模式的可见项（键盘选择必须基于过滤后列表，U-02：此前取全量导致输错序号选中错误项）
  const argsQuery = typedCommand === argsFor ? raw.slice(argsFor.command.length).trim() : "";
  const visibleArgs = argsFor ? (argsQuery ? argOptions.filter((o) => o.startsWith(argsQuery)) : [...argOptions]) : [];
  const visibleArgsRef = useRef<string[]>([]);
  visibleArgsRef.current = visibleArgs;
  stateRef.current = { filtered, argOptions: [...argOptions] };

  useEffect(() => {
    setSelectedIndex(0);
    dismissedRef.current = false; // 输入变化重新允许弹出
  }, [text, argsFor]);

  // 输入变化离开参数命令（比如删掉空格）时退出参数模式（同样用原始 text 判定）
  useEffect(() => {
    if (
      argsFor &&
      raw !== `${argsFor.command} ` &&
      !raw.startsWith(`${argsFor.command} `)
    ) {
      // 用户改了命令（删空格回裸命令/换命令）→ 退出参数模式回命令列表
      setArgsFor(null);
    }
  }, [text, argsFor, isCommandMode, raw]);

  const chooseCommand = (cmd: SlashCommand) => {
    if (cmd.args?.options?.length) {
      // 进入参数选择（保持菜单打开，列出选项）
      setArgsFor(cmd);
      setSelectedIndex(0);
      onSelect(`${cmd.command} `, { send: false });
      return;
    }
    setArgsFor(null);
    if (cmd.local) {
      // 本地动作：无参直接执行（compact/tree）
      onLocalAction({ kind: cmd.local } as LocalAction, `${cmd.command}`);
      return;
    }
    if (cmd.source === "skill") {
      // 技能：渲染为输入框胶囊（只显示技能名，长描述不进胶囊）
      onSkillPick(cmd.command, cmd.command.replace(/^\/skill:/, ""));
      return;
    }
    if (cmd.source === "prompt" || cmd.source === "extension") {
      // 命令类：插入到输入框等用户补充参数，不自动发送
      onSelect(`${cmd.command} `, { send: false });
      return;
    }
    onSelect(`${cmd.command} `, { send: true });
  };

  const chooseArg = (value: string) => {
    const cmd = argsFor;
    setArgsFor(null);
    if (!cmd) return;
    if (cmd.local === "thinking") {
      onLocalAction({ kind: "thinking", level: value }, `${cmd.command} ${value}`);
      return;
    }
    onSelect(`${cmd.command} ${value} `, { send: true });
  };

  // 键盘导航：原生 listener 先于 React 合成事件执行，
  // 拦截 Enter/Tab/箭头时 preventDefault + stopPropagation，防止被 composer 当成发送
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const handler = (e: KeyboardEvent) => {
      if (!menuOpen) return;
      const { filtered: cmds, argOptions: opts } = stateRef.current;
      const inArgs = argsFor !== null;
      const listLen = inArgs ? visibleArgsRef.current.length : cmds.length;
      if (listLen === 0) return;
      if (e.key === "Enter" && e.isComposing) return; // IME 组合中的 Enter 是确认输入
      if (e.key === "ArrowDown") {
        e.preventDefault(); e.stopPropagation();
        setSelectedIndex((i) => Math.min(i + 1, listLen - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault(); e.stopPropagation();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Tab" || e.key === "Enter") {
        e.preventDefault(); e.stopPropagation();
        if (inArgs) {
          const v = visibleArgsRef.current[selectedIndex];
          if (v) chooseArg(v);
        } else {
          const c = cmds[selectedIndex];
          if (c) chooseCommand(c);
        }
      } else if (e.key === "Escape") {
        e.stopPropagation(); e.preventDefault();
        setArgsFor(null);
        dismissedRef.current = true; // 收起菜单（含命令列表，U-03）
      }
    };
    ta.addEventListener("keydown", handler);
    return () => ta.removeEventListener("keydown", handler);
  });

  if (!menuOpen) return null;

  if (argsFor) {
    const visible = visibleArgs;
    return (
      <div className="slash-menu">
        <div className="slash-menu__group">{argsFor.command} · 选择{argsFor.args?.label ?? "参数"}</div>
        {visible.map((value, i) => {
          const globalIndex = argOptions.indexOf(value);
          return (
            <div
              key={value}
              className={`slash-menu__item ${globalIndex === selectedIndex ? "active" : ""}`}
              onMouseEnter={() => setSelectedIndex(globalIndex)}
              onMouseDown={(e) => { e.preventDefault(); chooseArg(value); }}
            >
              <span className="slash-menu__cmd">{value}</span>
              <span className="slash-menu__desc">{argsFor.command} {value}</span>
            </div>
          );
        })}
        {visible.length === 0 && <div className="slash-menu__item at-file-menu__empty">没有匹配的选项</div>}
      </div>
    );
  }

  return (
    <div className="slash-menu">
      {filtered.map((cmd, i) => (
        <div
          key={cmd.command + (cmd.source ?? "")}
          ref={(el) => { itemRefs.current[i] = el; }}
          className={`slash-menu__item ${i === selectedIndex ? "active" : ""}`}
          onMouseEnter={() => setSelectedIndex(i)}
          onMouseDown={(e) => { e.preventDefault(); chooseCommand(cmd); }}
        >
          <span className="slash-menu__cmd">{cmd.command}</span>
          <span className="slash-menu__desc">
            {cmd.description}
            {cmd.args ? " · 选择后填参数" : ""}
            {cmd.source ? ` (${SOURCE_LABELS[cmd.source] ?? cmd.source})` : ""}
          </span>
        </div>
      ))}
    </div>
  );
}

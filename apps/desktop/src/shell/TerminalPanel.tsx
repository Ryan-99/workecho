import { useState, useEffect, useRef, useCallback } from "react";
import { Terminal as TerminalIcon } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { DesktopAppState } from "../desktop-state";

interface Props {
  state: DesktopAppState;
}

/** 终端面板 — xterm.js 全功能终端模拟器 */
export function TerminalPanel({ state }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  // R-19：onData 闭包不能依赖 state（订阅时 sessionId 还是 null，输入会被丢）——用 ref 直读
  const sessionRef = useRef<string | null>(null);
  const [height, setHeight] = useState(200);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsId = state.selectedWorkspaceId;
  const resizeRef = useRef<{ startY: number; startH: number } | null>(null);

  useEffect(() => {
    if (!wsId || !containerRef.current) return;
    let disposed = false;

    const init = async () => {
      if (disposed || !containerRef.current) return;

      const term = new Terminal({
        fontSize: 13,
        fontFamily: "'SF Mono', Consolas, 'Courier New', monospace",
        theme: document.documentElement.classList.contains("dark")
          ? {
              background: "#1e1e1f",
              foreground: "#d4d4d8",
              cursor: "#a0a0a8",
              cursorAccent: "#1e1e1f",
              selectionBackground: "#3a3a3caa",
              black: "#2a2a2b",
              red: "#e07a70",
              green: "#6a9a70",
              yellow: "#c4a04a",
              blue: "#6a8ac08a",
              magenta: "#a080b0",
              cyan: "#5a9a9a",
              white: "#8a8a92",
              brightBlack: "#6e6e76",
              brightRed: "#e88a80",
              brightGreen: "#7aaa80",
              brightYellow: "#d4b060",
              brightBlue: "#8aaad0",
              brightMagenta: "#b090c0",
              brightCyan: "#6aabb0",
              brightWhite: "#ececf1",
            }
          : {
              background: "#fafafa",
              foreground: "#3c3c3c",
              cursor: "#6b6b6b",
              cursorAccent: "#fafafa",
              selectionBackground: "#d0d0d0aa",
              black: "#3c3c3c",
              red: "#c0392b",
              green: "#27ae60",
              yellow: "#d4a017",
              blue: "#2563eb",
              magenta: "#8e44ad",
              cyan: "#16a085",
              white: "#9a9a9a",
              brightBlack: "#6b6b6b",
              brightRed: "#e74c3c",
              brightGreen: "#2ecc71",
              brightYellow: "#f1c40f",
              brightBlue: "#3b82f6",
              brightMagenta: "#a569bd",
              brightCyan: "#1abc9c",
              brightWhite: "#1f1f1f",
            },
        cursorBlink: true,
        scrollback: 2000,
        allowProposedApi: true,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(containerRef.current);
      try { fit.fit(); } catch {}
      termRef.current = term;
      fitRef.current = fit;

      // 创建 pty 会话
      try {
        const panel = await window.piApp.ensureTerminalPanel(wsId, "main", {
          cols: term.cols, rows: term.rows,
        });
        // R-19：await 期间用户可能已切走工作区（effect cleanup 已 dispose 旧
        // xterm）——旧工作区的 pty 不得绑进新终端
        if (disposed) return;
        if (panel.sessions.length > 0) {
          const s = panel.sessions[0];
          if (s) {
            setSessionId(s.id);
            sessionRef.current = s.id;
            if (s.replay) term.write(s.replay);
          }
        }
      } catch (e) {
        if (disposed) return;
        console.error("[terminal] pty 初始化失败:", e);
        term.writeln("\r\n终端初始化失败: " + (e as Error).message);
      }

      // xterm 输入 → pty
      term.onData((data: string) => {
        const sid = sessionRef.current;
        if (sid) {
          window.piApp.writeTerminal(sid, data);
        }
      });
    };
    init();

    return () => {
      disposed = true;
      // R-19：解除旧 pty 绑定，避免 onTerminalData 把旧工作区输出写进新终端
      sessionRef.current = null;
      setSessionId(null);
      if (termRef.current) {
        termRef.current.dispose();
        termRef.current = null;
      }
    };
  }, [wsId]);

  // pty 输出 → xterm
  useEffect(() => {
    if (!sessionId) return;
    const off = window.piApp.onTerminalData((event: { terminalId: string; data: string }) => {
      if (event.terminalId === sessionId && termRef.current) {
        termRef.current.write(event.data);
      }
    });
    return off;
  }, [sessionId]);

  // sessionId 变化时重新绑定 onData（确保 sessionId 可用）
  useEffect(() => {
    if (!sessionId || !termRef.current) return;
    const disposable = termRef.current.onData((data: string) => {
      window.piApp.writeTerminal(sessionId, data);
    });
    return () => disposable?.dispose?.();
  }, [sessionId]);

  // 高度变化时 refit
  useEffect(() => {
    if (fitRef.current && termRef.current) {
      try { fitRef.current.fit(); } catch {}
    }
  }, [height]);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    resizeRef.current = { startY: e.clientY, startH: height };
    const onMove = (ev: MouseEvent) => {
      if (!resizeRef.current) return;
      const delta = resizeRef.current.startY - ev.clientY;
      const h = Math.max(80, Math.min(400, resizeRef.current.startH + delta));
      setHeight(h);
    };
    const onUp = () => {
      resizeRef.current = null;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      if (fitRef.current) { try { fitRef.current.fit(); } catch {} }
      if (termRef.current) termRef.current.focus();
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [height]);

  return (
    <div className="terminal-panel" style={{ height }}>
      <div className="terminal-resize-handle" onMouseDown={handleResizeStart} />
      <div className="terminal-header">
        <span><TerminalIcon size={13} /> 终端</span>
      </div>
      <div ref={containerRef} className="terminal-xterm-container" />
    </div>
  );
}

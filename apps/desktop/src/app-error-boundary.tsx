import React from "react";

/**
 * R-23：全局错误边界。
 * 此前渲染层任何组件抛错都会让整窗白屏（无堆栈、无恢复入口）。
 * 边界放在最外层，捕获后显示可读的错误卡片 + 错误摘要，
 * 提供"重新加载"恢复入口；错误全文进 console 便于 DevTools 取证。
 */
interface ErrorBoundaryState {
  error: Error | null;
}

export class AppErrorBoundary extends React.Component<{ children: React.ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[renderer] 未捕获的渲染错误:", error, info.componentStack);
  }

  private handleReload = () => {
    this.setState({ error: null });
    // 完整重载渲染层（主进程与在途会话不受影响）
    window.location.reload();
  };

  render() {
    if (!this.state.error) return this.props.children;
    const message = this.state.error.message || String(this.state.error);
    return (
      <div
        style={{
          position: "fixed",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#f5f4f2",
          fontFamily: "system-ui, -apple-system, sans-serif",
          color: "#4a4a48",
          zIndex: 2147483647,
        }}
      >
        <div
          style={{
            maxWidth: 520,
            padding: "28px 32px",
            background: "#fff",
            borderRadius: 12,
            border: "1px solid #e3e1dd",
            boxShadow: "0 8px 28px rgba(0,0,0,0.08)",
          }}
        >
          <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>界面出现了一个问题</div>
          <div style={{ fontSize: 13, color: "#8a8782", marginBottom: 20, wordBreak: "break-all" }}>
            {message.slice(0, 600)}
          </div>
          <button
            type="button"
            onClick={this.handleReload}
            style={{
              padding: "8px 20px",
              fontSize: 13,
              borderRadius: 999,
              border: "1px solid #cfccc6",
              background: "#6e6b66",
              color: "#fff",
              cursor: "pointer",
            }}
          >
            重新加载界面
          </button>
        </div>
      </div>
    );
  }
}

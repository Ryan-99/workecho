import { useState, useEffect } from "react";
import { FileEdit, ChevronRight, RefreshCw, FilePlus, FileX, FileDiff } from "lucide-react";
import type { DesktopAppState } from "../desktop-state";
import type { ChangedFilesResult, ChangedFileEntry } from "../ipc";

interface Props {
  state: DesktopAppState;
}

/**
 * 文件变更追踪面板（#23 Diff 查看器 + #24 文件变更追踪）。
 * 显示当前 workspace 的 git 变更文件列表，点击查看 diff。
 */
export function FilesPanel({ state }: Props) {
  const [files, setFiles] = useState<ChangedFilesResult | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const wsId = state.selectedWorkspaceId;

  const fetchFiles = async () => {
    if (!wsId) return;
    setLoading(true);
    try {
      const result = await window.piApp.getChangedFiles(wsId);
      setFiles(result);
    } catch {
      setFiles(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchFiles();
  }, [wsId]);

  const handleSelectFile = async (filePath: string) => {
    setSelectedFile(filePath);
    setDiff(null);
    try {
      const d = await window.piApp.getFileDiff(wsId, filePath);
      setDiff(d);
    } catch {
      setDiff("无法获取 diff");
    }
  };

  const changedFiles = files?.state === "available" ? files.files : [];

  return (
    <div className="files-panel">
      <div className="files-header">
        <span className="files-title"><FileEdit size={14} /> 文件变更</span>
        <button className="refresh-btn" onClick={fetchFiles} title="刷新"><RefreshCw size={12} /></button>
      </div>

      {loading && <div className="status-empty">加载中...</div>}

      {!loading && files?.state === "unavailable" && (
        <div className="status-empty">{files.error.message}</div>
      )}

      {!loading && changedFiles.length === 0 && files?.state === "available" && (
        <div className="status-empty">没有文件变更</div>
      )}

      {changedFiles.length > 0 && (
        <div className="files-list">
          {changedFiles.map((f) => (
            <FileRow key={f.path} file={f} selected={selectedFile === f.path} onClick={() => handleSelectFile(f.path)} />
          ))}
        </div>
      )}

      {selectedFile && diff !== null && (
        <div className="diff-viewer">
          <div className="diff-header">
            <span>{selectedFile}</span>
            <button className="diff-close" onClick={() => { setSelectedFile(null); setDiff(null); }}>×</button>
          </div>
          <pre className="diff-content">{diff}</pre>
        </div>
      )}
    </div>
  );
}

function FileRow({ file, selected, onClick }: { file: ChangedFileEntry; selected: boolean; onClick: () => void }) {
  const icon = file.status === "added" || file.status === "untracked"
    ? <FilePlus size={13} className="status-added" />
    : file.status === "deleted"
    ? <FileX size={13} className="status-deleted" />
    : <FileDiff size={13} className="status-modified" />;

  return (
    <div className={`file-row ${selected ? "active" : ""}`} onClick={onClick}>
      {icon}
      <span className="file-path">{file.path}</span>
      <span className={`file-status status-${file.status}`}>{file.status}</span>
      {selected && <ChevronRight size={12} className="chev" />}
    </div>
  );
}

import { useState } from "react";
import { appConfirm } from "./app-dialog";
import { RotateCcw, Trash2, X } from "lucide-react";
import type { SessionRecord } from "../desktop-state";

interface Props {
  archivedSessions: SessionRecord[];
  onRestore: (id: string) => void;
  onDeleteForever: (id: string) => void;
  onClose: () => void;
}

export function ArchiveView({ archivedSessions, onRestore, onDeleteForever, onClose }: Props) {
  return (
    <div className="archive-overlay">
      <div className="archive-modal">
        <div className="archive-header">
          <h2>归档管理</h2>
          <button className="archive-close" onClick={onClose}><X size={18} /></button>
        </div>
        {archivedSessions.length === 0 ? (
          <div className="status-empty" style={{ padding: 32, textAlign: "center" }}>没有已归档的会话</div>
        ) : (
          <div className="archive-list">
            {archivedSessions.map((s) => (
              <div key={s.id} className="archive-item">
                <div className="archive-item-info">
                  <span className="archive-item-title">{s.title || "新会话"}</span>
                  <span className="archive-item-date">{s.updatedAt?.slice(0, 10)}</span>
                </div>
                <div className="archive-item-actions">
                  <button className="btn-ghost" title="恢复" onClick={() => onRestore(s.id)}>
                    <RotateCcw size={13} /> 恢复
                  </button>
                  <button className="btn-ghost danger" title="彻底删除" onClick={() => {
                    void appConfirm(`彻底删除"${s.title}"？此操作不可恢复。`, { danger: true }).then((ok) => { if (ok) onDeleteForever(s.id); });
                  }}>
                    <Trash2 size={13} /> 删除
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

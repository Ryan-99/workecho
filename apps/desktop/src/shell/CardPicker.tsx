import { useState } from "react";
import { X, Plus, Sparkles, Loader } from "lucide-react";
import * as LucideIcons from "lucide-react";

interface Template {
  title: string;
  icon: string;
  entityType: string;
  displayFields: string[];
  fieldLabels?: Record<string, string>;
}

const PRESETS: Array<Template & { id: string }> = [
  { id: "okr", title: "OKR 进展", icon: "Target", entityType: "okr", displayFields: ["title", "progress", "status"], fieldLabels: { title: "目标", progress: "进度", status: "状态" } },
  { id: "todos", title: "待办事项", icon: "CheckSquare", entityType: "todos", displayFields: ["title", "status", "dueDate"], fieldLabels: { title: "事项", status: "状态", dueDate: "截止" } },
];

interface Props {
  existingIds: string[];
  onAdd: (template: Template & { fieldLabels?: Record<string, string> }) => void;
  onCreateViaAI: (description: string) => Promise<void>;
  onClose: () => void;
}

export function CardPicker({ existingIds, onAdd, onCreateViaAI, onClose }: Props) {
  const [description, setDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const availablePresets = PRESETS.filter((t) => !existingIds.some((id) => id.includes(t.entityType)));

  const handleCreate = async () => {
    const desc = description.trim();
    if (!desc) return;
    setCreating(true);
    setError(undefined);
    try {
      await onCreateViaAI(desc);
      setDescription("");
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="archive-overlay" onClick={onClose}>
      <div className="archive-modal" onClick={(e) => e.stopPropagation()} style={{ width: 520 }}>
        <div className="archive-header">
          <h2>添加卡片</h2>
          <button className="archive-close" onClick={onClose}><X size={18} /></button>
        </div>
        <div style={{ padding: 20 }}>
          {/* 预定义模板 */}
          {availablePresets.length > 0 && (
            <>
              <div className="picker-section-title">快速添加</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 24 }}>
                {availablePresets.map((t) => {
                  const Icon = (LucideIcons as any)[t.icon] ?? LucideIcons.FileText;
                  return (
                    <div key={t.id} className="card-pick-item" onClick={() => { onAdd(t); onClose(); }}>
                      <Icon size={16} />
                      <span style={{ fontSize: 13, fontWeight: 500 }}>{t.title}</span>
                      <Plus size={13} style={{ marginLeft: "auto", color: "var(--text-muted)" }} />
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {/* AI 自定义 */}
          <div className="picker-section-title">
            <Sparkles size={13} /> 自定义卡片
          </div>
          <p style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 10 }}>
            描述你想要的卡片，AI 会自动创建数据结构和示例。比如："客户拜访记录" "竞品分析" "合同跟进"
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              className="api-key-input"
              style={{ flex: 1, width: "auto" }}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !creating) handleCreate(); }}
              placeholder="输入卡片名称或描述..."
              autoFocus
              disabled={creating}
            />
            <button className="btn-primary" onClick={handleCreate} disabled={creating || !description.trim()}>
              {creating ? <Loader size={13} className="spin" /> : <Sparkles size={13} />} 创建
            </button>
          </div>
          {error && <div style={{ color: "var(--danger)", fontSize: 12, marginTop: 8 }}>{error}</div>}
        </div>
      </div>
    </div>
  );
}

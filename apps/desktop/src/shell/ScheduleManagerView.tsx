import { useState, useEffect } from "react";
import { appConfirm } from "./app-dialog";
import { Plus, Trash2, Clock, Check, Loader } from "lucide-react";

interface ScheduleRule {
  id: string;
  name: string;
  enabled: boolean;
  trigger: {
    type: "every" | "before_event" | "at";
    time?: string;
    weekday?: number;
    date?: string;
    days?: number;
    entityType?: string;
    field?: string;
  };
  action: string;
}

const WEEKDAY_NAMES = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

interface Props {
  onClose?: () => void;
}

/** 定时任务页面（主区域独立页面，session 样式任务列表） */
export function ScheduleManagerView({ onClose }: Props) {
  const [rules, setRules] = useState<ScheduleRule[] | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [desc, setDesc] = useState("");
  const api = window as any;

  const load = async () => {
    try {
      const list = await api.piApp?.listSchedulesUI?.();
      setRules(Array.isArray(list) ? list : []);
    } catch {
      setRules([]);
    }
  };

  useEffect(() => { load(); }, []);

  /** 最小化配置：用户一句自然语言描述 → 发给 Agent 解析并调用 wiki_create_schedule 创建 */
  const handleCreate = () => {
    const text = desc.trim();
    if (!text) return;
    api.piApp?.submitComposer?.(
      `请创建一个定时任务：${text}\n\n用 wiki_create_schedule 工具创建。自动从描述中解析触发时间（每天/每周几/几点/事件前几天），name 用简短的任务名，action 是到时间后你要执行的具体动作。创建完成后简要确认。`
    );
    setDesc("");
    setShowForm(false);
    onClose?.(); // 回到对话看 Agent 处理
  };

  const handleRemove = async (id: string) => {
    await api.piApp?.removeScheduleUI?.(id);
    await load();
  };

  /** 手动触发一次（发送到对话） */
  const handleRunNow = (r: ScheduleRule) => {
    api.piApp?.submitComposer?.(`[定时任务: ${r.name}] ${r.action}`);
  };

  const describeTrigger = (r: ScheduleRule): string => {
    if (r.trigger?.type === "every") {
      const day = r.trigger.weekday !== undefined ? `每${WEEKDAY_NAMES[r.trigger.weekday]}` : "每天";
      return `${day} ${r.trigger.time ?? ""}`.trim();
    }
    if (r.trigger?.type === "at") return `${r.trigger.date ?? ""} ${r.trigger.time ?? ""}`.trim();
    if (r.trigger?.type === "before_event") {
      return `维保到期前 ${r.trigger.days ?? 0} 天`;
    }
    return "未知触发";
  };

  return (
    <div className="schedule-page">
      {/* 页头 */}
      <div className="schedule-page-header">
        <h2><Clock size={15} style={{ verticalAlign: -2, marginRight: 6 }} /> 定时任务</h2>
        <span className="hint">
          {rules ? `${rules.length} 个任务` : "加载中"}
        </span>
        {!showForm && (
          <button className="schedule-new-btn" onClick={() => setShowForm(true)}>
            <Plus size={11} /> 新建
          </button>
        )}
      </div>

      {/* 新建：一句话描述，Agent 解析创建 */}
      {showForm && (
        <div className="schedule-form">
          <input
            autoFocus
            className="schedule-form-input"
            placeholder="用一句话描述，如：每周五下午5点给我生成本周工作周报"
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleCreate(); if (e.key === "Escape") { setShowForm(false); setDesc(""); } }}
          />
          <div className="schedule-form-actions">
            <button className="schedule-new-btn" onClick={handleCreate} disabled={!desc.trim()}>
              <Check size={11} /> 创建（AI 解析）
            </button>
            <button className="btn-ghost" onClick={() => { setShowForm(false); setDesc(""); }}>取消</button>
          </div>
        </div>
      )}

      {/* 任务列表（session 样式） */}
      {rules === null ? (
        <div className="schedule-empty"><Loader size={14} className="spin" /> 加载中...</div>
      ) : rules.length === 0 ? (
        <div className="schedule-empty">
          暂无定时任务
          <div style={{ fontSize: 11, marginTop: 4 }}>点击上方「新建定时任务」创建第一个任务</div>
        </div>
      ) : (
        <div className="schedule-list">
          {rules.map((r) => (
            <div key={r.id} className="schedule-item">
              <div className="schedule-item-main">
                <div className="schedule-item-title-row">
                  <Clock size={12} className="schedule-item-icon" />
                  <span className="schedule-item-title">{r.name}</span>
                  <span className={`schedule-item-badge ${r.enabled ? "" : "off"}`}>
                    {r.enabled ? "启用" : "禁用"}
                  </span>
                  <span className="schedule-item-trigger">{describeTrigger(r)}</span>
                </div>
                <div className="schedule-item-action">{r.action}</div>
              </div>
              <div className="schedule-item-actions">
                <button className="schedule-run-btn" title="立即执行一次" onClick={() => handleRunNow(r)}>立即执行</button>
                <button
                  className="action-btn danger"
                  title="删除任务"
                  onClick={() => {
                    void appConfirm(`删除定时任务"${r.name}"？`, { danger: true }).then((ok) => { if (ok) handleRemove(r.id); });
                  }}
                ><Trash2 size={13} /></button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

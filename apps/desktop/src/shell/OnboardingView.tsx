import { useState } from "react";
import { FolderOpen, ScanSearch, SkipForward, Loader, Check, Folder } from "lucide-react";
import workechoMarkUrl from "../assets/workecho-mark.svg?url";

interface Props {
  defaultPath: string;
  onPickWorkspace: () => Promise<string | null>;
  onConfirmWorkspace: (path: string) => Promise<void>;
  onScan: () => Promise<{ total: number; ok: number; categories: Record<string, number> }>;
  onFinish: () => void;
}

/**
 * 首次启动引导：两步
 * 1. 选择/确认工作目录（强制）
 * 2. 选择是否扫描全 PC 文档（可选）
 */
export function OnboardingView({ defaultPath, onPickWorkspace, onConfirmWorkspace, onScan, onFinish }: Props) {
  const [step, setStep] = useState<1 | 2>(1);
  const [workspacePath, setWorkspacePath] = useState(defaultPath);
  const [confirming, setConfirming] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<{ total: number; ok: number; categories: Record<string, number> } | null>(null);
  const [error, setError] = useState<string | undefined>();

  const handlePick = async () => {
    setError(undefined);
    const picked = await onPickWorkspace();
    if (picked) setWorkspacePath(picked);
  };

  const handleConfirm = async () => {
    setConfirming(true);
    setError(undefined);
    try {
      await onConfirmWorkspace(workspacePath);
      setStep(2);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setConfirming(false);
    }
  };

  const handleScan = async () => {
    setScanning(true);
    setError(undefined);
    try {
      const result = await onScan();
      setScanResult(result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setScanning(false);
    }
  };

  const handleSkipOrFinish = () => {
    onFinish();
  };

  return (
    <div className="onboarding">
      <div className="onboarding-content">
        <div className="onboarding-logo"><img src={workechoMarkUrl} alt="Workecho" style={{ height: 40, width: "auto" }} /></div>
        <h1 className="onboarding-title">欢迎使用 Workecho</h1>

        {step === 1 && (
          <div className="onboarding-step">
            <p className="onboarding-desc">
              选择一个目录作为你的工作区。业务数据（OKR、维保、待办、知识库）会存在这里。
            </p>
            <div className="onboarding-path-box" onClick={handlePick}>
              <FolderOpen size={16} />
              <span className="path-text">{workspacePath}</span>
              <span className="path-change">更改</span>
            </div>
            {error && <div className="onboarding-error">{error}</div>}
            <button className="onboarding-btn primary" onClick={handleConfirm} disabled={confirming}>
              {confirming ? <Loader size={14} className="spin" /> : <Check size={14} />} 确认并继续
            </button>
          </div>
        )}

        {step === 2 && (
          <div className="onboarding-step">
            <p className="onboarding-desc">
              工作目录已就绪。要不要扫描你电脑上的文档（桌面/文档/下载 + 其他盘），
              自动分类导入知识库？
            </p>
            <p className="onboarding-hint">
              扫描只处理 .md/.txt 文件，不会修改或移动原文件。也可以跳过，以后把文件发给 agent 处理。
            </p>

            {scanning && (
              <div className="onboarding-scanning">
                <Loader size={16} className="spin" /> 正在扫描并导入文档...
              </div>
            )}

            {scanResult && (
              <div className="onboarding-scan-result">
                <Check size={14} /> 导入完成：{scanResult.ok} 篇文档
                <div className="cat-detail">
                  {Object.entries(scanResult.categories).map(([k, v]) => (
                    <span key={k} className="cat-tag">{k}: {v}</span>
                  ))}
                </div>
              </div>
            )}

            {error && <div className="onboarding-error">{error}</div>}

            {!scanning && !scanResult && (
              <button className="onboarding-btn primary" onClick={handleScan}>
                <ScanSearch size={14} /> 立即扫描
              </button>
            )}
            {scanResult && (
              <button className="onboarding-btn primary" onClick={handleSkipOrFinish}>
                <Check size={14} /> 完成，开始使用
              </button>
            )}
            {!scanning && !scanResult && (
              <button className="onboarding-btn ghost" onClick={handleSkipOrFinish}>
                <SkipForward size={14} /> 跳过，以后再说
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

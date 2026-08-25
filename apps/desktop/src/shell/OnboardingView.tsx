import { useState } from "react";
import { FolderOpen, ScanSearch, SkipForward, Loader, Check, Cloud, ArrowRight } from "lucide-react";
import workechoMarkUrl from "../assets/workecho-mark.svg?url";

interface Props {
  defaultPath: string;
  onPickWorkspace: () => Promise<string | null>;
  onConfirmWorkspace: (path: string) => Promise<void>;
  onScan: () => Promise<{ total: number; byExt: Record<string, number> }>;
  onImport: () => Promise<{
    total: number;
    ok: number;
    categories: Record<string, number>;
    skipped?: { dup: number; ignore: number; empty: number };
  }>;
  onFinish: () => Promise<void>;
  /** 打开模型服务配置引导（复用 ProviderSetupDialog） */
  onConfigureProvider: () => void;
  /** 是否已有可用模型服务（决定第三步的完成话术） */
  providerReady: boolean;
}

const EXT_LABELS: Record<string, string> = {
  ".docx": "Word",
  ".pptx": "PPT",
  ".xlsx": "Excel",
  ".md": "Markdown",
  ".txt": "文本",
};

/**
 * 首次启动引导：三步
 * 1. 选择/确认工作目录（强制）
 * 2. 扫描文档（两步制：先统计不读正文，确认后才导入）
 * 3. 配置模型服务（可跳过，首次发消息时会再次引导）
 */
export function OnboardingView({
  defaultPath,
  onPickWorkspace,
  onConfirmWorkspace,
  onScan,
  onImport,
  onFinish,
  onConfigureProvider,
  providerReady,
}: Props) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [workspacePath, setWorkspacePath] = useState(defaultPath);
  const [confirming, setConfirming] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [importing, setImporting] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [scanStats, setScanStats] = useState<{ total: number; byExt: Record<string, number> } | null>(null);
  const [importResult, setImportResult] = useState<{
    total: number;
    ok: number;
    categories: Record<string, number>;
    skipped?: { dup: number; ignore: number; empty: number };
  } | null>(null);
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
      setScanStats(await onScan());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setScanning(false);
    }
  };

  const handleImport = async () => {
    setImporting(true);
    setError(undefined);
    try {
      setImportResult(await onImport());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setImporting(false);
    }
  };

  const handleFinish = async () => {
    setFinishing(true);
    setError(undefined);
    try {
      await onFinish();
    } catch (e) {
      // 完成失败不再卡死：提示后允许重试/跳过
      setError(`完成引导失败：${(e as Error).message}`);
      setFinishing(false);
    }
  };

  return (
    <div className="onboarding">
      <div className="onboarding-content">
        <div className="onboarding-logo"><img src={workechoMarkUrl} alt="Workecho" style={{ height: 40, width: "auto" }} /></div>
        <h1 className="onboarding-title">欢迎使用 Workecho</h1>

        {step === 1 && (
          <div className="onboarding-step">
            <p className="onboarding-desc">
              选择一个目录作为你的工作区，知识库会存在这里。
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
              要不要扫描你电脑上的文档（桌面/文档目录），导入知识库？
            </p>
            <p className="onboarding-hint">
              扫描 Word、PPT、Excel、Markdown 和文本文件。扫描阶段只统计文件名和格式，
              <strong>不读取文件内容</strong>；你在下一步确认导入后才会读取正文并自动分类，
              原文件不会被修改或移动。也可以跳过，以后把文件直接发给助手处理。
            </p>

            {scanning && (
              <div className="onboarding-scanning">
                <Loader size={16} className="spin" /> 正在统计文档...
              </div>
            )}

            {scanStats && !importing && !importResult && (
              <div className="onboarding-scan-result">
                <ScanSearch size={14} /> 找到 {scanStats.total} 个文档
                <div className="cat-detail">
                  {Object.entries(scanStats.byExt).map(([ext, n]) => (
                    <span key={ext} className="cat-tag">{EXT_LABELS[ext] ?? ext}: {n}</span>
                  ))}
                </div>
              </div>
            )}

            {importing && (
              <div className="onboarding-scanning">
                <Loader size={16} className="spin" /> 正在读取并导入文档...
              </div>
            )}

            {importResult && (
              <div className="onboarding-scan-result">
                <Check size={14} /> 已导入 {importResult.ok} 篇文档
                {importResult.skipped && importResult.total - importResult.ok > 0 && (
                  <div className="cat-detail">
                    <span className="cat-tag">
                      跳过 {importResult.total - importResult.ok} 个
                      {importResult.skipped.dup > 0 && `（重复 ${importResult.skipped.dup}）`}
                      {importResult.skipped.empty > 0 && `（内容过短 ${importResult.skipped.empty}）`}
                      {importResult.skipped.ignore > 0 && `（不需要导入 ${importResult.skipped.ignore}）`}
                    </span>
                  </div>
                )}
                <div className="cat-detail">
                  {Object.entries(importResult.categories).map(([k, v]) => (
                    <span key={k} className="cat-tag">{k}: {v}</span>
                  ))}
                </div>
              </div>
            )}

            {error && <div className="onboarding-error">{error}</div>}

            {!scanning && !scanStats && (
              <button className="onboarding-btn primary" onClick={handleScan}>
                <ScanSearch size={14} /> 扫描我的文档
              </button>
            )}
            {scanStats && !importResult && !importing && scanStats.total > 0 && (
              <button className="onboarding-btn primary" onClick={handleImport}>
                <Check size={14} /> 导入这 {scanStats.total} 个文档
              </button>
            )}
            {(importResult || (scanStats && scanStats.total === 0) || !scanning) && !importing && (
              <button className="onboarding-btn ghost" onClick={() => setStep(3)}>
                <ArrowRight size={14} /> {importResult ? "下一步" : "跳过，继续"}
              </button>
            )}
          </div>
        )}

        {step === 3 && (
          <div className="onboarding-step">
            <p className="onboarding-desc">
              最后一步：接入一个模型服务，配好就能开始对话。
            </p>
            <p className="onboarding-hint">
              支持账号登录、API Key 或自定义 OpenAI 兼容端点。
            </p>
            {providerReady ? (
              <>
                <div className="onboarding-scan-result">
                  <Check size={14} /> 模型服务已就绪
                </div>
                <button className="onboarding-btn primary" onClick={handleFinish} disabled={finishing}>
                  {finishing ? <Loader size={14} className="spin" /> : <Check size={14} />} 完成，开始使用
                </button>
                <button className="onboarding-btn ghost" onClick={onConfigureProvider} disabled={finishing}>
                  <Cloud size={14} /> 再添加一个
                </button>
              </>
            ) : (
              <button className="onboarding-btn primary" onClick={onConfigureProvider} disabled={finishing}>
                <Cloud size={14} /> 配置模型服务
              </button>
            )}
            {!providerReady && (
              <p className="onboarding-hint">配置完成后即可开始使用。</p>
            )}
            {error && <div className="onboarding-error">{error}</div>}
          </div>
        )}
      </div>
    </div>
  );
}

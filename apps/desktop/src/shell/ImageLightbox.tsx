import { useEffect } from "react";
import { X } from "lucide-react";

/**
 * 图片大图预览（双击缩略图打开；ESC / 点击背景 / 右上 × 关闭）。
 * 纯渲染层组件，输入框缩略卡与消息内图片共用。
 */
export function ImageLightbox({
  src,
  alt,
  onClose,
}: {
  src: string;
  alt?: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="image-lightbox" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <button type="button" className="image-lightbox__close" onClick={onClose} title="关闭">
        <X size={16} />
      </button>
      <img src={src} alt={alt ?? "图片预览"} />
    </div>
  );
}

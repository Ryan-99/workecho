import { Notification, app, nativeImage } from "electron";
import path from "node:path";

/**
 * Workecho 品牌图标（用于系统通知等原生 UI）。
 * 开发模式跑的是 electron.exe，通知默认带 Electron 原生 logo——统一注入品牌图标；
 * 打包版 exe 自带 icon.ico，通知本就用应用图标，此处注入保持两态一致。
 */
let cachedIcon: Electron.NativeImage | null = null;

export function workechoNotificationIcon(): Electron.NativeImage | undefined {
  if (!Notification.isSupported()) return undefined;
  if (cachedIcon !== null) return cachedIcon.isEmpty() ? undefined : cachedIcon;
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, "icon.png")
    : path.join(app.getAppPath(), "resources", "icon.png");
  cachedIcon = nativeImage.createFromPath(iconPath);
  if (cachedIcon.isEmpty()) return undefined;
  // 通知图标缩小到 48px——按原尺寸(256)注入时 toast 渲染偏大（Ryan 反馈）
  cachedIcon = cachedIcon.resize({ width: 48 });
  return cachedIcon;
}

/** 统一通知构造：带 Workecho 品牌图标 */
export function showWorkechoNotification(options: {
  title: string;
  body: string;
  silent?: boolean;
  onClick?: () => void;
  onClose?: () => void;
}): Notification | null {
  if (!Notification.isSupported()) return null;
  const notification = new Notification({
    title: options.title,
    body: options.body,
    silent: options.silent ?? false,
    ...(workechoNotificationIcon() ? { icon: workechoNotificationIcon()! } : {}),
  });
  if (options.onClick) notification.on("click", options.onClick);
  if (options.onClose) notification.on("close", options.onClose);
  notification.show();
  return notification;
}

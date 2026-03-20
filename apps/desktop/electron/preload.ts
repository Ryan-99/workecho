import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("piApp", {
  platform: process.platform,
  versions: process.versions,
  ping: () => ipcRenderer.invoke("app:ping") as Promise<string>,
  openExternal: (url: string) => ipcRenderer.invoke("app:open-external", url) as Promise<void>,
});

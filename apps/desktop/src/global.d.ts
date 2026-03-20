export {};

declare global {
  interface Window {
    piApp: {
      platform: NodeJS.Platform;
      versions: NodeJS.ProcessVersions;
      ping(): Promise<string>;
      openExternal(url: string): Promise<void>;
    };
  }
}

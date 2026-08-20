import { join, resolve } from "node:path";
import { ModelRuntime, ModelRegistry, getAgentDir } from "@earendil-works/pi-coding-agent";
import { CustomProviderStore } from "./custom-provider-store.js";
import type { RuntimeSupervisorOptions } from "./runtime-supervisor.js";

/**
 * pi 0.84.x 适配：AuthStorage 类移除、ModelRegistry.create(authStorage, path) 静态工厂移除，
 * 统一由 ModelRuntime.create()（异步）承载 auth + models。依赖因此改为惰性 Promise 单例。
 */
export interface RuntimeDependencies {
  readonly agentDir: string;
  readonly modelRuntime: ModelRuntime;
  readonly modelRegistry: ModelRegistry;
  readonly customProviderStore: CustomProviderStore;
}

export async function createRuntimeDependencies(options: RuntimeSupervisorOptions = {}): Promise<RuntimeDependencies> {
  const agentDir = resolve(options.agentDir ?? getAgentDir());
  const modelsJsonPath = join(agentDir, "models.json");
  const modelRuntime = options.modelRuntime
    ?? await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: modelsJsonPath,
    });
  const modelRegistry = options.modelRegistry ?? new ModelRegistry(modelRuntime);
  const customProviderStore = options.customProviderStore ?? new CustomProviderStore(modelsJsonPath);
  return {
    agentDir,
    modelRuntime,
    modelRegistry,
    customProviderStore,
  };
}

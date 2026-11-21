import {
  NodeModelSelectionConfigRepository,
  createNodeModelSelectionFacade,
} from "@zcode/provider-node";
import {
  ProviderRegistryService,
  ProviderSettingsFacade,
  buildAcpBridgeProviders,
  createFailClosedAccountProviderConfigSnapshot,
  type AccountProviderConfigSnapshot,
  type Provider,
  type ProviderConfigSnapshot,
  type ProviderSettingsMutationTarget,
  type ProviderSource,
} from "@zcode/provider";
import { readAcpAgentsConfig } from "@zcode/acp-engine";
import {
  createProviderConfigRuntime,
  type ProviderConfigRuntime,
  type ProviderConfigRuntimeOptions,
} from "./providerConfigRuntime.js";
import {
  createModelSelectionService,
  createProviderSettingsService,
  type IModelSelectionService,
  type IProviderSettingsService,
  type ModelSelectionConfiguredDefaultSource,
  type ProviderSettingsConnectivityTester,
} from "./providerFacadeServices.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { getDataBaseDir } from "#src/paths.js";

const log = createServiceLogger("provider-runtime");

export interface ProviderRuntimeOptions extends ProviderConfigRuntimeOptions {
  readonly accountSource?: RefreshableProviderSource<AccountProviderConfigSnapshot>;
  readonly testConnectivity?: ProviderSettingsConnectivityTester;
}

export interface ProviderRuntimeDependencies {
  readonly configRuntime: ProviderConfigRuntime;
  readonly accountSource?: RefreshableProviderSource<AccountProviderConfigSnapshot>;
  readonly disposeAccountSource?: () => void;
  readonly testConnectivity?: ProviderSettingsConnectivityTester;
  readonly modelSelectionConfiguredDefaultSource?: ModelSelectionConfiguredDefaultSource;
  readonly disposeModelSelectionConfiguredDefaultSource?: () => void;
  /**
   * acp-bridge: 进程内合成、只进 Registry 的 ACP Provider（`acp:<id>`）。
   * 缺省时由 createProviderRuntimeFromConfigRuntime 从 `<dataBaseDir>/.zcode/acp-agents.json` 读取。
   */
  readonly extraRegistryProviders?: readonly Provider[];
}

interface RefreshableProviderSource<TSnapshot> extends ProviderSource<TSnapshot> {
  refresh?(reason: string): Promise<TSnapshot>;
}

/**
 * 普通 API Provider 可以在账号能力尚未装配时独立运行。
 * Account Provider 由当前 Built-in revision 对齐的 access.entitled=false Overlay 显式 fail-closed。
 */
export class EmptyAccountProviderConfigSource implements ProviderSource<AccountProviderConfigSnapshot> {
  constructor(readonly configSource: ProviderSource<ProviderConfigSnapshot>) {}

  async read(): Promise<AccountProviderConfigSnapshot> {
    return createFailClosedAccountProviderConfigSnapshot(await this.configSource.read());
  }

  onDidChange(): () => void {
    return () => {};
  }
}

/** 组装一个进程内共享的 Provider Config、Registry 与 Facade。 */
export class ProviderRuntime {
  readonly configService: ProviderConfigRuntime["configService"];
  readonly registryService: ProviderRegistryService;
  readonly providerSettings: IProviderSettingsService;
  readonly modelSelection: IModelSelectionService;
  readonly #configRuntime: ProviderConfigRuntime;
  readonly #disposeAccountSource?: () => void;
  readonly #disposeBuiltinRecovery: () => void;
  readonly #modelSelectionRuntime: IModelSelectionService & { dispose(): void };
  readonly #disposeModelSelectionConfiguredDefaultSource?: () => void;
  #startPromise: ReturnType<ProviderRegistryService["start"]> | null = null;
  #disposed = false;

  constructor(dependencies: ProviderRuntimeDependencies) {
    this.#configRuntime = dependencies.configRuntime;
    this.#disposeAccountSource = dependencies.disposeAccountSource;
    this.#disposeModelSelectionConfiguredDefaultSource =
      dependencies.disposeModelSelectionConfiguredDefaultSource;
    this.configService = this.#configRuntime.configService;
    const accountSource: RefreshableProviderSource<AccountProviderConfigSnapshot> =
      dependencies.accountSource ?? new EmptyAccountProviderConfigSource(this.configService);
    this.#disposeBuiltinRecovery = this.#configRuntime.onDidCheckZCodeBuiltin(async () => {
      const [config, account] = await Promise.all([
        this.configService.read(),
        accountSource.read(),
      ]);
      if (!this.#disposed && config.zcodeBuiltinRevision !== account.basedOnZCodeBuiltinRevision) {
        await accountSource.refresh?.("builtin-account-recovery");
      }
    });
    this.registryService = new ProviderRegistryService({
      configSource: this.configService,
      accountSource,
      // acp-bridge: 无 ACP 配置时为空数组，Registry 行为与改动前一致。
      ...(dependencies.extraRegistryProviders?.length
        ? { extraRegistryProviders: dependencies.extraRegistryProviders }
        : {}),
    });
    const mutations = createSettingsMutationTarget(
      this.#configRuntime,
      this.registryService,
      accountSource,
    );
    const ensureReady = () => this.start();
    const settingsFacade = new ProviderSettingsFacade(this.registryService, mutations);
    this.providerSettings = createProviderSettingsService(
      settingsFacade,
      ensureReady,
      dependencies.testConnectivity,
    );
    this.#modelSelectionRuntime = createModelSelectionService(
      createNodeModelSelectionFacade(this.registryService),
      ensureReady,
      dependencies.modelSelectionConfiguredDefaultSource,
    );
    this.modelSelection = this.#modelSelectionRuntime;
  }

  start(): Promise<void> {
    if (this.#disposed) throw new Error("ProviderRuntime 已 dispose");
    if (this.#startPromise) return this.#startPromise;
    const startPromise = this.#configRuntime.start().then(() => this.registryService.start());
    this.#startPromise = startPromise;
    void startPromise.catch(() => {
      if (this.#startPromise === startPromise) this.#startPromise = null;
    });
    return startPromise;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#disposeBuiltinRecovery();
    this.#modelSelectionRuntime.dispose();
    this.registryService.dispose();
    this.#disposeAccountSource?.();
    this.#disposeModelSelectionConfiguredDefaultSource?.();
    this.#configRuntime.dispose();
  }
}

function createSettingsMutationTarget(
  configRuntime: ProviderConfigRuntime,
  registryService: ProviderRegistryService,
  accountSource: RefreshableProviderSource<AccountProviderConfigSnapshot>,
): ProviderSettingsMutationTarget {
  const configService = configRuntime.configService;
  return {
    createPersonalProvider: (input) => configService.createPersonalProvider(input),
    savePersonalProviderOverlay: (providerId, config, membership, metadata) =>
      configService.savePersonalProviderOverlay(providerId, config, membership, metadata),
    deletePersonalProvider: (providerId) => configService.deletePersonalProvider(providerId),
    reorderPersonalProviders: (providerIds) => configService.reorderPersonalProviders(providerIds),
    reorderPersonalModels: (providerId, modelIds, membership) =>
      configService.reorderPersonalModels(providerId, modelIds, membership),
    // 手工四参数转发曾丢掉新增的配置模式；直接绑定完整签名，避免装配层截断写入意图。
    addPersonalModel: configService.addPersonalModel.bind(configService),
    renamePersonalModel: (providerId, currentModelId, nextModelId, membership) =>
      configService.renamePersonalModel(providerId, currentModelId, nextModelId, membership),
    deletePersonalModel: (providerId, modelId, membership) =>
      configService.deletePersonalModel(providerId, modelId, membership),
    setPersonalModelEnabled: (providerId, modelId, enabled, membership) =>
      configService.setPersonalModelEnabled(providerId, modelId, enabled, membership),
    savePersonalModelDraft: (
      providerId,
      originalModelId,
      nextModelId,
      config,
      expectedPersonalRevision,
      useRecommendedConfig,
      membership,
    ) =>
      configService.savePersonalModelDraft(
        providerId,
        originalModelId,
        nextModelId,
        config,
        expectedPersonalRevision,
        useRecommendedConfig,
        membership,
      ),
    refresh: (reason) => registryService.refresh(reason),
    refreshSources: async (reason) => {
      const [builtinResult, accountResult] = await Promise.allSettled([
        configRuntime.refreshZCodeBuiltin({ force: true }),
        accountSource.refresh?.(reason) ?? Promise.resolve(),
      ]);
      // 远端更新失败不代表本地配置不可用；此前统一抛错会让套餐切换回滚，
      // 并掩盖真正的账号失败。只降级远端更新，Config/Registry 和权益错误仍保留。
      if (builtinResult.status === "rejected") {
        log.warn(undefined, "Builtin 远端更新失败，继续使用本地配置", {
          reason,
          error: builtinResult.reason,
        });
      }
      const snapshot = await registryService.refresh(reason);
      if (accountResult.status === "rejected") throw accountResult.reason;
      return snapshot;
    },
  };
}

export function createProviderRuntime(options: ProviderRuntimeOptions): ProviderRuntime {
  const { accountSource, testConnectivity, ...configRuntimeOptions } = options;
  const configRuntime = createProviderConfigRuntime(configRuntimeOptions);
  const modelSelectionConfiguredDefaultSource = new NodeModelSelectionConfigRepository({
    personalRepository: configRuntime.personalRepository,
  });
  return createProviderRuntimeFromConfigRuntime({
    configRuntime,
    accountSource,
    testConnectivity,
    modelSelectionConfiguredDefaultSource,
    disposeModelSelectionConfiguredDefaultSource: () =>
      modelSelectionConfiguredDefaultSource.dispose(),
  });
}

export function createProviderRuntimeFromConfigRuntime(
  dependencies: ProviderRuntimeDependencies,
): ProviderRuntime {
  return new ProviderRuntime({
    ...dependencies,
    // acp-bridge: 未显式注入时读用户 ACP 配置；Host 与 CLI 读同一份文件、合成同一份 Provider。
    extraRegistryProviders: dependencies.extraRegistryProviders ?? loadAcpBridgeRegistryProviders(),
  });
}

/**
 * acp-bridge: 读 `<dataBaseDir>/.zcode/acp-agents.json`，合成与 CLI 逐字段相同的 `acp:<id>` Provider。
 * dataBaseDir 与 CLI `resolveZCodeDataBaseDir` 同规则（ZCODE_DATA_BASE_DIR 优先，空值回落 homedir），
 * Host 侧以 getDataBaseDir() 为准（它还承接 setDataBaseDir 覆盖，并把同一目录传给 CLI 子进程）。
 * 文件不存在/为空/坏掉时返回 []，本功能完全不出现；配置只在 Host 启动时读一次（与 acp-engine
 * 同步契约一致，文件很小），改配置后需重启。日志只写字段名与序号，不写 env 的值。
 */
export function loadAcpBridgeRegistryProviders(
  dataBaseDir: string = getDataBaseDir(),
): readonly Provider[] {
  try {
    const config = readAcpAgentsConfig(dataBaseDir);
    if (config.errors.length > 0) {
      log.warn(undefined, "ACP agents config has invalid entries", { errors: config.errors });
    }
    if (config.agents.length === 0) return [];
    log.info(undefined, "ACP agents loaded into provider registry", {
      agentIds: config.agents.map((agent) => agent.id),
    });
    return buildAcpBridgeProviders(config.agents);
  } catch (error) {
    // 配置坏了只关闭本功能，不能拖垮 Provider Runtime 启动。
    log.warn(undefined, "ACP agents config could not be loaded", {
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

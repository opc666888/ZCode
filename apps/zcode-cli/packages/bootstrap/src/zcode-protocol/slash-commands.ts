import { BUILTIN_ZCODE_SLASH_COMMAND_HELP_ENTRIES, type ZCodeSlashCommand } from "@zcode/shared";
import { resolveZCodeDataBaseDir } from "@zcode/adapters/config";
import { loadAcpAgents, readCommandCache } from "@zcode/acp-engine";
import { BUILTIN_WORKFLOW_COMMAND_NAME } from "../builtin-workflow-command.js";
import {
  listZCodeCustomCommands,
  type ListZCodeCustomCommandsOptions,
} from "../custom-commands.js";
import {
  APP_PROTOCOL_VISIBLE_BUILTIN_SLASH_COMMAND_NAMES,
  isReservedZCodeSlashCommandName,
} from "../slash-command-surface.js";

export interface ListProtocolSlashCommandsOptions extends ListZCodeCustomCommandsOptions {
  /**
   * 动态工作流灰度门（docs/dynamic-workflow/launch.md「Gray release」）。**只有显式 false
   * 才剔除** 内置 `workflow`：CLI 自身的目录装配（TUI / 未参与灰度的调用方）缺席该字段，
   * 必须保持原样。协议服务端一律从 appRuntimePreferences 传入显式布尔。
   */
  dynamicWorkflowEnabled?: boolean;
}

export async function listProtocolSlashCommands(
  options: ListProtocolSlashCommandsOptions = {},
): Promise<ZCodeSlashCommand[]> {
  // 灰度关闭：composer 的加号菜单与 `/` 面板都只读这份目录，剔除即两个入口一起消失（DWG-03）。
  // `workflow` 是内置命令且是保留名，用户/插件的同名自定义命令在下面的 reserved 过滤里一并消失，
  // 不会在门关着时借自定义命令的身份漏回目录。
  const builtins = listAppProtocolBuiltinSlashCommands().filter(
    (command) =>
      options.dynamicWorkflowEnabled !== false || command.name !== BUILTIN_WORKFLOW_COMMAND_NAME,
  );
  let customCommands: Awaited<ReturnType<typeof listZCodeCustomCommands>>["commands"] = [];
  try {
    const outcome = await listZCodeCustomCommands(options);
    customCommands = outcome.commands;
  } catch {
    // 自定义命令发现失败不应阻断 session snapshot；保留可执行的内置协议命令。
    customCommands = [];
  }

  const custom = customCommands
    .filter((command) => !command.disableNonInteractive)
    .filter((command) => !isReservedZCodeSlashCommandName(command.name))
    .map((command) => ({
      description: command.description,
      inputHint: `/${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ""}`,
      name: command.name,
      source: "custom" as const,
    }));
  const taken = new Set([...builtins, ...custom].map((command) => command.name.toLowerCase()));
  return [
    ...builtins,
    ...custom,
    ...listAcpAgentSlashCommands(options.env).filter(
      (command) => !taken.has(command.name.toLowerCase()),
    ),
  ];
}

/**
 * 外部 ACP 智能体自己的斜杠命令（如 Claude Code 的 /usage、/context）。清单是智能体建会话时报上来、
 * 引擎缓存在数据目录里的；选中后按普通文本 `/名字` 发给智能体，由它自己执行。
 * 和宿主内置命令、用户自定义命令重名的不收（那些名字宿主会先接走）。
 */
function listAcpAgentSlashCommands(env: NodeJS.ProcessEnv | undefined): ZCodeSlashCommand[] {
  try {
    const dataBaseDir = resolveZCodeDataBaseDir({ ...(env ?? process.env) });
    const seen = new Set<string>();
    const out: ZCodeSlashCommand[] = [];
    for (const agent of loadAcpAgents(dataBaseDir)) {
      for (const command of readCommandCache(dataBaseDir, agent.id)) {
        const key = command.name.toLowerCase();
        if (seen.has(key) || isReservedZCodeSlashCommandName(command.name)) continue;
        seen.add(key);
        out.push({
          description: command.description || `${agent.name} 的命令`,
          inputHint: `/${command.name}`,
          name: command.name,
          source: "custom" as const,
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** App `/` 面板按本目录顺序展示；内置段的顺序由 APP_PROTOCOL_VISIBLE_BUILTIN_SLASH_COMMAND_NAMES 决定。 */
function listAppProtocolBuiltinSlashCommands(): ZCodeSlashCommand[] {
  const sharedBuiltins = APP_PROTOCOL_VISIBLE_BUILTIN_SLASH_COMMAND_NAMES.flatMap((name) => {
    const command = BUILTIN_ZCODE_SLASH_COMMAND_HELP_ENTRIES.find((entry) => entry.name === name);
    if (!command) return [];
    return [
      {
        description: command.summary,
        inputHint: command.usage,
        name: command.name,
        source: "builtin" as const,
      },
    ];
  });
  return sharedBuiltins;
}

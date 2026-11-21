import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 测试不能依赖开发机上是否装了 Zed / Claude 适配器：关掉 acp-engine 的内置默认智能体，
    // 需要它的用例自己通过 probe 注入环境（见 acp-engine/test/config.test.ts）。
    env: { ZCODE_ACP_BUILTIN: "0" },
    // Bugfix: 外部 zcode-cli 历史里同时存在 test/ 和 tests/ 目录；合入 apps 后需要同时保留两种约定，避免新增包测试被根 include 规则过滤掉。
    include: [
      "test/**/*.test.ts",
      "tests/**/*.test.ts",
      "packages/*/test/**/*.test.ts",
      "packages/*/tests/**/*.test.ts",
    ],
  },
});

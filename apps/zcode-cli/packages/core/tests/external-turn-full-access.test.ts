import { describe, expect, it } from "vitest";
import { fullAccessAutoAllow } from "../src/runtime/external-turn/run-external-turn.js";

const request = (toolName: string, kinds: ("allow_once" | "allow_always" | "reject_once" | "reject_always")[]) => ({
  toolCallId: "t1",
  toolName,
  title: toolName,
  input: {},
  options: kinds.map((kind) => ({ optionId: `opt-${kind}`, name: kind, kind })),
});

describe("ACP 会话在完全访问下的权限请求", () => {
  const all = ["allow_always", "allow_once", "reject_once"] as const;

  it("完全访问：直接单次允许，不弹窗", () => {
    expect(fullAccessAutoAllow(request("Bash", [...all]), { mode: "yolo" })).toEqual({ optionId: "opt-allow_once" });
  });

  it("只有永久允许选项时用它", () => {
    expect(fullAccessAutoAllow(request("Edit", ["allow_always", "reject_once"]), { mode: "yolo" })).toEqual({
      optionId: "opt-allow_always",
    });
  });

  it("其他模式、开着规划、审阅规划、没有允许选项时照旧交给用户", () => {
    expect(fullAccessAutoAllow(request("Bash", [...all]), { mode: "build" })).toBeUndefined();
    expect(fullAccessAutoAllow(request("Bash", [...all]), { mode: "guarded" })).toBeUndefined();
    expect(fullAccessAutoAllow(request("Bash", [...all]), { mode: "yolo", planEnabled: true })).toBeUndefined();
    expect(fullAccessAutoAllow(request("ExitPlanMode", [...all]), { mode: "yolo" })).toBeUndefined();
    expect(fullAccessAutoAllow(request("Bash", ["reject_once"]), { mode: "yolo" })).toBeUndefined();
  });
});

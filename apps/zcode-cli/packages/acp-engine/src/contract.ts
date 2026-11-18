/**
 * acp-engine 对外契约：完整定义见 ./types.ts 与 docs/acp-bridge/DESIGN.md §4.1。
 * AcpEngineContract = createAcpEngine 返回的引擎；调用方只依赖本文件导出的类型。
 */
export * from "./types.js";
import type { AcpEngine } from "./types.js";
export type AcpEngineContract = AcpEngine;

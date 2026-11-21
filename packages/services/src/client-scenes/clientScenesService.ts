import type { ApiClient } from "@zcode/shared";
import { isPrivacyMode } from "@zcode/shared/privacy-mode";
import { readApiJson } from "../providers/api/apiJson.js";
import { ZCODE_CLIENT_SCENES_URL } from "../providers/api/apiEndpoints.js";
import type { ClientScenesResponse, IClientScenesService } from "./clientScenes.js";

export function createClientScenesService(dependencies: {
  apiClient: ApiClient;
}): IClientScenesService {
  return {
    list: async () => {
      // acp-bridge(privacy): 隐私模式不拉远程场景配置（草稿页推荐提示词、自动化模板），返回空列表。
      if (isPrivacyMode()) return { code: 0, msg: "", data: [] };
      return readApiJson<ClientScenesResponse>(dependencies.apiClient, ZCODE_CLIENT_SCENES_URL, {
        method: "GET",
      });
    },
  };
}

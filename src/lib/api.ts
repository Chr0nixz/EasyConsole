import { ApiClient } from "./api-client";
import { createEasyConsoleApi, formatContentRange } from "./api-factory";
import { browserRuntime } from "./runtime";

export { createEasyConsoleApi, formatContentRange };
export type { EasyConsoleApi } from "./api-factory";

export const apiClient = new ApiClient(browserRuntime);
export const { authApi, imageApi, instanceApi, resourceApi, storageApi } = createEasyConsoleApi(apiClient);

export function setApiBaseUrl(baseUrl: string) {
  apiClient.setBaseUrl(baseUrl);
}

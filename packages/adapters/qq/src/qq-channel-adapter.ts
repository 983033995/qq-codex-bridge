import type { QqSttConfig } from "./qq-stt.js";
import { QqApiClient } from "./qq-api-client.js";
import type { QqGatewaySessionStore } from "./qq-gateway-session-store.js";
import { QqGatewayClient } from "./qq-gateway-client.js";
import { QqMediaDownloader } from "./qq-media-downloader.js";
import { QqSender } from "./qq-sender.js";

export function createQqChannelAdapter(config: {
  accountKey: string;
  appId: string;
  apiClient: QqApiClient;
  sessionStore: QqGatewaySessionStore;
  mediaDownloadDir?: string;
  stt?: QqSttConfig | null;
}) {
  return {
    ingress: new QqGatewayClient({
      accountKey: config.accountKey,
      appId: config.appId,
      apiClient: config.apiClient,
      sessionStore: config.sessionStore,
      ...(config.mediaDownloadDir
        ? {
            mediaDownloader: new QqMediaDownloader({
              baseDir: config.mediaDownloadDir,
              stt: config.stt
            })
          }
        : {})
    }),
    egress: new QqSender(config.apiClient)
  };
}

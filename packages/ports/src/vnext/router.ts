import type {
  ComponentHealth,
  RoutingDecision
} from "../../../domain/src/vnext/index.js";

export type IntentRouterInput = {
  message: string;
  spaceDisplayName: string;
  currentThreadTitle: string | null;
  candidateThreads: Array<{
    title: string;
    projectName: string | null;
    relativeTime: string | null;
  }>;
  recentControlMessages: string[];
  allowedActionTypes: string[];
};

export type RouterHealth = ComponentHealth & {
  circuitOpenUntil?: string;
};

export interface IntentRouterPort {
  routeFast?(input: Pick<IntentRouterInput, "message" | "allowedActionTypes">): Promise<RoutingDecision | null>;
  route(input: IntentRouterInput): Promise<RoutingDecision>;
  health(): Promise<RouterHealth>;
}

import { MemorySecretStore } from "../../packages/config/src/index.js";
import { secretStorePortContract } from "./support/vnext-port-contracts.js";

secretStorePortContract("vNext memory adapter", () => new MemorySecretStore());

import {
  SqliteConversationSpaceRepository,
  SqliteDeliveryRepository,
  SqliteMessageLedger,
  SqlitePushRepository,
  SqliteRoutingDecisionRepository,
  SqliteRuntimeEventRepository,
  SqliteThreadBindingRepository,
  SqliteTurnRepository,
  openVNextDatabase
} from "../../packages/store-sqlite/src/index.js";
import {
  repositoryPortContract,
  type RepositoryPortHarness
} from "./support/vnext-repository-contracts.js";

repositoryPortContract("SQLite vNext", createHarness);

function createHarness(): RepositoryPortHarness {
  const db = openVNextDatabase(":memory:");
  return {
    spaces: new SqliteConversationSpaceRepository(db),
    bindings: new SqliteThreadBindingRepository(db),
    messages: new SqliteMessageLedger(db),
    turns: new SqliteTurnRepository(db),
    decisions: new SqliteRoutingDecisionRepository(db),
    deliveries: new SqliteDeliveryRepository(db),
    pushes: new SqlitePushRepository(db),
    events: new SqliteRuntimeEventRepository(db),
    close: () => db.close()
  };
}

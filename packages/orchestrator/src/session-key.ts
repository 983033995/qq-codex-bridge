export type ChatType = "c2c" | "group";

export function buildPeerKey(input: { chatType: ChatType; peerId: string }): string {
  return input.chatType === "c2c" ? `qq:c2c:${input.peerId}` : `qq:group:${input.peerId}`;
}

export function buildSessionKey(input: { accountKey: string; peerKey: string }): string {
  return `${input.accountKey}::${input.peerKey}`;
}

export type CdpSessionConfig = {
  appName: string;
  remoteDebuggingPort: number;
};

export class CdpSession {
  constructor(readonly config: CdpSessionConfig) {}

  async connect(): Promise<void> {
    return;
  }
}

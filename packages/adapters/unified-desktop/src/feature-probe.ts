import type {
  DesktopDriverPort,
  DesktopTransportMode,
  DesktopTransportName,
  DesktopTransportStatus
} from "../../../ports/src/conversation.js";

type ProbeDriver = Pick<DesktopDriverPort, "ensureAppReady">;

export type DesktopFeatureProbeOptions = {
  appServer: ProbeDriver;
  cdp: ProbeDriver;
  configured: DesktopTransportMode;
  now?: () => Date;
};

export class DesktopFeatureProbe {
  private readonly now: () => Date;
  private status: DesktopTransportStatus;

  constructor(private readonly options: DesktopFeatureProbeOptions) {
    this.now = options.now ?? (() => new Date());
    this.status = {
      configured: options.configured,
      active: null,
      appServerAvailable: null,
      cdpAvailable: null,
      lastProbedAt: null,
      lastError: null
    };
  }

  getStatus(): DesktopTransportStatus {
    return { ...this.status };
  }

  async probe(): Promise<DesktopTransportName> {
    if (this.options.configured === "app-server") {
      await this.requireTransport("app-server", this.options.appServer);
      return "app-server";
    }
    if (this.options.configured === "cdp") {
      await this.requireTransport("cdp", this.options.cdp);
      return "cdp";
    }

    const appServerError = await this.probeDriver("app-server", this.options.appServer);
    if (!appServerError) {
      this.setActive("app-server", null);
      return "app-server";
    }

    const cdpError = await this.probeDriver("cdp", this.options.cdp);
    if (!cdpError) {
      this.setActive("cdp", appServerError.message);
      return "cdp";
    }

    const error = new Error(
      `no desktop transport is available: app-server=${appServerError.message}; cdp=${cdpError.message}`
    );
    this.setActive(null, error.message);
    throw error;
  }

  async probeAppServer(): Promise<boolean> {
    const error = await this.probeDriver("app-server", this.options.appServer);
    if (!error) {
      this.setActive("app-server", null);
      return true;
    }
    this.setActive(this.status.active, error.message);
    return false;
  }

  markActive(transport: DesktopTransportName, error: string | null = null): void {
    this.setActive(transport, error);
  }

  private async requireTransport(
    transport: DesktopTransportName,
    driver: ProbeDriver
  ): Promise<void> {
    const error = await this.probeDriver(transport, driver);
    if (error) {
      this.setActive(null, error.message);
      throw error;
    }
    this.setActive(transport, null);
  }

  private async probeDriver(
    transport: DesktopTransportName,
    driver: ProbeDriver
  ): Promise<Error | null> {
    try {
      await driver.ensureAppReady();
      this.setAvailability(transport, true);
      return null;
    } catch (error) {
      this.setAvailability(transport, false);
      return error instanceof Error ? error : new Error(String(error));
    } finally {
      this.status.lastProbedAt = this.now().toISOString();
    }
  }

  private setAvailability(transport: DesktopTransportName, available: boolean): void {
    if (transport === "app-server") {
      this.status.appServerAvailable = available;
      return;
    }
    this.status.cdpAvailable = available;
  }

  private setActive(
    active: DesktopTransportName | null,
    lastError: string | null
  ): void {
    this.status.active = active;
    this.status.lastError = lastError;
  }
}

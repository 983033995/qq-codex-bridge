export type ConfigSnapshot<TConfig> = {
  revision: string;
  value: TConfig;
};

export interface ConfigStorePort<TConfig> {
  read(): Promise<ConfigSnapshot<TConfig> | null>;
  writeAtomic(snapshot: ConfigSnapshot<TConfig>): Promise<void>;
}

export interface SecretStorePort {
  get(ref: string): Promise<string | null>;
  set(ref: string, value: string): Promise<void>;
  delete(ref: string): Promise<void>;
}

export type ServiceStatus = {
  installed: boolean;
  running: boolean;
  pid: number | null;
};

export interface ServiceManagerPort {
  install(): Promise<void>;
  uninstall(options?: { preserveData?: boolean }): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  status(): Promise<ServiceStatus>;
}

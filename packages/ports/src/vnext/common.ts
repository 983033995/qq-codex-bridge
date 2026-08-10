export type DomainEvent<TPayload = unknown> = {
  eventId: string;
  type: string;
  occurredAt: string;
  payload: TPayload;
};

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(): string;
}

export interface EventPublisher {
  publish<TPayload>(event: DomainEvent<TPayload>): Promise<void>;
}

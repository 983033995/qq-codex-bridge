export class ThreadSerialExecutor {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(threadId: string, work: () => Promise<T>): Promise<T> {
    if (!threadId.trim()) {
      throw new Error("threadId cannot be empty");
    }
    const previous = this.tails.get(threadId) ?? Promise.resolve();
    const task = previous.then(work);
    const tail = task.then(
      () => undefined,
      () => undefined
    );
    this.tails.set(threadId, tail);
    try {
      return await task;
    } finally {
      if (this.tails.get(threadId) === tail) {
        this.tails.delete(threadId);
      }
    }
  }
}

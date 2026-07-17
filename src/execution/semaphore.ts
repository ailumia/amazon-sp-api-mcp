export class Semaphore {
  #active = 0;
  readonly #queue: (() => void)[] = [];

  public constructor(private readonly maximum: number) {}

  public async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.#active < this.maximum) {
      this.#active += 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.#queue.push(resolve);
    });
    this.#active += 1;
  }

  private release(): void {
    this.#active -= 1;
    this.#queue.shift()?.();
  }
}

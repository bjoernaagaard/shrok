export class StageFailedError extends Error {
  readonly stage: string;

  constructor(stage: string, reason: string) {
    super(`${stage}: ${reason}`);
    this.name = "StageFailedError";
    this.stage = stage;
  }
}

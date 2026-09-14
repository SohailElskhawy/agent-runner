export class ProcessSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProcessSpecError";
  }
}

export class ContextPackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextPackError";
  }
}

export class VerificationSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerificationSpecError";
  }
}

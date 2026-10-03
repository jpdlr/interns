/** A failed precondition: safe to leave the approval job pending and try again later. */
export class RetryableApprovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableApprovalError";
  }
}

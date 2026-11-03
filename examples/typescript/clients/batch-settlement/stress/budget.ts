/** Error raised when a deposit reservation would exceed the configured budget. */
export class BudgetExhaustedError extends Error {
  /**
   * Builds a budget exhaustion error with the attempted reservation details.
   *
   * @param amount - Requested amount.
   * @param reserved - Amount already reserved.
   * @param limit - Budget limit.
   */
  constructor(
    readonly amount: bigint,
    readonly reserved: bigint,
    readonly limit: bigint,
  ) {
    super(
      `budget exhausted: requested ${amount} atomic units with ${limit - reserved} remaining ` +
        `(limit ${limit}, reserved ${reserved})`,
    );
    this.name = "BudgetExhaustedError";
  }
}

/**
 * Tracks a monotonic atomic-unit budget.
 *
 * Reservations are never released: a failed request may have submitted a token transfer before
 * the client observed the failure, so releasing a reservation could allow the run to overspend.
 */
export class AtomicBudget {
  private reservedAmount = 0n;

  /**
   * Creates a monotonic budget.
   *
   * @param limit - Maximum amount that may be reserved.
   */
  constructor(readonly limit: bigint) {
    if (limit <= 0n) {
      throw new Error("budget limit must be positive");
    }
  }

  /**
   * Returns the amount reserved so far.
   *
   * @returns The amount reserved so far.
   */
  get reserved(): bigint {
    return this.reservedAmount;
  }

  /**
   * Reserves an amount when it fits within the remaining budget.
   *
   * @param amount - Amount in atomic units.
   * @returns Whether the reservation succeeded.
   */
  tryReserve(amount: bigint): boolean {
    if (amount <= 0n || this.reservedAmount + amount > this.limit) {
      return false;
    }
    this.reservedAmount += amount;
    return true;
  }
}

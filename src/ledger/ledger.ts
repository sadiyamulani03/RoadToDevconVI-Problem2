/**
 * Persistent ledger of payment decisions.
 *
 * Every ACCEPTED and REFUSED decision is recorded with a reason. The
 * authoritative cumulative spend is computed FROM THIS LEDGER (never from an
 * in-memory counter), so spending limits survive application restarts.
 *
 * Amounts are stored as exact decimal strings of bigint base units and summed
 * in bigint. SQLite's SUM() would cast TEXT to REAL (floating point), so it is
 * deliberately avoided.
 */
import type Database from "better-sqlite3";
import type { LedgerEntryInput, LedgerRecord, PolicyDecisionType } from "../types/index.js";

export interface MarkPaymentInfo {
  paymentSigned: boolean;
  paymentSubmitted: boolean;
  transactionHash: string | null;
}

export class Ledger {
  private readonly db: Database.Database;
  private readonly insertStmt: Database.Statement;
  private readonly markStmt: Database.Statement;
  private readonly selectByRunStmt: Database.Statement;
  private readonly selectByIdStmt: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;
    this.insertStmt = db.prepare(
      `INSERT INTO payment_decisions
         (timestamp, seller, endpoint, decision, reason, amount_base_units,
          asset, network, payment_required, payment_signed, payment_submitted,
          transaction_hash, run_id)
       VALUES
         (@timestamp, @seller, @endpoint, @decision, @reason, @amount_base_units,
          @asset, @network, @payment_required, @payment_signed, @payment_submitted,
          @transaction_hash, @run_id)`,
    );
    this.markStmt = db.prepare(
      `UPDATE payment_decisions
         SET payment_signed = @payment_signed,
             payment_submitted = @payment_submitted,
             transaction_hash = @transaction_hash
       WHERE id = @id`,
    );
    this.selectByRunStmt = db.prepare(`SELECT * FROM payment_decisions WHERE run_id = @run_id ORDER BY id ASC`);
    this.selectByIdStmt = db.prepare(`SELECT * FROM payment_decisions WHERE id = @id`);
  }

  /** Persist a payment decision. Returns the row id. */
  recordDecision(input: LedgerEntryInput): number {
    const result = this.insertStmt.run({
      timestamp: new Date().toISOString(),
      seller: input.seller,
      endpoint: input.endpoint,
      decision: input.decision,
      reason: input.reason,
      amount_base_units: input.amountBaseUnits === null ? null : input.amountBaseUnits.toString(),
      asset: input.asset,
      network: input.network,
      payment_required: input.paymentRequired ? 1 : 0,
      payment_signed: 0,
      payment_submitted: 0,
      transaction_hash: null,
      run_id: input.runId,
    });
    return Number(result.lastInsertRowid);
  }

  /** Update a record after signing/submitting a payment. */
  markPayment(id: number, info: MarkPaymentInfo): void {
    this.markStmt.run({
      id,
      payment_signed: info.paymentSigned ? 1 : 0,
      payment_submitted: info.paymentSubmitted ? 1 : 0,
      transaction_hash: info.transactionHash,
    });
  }

  /** Append extra failure detail to a record's reason (never credentials). */
  markRefusalExtra(id: number, extraReason: string): void {
    this.db
      .prepare(`UPDATE payment_decisions SET reason = reason || ' | ' || @extra WHERE id = @id`)
      .run({ id, extra: extraReason });
  }

  /**
   * Exact cumulative spend for a run, in bigint base units.
   *
   * Only ACCEPTED rows with a parsed amount contribute. Computed from the
   * persisted ledger (NOT from any in-memory variable), so it survives
   * application restarts.
   */
  getTotalSpendBaseUnits(runId: string): bigint {
    const rows = this.selectByRunStmt.all({ run_id: runId }) as Array<Record<string, unknown>>;
    let total = 0n;
    for (const row of rows) {
      if (row.decision !== "ACCEPTED") continue;
      const amount = row.amount_base_units;
      if (typeof amount !== "string") continue;
      total += BigInt(amount);
    }
    return total;
  }

  getRecord(id: number): LedgerRecord | null {
    const row = this.selectByIdStmt.get({ id }) as Record<string, unknown> | undefined;
    if (!row) return null;
    return rowToRecord(row);
  }

  getRecordsForRun(runId: string): LedgerRecord[] {
    const rows = this.selectByRunStmt.all({ run_id: runId }) as Array<Record<string, unknown>>;
    return rows.map(rowToRecord);
  }

  close(): void {
    this.db.close();
  }
}

function rowToRecord(row: Record<string, unknown>): LedgerRecord {
  return {
    id: Number(row.id),
    timestamp: String(row.timestamp),
    seller: String(row.seller),
    endpoint: String(row.endpoint),
    decision: String(row.decision) as PolicyDecisionType,
    reason: String(row.reason),
    amountBaseUnits: typeof row.amount_base_units === "string" ? row.amount_base_units : null,
    asset: typeof row.asset === "string" ? row.asset : null,
    network: typeof row.network === "string" ? row.network : null,
    paymentRequired: Number(row.payment_required) === 1,
    paymentSigned: Number(row.payment_signed) === 1,
    paymentSubmitted: Number(row.payment_submitted) === 1,
    transactionHash: typeof row.transaction_hash === "string" ? row.transaction_hash : null,
    runId: String(row.run_id),
  };
}

// Type declarations for reference-contract.mjs (added in Batch 1b so TypeScript can import it).
// The contract itself is used unchanged.
export declare const STATES: readonly [
  "known",
  "not_printed",
  "illegible",
  "not_applicable",
  "not_yet_verified",
];
export declare const POLICY: Readonly<{
  id: string;
  approval: string;
  legacyAssignmentMinimum: null;
  unknownReferenceCredit: boolean;
  engineFailureRemainsInEligibleDenominator: boolean;
}>;
export interface ContractError {
  path: string;
  code: string;
}
export declare function validateReference(
  reference: unknown,
  options?: { requireCompletedIdentity?: boolean },
): { valid: boolean; errors: ContractError[] };

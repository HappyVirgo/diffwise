import type { ReviewUnit } from "../diff/chunk.js";
import type { Finding } from "../types.js";

/** A review provider: turns one review unit into findings anchored to new-file lines. */
export interface Reviewer {
  /** Short provider name shown in reports, e.g. "heuristic" or "claude". */
  readonly name: string;
  /** Token budget per review unit this provider wants the chunker to respect. */
  readonly maxUnitTokens: number;
  /** Reviews one unit. Implementations may return findings on any line; the pipeline validates them. */
  review(unit: ReviewUnit): Promise<Finding[]>;
}

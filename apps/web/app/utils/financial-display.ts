/** Converts a canonical 0–1 financial score to a whole percentage for display. */
export function normalizedScorePercent(score: number): number {
  return Math.round(score * 100);
}

/** Converts a nullable canonical 0–1 financial score to a whole percentage for display. */
export function nullableNormalizedScorePercent(score: number | null): number | null {
  return score === null ? null : normalizedScorePercent(score);
}

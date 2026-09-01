// Used by the (not-yet-built) live hosting/scoring step to auto-accept close
// typos and leave anything further off for the host to review manually.

const TYPO_TOLERANCE = 0.2

function levenshtein(a, b) {
  const rows = a.length + 1
  const cols = b.length + 1
  const dp = Array.from({ length: rows }, () => new Array(cols).fill(0))

  for (let i = 0; i < rows; i++) dp[i][0] = i
  for (let j = 0; j < cols; j++) dp[0][j] = j

  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost)
    }
  }

  return dp[rows - 1][cols - 1]
}

// Case-insensitive; accepts exact matches and typos within ~20% of the
// answer's length (e.g. "haery" matches "hairy").
export function isCloseMatch(submitted, accepted) {
  const a = submitted.trim().toLowerCase()
  const b = accepted.trim().toLowerCase()
  if (!a || !b) return false
  if (a === b) return true

  const distance = levenshtein(a, b)
  const maxLen = Math.max(a.length, b.length)
  return distance / maxLen <= TYPO_TOLERANCE
}

// true = auto-correct, false = needs host review (not necessarily wrong).
export function autoAccepts(submitted, acceptableAnswers) {
  return acceptableAnswers.some((accepted) => isCloseMatch(submitted, accepted))
}

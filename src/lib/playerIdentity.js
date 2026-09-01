const KEY_PREFIX = 'trivia_player_'

export function getStoredIdentity(sessionId) {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + sessionId)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export function storeIdentity(sessionId, identity) {
  try {
    localStorage.setItem(KEY_PREFIX + sessionId, JSON.stringify(identity))
  } catch {
    // Private browsing / storage disabled — identity just won't survive a refresh.
  }
}

import { useEffect, useState } from 'react'

// Returns whole seconds remaining until startedAt + durationSeconds, or null
// if there's nothing running. Ticks every 250ms.
export function useCountdown(startedAt, durationSeconds) {
  const [secondsLeft, setSecondsLeft] = useState(null)

  useEffect(() => {
    if (!startedAt || !durationSeconds) {
      setSecondsLeft(null)
      return
    }

    const deadline = new Date(startedAt).getTime() + durationSeconds * 1000

    function tick() {
      setSecondsLeft(Math.max(0, Math.round((deadline - Date.now()) / 1000)))
    }

    tick()
    const interval = setInterval(tick, 250)
    return () => clearInterval(interval)
  }, [startedAt, durationSeconds])

  return secondsLeft
}

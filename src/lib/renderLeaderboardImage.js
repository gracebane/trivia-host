const WIDTH = 1000
const ROW_HEIGHT = 90
const ROW_GAP = 16
const TOP_PADDING = 160
const BOTTOM_PADDING = 40

function roundRect(ctx, x, y, width, height, radius) {
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + width, y, x + width, y + height, radius)
  ctx.arcTo(x + width, y + height, x, y + height, radius)
  ctx.arcTo(x, y + height, x, y, radius)
  ctx.arcTo(x, y, x + width, y, radius)
  ctx.closePath()
}

// Renders the same look as LeaderboardPage to a downloadable PNG, so the
// standings can go straight into a slide deck instead of a browser tab.
export async function renderLeaderboardImage(gameTitle, teams) {
  const rowsHeight = teams.length > 0 ? teams.length * (ROW_HEIGHT + ROW_GAP) - ROW_GAP : ROW_HEIGHT
  const height = Math.max(TOP_PADDING + rowsHeight + BOTTOM_PADDING, 400)

  const canvas = document.createElement('canvas')
  canvas.width = WIDTH
  canvas.height = height
  const ctx = canvas.getContext('2d')

  ctx.fillStyle = '#0b1220'
  ctx.fillRect(0, 0, WIDTH, height)

  ctx.textAlign = 'center'
  ctx.fillStyle = '#ffffff'
  ctx.font = 'bold 40px system-ui, sans-serif'
  ctx.fillText(gameTitle || 'Trivia Night', WIDTH / 2, 70)

  ctx.fillStyle = '#94a3b8'
  ctx.font = '22px system-ui, sans-serif'
  ctx.fillText('LEADERBOARD', WIDTH / 2, 105)

  const rowX = 40
  const rowWidth = WIDTH - 80

  if (teams.length === 0) {
    ctx.fillStyle = '#94a3b8'
    ctx.font = '24px system-ui, sans-serif'
    ctx.fillText('No teams yet.', WIDTH / 2, TOP_PADDING + 40)
  }

  teams.forEach((team, index) => {
    const y = TOP_PADDING + index * (ROW_HEIGHT + ROW_GAP)
    const isFirst = index === 0

    ctx.fillStyle = isFirst ? '#facc15' : '#1e293b'
    roundRect(ctx, rowX, y, rowWidth, ROW_HEIGHT, 14)
    ctx.fill()

    ctx.textBaseline = 'middle'
    ctx.textAlign = 'left'
    ctx.fillStyle = isFirst ? '#1e1e1e' : '#ffffff'
    ctx.font = 'bold 30px system-ui, sans-serif'
    ctx.fillText(`${index + 1}`, rowX + 24, y + ROW_HEIGHT / 2)
    ctx.fillText(team.name, rowX + 90, y + ROW_HEIGHT / 2)

    ctx.textAlign = 'right'
    ctx.font = 'bold 34px system-ui, sans-serif'
    ctx.fillText(String(team.score), rowX + rowWidth - 24, y + ROW_HEIGHT / 2)
  })

  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

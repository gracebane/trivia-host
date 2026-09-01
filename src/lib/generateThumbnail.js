const WIDTH = 320
const HEIGHT = 180

function wrapText(ctx, text, maxWidth, maxLines) {
  const words = (text || '').replace(/\n/g, ' ').split(/\s+/).filter(Boolean)
  const lines = []
  let line = ''

  for (const word of words) {
    const attempt = line ? `${line} ${word}` : word
    if (ctx.measureText(attempt).width > maxWidth && line) {
      lines.push(line)
      line = word
      if (lines.length >= maxLines) return lines
    } else {
      line = attempt
    }
  }
  if (line) lines.push(line)
  return lines.slice(0, maxLines)
}

// Best-effort visual for host bookkeeping — not a pixel-accurate render of
// the real slide, just enough (extracted text + any embedded image) to tell
// slides apart at a glance while building the game.
export async function generateSlideThumbnail(text, imageBlob) {
  const canvas = document.createElement('canvas')
  canvas.width = WIDTH
  canvas.height = HEIGHT
  const ctx = canvas.getContext('2d')

  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, WIDTH, HEIGHT)
  ctx.strokeStyle = '#ddd'
  ctx.strokeRect(0.5, 0.5, WIDTH - 1, HEIGHT - 1)

  let textTop = 10
  let textAreaHeight = HEIGHT - 20

  if (imageBlob) {
    try {
      const bitmap = await createImageBitmap(imageBlob)
      const maxImgHeight = HEIGHT * 0.6
      const scale = Math.min((WIDTH - 20) / bitmap.width, maxImgHeight / bitmap.height, 1)
      const drawWidth = bitmap.width * scale
      const drawHeight = bitmap.height * scale
      const x = (WIDTH - drawWidth) / 2
      ctx.drawImage(bitmap, x, 8, drawWidth, drawHeight)
      textTop = 8 + drawHeight + 6
      textAreaHeight = HEIGHT - textTop - 8
    } catch {
      // Unsupported image format for canvas decoding — fall back to text-only.
    }
  }

  ctx.fillStyle = '#222'
  ctx.font = '12px system-ui, sans-serif'
  ctx.textBaseline = 'top'

  const maxLines = Math.max(1, Math.floor(textAreaHeight / 14))
  const lines = wrapText(ctx, text, WIDTH - 16, maxLines)
  lines.forEach((line, i) => {
    ctx.fillText(line, 8, textTop + i * 14)
  })

  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), 'image/png')
  })
}

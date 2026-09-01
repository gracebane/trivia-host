import JSZip from 'jszip'

const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const P_NS = 'http://schemas.openxmlformats.org/presentationml/2006/main'

const IMAGE_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
}

function extOf(path) {
  const match = path.match(/\.([a-zA-Z0-9]+)$/)
  return match ? match[1].toLowerCase() : ''
}

function parseXml(text) {
  return new DOMParser().parseFromString(text, 'application/xml')
}

async function readXml(zip, path) {
  const file = zip.file(path)
  if (!file) return null
  const text = await file.async('text')
  return parseXml(text)
}

function resolveRelTarget(basePath, target) {
  const baseParts = basePath.split('/')
  for (const part of target.split('/')) {
    if (part === '..') baseParts.pop()
    else if (part !== '.') baseParts.push(part)
  }
  return baseParts.join('/')
}

function extractSlideText(slideDoc) {
  const paragraphs = slideDoc.getElementsByTagNameNS(A_NS, 'p')
  const lines = []
  for (const p of paragraphs) {
    const runs = p.getElementsByTagNameNS(A_NS, 't')
    const text = Array.from(runs).map((r) => r.textContent).join('')
    if (text.trim()) lines.push(text.trim())
  }
  return lines.join('\n')
}

async function findSlideImage(zip, slidePath) {
  const slideFileName = slidePath.split('/').pop()
  const relsPath = `ppt/slides/_rels/${slideFileName}.rels`
  const relsDoc = await readXml(zip, relsPath)
  if (!relsDoc) return null

  for (const rel of Array.from(relsDoc.getElementsByTagName('Relationship'))) {
    const type = rel.getAttribute('Type') || ''
    const target = rel.getAttribute('Target') || ''
    if (type.endsWith('/image')) {
      const ext = extOf(target)
      if (IMAGE_MIME[ext]) {
        return resolveRelTarget('ppt/slides', target)
      }
    }
  }
  return null
}

/**
 * Parses a .pptx File into an ordered list of slides, in actual
 * presentation order (slide XML filenames don't reflect display order
 * once slides have been reordered in PowerPoint/Slides).
 *
 * Only pulls what's needed for a host-side identification thumbnail —
 * text and a representative image, if any. Everything else (the real
 * question content — audio, full images, video) is presented separately
 * via the slideshow itself, not by this app.
 */
export async function parseSlides(file) {
  const zip = await JSZip.loadAsync(file)

  const presentationDoc = await readXml(zip, 'ppt/presentation.xml')
  const presRelsDoc = await readXml(zip, 'ppt/_rels/presentation.xml.rels')
  if (!presentationDoc || !presRelsDoc) {
    throw new Error('This does not look like a valid .pptx file.')
  }

  const relIdToTarget = {}
  for (const rel of Array.from(presRelsDoc.getElementsByTagName('Relationship'))) {
    relIdToTarget[rel.getAttribute('Id')] = rel.getAttribute('Target')
  }

  const slidePaths = Array.from(presentationDoc.getElementsByTagNameNS(P_NS, 'sldId'))
    .map((el) => el.getAttributeNS(REL_NS, 'id'))
    .map((rId) => relIdToTarget[rId])
    .filter(Boolean)
    .map((target) => `ppt/${target}`)

  if (slidePaths.length === 0) {
    throw new Error('No slides were found in this file.')
  }

  const results = []
  for (const slidePath of slidePaths) {
    const slideDoc = await readXml(zip, slidePath)
    if (!slideDoc) continue

    const text = extractSlideText(slideDoc)
    const imagePath = await findSlideImage(zip, slidePath)

    let imageBlob = null
    if (imagePath) {
      const imageFile = zip.file(imagePath)
      if (imageFile) {
        const buffer = await imageFile.async('arraybuffer')
        imageBlob = new Blob([buffer], { type: IMAGE_MIME[extOf(imagePath)] })
      }
    }

    results.push({ text, imageBlob })
  }

  return results
}

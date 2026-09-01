import { useEffect, useState, useCallback, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase.js'
import { parseSlides } from '../lib/pptxParser.js'
import { generateSlideThumbnail } from '../lib/generateThumbnail.js'
import { uploadThumbnail } from '../lib/uploadMedia.js'
import SlideCard from '../components/SlideCard.jsx'

function makeTempId() {
  return `new-${crypto.randomUUID()}`
}

const DEFAULT_POINTS = 4

function GameEditorPage() {
  const { gameId } = useParams()
  const navigate = useNavigate()
  const fileInputRef = useRef(null)

  const [title, setTitle] = useState('')
  const [slides, setSlides] = useState([])
  const [deletedIds, setDeletedIds] = useState([])
  const [defaultPoints, setDefaultPoints] = useState(DEFAULT_POINTS)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importProgress, setImportProgress] = useState(null)
  const [error, setError] = useState(null)
  const [savedAt, setSavedAt] = useState(null)

  const loadGame = useCallback(async () => {
    setLoading(true)
    setError(null)

    const [{ data: game, error: gameError }, { data: rows, error: rowsError }] = await Promise.all([
      supabase.from('games').select('*').eq('id', gameId).single(),
      supabase.from('questions').select('*').eq('game_id', gameId).order('order_index', { ascending: true }),
    ])

    if (gameError) {
      setError(gameError.message)
      setLoading(false)
      return
    }
    if (rowsError) {
      setError(rowsError.message)
      setLoading(false)
      return
    }

    const loaded = (rows || []).map((r) => ({ ...r, answers: r.answers || [] }))
    setTitle(game.title || '')
    setSlides(loaded)
    setDeletedIds([])

    const lastQuestion = [...loaded].reverse().find((s) => s.is_question)
    setDefaultPoints(lastQuestion ? lastQuestion.points : DEFAULT_POINTS)
    setLoading(false)
  }, [gameId])

  useEffect(() => {
    loadGame()
  }, [loadGame])

  function handleSlideChange(id, updated) {
    setSlides((prev) => prev.map((s) => (s.id === id ? updated : s)))
    if (updated.is_question) {
      setDefaultPoints(updated.points)
    }
  }

  function handleDeleteSlide(id) {
    if (!id.startsWith('new-')) {
      setDeletedIds((prev) => [...prev, id])
    }
    setSlides((prev) => prev.filter((s) => s.id !== id))
  }

  function handleMove(index, direction) {
    setSlides((prev) => {
      const next = [...prev]
      const swapWith = index + direction
      if (swapWith < 0 || swapWith >= next.length) return prev
      ;[next[index], next[swapWith]] = [next[swapWith], next[index]]
      return next
    })
  }

  async function handleImportFile(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return

    setImporting(true)
    setError(null)
    setImportProgress(null)

    try {
      const parsedSlides = await parseSlides(file)
      const startIndex = slides.length
      const newSlides = []

      for (let i = 0; i < parsedSlides.length; i++) {
        setImportProgress({ done: i, total: parsedSlides.length })
        const { text, imageBlob } = parsedSlides[i]
        const tempId = makeTempId()

        const thumbBlob = await generateSlideThumbnail(text, imageBlob)
        const thumbnailUrl = await uploadThumbnail(gameId, tempId, thumbBlob)

        newSlides.push({
          id: tempId,
          is_question: true,
          points: defaultPoints,
          time_limit: 30,
          answers: [],
          thumbnail_url: thumbnailUrl,
          order_index: startIndex + i,
        })
      }

      setSlides((prev) => [...prev, ...newSlides])
    } catch (err) {
      setError(err.message)
    } finally {
      setImporting(false)
      setImportProgress(null)
    }
  }

  async function handleSave() {
    setSaving(true)
    setError(null)

    try {
      const { error: titleError } = await supabase.from('games').update({ title }).eq('id', gameId)
      if (titleError) throw titleError

      if (deletedIds.length > 0) {
        const { error: deleteError } = await supabase.from('questions').delete().in('id', deletedIds)
        if (deleteError) throw deleteError
      }

      const withOrder = slides.map((s, index) => ({ ...s, order_index: index }))

      const existing = withOrder.filter((s) => !s.id.startsWith('new-'))
      const fresh = withOrder.filter((s) => s.id.startsWith('new-'))

      if (existing.length > 0) {
        const { error: updateError } = await supabase.from('questions').upsert(existing)
        if (updateError) throw updateError
      }

      if (fresh.length > 0) {
        const inserts = fresh.map(({ id, ...rest }) => ({ ...rest, game_id: gameId }))
        const { error: insertError } = await supabase.from('questions').insert(inserts)
        if (insertError) throw insertError
      }

      await loadGame()
      setSavedAt(new Date())
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div style={{ maxWidth: 780, margin: '0 auto', padding: '2rem 1rem' }}>
        <p>Loading…</p>
      </div>
    )
  }

  return (
    <div style={{ maxWidth: 780, margin: '0 auto', padding: '2rem 1rem' }}>
      <button onClick={() => navigate('/')} style={{ marginBottom: '1rem', background: 'none', border: 'none', padding: 0, color: '#0645ad' }}>
        ← Back to My Games
      </button>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', marginBottom: '1.5rem' }}>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Game title"
          style={{ fontSize: '1.5rem', fontWeight: 700, flex: 1, padding: '0.25rem 0.5rem' }}
        />
        <button onClick={handleSave} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>

      {error && <p style={{ color: 'crimson' }}>Error: {error}</p>}
      {savedAt && !error && (
        <p style={{ color: 'green', fontSize: '0.9rem' }}>Saved at {savedAt.toLocaleTimeString()}</p>
      )}

      <div
        style={{
          background: 'white',
          border: '1px dashed #aaa',
          borderRadius: 8,
          padding: '1rem',
          marginBottom: '1.5rem',
          display: 'flex',
          alignItems: 'center',
          gap: '1rem',
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".pptx"
          onChange={handleImportFile}
          disabled={importing}
          style={{ display: 'none' }}
        />
        <button type="button" onClick={() => fileInputRef.current?.click()} disabled={importing}>
          {importing ? 'Importing…' : '📥 Upload PowerPoint (.pptx)'}
        </button>
        <span style={{ color: '#666', fontSize: '0.9rem' }}>
          {importing && importProgress
            ? `Processing slide ${importProgress.done + 1} of ${importProgress.total}…`
            : 'Each slide becomes a row below, defaulted to "Question". Adds to the list — nothing is overwritten.'}
        </span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        {slides.map((s, index) => (
          <SlideCard
            key={s.id}
            slide={s}
            index={index}
            total={slides.length}
            onChange={(updated) => handleSlideChange(s.id, updated)}
            onDelete={() => handleDeleteSlide(s.id)}
            onMoveUp={() => handleMove(index, -1)}
            onMoveDown={() => handleMove(index, 1)}
          />
        ))}
      </div>

      {slides.length === 0 && !importing && (
        <p style={{ color: '#666' }}>No slides yet. Upload a PowerPoint to get started.</p>
      )}
    </div>
  )
}

export default GameEditorPage

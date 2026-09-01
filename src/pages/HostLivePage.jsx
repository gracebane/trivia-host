import { useEffect, useState, useCallback, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import QRCode from 'qrcode'
import { supabase } from '../lib/supabase.js'
import { useCountdown } from '../lib/useCountdown.js'
import { renderLeaderboardImage, downloadBlob } from '../lib/renderLeaderboardImage.js'

function HostLivePage() {
  const { sessionId } = useParams()
  const navigate = useNavigate()

  const [session, setSession] = useState(null)
  const [gameTitle, setGameTitle] = useState('')
  const [slides, setSlides] = useState([])
  const [teams, setTeams] = useState([])
  const [answers, setAnswers] = useState([])
  const [qrDataUrl, setQrDataUrl] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    async function init() {
      setLoading(true)
      const { data: sessionRow, error: sessionError } = await supabase
        .from('sessions')
        .select('*')
        .eq('id', sessionId)
        .single()

      if (sessionError) {
        setError(sessionError.message)
        setLoading(false)
        return
      }

      const [{ data: game }, { data: slideRows }] = await Promise.all([
        supabase.from('games').select('title').eq('id', sessionRow.game_id).single(),
        supabase
          .from('questions')
          .select('*')
          .eq('game_id', sessionRow.game_id)
          .order('order_index', { ascending: true }),
      ])

      setSession(sessionRow)
      setGameTitle(game?.title || '')
      setSlides(slideRows || [])
      setLoading(false)
    }
    init()
  }, [sessionId])

  const loadTeams = useCallback(async () => {
    const { data, error } = await supabase
      .from('teams')
      .select('*, captain:players!teams_captain_fk(name)')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true })
    if (!error) setTeams(data)
  }, [sessionId])

  useEffect(() => {
    loadTeams()
  }, [loadTeams])

  useEffect(() => {
    if (!session) return
    QRCode.toDataURL(`${window.location.origin}/play/${session.join_code}`, { width: 180 }).then(setQrDataUrl)
  }, [session?.join_code])

  const currentIndex = session?.current_slide_index
  const currentSlide = currentIndex != null && currentIndex >= 0 ? slides[currentIndex] : null

  const loadAnswers = useCallback(async () => {
    if (!currentSlide) {
      setAnswers([])
      return
    }
    const { data, error } = await supabase
      .from('answers')
      .select('*, teams(name)')
      .eq('session_id', sessionId)
      .eq('question_id', currentSlide.id)
      .order('created_at', { ascending: true })
    if (!error) setAnswers(data)
  }, [sessionId, currentSlide?.id])

  useEffect(() => {
    loadAnswers()
  }, [loadAnswers])

  useEffect(() => {
    const channel = supabase
      .channel(`host-session-${sessionId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sessions', filter: `id=eq.${sessionId}` }, (payload) =>
        setSession(payload.new),
      )
      .on('postgres_changes', { event: '*', schema: 'public', table: 'teams', filter: `session_id=eq.${sessionId}` }, () =>
        loadTeams(),
      )
      .on('postgres_changes', { event: '*', schema: 'public', table: 'answers', filter: `session_id=eq.${sessionId}` }, () =>
        loadAnswers(),
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [sessionId, loadTeams, loadAnswers])

  const secondsLeft = useCountdown(
    session?.answers_open ? session.current_slide_started_at : null,
    currentSlide?.time_limit,
  )

  useEffect(() => {
    if (session?.answers_open && secondsLeft === 0) {
      supabase.from('sessions').update({ answers_open: false }).eq('id', sessionId)
    }
  }, [secondsLeft, session?.answers_open, sessionId])

  async function goToSlide(index) {
    if (index >= slides.length) {
      await supabase.from('sessions').update({ status: 'ended', answers_open: false }).eq('id', sessionId)
      return
    }
    const slide = slides[index]
    await supabase
      .from('sessions')
      .update({
        status: 'active',
        current_slide_index: index,
        answers_open: !!slide.is_question,
        current_slide_started_at: new Date().toISOString(),
      })
      .eq('id', sessionId)
  }

  function handleStart() {
    goToSlide(0)
  }

  function handleNext() {
    goToSlide((session.current_slide_index ?? -1) + 1)
  }

  function handleCloseAnswersNow() {
    supabase.from('sessions').update({ answers_open: false }).eq('id', sessionId)
  }

  function handleShowLeaderboard() {
    // A named target means repeat clicks reuse the same tab/window instead
    // of spawning a new one each time — handy for pulling it up between rounds.
    window.open(`/leaderboard/${sessionId}`, 'trivia-leaderboard')
  }

  async function handleDownloadLeaderboardImage() {
    const blob = await renderLeaderboardImage(gameTitle, sortedTeams)
    downloadBlob(blob, `leaderboard-${(gameTitle || 'trivia').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.png`)
  }

  async function handleMark(answer, newValue) {
    // Scoring itself happens in a DB trigger on answers.is_correct, so this
    // covers both host overrides and the auto-match case consistently.
    await supabase.from('answers').update({ is_correct: newValue }).eq('id', answer.id)
    loadAnswers()
  }

  const sortedTeams = useMemo(() => [...teams].sort((a, b) => b.score - a.score), [teams])

  if (loading) {
    return (
      <div style={{ maxWidth: 900, margin: '0 auto', padding: '2rem 1rem' }}>
        <p>Loading…</p>
      </div>
    )
  }

  if (error) {
    return (
      <div style={{ maxWidth: 900, margin: '0 auto', padding: '2rem 1rem' }}>
        <p style={{ color: 'crimson' }}>Error: {error}</p>
      </div>
    )
  }

  const isLobby = session.status === 'lobby'
  const isEnded = session.status === 'ended'

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: '2rem 1rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
        <button
          onClick={() => navigate('/')}
          style={{ background: 'none', border: 'none', padding: 0, color: '#0645ad' }}
        >
          ← Back to My Games
        </button>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button onClick={handleDownloadLeaderboardImage}>📷 Download Leaderboard Image</button>
          <button onClick={handleShowLeaderboard}>🏆 Show Leaderboard</button>
        </div>
      </div>

      <h1 style={{ marginTop: 0 }}>{gameTitle}</h1>

      {isLobby && (
        <div
          style={{
            background: 'white',
            border: '1px solid #ddd',
            borderRadius: 8,
            padding: '1.5rem',
            display: 'flex',
            gap: '2rem',
            alignItems: 'center',
            marginBottom: '1.5rem',
          }}
        >
          <div>
            <p style={{ margin: 0, color: '#666' }}>Join code</p>
            <p style={{ margin: 0, fontSize: '2.5rem', fontWeight: 700, letterSpacing: '0.1em' }}>{session.join_code}</p>
            <p style={{ margin: 0, color: '#666', fontSize: '0.9rem' }}>{window.location.origin}/play/{session.join_code}</p>
          </div>
          {qrDataUrl && <img src={qrDataUrl} alt="QR code to join" width={140} height={140} />}
          <button onClick={handleStart} style={{ marginLeft: 'auto', fontSize: '1.1rem', padding: '0.6rem 1.2rem' }}>
            ▶ Start Game
          </button>
        </div>
      )}

      {!isLobby && !isEnded && currentSlide && (
        <div style={{ background: 'white', border: '1px solid #ddd', borderRadius: 8, padding: '1.5rem', marginBottom: '1.5rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <p style={{ margin: 0, color: '#666' }}>
                Slide {currentIndex + 1} of {slides.length} ·{' '}
                {currentSlide.is_question ? `Question (${currentSlide.points} pts)` : 'Non-question'}
              </p>
              {currentSlide.thumbnail_url && (
                <img
                  src={currentSlide.thumbnail_url}
                  alt=""
                  width={160}
                  style={{ marginTop: '0.5rem', borderRadius: 4, border: '1px solid #eee' }}
                />
              )}
            </div>
            <div style={{ textAlign: 'right' }}>
              {currentSlide.is_question && (
                <p style={{ margin: 0, fontSize: '1.5rem', fontWeight: 700 }}>
                  {session.answers_open ? `⏱ ${secondsLeft ?? currentSlide.time_limit}s` : 'Answers closed'}
                </p>
              )}
              <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem', justifyContent: 'flex-end' }}>
                {currentSlide.is_question && session.answers_open && (
                  <button onClick={handleCloseAnswersNow}>Close Answers</button>
                )}
                <button onClick={handleNext} style={{ fontWeight: 700 }}>
                  {currentIndex + 1 >= slides.length ? 'End Game' : 'Next →'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {isEnded && (
        <div style={{ background: 'white', border: '1px solid #ddd', borderRadius: 8, padding: '1.5rem', marginBottom: '1.5rem' }}>
          <strong>Game over.</strong> Final scores are below.
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem' }}>
        <div>
          <h3>Teams {isLobby && `(${teams.length} joined)`}</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {sortedTeams.length === 0 && <p style={{ color: '#666' }}>No teams yet.</p>}
            {sortedTeams.map((team) => (
              <div
                key={team.id}
                style={{
                  background: 'white',
                  border: '1px solid #ddd',
                  borderRadius: 6,
                  padding: '0.6rem 0.9rem',
                  display: 'flex',
                  justifyContent: 'space-between',
                }}
              >
                <span>
                  {team.name}{' '}
                  <span style={{ color: '#666', fontSize: '0.85rem' }}>
                    {team.captain ? `— captain: ${team.captain.name}` : '— no captain yet'}
                  </span>
                </span>
                <strong>{team.score}</strong>
              </div>
            ))}
          </div>
        </div>

        {currentSlide?.is_question && !isLobby && (
          <div>
            <h3>
              Answers{' '}
              {currentSlide.answers?.length > 0 && (
                <span style={{ fontWeight: 400, fontSize: '0.85rem', color: '#666' }}>
                  (accepted: {currentSlide.answers.join(', ')})
                </span>
              )}
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {answers.length === 0 && <p style={{ color: '#666' }}>No answers yet.</p>}
              {answers.map((a) => (
                <div key={a.id} style={{ background: 'white', border: '1px solid #ddd', borderRadius: 6, padding: '0.6rem 0.9rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span>
                      <strong>{a.teams?.name}</strong>: {a.submitted_text}
                    </span>
                    <span>
                      {a.is_correct === true && <span style={{ color: 'green' }}>✓ Correct</span>}
                      {a.is_correct === false && <span style={{ color: 'crimson' }}>✗ Incorrect</span>}
                      {a.is_correct === null && <span style={{ color: '#b8860b' }}>Needs review</span>}
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.4rem' }}>
                    <button onClick={() => handleMark(a, true)} disabled={a.is_correct === true}>
                      Mark Correct
                    </button>
                    <button onClick={() => handleMark(a, false)} disabled={a.is_correct === false}>
                      Mark Incorrect
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default HostLivePage

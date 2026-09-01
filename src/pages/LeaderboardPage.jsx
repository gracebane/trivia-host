import { useEffect, useState, useCallback } from 'react'
import { useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase.js'
import { renderLeaderboardImage, downloadBlob } from '../lib/renderLeaderboardImage.js'

function LeaderboardPage() {
  const { sessionId } = useParams()
  const [gameTitle, setGameTitle] = useState('')
  const [teams, setTeams] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const loadTeams = useCallback(async () => {
    const { data, error } = await supabase
      .from('teams')
      .select('*')
      .eq('session_id', sessionId)
      .order('score', { ascending: false })
    if (!error) setTeams(data)
  }, [sessionId])

  useEffect(() => {
    async function init() {
      setLoading(true)
      const { data: session, error: sessionError } = await supabase
        .from('sessions')
        .select('game_id')
        .eq('id', sessionId)
        .single()

      if (sessionError) {
        setError(sessionError.message)
        setLoading(false)
        return
      }

      const { data: game } = await supabase.from('games').select('title').eq('id', session.game_id).single()
      setGameTitle(game?.title || '')
      await loadTeams()
      setLoading(false)
    }
    init()
  }, [sessionId, loadTeams])

  useEffect(() => {
    const channel = supabase
      .channel(`leaderboard-${sessionId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'teams', filter: `session_id=eq.${sessionId}` }, () =>
        loadTeams(),
      )
      .subscribe()

    return () => supabase.removeChannel(channel)
  }, [sessionId, loadTeams])

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', background: '#0b1220', color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p>Loading…</p>
      </div>
    )
  }

  if (error) {
    return (
      <div style={{ minHeight: '100vh', background: '#0b1220', color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p style={{ color: '#f87171' }}>Error: {error}</p>
      </div>
    )
  }

  async function handleDownloadImage() {
    const blob = await renderLeaderboardImage(gameTitle, teams)
    downloadBlob(blob, `leaderboard-${(gameTitle || 'trivia').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.png`)
  }

  return (
    <div style={{ minHeight: '100vh', background: '#0b1220', color: 'white', padding: '3rem 2rem', fontFamily: 'system-ui, sans-serif' }}>
      <button
        onClick={handleDownloadImage}
        style={{
          position: 'absolute',
          top: '1.5rem',
          right: '1.5rem',
          background: '#1e293b',
          color: 'white',
          border: '1px solid #334155',
          borderRadius: 6,
          padding: '0.5rem 0.9rem',
          cursor: 'pointer',
        }}
      >
        📷 Download as Image
      </button>

      <h1 style={{ textAlign: 'center', fontSize: '2rem', margin: 0 }}>{gameTitle}</h1>
      <p
        style={{
          textAlign: 'center',
          color: '#94a3b8',
          marginTop: '0.25rem',
          marginBottom: '2.5rem',
          fontSize: '1.1rem',
          letterSpacing: '0.15em',
          textTransform: 'uppercase',
        }}
      >
        Leaderboard
      </p>

      <div style={{ maxWidth: 700, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        {teams.length === 0 && <p style={{ textAlign: 'center', color: '#94a3b8' }}>No teams yet.</p>}
        {teams.map((team, index) => (
          <div
            key={team.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              background: index === 0 ? '#facc15' : '#1e293b',
              color: index === 0 ? '#1e1e1e' : 'white',
              borderRadius: 10,
              padding: '1rem 1.5rem',
            }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: '1rem', fontSize: '1.5rem', fontWeight: 700 }}>
              <span style={{ opacity: 0.6, minWidth: '2ch' }}>{index + 1}</span>
              {team.name}
            </span>
            <span style={{ fontSize: '1.75rem', fontWeight: 800 }}>{team.score}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export default LeaderboardPage

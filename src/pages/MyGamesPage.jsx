import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase.js'
import { generateJoinCode } from '../lib/joinCode.js'

function MyGamesPage() {
  const navigate = useNavigate()
  const [games, setGames] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [creating, setCreating] = useState(false)
  const [startingId, setStartingId] = useState(null)

  useEffect(() => {
    loadGames()
  }, [])

  async function loadGames() {
    setLoading(true)
    setError(null)
    const { data, error } = await supabase
      .from('games')
      .select('id, title, questions(count)')
      .eq('questions.is_question', true)
      .order('created_at', { ascending: false })

    if (error) {
      setError(error.message)
    } else {
      setGames(data)
    }
    setLoading(false)
  }

  async function handleNewGame() {
    setCreating(true)
    const { data, error } = await supabase
      .from('games')
      .insert({ title: 'Untitled Game' })
      .select()
      .single()

    setCreating(false)

    if (error) {
      setError(error.message)
      return
    }

    navigate(`/edit/${data.id}`)
  }

  async function handleHostGame(gameId) {
    setStartingId(gameId)
    setError(null)

    // Retry on the rare join-code collision (unique constraint).
    for (let attempt = 0; attempt < 5; attempt++) {
      const { data, error } = await supabase
        .from('sessions')
        .insert({ game_id: gameId, join_code: generateJoinCode() })
        .select()
        .single()

      if (!error) {
        navigate(`/host/${data.id}`)
        return
      }
      if (error.code !== '23505') {
        setError(error.message)
        setStartingId(null)
        return
      }
    }

    setError('Could not generate a unique join code. Please try again.')
    setStartingId(null)
  }

  return (
    <div style={{ maxWidth: 720, margin: '0 auto', padding: '2rem 1rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <h1 style={{ margin: 0 }}>My Games</h1>
        <button onClick={handleNewGame} disabled={creating}>
          {creating ? 'Creating…' : '+ New Game'}
        </button>
      </div>

      {error && <p style={{ color: 'crimson' }}>Error: {error}</p>}
      {loading && <p>Loading…</p>}

      {!loading && games.length === 0 && (
        <p style={{ color: '#666' }}>No games yet. Click "New Game" to create one.</p>
      )}

      <ul style={{ listStyle: 'none', padding: 0, display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        {games.map((game) => {
          const questionCount = game.questions?.[0]?.count ?? 0
          return (
            <li
              key={game.id}
              style={{
                padding: '1rem',
                background: 'white',
                border: '1px solid #ddd',
                borderRadius: 8,
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: '1rem',
              }}
            >
              <button
                onClick={() => navigate(`/edit/${game.id}`)}
                style={{
                  flex: 1,
                  textAlign: 'left',
                  background: 'none',
                  border: 'none',
                  padding: 0,
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <span style={{ fontWeight: 600 }}>{game.title || 'Untitled Game'}</span>
                <span style={{ color: '#666', fontSize: '0.9rem', marginRight: '1rem' }}>
                  {questionCount} question{questionCount === 1 ? '' : 's'}
                </span>
              </button>
              <button onClick={() => handleHostGame(game.id)} disabled={startingId === game.id}>
                {startingId === game.id ? 'Starting…' : '▶ Host'}
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

export default MyGamesPage

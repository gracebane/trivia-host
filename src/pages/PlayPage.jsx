import { useEffect, useState, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase.js'
import { useCountdown } from '../lib/useCountdown.js'
import { getStoredIdentity, storeIdentity } from '../lib/playerIdentity.js'

function JoinByCodeForm({ onSubmit, error }) {
  const [code, setCode] = useState('')
  return (
    <div style={{ maxWidth: 360, margin: '3rem auto', padding: '0 1rem', textAlign: 'center' }}>
      <h1>Join a Game</h1>
      <input
        type="text"
        value={code}
        onChange={(e) => setCode(e.target.value.toUpperCase())}
        placeholder="Enter join code"
        style={{ fontSize: '1.5rem', textAlign: 'center', letterSpacing: '0.1em', width: '100%', padding: '0.5rem' }}
        maxLength={8}
      />
      <button onClick={() => onSubmit(code.trim())} style={{ marginTop: '1rem', width: '100%', padding: '0.6rem' }}>
        Join
      </button>
      {error && <p style={{ color: 'crimson' }}>{error}</p>}
    </div>
  )
}

function TeamJoinForm({ sessionId, teams, onJoined }) {
  const [name, setName] = useState('')
  const [selectedTeamId, setSelectedTeamId] = useState('')
  const [newTeamName, setNewTeamName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  async function handleSubmit() {
    if (!name.trim()) {
      setError('Enter your name.')
      return
    }
    if (!selectedTeamId && !newTeamName.trim()) {
      setError('Pick a team or create a new one.')
      return
    }

    setSubmitting(true)
    setError(null)

    try {
      let teamId = selectedTeamId
      if (!teamId) {
        const { data, error } = await supabase
          .from('teams')
          .insert({ session_id: sessionId, name: newTeamName.trim() })
          .select()
          .single()
        if (error) throw error
        teamId = data.id
      }

      const { data: player, error: playerError } = await supabase
        .from('players')
        .insert({ session_id: sessionId, team_id: teamId, name: name.trim() })
        .select()
        .single()
      if (playerError) throw playerError

      storeIdentity(sessionId, { playerId: player.id, teamId, name: name.trim() })
      onJoined({ playerId: player.id, teamId, name: name.trim() })
    } catch (err) {
      setError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div style={{ maxWidth: 400, margin: '2rem auto', padding: '0 1rem' }}>
      <h1>Join Game</h1>
      <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', marginBottom: '1rem' }}>
        Your name
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Alex" />
      </label>

      {teams.length > 0 && (
        <div style={{ marginBottom: '1rem' }}>
          <p style={{ marginBottom: '0.4rem' }}>Join an existing team</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
            {teams.map((t) => (
              <button
                key={t.id}
                onClick={() => {
                  setSelectedTeamId(t.id)
                  setNewTeamName('')
                }}
                style={{
                  textAlign: 'left',
                  padding: '0.5rem 0.75rem',
                  borderRadius: 6,
                  border: selectedTeamId === t.id ? '2px solid #0645ad' : '1px solid #ccc',
                  background: selectedTeamId === t.id ? '#e8f0fe' : 'white',
                }}
              >
                {t.name}
              </button>
            ))}
          </div>
        </div>
      )}

      <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', marginBottom: '1rem' }}>
        Or create a new team
        <input
          type="text"
          value={newTeamName}
          onChange={(e) => {
            setNewTeamName(e.target.value)
            setSelectedTeamId('')
          }}
          placeholder="e.g. The Quizzards"
        />
      </label>

      <button onClick={handleSubmit} disabled={submitting} style={{ width: '100%', padding: '0.6rem' }}>
        {submitting ? 'Joining…' : 'Join'}
      </button>
      {error && <p style={{ color: 'crimson' }}>{error}</p>}
    </div>
  )
}

function GameView({ session, slides, identity }) {
  const [team, setTeam] = useState(null)
  const [myAnswer, setMyAnswer] = useState(null)
  const [answerText, setAnswerText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  const currentIndex = session.current_slide_index
  const currentSlide = currentIndex != null && currentIndex >= 0 ? slides[currentIndex] : null
  const isCaptain = team?.captain_player_id === identity.playerId

  const loadTeam = useCallback(async () => {
    const { data } = await supabase.from('teams').select('*').eq('id', identity.teamId).single()
    setTeam(data)
  }, [identity.teamId])

  useEffect(() => {
    loadTeam()
  }, [loadTeam])

  const loadMyAnswer = useCallback(async () => {
    if (!currentSlide) {
      setMyAnswer(null)
      return
    }
    const { data } = await supabase
      .from('answers')
      .select('*')
      .eq('team_id', identity.teamId)
      .eq('question_id', currentSlide.id)
      .maybeSingle()
    setMyAnswer(data)
    setAnswerText(data?.submitted_text || '')
  }, [identity.teamId, currentSlide?.id])

  useEffect(() => {
    loadMyAnswer()
  }, [loadMyAnswer])

  useEffect(() => {
    const channel = supabase
      .channel(`play-${session.id}-${identity.teamId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'teams', filter: `id=eq.${identity.teamId}` },
        (payload) => setTeam(payload.new),
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'answers', filter: `team_id=eq.${identity.teamId}` },
        () => loadMyAnswer(),
      )
      .subscribe()

    return () => supabase.removeChannel(channel)
  }, [session.id, identity.teamId, loadMyAnswer])

  const secondsLeft = useCountdown(
    session.answers_open ? session.current_slide_started_at : null,
    currentSlide?.time_limit,
  )

  async function handleClaimCaptain() {
    await supabase.from('teams').update({ captain_player_id: identity.playerId }).eq('id', identity.teamId).is('captain_player_id', null)
    loadTeam()
  }

  async function handleSubmitAnswer() {
    if (!answerText.trim()) return
    setSubmitting(true)
    setError(null)
    const { error } = await supabase.rpc('submit_team_answer', {
      p_session_id: session.id,
      p_question_id: currentSlide.id,
      p_team_id: identity.teamId,
      p_submitted_text: answerText.trim(),
    })
    setSubmitting(false)
    if (error) {
      setError(error.message)
      return
    }
    loadMyAnswer()
  }

  if (!team) return <p style={{ textAlign: 'center', marginTop: '3rem' }}>Loading…</p>

  return (
    <div style={{ maxWidth: 480, margin: '0 auto', padding: '1.5rem 1rem', textAlign: 'center' }}>
      <p style={{ color: '#666', margin: 0 }}>
        {team.name} · {isCaptain ? 'You are captain ✓' : 'Team member'}
      </p>

      {!team.captain_player_id && (
        <button onClick={handleClaimCaptain} style={{ marginTop: '0.5rem' }}>
          Claim Captain
        </button>
      )}

      <hr style={{ margin: '1.5rem 0' }} />

      {session.status === 'lobby' && <p>Waiting for the host to start the game…</p>}

      {session.status === 'ended' && (
        <div>
          <h2>Game Over!</h2>
          <p style={{ fontSize: '2rem', fontWeight: 700 }}>{team.score} pts</p>
        </div>
      )}

      {session.status === 'active' && currentSlide && !currentSlide.is_question && (
        <p>Stand by…</p>
      )}

      {session.status === 'active' && currentSlide?.is_question && (
        <div>
          <p style={{ fontSize: '1.5rem', fontWeight: 700 }}>
            {session.answers_open ? `⏱ ${secondsLeft ?? currentSlide.time_limit}s` : 'Answers closed'}
          </p>

          {isCaptain ? (
            <>
              <input
                type="text"
                value={answerText}
                onChange={(e) => setAnswerText(e.target.value)}
                placeholder="Type your team's answer"
                disabled={!session.answers_open}
                style={{ width: '100%', padding: '0.6rem', fontSize: '1.1rem', marginTop: '1rem' }}
              />
              <button
                onClick={handleSubmitAnswer}
                disabled={!session.answers_open || submitting}
                style={{ width: '100%', padding: '0.6rem', marginTop: '0.5rem' }}
              >
                {submitting ? 'Submitting…' : myAnswer ? 'Update Answer' : 'Submit Answer'}
              </button>
              {error && <p style={{ color: 'crimson' }}>{error}</p>}
            </>
          ) : (
            <p style={{ color: '#666' }}>
              {myAnswer ? `Your captain answered: "${myAnswer.submitted_text}"` : 'Waiting for your captain to answer…'}
            </p>
          )}

          {!session.answers_open && myAnswer && (
            <p style={{ marginTop: '1rem' }}>
              {myAnswer.is_correct === true && <span style={{ color: 'green' }}>✓ Correct!</span>}
              {myAnswer.is_correct === false && <span style={{ color: 'crimson' }}>✗ Incorrect</span>}
              {myAnswer.is_correct === null && <span style={{ color: '#b8860b' }}>Under review by the host</span>}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function PlayPage() {
  const { joinCode: joinCodeParam } = useParams()
  const navigate = useNavigate()

  const [session, setSession] = useState(null)
  const [slides, setSlides] = useState([])
  const [teams, setTeams] = useState([])
  const [identity, setIdentity] = useState(null)
  const [lookupError, setLookupError] = useState(null)
  const [loading, setLoading] = useState(!!joinCodeParam)

  const resolveSession = useCallback(async (code) => {
    setLookupError(null)
    const { data: sessionRow, error } = await supabase
      .from('sessions')
      .select('*')
      .eq('join_code', code.toUpperCase())
      .maybeSingle()

    if (error || !sessionRow) {
      setLookupError('No game found with that code.')
      setLoading(false)
      return
    }

    const { data: slideRows } = await supabase
      .from('questions')
      .select('id, is_question, time_limit')
      .eq('game_id', sessionRow.game_id)
      .order('order_index', { ascending: true })

    setSession(sessionRow)
    setSlides(slideRows || [])
    setIdentity(getStoredIdentity(sessionRow.id))
    setLoading(false)
  }, [])

  useEffect(() => {
    if (joinCodeParam) {
      resolveSession(joinCodeParam)
    }
  }, [joinCodeParam, resolveSession])

  const loadTeams = useCallback(async () => {
    if (!session) return
    const { data } = await supabase.from('teams').select('*').eq('session_id', session.id).order('created_at', { ascending: true })
    setTeams(data || [])
  }, [session?.id])

  useEffect(() => {
    loadTeams()
  }, [loadTeams])

  useEffect(() => {
    if (!session) return
    const channel = supabase
      .channel(`play-lobby-${session.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sessions', filter: `id=eq.${session.id}` }, (payload) =>
        setSession(payload.new),
      )
      .on('postgres_changes', { event: '*', schema: 'public', table: 'teams', filter: `session_id=eq.${session.id}` }, () =>
        loadTeams(),
      )
      .subscribe()

    return () => supabase.removeChannel(channel)
  }, [session?.id, loadTeams])

  if (!joinCodeParam) {
    return (
      <JoinByCodeForm
        error={lookupError}
        onSubmit={(code) => {
          if (!code) return
          navigate(`/play/${code}`)
        }}
      />
    )
  }

  if (loading) {
    return <p style={{ textAlign: 'center', marginTop: '3rem' }}>Loading…</p>
  }

  if (lookupError || !session) {
    return <JoinByCodeForm error={lookupError} onSubmit={(code) => code && navigate(`/play/${code}`)} />
  }

  if (!identity) {
    return (
      <TeamJoinForm
        sessionId={session.id}
        teams={teams}
        onJoined={(newIdentity) => setIdentity(newIdentity)}
      />
    )
  }

  return <GameView session={session} slides={slides} identity={identity} />
}

export default PlayPage

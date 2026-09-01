import { useState } from 'react'

const POINT_OPTIONS = [4, 6, 8]

function AnswersInput({ answers, onChange }) {
  const [draft, setDraft] = useState('')

  function commitDraft() {
    const value = draft.trim()
    if (value && !answers.includes(value)) {
      onChange([...answers, value])
    }
    setDraft('')
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      commitDraft()
    }
  }

  function removeAnswer(value) {
    onChange(answers.filter((a) => a !== value))
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
      {answers.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
          {answers.map((a) => (
            <span
              key={a}
              style={{
                background: '#eee',
                borderRadius: 12,
                padding: '0.2rem 0.6rem',
                display: 'flex',
                alignItems: 'center',
                gap: '0.3rem',
                fontSize: '0.9rem',
              }}
            >
              {a}
              <button
                type="button"
                onClick={() => removeAnswer(a)}
                title="Remove"
                style={{ border: 'none', background: 'none', padding: 0, lineHeight: 1, fontSize: '1rem' }}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <input
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={commitDraft}
        placeholder="Type an acceptable answer, press Enter"
      />
    </div>
  )
}

function SlideCard({ slide, index, total, onChange, onDelete, onMoveUp, onMoveDown }) {
  function update(field, value) {
    onChange({ ...slide, [field]: value })
  }

  return (
    <div
      style={{
        background: 'white',
        border: '1px solid #ddd',
        borderRadius: 8,
        padding: '1rem',
        display: 'flex',
        gap: '1rem',
      }}
    >
      {slide.thumbnail_url ? (
        <img
          src={slide.thumbnail_url}
          alt={`Slide ${index + 1}`}
          style={{ width: 160, height: 90, objectFit: 'cover', borderRadius: 4, border: '1px solid #eee', flexShrink: 0 }}
        />
      ) : (
        <div
          style={{
            width: 160,
            height: 90,
            borderRadius: 4,
            border: '1px solid #eee',
            background: '#f0f0f0',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#999',
            fontSize: '0.8rem',
            flexShrink: 0,
          }}
        >
          No preview
        </div>
      )}

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <strong>Slide {index + 1}</strong>
          <div style={{ display: 'flex', gap: '0.4rem' }}>
            <button type="button" onClick={onMoveUp} disabled={index === 0} title="Move up">
              ↑
            </button>
            <button type="button" onClick={onMoveDown} disabled={index === total - 1} title="Move down">
              ↓
            </button>
            <button type="button" onClick={onDelete} title="Delete slide">
              🗑 Delete
            </button>
          </div>
        </div>

        <div style={{ display: 'flex', gap: '0.4rem' }}>
          <button
            type="button"
            onClick={() => update('is_question', true)}
            style={{
              padding: '0.4rem 0.9rem',
              borderRadius: 6,
              border: slide.is_question ? '2px solid #0645ad' : '1px solid #ccc',
              background: slide.is_question ? '#e8f0fe' : 'white',
              fontWeight: slide.is_question ? 700 : 400,
            }}
          >
            Question
          </button>
          <button
            type="button"
            onClick={() => update('is_question', false)}
            style={{
              padding: '0.4rem 0.9rem',
              borderRadius: 6,
              border: !slide.is_question ? '2px solid #0645ad' : '1px solid #ccc',
              background: !slide.is_question ? '#e8f0fe' : 'white',
              fontWeight: !slide.is_question ? 700 : 400,
            }}
          >
            Non-question
          </button>
        </div>

        {slide.is_question && (
          <>
            <div style={{ display: 'flex', gap: '1rem' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                Points
                <div style={{ display: 'flex', gap: '0.4rem' }}>
                  {POINT_OPTIONS.map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => update('points', p)}
                      style={{
                        padding: '0.4rem 0.75rem',
                        borderRadius: 6,
                        border: p === slide.points ? '2px solid #0645ad' : '1px solid #ccc',
                        background: p === slide.points ? '#e8f0fe' : 'white',
                        fontWeight: p === slide.points ? 700 : 400,
                      }}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              </div>

              <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                Time Limit (sec)
                <input
                  type="number"
                  min={1}
                  value={slide.time_limit}
                  onChange={(e) => update('time_limit', Number(e.target.value))}
                  style={{ width: 100 }}
                />
              </label>
            </div>

            <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
              Acceptable Answers
              <AnswersInput answers={slide.answers || []} onChange={(next) => update('answers', next)} />
              <small style={{ color: '#666' }}>
                Not case-sensitive. Close typos are auto-accepted; anything further off is flagged for you to review while hosting.
              </small>
            </label>
          </>
        )}
      </div>
    </div>
  )
}

export default SlideCard

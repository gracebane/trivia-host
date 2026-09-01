import { supabase } from './supabase.js'

const BUCKET = 'question-media'

export async function uploadThumbnail(gameId, slideTempId, blob) {
  const path = `${gameId}/${slideTempId}-thumb.png`

  const { error } = await supabase.storage.from(BUCKET).upload(path, blob, {
    contentType: 'image/png',
    upsert: true,
  })
  if (error) throw error

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path)
  return data.publicUrl
}

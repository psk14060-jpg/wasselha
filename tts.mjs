// Spoken alerts in a Saudi (Al-Ahsa) voice via ElevenLabs, generated once per phrase and kept in Postgres.
const VOICE = process.env.ELEVENLABS_VOICE_ID || "kr4VZw8MSZMHE0y2m40n"; // "Hasawi" (Al-Ahsa accent)
const MODEL = process.env.ELEVENLABS_MODEL || "eleven_multilingual_v2";

export async function migrateTts(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS tts_cache (text TEXT PRIMARY KEY, audio BYTEA NOT NULL, created BIGINT NOT NULL)`);
}

const inflight = new Map();
export async function speech(pool, text) {
  text = String(text || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 120);
  if (!text) throw Object.assign(new Error("empty"), { code: 400 });
  const hit = await pool.query("SELECT audio FROM tts_cache WHERE text=$1", [text]);
  if (hit.rows.length) return hit.rows[0].audio;
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw Object.assign(new Error("no_key"), { code: 503 });
  if (!inflight.has(text)) {
    inflight.set(text, (async () => {
      const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE}?output_format=mp3_44100_64`, {
        method: "POST",
        headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
        body: JSON.stringify({ text, model_id: MODEL, language_code: "ar", voice_settings: { stability: 0.6, similarity_boost: 0.8, speed: 0.95 } }),
        signal: AbortSignal.timeout(20000),
      });
      if (!r.ok) throw Object.assign(new Error("tts_" + r.status + " " + (await r.text()).slice(0, 160)), { code: 502 });
      const buf = Buffer.from(await r.arrayBuffer());
      await pool.query("INSERT INTO tts_cache (text, audio, created) VALUES ($1,$2,$3) ON CONFLICT (text) DO NOTHING", [text, buf, Date.now()]);
      return buf;
    })().finally(() => inflight.delete(text)));
  }
  return inflight.get(text);
}

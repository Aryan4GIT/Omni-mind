/* API server. Holds the Gemini key — the browser never sees it.
   Two real endpoints: /api/ask (retrieval answer) and /api/run (three
   agents over your sources, streamed as NDJSON). */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import express from 'express'
import { ANSWER_SCHEMA, ANSWER_SYSTEM, orchestrate, render } from './agents.js'

try {
  process.loadEnvFile('.env')
} catch {
  /* no .env — the key may already be exported */
}

const PORT = process.env.PORT || 8787
// The `-latest` alias tracks the current stable flash model, so it never hits
// the "no longer available to new users" wall that pinned versions do. Set
// GEMINI_MODEL to pin a specific one (e.g. gemini-3-pro-preview for quality).
const MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest'
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models'
const DIST = join(import.meta.dirname, 'dist')

const key = process.env.GEMINI_API_KEY

/* Gemini's responseSchema is an OpenAPI subset, not full JSON Schema: it
   rejects `additionalProperties` outright and wants the type enum in caps.
   The agent schemas are written as plain JSON Schema, so translate here and
   leave agents.js provider-agnostic. */
function toGeminiSchema(s) {
  if (Array.isArray(s)) return s.map(toGeminiSchema)
  if (s && typeof s === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(s)) {
      if (k === 'additionalProperties') continue
      out[k] = k === 'type' && typeof v === 'string' ? v.toUpperCase() : toGeminiSchema(v)
    }
    return out
  }
  return s
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Seconds Gemini asks us to wait on a 429, from its RetryInfo detail. */
function retryDelayMs(errBody) {
  const info = errBody?.error?.details?.find((d) => (d['@type'] ?? '').includes('RetryInfo'))
  const m = /^([\d.]+)s$/.exec(info?.retryDelay ?? '')
  return m ? Math.ceil(parseFloat(m[1]) * 1000) : null
}

/* Every agent call is the same shape: a system prompt, a user turn, and a
   JSON schema the reply must satisfy. responseSchema means we never parse
   prose — a malformed reply is impossible, not merely unlikely.
   `think` gates dynamic thinking (the drafting and checking passes want it,
   the retrieval passes don't). Newer models reject thinkingBudget:0, so to
   turn thinking off we omit thinkingConfig entirely rather than send 0. */
async function call(system, user, schema, { think = false } = {}) {
  const payload = JSON.stringify({
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: toGeminiSchema(schema),
      maxOutputTokens: 8192,
      ...(think ? { thinkingConfig: { thinkingBudget: -1 } } : {}), // -1 = dynamic
    },
  })

  // A full agent run makes ~6 calls; the free tier allows 5/minute. Honour
  // the server's own RetryInfo so a run completes (slowly) instead of dying
  // mid-loop. ponytail: bounded retry, not a queue — add a token bucket if
  // you outgrow the free tier.
  let res
  for (let attempt = 0; ; attempt++) {
    res = await fetch(`${ENDPOINT}/${MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: payload,
    })
    if (res.status !== 429 || attempt >= 4) break
    const body = await res.json().catch(() => null)
    await sleep(Math.min(retryDelayMs(body) ?? 5000, 30000))
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    let msg = `Gemini returned ${res.status}`
    try {
      msg = JSON.parse(body).error?.message ?? msg
    } catch {
      /* non-JSON error body */
    }
    throw new Error(msg)
  }

  const data = await res.json()
  if (data.promptFeedback?.blockReason)
    throw new Error(`The request was blocked (${data.promptFeedback.blockReason}).`)

  const cand = data.candidates?.[0]
  const reason = cand?.finishReason
  if (reason && reason !== 'STOP' && reason !== 'MAX_TOKENS')
    throw new Error(`The model stopped: ${reason}.`)

  const text = (cand?.content?.parts ?? [])
    .map((p) => p.text)
    .filter(Boolean)
    .join('')
  if (!text) throw new Error('The model returned no content.')
  return JSON.parse(text) // guaranteed JSON by responseMimeType + schema
}

const app = express()
app.use(express.json({ limit: '8mb' }))

const needsKey = (_req, res, next) =>
  key ? next() : res.status(503).json({ error: 'GEMINI_API_KEY is not set on the server.' })

/* ── Answer one question over retrieved passages ────────────────
   The client ranks and sends the passages; the model may use only
   what it was given, and must cite the ids it used. */
app.post('/api/ask', needsKey, async (req, res) => {
  const { question, chunks } = req.body ?? {}
  if (!question?.trim()) return res.status(400).json({ error: 'question is required' })
  if (!chunks?.length) return res.status(400).json({ error: 'no passages were retrieved' })

  try {
    const out = await call(
      ANSWER_SYSTEM,
      `Passages:\n\n${render(chunks)}\n\nQuestion: ${question}`,
      ANSWER_SCHEMA,
    )
    const ids = new Set(chunks.map((c) => c.id))
    res.json({ ...out, cites: (out.cites ?? []).filter((id) => ids.has(id)) })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

/* ── Run the three agents, streaming progress ───────────────────
   NDJSON rather than SSE: the client is a plain fetch reader, and each
   line is one already-shaped event. */
app.post('/api/run', needsKey, async (req, res) => {
  const { task, chunks } = req.body ?? {}
  if (!task?.trim()) return res.status(400).json({ error: 'task is required' })
  if (!chunks?.length)
    return res.status(400).json({ error: 'no sources — add a document in Retrieve first' })

  res.set({ 'content-type': 'application/x-ndjson', 'cache-control': 'no-cache' })
  const t0 = Date.now()
  const send = (o) => res.write(`${JSON.stringify(o)}\n`)
  const emit = (agent, status, msg, edge) =>
    send({ t: Date.now() - t0, agent, status, msg, ...(edge ? { edge } : {}) })

  // Headers are already sent, so a failure here is a stream event, not a
  // status code. The client reads `type` to tell them apart.
  try {
    const out = await orchestrate({ task, chunks, emit, call })
    send({ type: 'result', t: Date.now() - t0, ...out })
  } catch (e) {
    send({ type: 'error', t: Date.now() - t0, error: e.message })
  }
  res.end()
})

app.get('/api/health', (_req, res) => res.json({ ok: Boolean(key), model: MODEL }))

/* Serve the built app when it exists, so production is a single process. */
if (existsSync(DIST)) {
  app.use(express.static(DIST))
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/')) return next()
    res.sendFile(join(DIST, 'index.html'))
  })
}

app.listen(PORT, () => {
  console.log(`api  http://localhost:${PORT}  model ${MODEL}`)
  if (!key) console.warn('warn GEMINI_API_KEY is not set — /api/ask and /api/run return 503')
})

/* Agent prompts, schemas, and the orchestration loop.
   `call` is injected rather than imported so the loop — the one piece of
   real branching in this app — can be exercised without an API key.
   See agents.test.mjs. */

const obj = (props, required) => ({
  type: 'object',
  additionalProperties: false,
  required,
  properties: props,
})

/** Chunks rendered for a prompt. Ids are what citations point back at. */
export const render = (chunks) =>
  chunks.map((c) => `[${c.id}] (${c.label ?? `p.${c.page}`})\n${c.body}`).join('\n\n')

/* ── Retrieval answer ───────────────────────────────────────── */

export const ANSWER_SCHEMA = obj(
  {
    found: { type: 'boolean' },
    answer: { type: 'string' },
    cites: { type: 'array', items: { type: 'string' } },
  },
  ['found', 'answer', 'cites'],
)

export const ANSWER_SYSTEM = `You answer questions strictly from the passages you are given.

Rules:
- Use only the passages. Never use outside knowledge, and never guess.
- If the passages do not answer the question, set found=false and say plainly what is missing. Do not pad it out.
- cites must list the ids of only the passages you actually used. Leave it empty when found=false.
- Answer in at most four sentences. Quote figures and names exactly as they appear.
- Wrap the key figure or finding in **double asterisks**.`

/* ── Orchestrator ───────────────────────────────────────────── */

const RESEARCH_SCHEMA = obj(
  {
    summary: { type: 'string' },
    evidence: {
      type: 'array',
      items: obj({ id: { type: 'string' }, why: { type: 'string' } }, ['id', 'why']),
    },
  },
  ['summary', 'evidence'],
)

const DRAFT_SCHEMA = obj(
  {
    brief: { type: 'string' },
    claims: { type: 'array', items: { type: 'string' } },
  },
  ['brief', 'claims'],
)

const CHECK_SCHEMA = obj(
  {
    verdicts: {
      type: 'array',
      items: obj(
        {
          claim: { type: 'string' },
          verdict: { type: 'string', enum: ['supported', 'unsupported'] },
          note: { type: 'string' },
        },
        ['claim', 'verdict', 'note'],
      ),
    },
  },
  ['verdicts'],
)

const RESEARCHER = `You select evidence. Given a task and a set of passages, pick only the passages that bear on the task and say in one line what each contributes. Ignore passages that are merely adjacent to the topic. Use the exact ids you were given — never invent one.`

const WRITER = `You write short, evidence-backed briefs. Every sentence must be traceable to one of the passages. No preamble, no hedging, and no recommendations the evidence does not support. Then list each factual claim you made as a separate item in claims, each phrased so it can be checked against a passage on its own.`

const CHECKER = `You verify claims against passages. A claim is "supported" only if a passage states it or directly entails it. Plausible is not supported, and neither is common knowledge. When a claim is unsupported, the note says exactly what the passages do and do not say about it.`

/** Two drafting passes. One revision round is where the fact-checker earns
 *  its place; a second would mostly re-litigate claims the sources simply
 *  do not cover, which the run reports as unresolved instead. */
export const MAX_PASSES = 2

/**
 * Run the three agents over `chunks`. Emits progress as it goes and
 * resolves to the finished brief.
 *
 * @param {object}   o
 * @param {string}   o.task
 * @param {{id:string, page?:number, body:string, label?:string}[]} o.chunks
 * @param {(agent:string, status:string, msg:string, edge?:string) => void} o.emit
 * @param {(system:string, user:string, schema:object, opts?:object) => Promise<object>} o.call
 */
export async function orchestrate({ task, chunks, emit, call }) {
  emit('researcher', 'running', `Reading ${chunks.length} passages`)
  const research = await call(RESEARCHER, `Task: ${task}\n\nPassages:\n\n${render(chunks)}`, RESEARCH_SCHEMA, {
    effort: 'low',
  })

  // Drop any id the model invented — a citation that resolves to nothing is
  // worse than one fewer citation.
  const ids = new Set(chunks.map((c) => c.id))
  const evidence = (research.evidence ?? []).filter((e) => ids.has(e.id))
  if (!evidence.length) {
    emit('researcher', 'failed', 'No passage in the sources bears on this task')
    return { halted: true }
  }
  emit('researcher', 'done', `${evidence.length} of ${chunks.length} passages kept`)

  const cited = chunks.filter((c) => evidence.some((e) => e.id === c.id))
  const notes = evidence.map((e) => `[${e.id}] ${e.why}`).join('\n')

  let draft = null
  let verdicts = []

  for (let pass = 1; pass <= MAX_PASSES; pass++) {
    const failed = verdicts.filter((v) => v.verdict === 'unsupported')
    const revising = pass > 1

    emit(
      'writer',
      'running',
      revising ? `Revising ${failed.length} unsupported claim(s)` : `Drafting from ${cited.length} passages`,
      revising ? 'c-w' : 'r-w',
    )

    draft = await call(
      WRITER,
      revising
        ? `Task: ${task}\n\nPassages:\n\n${render(cited)}\n\nYour previous draft:\n${draft.brief}\n\n` +
            `A fact-checker rejected these claims. Rewrite the brief so each one is either supported by a passage or removed:\n` +
            failed.map((v) => `- "${v.claim}" — ${v.note}`).join('\n')
        : `Task: ${task}\n\nWhat the researcher kept:\n${notes}\n\nPassages:\n\n${render(cited)}`,
      DRAFT_SCHEMA,
      { effort: 'high', think: true },
    )
    emit(
      'writer',
      'done',
      `Draft ${pass} · ${draft.brief.trim().split(/\s+/).length} words, ${draft.claims.length} claims`,
    )

    emit('checker', 'running', `Verifying ${draft.claims.length} claims`, 'w-c')
    const check = await call(
      CHECKER,
      `Passages:\n\n${render(cited)}\n\nClaims:\n${draft.claims.map((c, i) => `${i + 1}. ${c}`).join('\n')}`,
      CHECK_SCHEMA,
      { effort: 'medium', think: true },
    )
    verdicts = check.verdicts ?? []

    const bad = verdicts.filter((v) => v.verdict === 'unsupported')
    const done = { brief: draft.brief, verdicts, passes: pass, cites: cited.map((c) => c.id) }

    if (!bad.length) {
      emit('checker', 'done', `${verdicts.length} of ${verdicts.length} claims verified`)
      return done
    }
    if (pass === MAX_PASSES) {
      emit('checker', 'revise', `${bad.length} claim(s) still unsupported after ${pass} passes`)
      return { ...done, unresolved: true }
    }
    emit('checker', 'revise', `${bad.length} of ${verdicts.length} unsupported · back to Writer`)
  }
}

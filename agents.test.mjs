/* Self-check for the orchestration loop — the branchy part of this app.
   The model is stubbed, so this runs offline and costs nothing: what is
   under test is the revision loop, its termination, and the id guard, not
   Claude's judgement. Run: `npm test`. */
import assert from 'node:assert/strict'
import { MAX_PASSES, orchestrate } from './agents.js'

const CHUNKS = [
  { id: 'a', page: 1, body: 'Revenue was 4.28M.' },
  { id: 'b', page: 2, body: 'Margin held at 71.2%.' },
  { id: 'c', page: 3, body: 'Headcount ended at 84.' },
]

/** Stub `call`, dispatching on which schema it was handed. Records every
 *  prompt so the tests can assert what the writer was actually told. */
function stub({ evidence, verdictsByPass }) {
  const prompts = []
  let pass = 0
  const call = async (system, user, schema) => {
    prompts.push(user)
    const props = schema.properties
    if (props.evidence) return { summary: 's', evidence }
    if (props.brief) return { brief: `draft ${++pass}`, claims: ['claim one', 'claim two'] }
    return { verdicts: verdictsByPass[pass - 1] }
  }
  return { call, prompts }
}

const ok = (claim) => ({ claim, verdict: 'supported', note: '' })
const bad = (claim, note = 'the passages do not say this') => ({
  claim,
  verdict: 'unsupported',
  note,
})

/** Run and collect the emitted events. */
async function run(opts) {
  const events = []
  const { call, prompts } = stub(opts)
  const result = await orchestrate({
    task: 'Summarise the quarter',
    chunks: CHUNKS,
    emit: (agent, status, msg, edge) => events.push({ agent, status, msg, edge }),
    call,
  })
  return { result, events, prompts }
}

const EVIDENCE = [
  { id: 'a', why: 'revenue' },
  { id: 'b', why: 'margin' },
]

/* ── A clean run stops after one pass ───────────────────────── */
{
  const { result, events } = await run({
    evidence: EVIDENCE,
    verdictsByPass: [[ok('claim one'), ok('claim two')]],
  })

  assert.equal(result.passes, 1, 'a verified draft is not rewritten')
  assert.ok(!result.unresolved)
  assert.equal(result.brief, 'draft 1')
  assert.deepEqual(result.cites, ['a', 'b'], 'only the passages the researcher kept are cited')

  const writes = events.filter((e) => e.agent === 'writer' && e.status === 'running')
  assert.equal(writes.length, 1, 'the writer runs once')
  assert.equal(writes[0].edge, 'r-w', 'the first draft comes off the researcher edge')
  assert.equal(events.at(-1).status, 'done')
  assert.ok(
    !events.some((e) => e.edge === 'c-w'),
    'the revision edge stays dark when nothing needed revising',
  )
}

/* ── An unsupported claim sends the draft back ──────────────── */
{
  const { result, events, prompts } = await run({
    evidence: EVIDENCE,
    verdictsByPass: [
      [ok('claim one'), bad('claim two', 'no passage mentions headcount')],
      [ok('claim one'), ok('claim two')],
    ],
  })

  assert.equal(result.passes, 2, 'the second pass ran')
  assert.equal(result.brief, 'draft 2', 'the revised draft is the one returned')
  assert.ok(!result.unresolved, 'the second pass cleared the flag')

  const writes = events.filter((e) => e.agent === 'writer' && e.status === 'running')
  assert.equal(writes.length, 2, 'the writer runs twice')
  assert.equal(writes[1].edge, 'c-w', 'the rewrite is attributed to the revision edge')
  assert.ok(
    events.some((e) => e.agent === 'checker' && e.status === 'revise'),
    'the checker reports the send-back',
  )

  // The rewrite is only meaningful if the writer is told what failed.
  const rewrite = prompts.at(-2)
  assert.match(rewrite, /claim two/, 'the rejected claim reaches the writer')
  assert.match(rewrite, /no passage mentions headcount/, "so does the checker's reason")
  assert.match(rewrite, /draft 1/, 'and the draft being revised')
  assert.doesNotMatch(rewrite, /claim one/, 'claims that passed are not re-litigated')
}

/* ── A claim the sources never cover terminates the loop ────── */
{
  const stubborn = [bad('claim one'), bad('claim two')]
  const { result, events } = await run({
    evidence: EVIDENCE,
    // More verdict sets than MAX_PASSES: if the loop did not stop itself,
    // it would happily keep going.
    verdictsByPass: [stubborn, stubborn, stubborn, stubborn],
  })

  assert.equal(result.passes, MAX_PASSES, 'the loop stops at the pass ceiling')
  assert.equal(
    events.filter((e) => e.agent === 'writer' && e.status === 'running').length,
    MAX_PASSES,
    'the writer is not called again after the ceiling',
  )
  assert.ok(result.unresolved, 'the run says plainly that claims are still unsupported')
  assert.ok(result.brief, 'the draft is still returned, labelled rather than discarded')
  assert.equal(result.verdicts.filter((v) => v.verdict === 'unsupported').length, 2)
}

/* ── Invented passage ids are dropped ───────────────────────── */
{
  const { result, events } = await run({
    evidence: [
      { id: 'a', why: 'revenue' },
      { id: 'ZZZ', why: 'a passage that does not exist' },
    ],
    verdictsByPass: [[ok('claim one'), ok('claim two')]],
  })

  assert.deepEqual(result.cites, ['a'], 'a citation that resolves to nothing never reaches the client')
  assert.match(
    events.find((e) => e.agent === 'researcher' && e.status === 'done').msg,
    /1 of 3/,
    'the count reflects what survived, not what was claimed',
  )
}

/* ── Nothing relevant halts before the writer ───────────────── */
{
  const { result, events } = await run({
    evidence: [{ id: 'nope', why: 'invented' }],
    verdictsByPass: [[ok('claim one')]],
  })

  assert.ok(result.halted, 'the run halts rather than drafting from nothing')
  assert.ok(!result.brief, 'no brief is fabricated')
  assert.ok(
    !events.some((e) => e.agent === 'writer'),
    'a failed research step never dispatches the writer',
  )
  assert.equal(events.at(-1).status, 'failed')
}

console.log('ok — 27 assertions passed')

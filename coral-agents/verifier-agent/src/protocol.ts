/**
 * Market protocol extensions — the two verbs the verifier economy adds on top of the kit's
 * WANT/BID/AWARD/ESCROW/DEPOSITED wire format (packages/agent-runtime/src/market): a DELIVER that
 * carries the payload hash-bound to the order, and a VERDICT that carries the verifier's ruling and
 * its settlement signature. Same style as the kit: single-token key=value strings, pure functions,
 * fully unit-testable. Extra tokens ride on the kit's own verbs unchanged (its regex parsers ignore
 * what they don't know), so kit agents can still read this market.
 */

export interface Deliver {
  round: number
  reference: string
  by: string
  /** base64url JSON — the work product being sold. */
  payload: string
}

export interface VerdictMsg {
  round: number
  reference: string
  result: 'VERIFIED' | 'REJECTED'
  /** Settlement tx signature (release or refund), once ruled on-chain. */
  sig?: string
  /** base64url — human-readable failure list for REJECTED. */
  reason?: string
}

const num = (text: string, key: string): number | undefined => {
  const m = text.match(new RegExp(`${key}=([\\d.]+)`))
  return m ? Number(m[1]) : undefined
}
const tok = (text: string, key: string): string | undefined =>
  text.match(new RegExp(`${key}=(\\S+)`))?.[1]

export function formatDeliver(d: Deliver): string {
  return `DELIVER round=${d.round} reference=${d.reference} by=${d.by} payload=${d.payload}`
}
export function parseDeliver(text: string): Deliver | null {
  if (!text.trim().toUpperCase().startsWith('DELIVER ')) return null
  const round = num(text, 'round')
  const reference = tok(text, 'reference')
  const by = tok(text, 'by')
  const payload = tok(text, 'payload')
  if (round == null || !reference || !by || !payload) return null
  return { round, reference, by, payload }
}

/**
 * Mutual consent on the referee. Today the buyer names the verifier unilaterally, so a buyer could
 * name one it secretly controls and grief the seller. The seller's defence is the right to REFUSE an
 * order whose verifier it does not accept — the referee must be one *both* sides consented to.
 *
 * `accepted` undefined/empty = "any verifier" (the seller opts out of the check; the demo's default,
 * so its happy path is unchanged). Otherwise the named verifier must be on the seller's allowlist.
 */
export function sellerAcceptsVerifier(namedVerifier: string, accepted?: string[]): boolean {
  if (!accepted || accepted.length === 0) return true
  return accepted.includes(namedVerifier)
}

/** A seller's on-market refusal to work under an order's named verifier (mutual-consent, above). */
export function formatDecline(round: number, reference: string, by: string, reason: string): string {
  return `DECLINE round=${round} reference=${reference} by=${by} reason=${b64Reason(reason)}`
}
const b64Reason = (s: string): string => Buffer.from(s, 'utf8').toString('base64url')

export function formatVerdict(v: VerdictMsg): string {
  const parts = [`VERDICT round=${v.round}`, `reference=${v.reference}`, `result=${v.result}`]
  if (v.sig) parts.push(`sig=${v.sig}`)
  if (v.reason) parts.push(`reason=${v.reason}`)
  return parts.join(' ')
}
export function parseVerdict(text: string): VerdictMsg | null {
  if (!text.trim().toUpperCase().startsWith('VERDICT ')) return null
  const round = num(text, 'round')
  const reference = tok(text, 'reference')
  const result = tok(text, 'result')
  if (round == null || !reference || (result !== 'VERIFIED' && result !== 'REJECTED')) return null
  const sig = tok(text, 'sig')
  const reason = tok(text, 'reason')
  return { round, reference, result, ...(sig ? { sig } : {}), ...(reason ? { reason } : {}) }
}

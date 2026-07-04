/**
 * Acceptance specs — the buyer's checks, as data. A WANT carries a spec; the verifier runs it
 * against the delivery and rules. Everything here is pure (network-free) so the verdict logic is
 * fully unit-testable: the model may PROPOSE a delivery, but this code DISPOSES.
 *
 * A spec names the fields a delivery must carry (with types) and the invariants that must hold
 * between them. The demo sells invoice extraction, so the invariants are the ones a paying buyer
 * actually cares about: the line items sum to the total, the date parses, nothing is missing.
 */
import { createHash } from 'node:crypto'

export interface FieldSpec {
  /** JSON type the field must have. */
  type: 'string' | 'number'
  /** For strings: a regex the value must match (source form, applied anchored). */
  pattern?: string
}

export interface AcceptanceSpec {
  /** What is being bought, e.g. "invoice-extraction". */
  service: string
  /** Top-level fields the delivery must carry. */
  fields: Record<string, FieldSpec>
  /** Line-item fields, when the delivery must carry an `items` array (one per line). */
  itemFields?: Record<string, FieldSpec>
  /** Named cross-field rules, checked by `checkInvariants`. */
  invariants: InvariantName[]
}

export type InvariantName = 'total-equals-item-sum' | 'items-nonempty' | 'date-parses'

export interface Verdict {
  pass: boolean
  /** Every failed check, human-readable — the REJECTED reason that goes on the wire. */
  failures: string[]
}

/** Base64 helpers — specs and deliveries travel as single tokens in market strings. */
export const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64url')
export const unb64 = (s: string): string => Buffer.from(s, 'base64url').toString('utf8')

export const specHash = (spec: AcceptanceSpec): string =>
  createHash('sha256').update(canonicalize(spec)).digest('hex')

/** Deterministic, key-order-independent JSON for hashing — two specs that are equal as values hash
 * equally even if their keys were serialized in a different order (the buyer and the verifier build
 * the object independently). Plain `JSON.stringify` is order-sensitive, which would silently break
 * the binding check between honest parties. */
function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** Validate that a spec is actually runnable BEFORE any order binds to it: every field pattern must
 * compile. Returns the list of problems (empty = usable). The verifier refuses to register a spec
 * that fails this, so a buyer can't (accidentally or maliciously) post a WANT whose broken regex
 * would later strand the order and leave an honest seller unpaid. */
export function validateSpec(spec: AcceptanceSpec): string[] {
  const problems: string[] = []
  const checkPatterns = (fields: Record<string, FieldSpec> | undefined, where: string): void => {
    for (const [name, f] of Object.entries(fields ?? {})) {
      if (f.pattern === undefined) continue
      try { new RegExp(`^(?:${f.pattern})$`) }
      catch { problems.push(`${where}${name}: pattern /${f.pattern}/ is not a valid regex`) }
    }
  }
  checkPatterns(spec.fields, '')
  checkPatterns(spec.itemFields, 'items[].')
  return problems
}

/** Parse a delivery payload (base64url JSON). Returns null instead of throwing — malformed JSON is
 * a verdict ("REJECTED: not JSON"), not a crash. */
export function parseDelivery(payloadB64: string): Record<string, unknown> | null {
  // Bound the work a hostile seller can force onto the verifier: an oversized payload is a verdict
  // ("REJECTED: too large"), not an OOM. 256 KB is far more than any honest structured delivery.
  if (typeof payloadB64 !== 'string' || payloadB64.length > 256 * 1024) return null
  try {
    const parsed = JSON.parse(unb64(payloadB64))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

const checkFields = (
  obj: Record<string, unknown>, fields: Record<string, FieldSpec>, where: string, failures: string[],
): void => {
  for (const [name, f] of Object.entries(fields)) {
    const v = obj[name]
    if (v === undefined || v === null) { failures.push(`${where}${name}: missing`); continue }
    if (typeof v !== f.type) { failures.push(`${where}${name}: expected ${f.type}, got ${typeof v}`); continue }
    if (f.type === 'number' && !Number.isFinite(v as number)) { failures.push(`${where}${name}: not finite`); continue }
    if (f.pattern) {
      const s = String(v)
      // Cap the string a hostile delivery can feed a buyer-supplied regex — bounds catastrophic
      // backtracking (ReDoS) amplitude. Honest field values are short; an over-long one is a fail.
      if (s.length > 8192) { failures.push(`${where}${name}: too long (${s.length} chars)`); continue }
      // The pattern is buyer-supplied, so it may not even compile (e.g. "("). A broken pattern must be
      // a verdict ("REJECTED: unusable spec"), NEVER an exception — an exception here would propagate
      // out of judge() and strand the order (the verifier marks it ruled but never settles), which
      // punishes an honest seller and is a griefing vector. Compile defensively; treat failure as a fail.
      let re: RegExp
      try { re = new RegExp(`^(?:${f.pattern})$`) }
      catch { failures.push(`${where}${name}: spec pattern /${f.pattern}/ is not a valid regex`); continue }
      if (!re.test(s)) failures.push(`${where}${name}: fails /${f.pattern}/`)
    }
  }
}

function checkInvariants(delivery: Record<string, unknown>, spec: AcceptanceSpec, failures: string[]): void {
  const items = Array.isArray(delivery.items) ? (delivery.items as Record<string, unknown>[]) : undefined
  for (const inv of spec.invariants) {
    if (inv === 'items-nonempty') {
      if (!items || items.length === 0) failures.push('items: missing or empty')
    } else if (inv === 'total-equals-item-sum') {
      if (!items) { failures.push('total-equals-item-sum: no items array'); continue }
      const sum = items.reduce((acc, it) => acc + (typeof it.amount === 'number' ? it.amount : NaN), 0)
      const total = delivery.total
      // Money in cents-exact terms: compare at 2dp so float noise doesn't fail honest work.
      if (typeof total !== 'number' || !Number.isFinite(sum) || Math.abs(sum - total) > 0.005)
        failures.push(`total-equals-item-sum: items sum ${sum} != total ${String(total)}`)
    } else if (inv === 'date-parses') {
      const d = delivery.date
      if (typeof d !== 'string' || Number.isNaN(Date.parse(d))) failures.push(`date-parses: ${String(d)}`)
    }
  }
}

/**
 * The verifier's ruling: run every schema check and invariant, collect every failure. Deterministic
 * and reproducible — a REJECTED verdict can be re-derived by anyone with the spec + delivery, which
 * is what makes the verifier auditable (and disputable) rather than an oracle you just trust.
 */
export function judge(payloadB64: string, spec: AcceptanceSpec): Verdict {
  const delivery = parseDelivery(payloadB64)
  if (!delivery) return { pass: false, failures: ['delivery: not a JSON object'] }
  const failures: string[] = []
  checkFields(delivery, spec.fields, '', failures)
  if (spec.itemFields) {
    const items = Array.isArray(delivery.items) ? (delivery.items as unknown[]) : []
    items.forEach((it, i) => {
      if (typeof it !== 'object' || it === null) failures.push(`items[${i}]: not an object`)
      else checkFields(it as Record<string, unknown>, spec.itemFields!, `items[${i}].`, failures)
    })
  }
  checkInvariants(delivery, spec, failures)
  return { pass: failures.length === 0, failures }
}

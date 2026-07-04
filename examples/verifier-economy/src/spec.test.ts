import { describe, expect, it } from 'vitest'
import { judge, b64, parseDelivery, validateSpec, specHash, type AcceptanceSpec } from './spec.js'
import { bindOrder, referenceOf, preimageMatches, hashInput, inputOf } from './reference.js'
import { formatDeliver, parseDeliver, formatVerdict, parseVerdict, sellerAcceptsVerifier, formatDecline } from './protocol.js'
import { extractInvoice } from './agents/seller.js'
import { INVOICE_SPEC, JOBS } from './data.js'

const wrap = (obj: unknown): string => b64(JSON.stringify(obj))

describe('judge', () => {
  it('passes the honest extraction of every fixture', () => {
    for (const job of JOBS) {
      const verdict = judge(wrap(extractInvoice(job.document)), INVOICE_SPEC)
      expect(verdict.failures).toEqual([])
      expect(verdict.pass).toBe(true)
    }
  })

  it('rejects non-JSON and non-object payloads', () => {
    expect(judge(b64('not json'), INVOICE_SPEC).pass).toBe(false)
    expect(judge(wrap([1, 2]), INVOICE_SPEC).pass).toBe(false)
  })

  it('rejects a delivery whose items do not sum to the total, and says why', () => {
    const honest = extractInvoice(JOBS[0].document)
    const slop = { ...honest, items: (honest.items as unknown[]).slice(0, 1) }
    const verdict = judge(wrap(slop), INVOICE_SPEC)
    expect(verdict.pass).toBe(false)
    expect(verdict.failures.join(' ')).toContain('total-equals-item-sum')
  })

  it('rejects missing and mistyped fields', () => {
    const honest = extractInvoice(JOBS[0].document) as Record<string, unknown>
    const { vendor: _vendor, ...noVendor } = honest
    expect(judge(wrap(noVendor), INVOICE_SPEC).failures.join(' ')).toContain('vendor: missing')
    expect(judge(wrap({ ...honest, total: '778.00' }), INVOICE_SPEC).failures.join(' ')).toContain('total: expected number')
  })

  it('rejects an unparseable date', () => {
    const honest = extractInvoice(JOBS[0].document)
    expect(judge(wrap({ ...honest, date: 'sometime in June' }), INVOICE_SPEC).failures.join(' ')).toContain('date-parses')
  })

  it('tolerates 2dp float noise on the money invariant', () => {
    const honest = extractInvoice(JOBS[0].document) as { total: number }
    expect(judge(wrap({ ...honest, total: honest.total + 0.004 }), INVOICE_SPEC).pass).toBe(true)
    expect(judge(wrap({ ...honest, total: honest.total + 0.02 }), INVOICE_SPEC).pass).toBe(false)
  })

  it('does NOT throw on a buyer-supplied pattern that cannot compile — it is a verdict, not a crash', () => {
    // "(" is a legal JSON string but an illegal regex. Before the fix this threw out of judge(),
    // propagated through the verifier, and stranded the order (honest seller left unpaid). Now it
    // is simply a failed check, so the order still settles (refund) instead of hanging forever.
    const brokenSpec: AcceptanceSpec = {
      service: 'x', fields: { vendor: { type: 'string', pattern: '(' } }, invariants: [],
    }
    expect(() => judge(wrap({ vendor: 'ACME' }), brokenSpec)).not.toThrow()
    const v = judge(wrap({ vendor: 'ACME' }), brokenSpec)
    expect(v.pass).toBe(false)
    expect(v.failures.join(' ')).toContain('not a valid regex')
  })
})

describe('validateSpec (reject an unusable spec before any order binds to it)', () => {
  it('passes a runnable spec and reports every uncompilable pattern', () => {
    expect(validateSpec(INVOICE_SPEC)).toEqual([])
    const bad: AcceptanceSpec = {
      service: 'x',
      fields: { a: { type: 'string', pattern: '(' } },
      itemFields: { b: { type: 'string', pattern: '[' } },
      invariants: [],
    }
    const problems = validateSpec(bad)
    expect(problems.length).toBe(2)
    expect(problems.join(' ')).toContain('a: pattern')
    expect(problems.join(' ')).toContain('items[].b: pattern')
  })
})

describe('specHash is a function of the spec value, not its key order', () => {
  it('hashes two equal-by-value specs identically regardless of serialization order', () => {
    const a: AcceptanceSpec = {
      service: 'invoice', fields: { total: { type: 'number' }, vendor: { type: 'string' } }, invariants: ['date-parses'],
    }
    // Same value, keys built in a different order (as an independent party might serialize it).
    const b: AcceptanceSpec = {
      invariants: ['date-parses'], fields: { vendor: { type: 'string' }, total: { type: 'number' } }, service: 'invoice',
    } as AcceptanceSpec
    expect(specHash(a)).toBe(specHash(b))
    // A genuine value difference must still change the hash.
    expect(specHash(a)).not.toBe(specHash({ ...a, service: 'other' }))
  })
})

describe('extractInvoice (the honest fallback brain)', () => {
  it('reads quantities, totals, and identity fields from each fixture', () => {
    const a = extractInvoice(JOBS[0].document)
    expect(a.total).toBe(778.0)
    expect(a.currency).toBe('USD')
    expect(a.invoiceNo).toBe('NW-2026-114')
    const b = extractInvoice(JOBS[1].document)
    expect(b.total).toBe(775.5)
    expect(b.currency).toBe('EUR')
  })
})

describe('order binding', () => {
  it('binds reference to round + spec, detects mismatches', () => {
    const { reference, preimage } = bindOrder(3, INVOICE_SPEC, 12345)
    expect(referenceOf(preimage).toBase58()).toBe(reference.toBase58())
    expect(preimageMatches(preimage, 3, INVOICE_SPEC)).toBe(true)
    expect(preimageMatches(preimage, 4, INVOICE_SPEC)).toBe(false)
    expect(preimageMatches(preimage, 3, { ...INVOICE_SPEC, invariants: [] })).toBe(false)
  })

  it('omitting an input hash reproduces the legacy preimage byte-for-byte (recorded orders stay valid)', () => {
    // The input segment must be strictly additive: no input → the exact old format, same reference.
    const legacy = bindOrder(3, INVOICE_SPEC, 12345)
    expect(legacy.preimage).toBe(`verify:${INVOICE_SPEC.service}:round=3:spec=${specHash(INVOICE_SPEC)}:nonce=12345`)
    expect(inputOf(legacy.preimage)).toBeUndefined()
  })

  it('can commit to the task input, and the commitment is checkable + swap-proof', () => {
    const doc = 'INVOICE NW-2026-114 ... total 778.00 USD'
    const ih = hashInput(doc)
    const { preimage } = bindOrder(3, INVOICE_SPEC, 12345, ih)
    expect(inputOf(preimage)).toBe(ih)
    // The order now commits to THIS input: the right input matches, a different input does not.
    expect(preimageMatches(preimage, 3, INVOICE_SPEC, ih)).toBe(true)
    expect(preimageMatches(preimage, 3, INVOICE_SPEC, hashInput('a different invoice'))).toBe(false)
    // Round + spec still verify on their own (input check is opt-in for callers that have the input).
    expect(preimageMatches(preimage, 3, INVOICE_SPEC)).toBe(true)
  })
})

describe('protocol extensions', () => {
  it('round-trips DELIVER and VERDICT', () => {
    const d = { round: 2, reference: 'Ref111', by: 'atlas-extracts', payload: wrap({ ok: 1 }) }
    expect(parseDeliver(formatDeliver(d))).toEqual(d)
    const v = { round: 2, reference: 'Ref111', result: 'REJECTED' as const, reason: b64('total mismatch'), sig: 'sig123' }
    expect(parseVerdict(formatVerdict(v))).toEqual(v)
    expect(parseVerdict('BID round=1 price=0.01 by=x')).toBeNull()
  })

  it('parseDelivery guards shape', () => {
    expect(parseDelivery(wrap({ a: 1 }))).toEqual({ a: 1 })
    expect(parseDelivery(wrap('str'))).toBeNull()
  })
})

describe('mutual verifier consent (the seller must agree to the referee)', () => {
  it('accepts any verifier when the seller sets no allowlist (demo default, unchanged)', () => {
    expect(sellerAcceptsVerifier('AnyVerifierKey', undefined)).toBe(true)
    expect(sellerAcceptsVerifier('AnyVerifierKey', [])).toBe(true)
  })

  it('refuses an order named on a verifier the seller did not agree to', () => {
    const allow = ['GoodVerifier111', 'GoodVerifier222']
    expect(sellerAcceptsVerifier('GoodVerifier111', allow)).toBe(true)
    expect(sellerAcceptsVerifier('BuyerControlledVerifier', allow)).toBe(false)
  })

  it('formats a DECLINE the market can read', () => {
    const d = formatDecline(2, 'Ref111', 'atlas-extracts', 'verifier not accepted')
    expect(d.startsWith('DECLINE round=2 reference=Ref111 by=atlas-extracts reason=')).toBe(true)
  })
})

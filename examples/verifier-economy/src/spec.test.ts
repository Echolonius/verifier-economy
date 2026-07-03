import { describe, expect, it } from 'vitest'
import { judge, b64, parseDelivery } from './spec.js'
import { bindOrder, referenceOf, preimageMatches } from './reference.js'
import { formatDeliver, parseDeliver, formatVerdict, parseVerdict } from './protocol.js'
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

/**
 * The work being sold: invoice extraction. Three plain-text invoices (the kind of semi-structured
 * mess agents get paid to structure) and the acceptance spec a buyer attaches to each job. The
 * documents are demo fixtures; the spec is the product surface — swap both to sell any extraction.
 */
import type { AcceptanceSpec } from './spec.js'

export interface Job {
  docId: string
  document: string
}

export const INVOICE_SPEC: AcceptanceSpec = {
  service: 'invoice-extraction',
  fields: {
    vendor: { type: 'string' },
    invoiceNo: { type: 'string', pattern: '[A-Z0-9-]{4,}' },
    date: { type: 'string' },
    currency: { type: 'string', pattern: 'USD|EUR' },
    total: { type: 'number' },
  },
  itemFields: {
    description: { type: 'string' },
    amount: { type: 'number' },
  },
  invariants: ['items-nonempty', 'total-equals-item-sum', 'date-parses'],
}

export const JOBS: Job[] = [
  {
    docId: 'invoice-114',
    document: `NORTHWIND ROBOTICS  —  INVOICE
Invoice #: NW-2026-114        Date: 2026-06-12        Currency: USD
Bill to: Coral Harbor Labs

  1x  LIDAR calibration service ........... 420.00
  2x  Actuator gasket kit ................. 36.50 ea
  1x  Priority bench time (3h) ............ 285.00

                         TOTAL DUE:  778.00 USD
Terms: net 30. Wire only.`,
  },
  {
    docId: 'invoice-217',
    document: `— PELICAN FREIGHT SERVICES —
INV PF-88217 / issued 2026-05-30 (EUR)

Container drayage, pier 4 -> yard B          610.00
Chassis rental, 2 days @ 45.00                90.00
Overweight surcharge                          75.50
==============================================
AMOUNT DUE                                   775.50 EUR`,
  },
  {
    docId: 'invoice-309',
    document: `Studio Meridian / statement of charges
no. SM-309 | 2026-06-28 | USD

  brand sprint workshop ............ 1200.00
  revised deck (2 rounds) ...........  340.00
  font licensing pass-through .......   96.25

  balance due 1636.25`,
  },
]

export const jobById = (docId: string): Job | undefined => JOBS.find((j) => j.docId === docId)

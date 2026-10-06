import { z } from 'zod'
import { OptionalText } from './common.ts'

// ---------------------------------------------------------------------------
// Service orders (Doctor HERO final): the doctor orders a laboratory test, an imaging study or another service from inside the consultation.
// The list comes from configuration (config/adaxai.yaml `serviceOrders`). No laboratory or imaging system is connected: the only provider is a
// deterministic SIMULATOR, labelled as such wherever an order appears. It moves an order along on a fixed schedule from the time it was
// requested (requested -> in progress -> completed), never performs anything, never writes an investigation result and never invents a value:
// a completed simulated order carries only a sentence that says so.
// ---------------------------------------------------------------------------

export const ServiceCategory = z.enum(['lab', 'imaging', 'other'])
export type ServiceCategory = z.infer<typeof ServiceCategory>
export const SERVICE_CATEGORY_LABELS: Record<ServiceCategory, string> = { lab: 'Laboratory', imaging: 'Imaging', other: 'Other' }

export const ServiceOrderStatus = z.enum(['requested', 'in_progress', 'completed', 'cancelled'])
export type ServiceOrderStatus = z.infer<typeof ServiceOrderStatus>
export const SERVICE_ORDER_STATUS_LABELS: Record<ServiceOrderStatus, string> = { requested: 'Requested', in_progress: 'In progress', completed: 'Completed', cancelled: 'Cancelled' }
/** Orders that can still be cancelled. */
export const OPEN_SERVICE_ORDER_STATUSES: ServiceOrderStatus[] = ['requested', 'in_progress']
/** What the database allows (migration 0033, trigger service_order_guard). */
export const SERVICE_ORDER_TRANSITIONS: Record<ServiceOrderStatus, ServiceOrderStatus[]> = {
  requested: ['in_progress', 'cancelled'],
  in_progress: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
}

/** Who moved an order: the doctor (placed, cancelled) or a step of the simulated laboratory. Written by the database. */
export const ServiceOrderEventSource = z.enum(['doctor', 'simulated_lab'])
export type ServiceOrderEventSource = z.infer<typeof ServiceOrderEventSource>

/** The one provider there is. */
export const ServiceOrderProvider = z.enum(['simulated'])
export type ServiceOrderProvider = z.infer<typeof ServiceOrderProvider>

/** The report text of a completed simulated order, by category (the database accepts nothing else for a simulated order: it starts "Simulated "). */
export const SIMULATED_LAB_REPORT_TEXT = 'Simulated laboratory: no test was performed and no result values exist.'
export const SIMULATED_REPORT_TEXT: Record<ServiceCategory, string> = {
  lab: SIMULATED_LAB_REPORT_TEXT,
  imaging: 'Simulated imaging service: no study was performed and no images or findings exist.',
  other: 'Simulated service: nothing was performed and no results exist.',
}
/** The local mark shown with every simulated order (the shared SourceTag "simulated"). */
export const SIMULATED_ORDER_MARK = 'SIMULATED'

/** How a catalogue code reads (config and requests). */
export const SERVICE_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{1,39}$/

/** One entry of the catalogue (config/adaxai.yaml `serviceOrders.catalogue`). */
export const ServiceCatalogueEntry = z.object({
  code: z.string().regex(SERVICE_CODE_PATTERN, 'Upper-case letters, digits, - and _ (2 to 40)'),
  name: z.string().trim().min(1).max(120),
  category: ServiceCategory,
  /** The simulated provider's time from request to completion, in minutes. */
  turnaroundMinutes: z.number().int().min(1).max(10080),
})
export type ServiceCatalogueEntry = z.infer<typeof ServiceCatalogueEntry>

/** GET /api/service-catalogue */
export const ServiceCatalogue = z.object({
  provider: ServiceOrderProvider,
  /** True: every order goes to the simulator (always, until a real provider is connected). */
  simulated: z.boolean(),
  services: z.array(ServiceCatalogueEntry.extend({ simulated: z.boolean() })),
})
export type ServiceCatalogue = z.infer<typeof ServiceCatalogue>

/** POST /api/encounters/:id/service-orders */
export const CreateServiceOrderRequest = z.object({
  serviceCode: z.string().trim().regex(SERVICE_CODE_PATTERN, 'Choose a service from the list'),
  /** Instructions or the reason (optional). */
  note: OptionalText(500),
  /** A repeated "Send order" with the same key returns the same order instead of a second one. */
  idempotencyKey: z.uuid().optional(),
})
export type CreateServiceOrderRequest = z.input<typeof CreateServiceOrderRequest>

/** POST /api/service-orders/:id/cancel */
export const CancelServiceOrderRequest = z.object({ reason: OptionalText(200) })
export type CancelServiceOrderRequest = z.input<typeof CancelServiceOrderRequest>

export const ServiceOrderEvent = z.object({
  from: ServiceOrderStatus.nullable(),
  to: ServiceOrderStatus,
  source: ServiceOrderEventSource,
  actorName: z.string().nullable(),
  at: z.string(),
})
export type ServiceOrderEvent = z.infer<typeof ServiceOrderEvent>

export const ServiceOrder = z.object({
  id: z.uuid(),
  patientId: z.uuid(),
  encounterId: z.uuid(),
  visitId: z.uuid().nullable(),
  serviceCode: z.string(),
  serviceName: z.string(),
  category: ServiceCategory,
  note: z.string().nullable(),
  status: ServiceOrderStatus,
  provider: ServiceOrderProvider,
  /** Always shown with the SIMULATED mark when true. */
  simulated: z.boolean(),
  requestedAt: z.string(),
  statusChangedAt: z.string(),
  completedAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  cancelReason: z.string().nullable(),
  /** For a completed simulated order: the fixed sentence saying nothing was performed. Never a result. */
  reportText: z.string().nullable(),
  orderedByName: z.string().nullable(),
  /** The status history, oldest first (optional in lists). */
  events: z.array(ServiceOrderEvent).optional(),
  /** For the caller: whether they may cancel it now (they placed it and it is still requested or in progress). Set by the server. */
  canCancel: z.boolean().optional(),
})
export type ServiceOrder = z.infer<typeof ServiceOrder>

export const ServiceOrderList = z.object({ orders: z.array(ServiceOrder) })
export type ServiceOrderList = z.infer<typeof ServiceOrderList>

/** Whether an order can still be cancelled (requested or in progress). */
export const isOpenServiceOrder = (status: ServiceOrderStatus): boolean => OPEN_SERVICE_ORDER_STATUSES.includes(status)

/**
 * The simulated provider's fixed schedule for an order: in progress `inProgressAfterMinutes` after the request, completed `turnaroundMinutes`
 * after the request (never before it is in progress). Deterministic: the same order always has the same schedule.
 */
export function simulatedOrderSchedule(o: { requestedAt: string | Date; turnaroundMinutes: number }, inProgressAfterMinutes = 1): { inProgressAt: Date; completedAt: Date } {
  const start = new Date(o.requestedAt).getTime()
  const inProgressAt = new Date(start + inProgressAfterMinutes * 60_000)
  const completedAt = new Date(Math.max(start + o.turnaroundMinutes * 60_000, inProgressAt.getTime()))
  return { inProgressAt, completedAt }
}

/** Where the schedule says an open simulated order is at `now` (a cancelled order stays cancelled, a completed one completed). */
export function simulatedOrderStatusAt(o: { status: ServiceOrderStatus; requestedAt: string | Date; turnaroundMinutes: number }, now: Date | number, inProgressAfterMinutes = 1): ServiceOrderStatus {
  if (o.status === 'cancelled' || o.status === 'completed') return o.status
  const t = typeof now === 'number' ? now : now.getTime()
  const s = simulatedOrderSchedule(o, inProgressAfterMinutes)
  if (t >= s.completedAt.getTime()) return 'completed'
  if (t >= s.inProgressAt.getTime()) return 'in_progress'
  return 'requested'
}

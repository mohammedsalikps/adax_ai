import {
  type CancelServiceOrderRequest,
  type CreateServiceOrderRequest,
  isOpenServiceOrder,
  SERVICE_CATEGORY_LABELS,
  SERVICE_ORDER_STATUS_LABELS,
  type ServiceCatalogue,
  type ServiceCategory,
  type ServiceOrder,
  type ServiceOrderList,
  type ServiceOrderStatus,
} from '@adaxai/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { HeroStatus } from '../components/hero/spec.ts'
import { api } from './api.ts'

/**
 * Service orders in the doctor's app (DESIGN §5.4 Orders, §5.6, spec 17C-17E): the configured catalogue, a consultation's or a patient's
 * orders, ordering and cancelling. No laboratory is connected: every order goes to the simulated lab, and the screen says so next to it.
 * The pure parts (grouping, words, the polling rule) are unit-tested in node (test/serviceOrders.test.ts).
 */

/** How often an open order's status is read again (the simulated lab moves it on a schedule; nothing changes faster than that). */
export const SERVICE_ORDERS_POLL_MS = 30_000

export const serviceOrdersRoot = ['service-orders'] as const
export const serviceCatalogueKey = ['service-catalogue'] as const
/** One consultation's orders, or (without an encounter) every order of the patient. */
export const serviceOrdersKey = (scope: { encounterId?: string | undefined; patientId: string }) =>
  scope.encounterId ? ([...serviceOrdersRoot, 'encounter', scope.encounterId] as const) : ([...serviceOrdersRoot, 'patient', scope.patientId] as const)

/** The catalogue's services in the design's order of categories (Laboratory, Imaging, Other), each in the configured order; empty ones left out. */
export interface CatalogueGroup {
  category: ServiceCategory
  label: string
  services: ServiceCatalogue['services']
}
const CATEGORY_ORDER: ServiceCategory[] = ['lab', 'imaging', 'other']
export function groupCatalogue(services: ServiceCatalogue['services']): CatalogueGroup[] {
  return CATEGORY_ORDER.map((category) => ({ category, label: SERVICE_CATEGORY_LABELS[category], services: services.filter((s) => s.category === category) })).filter((g) => g.services.length > 0)
}

/**
 * The words and the pill of an order's status: Requested · In progress · Completed · Cancelled, drawn with the shared StatusPill tones
 * (requested waits like Waiting, in progress like In consultation, completed ok, cancelled neutral). The word is always shown: never colour alone.
 */
export function orderStatusPill(status: ServiceOrderStatus): { status: HeroStatus; label: string } {
  const pill: Record<ServiceOrderStatus, HeroStatus> = { requested: 'waiting', in_progress: 'in_consultation', completed: 'completed', cancelled: 'cancelled' }
  return { status: pill[status], label: SERVICE_ORDER_STATUS_LABELS[status] }
}

/** When the order was placed and, once it moved, when its current status began ("Requested 10:42 · completed 11:12"). */
export function orderTimeline(o: Pick<ServiceOrder, 'status' | 'requestedAt' | 'statusChangedAt'>, time: (iso: string) => string): string {
  const placed = `Requested ${time(o.requestedAt)}`
  if (o.status === 'requested') return placed
  const since = o.status === 'in_progress' ? 'in progress since' : SERVICE_ORDER_STATUS_LABELS[o.status].toLowerCase()
  return `${placed} · ${since} ${time(o.statusChangedAt)}`
}

/** Polling: every 30 s only while an order is still open (requested or in progress); nothing to wait for, no polling. */
export function ordersPollInterval(orders: readonly Pick<ServiceOrder, 'status'>[] | undefined): number | false {
  return orders?.some((o) => isOpenServiceOrder(o.status)) ? SERVICE_ORDERS_POLL_MS : false
}

/**
 * What a list of orders shows. Loading until the first answer; a failed first load is an error with a retry; once orders were read they stay
 * on screen (with their Cancel buttons), and a later read that fails (a poll, a refetch on focus: TanStack Query keeps the last data with
 * status 'error') only adds that they may be out of date.
 */
export type OrdersListView<T> = { kind: 'loading' } | { kind: 'failed' } | { kind: 'ready'; data: T; stale: boolean }
export function ordersListView<T>(q: { isError: boolean; data: T | undefined }): OrdersListView<T> {
  if (q.data !== undefined) return { kind: 'ready', data: q.data, stale: q.isError }
  return q.isError ? { kind: 'failed' } : { kind: 'loading' }
}

/** The empty state of a list: missing is said as missing, for what the list covers. */
export const noOrdersText = (scope: { encounterId?: string | undefined }) => (scope.encounterId ? 'No orders for this consultation' : 'No orders for this patient')

/** A new key for one "Send order": a repeat with the same key (a double tap, a retry) returns the order already made. */
export const newOrderKey = (): string => crypto.randomUUID()

export function useServiceCatalogue(enabled = true) {
  return useQuery({ queryKey: serviceCatalogueKey, queryFn: () => api<ServiceCatalogue>('/service-catalogue'), enabled, staleTime: 5 * 60_000 })
}

/** A consultation's orders (with `encounterId`) or the patient's; read again every 30 s while one is open, never in the background. */
export function useServiceOrders(scope: { encounterId?: string | undefined; patientId: string }) {
  const path = scope.encounterId ? `/encounters/${scope.encounterId}/service-orders` : `/patients/${scope.patientId}/service-orders`
  return useQuery({
    queryKey: serviceOrdersKey(scope),
    queryFn: () => api<ServiceOrderList>(path),
    refetchInterval: (q) => ordersPollInterval(q.state.data?.orders),
    refetchIntervalInBackground: false,
    staleTime: 10_000,
  })
}

export function useCreateServiceOrder(encounterId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: CreateServiceOrderRequest) => api<ServiceOrder>(`/encounters/${encounterId}/service-orders`, { method: 'POST', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: serviceOrdersRoot }),
  })
}

export function useCancelServiceOrder() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { orderId: string; body: CancelServiceOrderRequest }) => api<ServiceOrder>(`/service-orders/${v.orderId}/cancel`, { method: 'POST', body: v.body }),
    // Also after a refusal (the lab completed it meanwhile): the list shows how the order stands now.
    onSettled: () => qc.invalidateQueries({ queryKey: serviceOrdersRoot }),
  })
}

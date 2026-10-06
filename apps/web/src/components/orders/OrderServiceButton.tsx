import { Check, FlaskConical } from 'lucide-react'
import { useId, useRef, useState } from 'react'
import { errorMessage, issuesToErrors } from '../../lib/api.ts'
import { groupCatalogue, newOrderKey, useCreateServiceOrder, useServiceCatalogue } from '../../lib/serviceOrders.ts'
import { SECTION_LABEL } from '../hero/Panel.tsx'
import { Sheet } from '../hero/Sheet.tsx'
import { SourceTag } from '../hero/SourceTag.tsx'
import { Button } from '../ui/Button.tsx'
import { Alert, LoadingState } from '../ui/Feedback.tsx'
import { TextAreaField } from '../ui/Form.tsx'
import { useToast } from '../ui/Toast.tsx'

/** Props of the Order service action (DESIGN §5.4 bottom bar and Orders, §5.6, §7). */
export interface OrderServiceButtonProps {
  encounterId: string
  patientId: string
  /** `secondary` (default) in the consultation's bottom bar; `primary` where ordering is the area's one main action. */
  variant?: 'primary' | 'secondary'
}

/**
 * [Order service]: select a service from the configured catalogue, an optional note, [Send order] — without leaving the consultation
 * (`POST /api/encounters/:id/service-orders`): three clicks. The only provider is the deterministic simulated lab, marked SIMULATED in the
 * dialog and on every order. The consultation must be the doctor's own and in progress (the API refuses otherwise and the dialog says why).
 * Every list of orders (ServiceOrdersList) is refreshed when an order is sent.
 */
export function OrderServiceButton({ encounterId, variant = 'secondary' }: OrderServiceButtonProps) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button variant={variant} icon={<FlaskConical aria-hidden="true" className="size-4" />} onClick={() => setOpen(true)} data-testid="order-service">
        Order service
      </Button>
      {/* Mounted only while open: a new order key and an empty form each time. */}
      {open && <OrderServiceDialog encounterId={encounterId} onClose={() => setOpen(false)} />}
    </>
  )
}

function OrderServiceDialog({ encounterId, onClose }: { encounterId: string; onClose: () => void }) {
  const catalogue = useServiceCatalogue()
  const create = useCreateServiceOrder(encounterId)
  const toast = useToast()
  const [code, setCode] = useState<string | null>(null)
  const [note, setNote] = useState('')
  // One key per order being sent: kept across a double tap or a retry of the same order, renewed when what is ordered changes.
  const key = useRef(newOrderKey())
  const changed = () => {
    if (create.isPending) return
    key.current = newOrderKey()
    if (!create.isIdle) create.reset()
  }
  const formId = useId()
  const groups = groupCatalogue(catalogue.data?.services ?? [])
  const chosen = catalogue.data?.services.find((s) => s.code === code)
  const fieldErrors = issuesToErrors(create.error)
  const close = () => {
    if (!create.isPending) onClose()
  }

  const send = () => {
    if (!chosen || create.isPending) return
    create.mutate(
      { serviceCode: chosen.code, note: note.trim() || null, idempotencyKey: key.current },
      {
        onSuccess: (o) => {
          toast('success', `Order sent · ${o.serviceName}`)
          onClose()
        },
      },
    )
  }

  return (
    <Sheet
      open
      onClose={close}
      dismissible={!create.isPending}
      title="Order service"
      placement="center"
      testId="order-service-dialog"
      footer={
        <>
          <Button variant="secondary" disabled={create.isPending} onClick={close}>
            Cancel
          </Button>
          <Button type="submit" form={formId} disabled={!chosen} loading={create.isPending} data-testid="send-order">
            Send order
          </Button>
        </>
      }
    >
      <form
        id={formId}
        noValidate
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          send()
        }}
      >
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink-muted">
          <SourceTag kind="simulated" testId="simulated-lab-mark" />
          <span>Simulated lab · no laboratory is connected, nothing is performed</span>
        </p>
        {catalogue.isPending ? (
          <LoadingState label="Loading the services…" rows={2} />
        ) : catalogue.isError ? (
          <Alert tone="error" title="The services could not be loaded">
            <span className="flex flex-wrap items-center gap-3">
              {errorMessage(catalogue.error)}
              <Button size="sm" variant="secondary" loading={catalogue.isFetching} onClick={() => void catalogue.refetch()}>
                Try again
              </Button>
            </span>
          </Alert>
        ) : groups.length === 0 ? (
          <p className="text-sm text-ink-muted">No services are configured.</p>
        ) : (
          groups.map((g) => (
            <fieldset key={g.category} className="min-w-0">
              <legend className={`mb-2 ${SECTION_LABEL}`}>{g.label}</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {g.services.map((s) => {
                  const selected = s.code === code
                  return (
                    <label
                      key={s.code}
                      className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors motion-safe:duration-150 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-brand ${selected ? 'border-brand bg-brand-soft font-medium text-brand-strong' : 'border-line bg-surface hover:bg-canvas'}`}
                    >
                      <input
                        type="radio"
                        name="service"
                        value={s.code}
                        checked={selected}
                        onChange={() => {
                          setCode(s.code)
                          changed()
                        }}
                        className="sr-only"
                      />
                      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{s.name}</span>
                      {selected && <Check aria-hidden="true" className="size-4 shrink-0" />}
                    </label>
                  )
                })}
              </div>
            </fieldset>
          ))
        )}
        <TextAreaField
          label="Note (optional)"
          placeholder="Reason or instructions"
          rows={2}
          maxLength={500}
          value={note}
          onChange={(e) => {
            setNote(e.target.value)
            changed()
          }}
          error={fieldErrors.note}
        />
        {create.isError && !fieldErrors.note && <Alert tone="error">{fieldErrors.serviceCode ?? errorMessage(create.error)}</Alert>}
      </form>
    </Sheet>
  )
}

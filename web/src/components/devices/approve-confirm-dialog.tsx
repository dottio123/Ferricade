import type { components } from '@/api/schema'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { deviceName } from '@/lib/device'

type Device = components['schemas']['Device']

export function ApproveConfirmDialog({
  devices,
  onCancel,
  onApprove,
  busy = false,
}: {
  devices: Device[]
  onCancel: () => void
  onApprove: () => void
  busy?: boolean
}) {
  return (
    <Dialog
      open={devices.length > 0}
      onOpenChange={(open) => {
        if (!open && !busy) onCancel()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Approve {devices.length} devices?</DialogTitle>
          <DialogDescription>
            They can be connected to as soon as they are approved.
          </DialogDescription>
        </DialogHeader>
        <ul className="max-h-48 overflow-auto text-sm list-disc pl-5">
          {devices.slice(0, 10).map((device) => (
            <li key={device.id}>{deviceName(device)}</li>
          ))}
        </ul>
        {devices.length > 10 && (
          <p className="text-sm text-muted-foreground">and {devices.length - 10} more</p>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" autoFocus disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
          <Button type="button" disabled={busy} onClick={onApprove}>
            Approve {devices.length}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

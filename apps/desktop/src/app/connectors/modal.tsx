import { useStore } from '@nanostores/react'

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useI18n } from '@/i18n'
import { Plug } from '@/lib/icons'

import { ConnectorsPanel } from './panel'
import { $connectorsOpen, closeConnectors } from './store'

export function ConnectorsModal() {
  const { t } = useI18n()
  const open = useStore($connectorsOpen)

  return (
    <Dialog onOpenChange={next => !next && closeConnectors()} open={open}>
      <DialogContent bodyClassName="gap-3" className="w-[min(35rem,94vw)] max-w-none" data-testid="connectors-modal">
        <DialogHeader>
          <DialogTitle icon={Plug}>{t.connectors.title}</DialogTitle>
          <DialogDescription>{t.connectors.subtitle}</DialogDescription>
        </DialogHeader>
        <ConnectorsPanel active={open} />
      </DialogContent>
    </Dialog>
  )
}

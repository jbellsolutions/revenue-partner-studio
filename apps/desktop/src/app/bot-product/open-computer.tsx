import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog'

export function OpenComputerButton() {
  const [open,setOpen]=useState(false)
  const [id,setId]=useState('')
  const [key,setKey]=useState('')
  const [busy,setBusy]=useState(false)
  const [error,setError]=useState('')
  const submit=async()=>{
    setBusy(true);setError('')
    try {
      const api=window.hermesDesktop?.orgoDesktop
      if(!api?.openComputer) throw new Error('Opening another computer requires the installed Studio app.')
      await api.openComputer({computerId:id.trim(),...(key.trim()?{apiKey:key.trim()}:{})})
      setKey('');setId('');setOpen(false)
      window.dispatchEvent(new Event('studio:computers-changed'))
    } catch(e) {setError(e instanceof Error?e.message:String(e))}
    finally {setBusy(false)}
  }
  return <>
    <Button type="button" variant="outline" size="sm" onClick={()=>{setError('');setOpen(true)}}>Open another computer</Button>
    <Dialog open={open} onOpenChange={value=>{if(!busy){setOpen(value);if(!value)setKey('')}}}>
      <DialogContent className="max-w-md">
        <DialogTitle>Open another computer</DialogTitle>
        <DialogDescription>Each computer opens in its own window with separate settings and conversations. Your current workspace stays open.</DialogDescription>
        <form className="grid gap-4" onSubmit={event=>{event.preventDefault();void submit()}}>
          <label className="grid gap-2 text-sm">Computer ID
            <Input autoFocus value={id} onChange={event=>setId(event.target.value)} placeholder="Orgo computer ID" disabled={busy} />
          </label>
          <label className="grid gap-2 text-sm">Orgo API key (optional)
            <Input type="password" autoComplete="off" value={key} onChange={event=>setKey(event.target.value)} placeholder="Use this window’s saved key" disabled={busy} />
          </label>
          <p className="text-xs leading-relaxed text-muted-foreground">Compatible Hermes computers open with chats, workspace settings and the computer panel. Existing histories remain on their own computer.</p>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <Button type="submit" disabled={busy || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id.trim())}>{busy?'Checking computer…':'Open computer window'}</Button>
        </form>
      </DialogContent>
    </Dialog>
  </>
}

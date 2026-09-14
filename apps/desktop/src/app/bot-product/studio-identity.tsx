import { requestOrgoDesktopSettings } from '@/app/right-sidebar/store'
import BRAND from '../../../../../brand/product.json'
import { Button } from '@/components/ui/button'

export function StudioBrand({ connected }: { connected: boolean }) {
  return <header className="studio-brand">
    <img src="./studio-icon.png" alt="" className="studio-brand-icon" />
    <div><h1>{BRAND.name}<span>{BRAND.byline}</span></h1>
      <p className="studio-connection-label"><i data-connected={connected} />{connected ? 'Connected to Orgo' : 'Waiting for connection'}</p>
    </div>
  </header>
}

export function StudioConnectionEmpty() {
  return <section className="studio-connection-empty" aria-label="Remote workspace connection">
    <img src="./studio-icon.png" alt="" />
    <p className="studio-eyebrow">REMOTE WORKSPACE</p>
    <h2>Your workspace is on Orgo.</h2>
    <p>Connect to see your agents, conversations,<br />and the work happening on their screens.</p>
    <Button variant="outline" onClick={requestOrgoDesktopSettings}>Connection settings <span aria-hidden="true">↗</span></Button>
    <span className="studio-empty-note">Hermes runtime · Dedicated computer</span>
  </section>
}

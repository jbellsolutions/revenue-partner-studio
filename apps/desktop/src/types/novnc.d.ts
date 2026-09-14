declare module '@novnc/novnc' {
  interface RfbCredentials {
    password?: string
    target?: string
    username?: string
  }

  interface RfbOptions {
    credentials?: RfbCredentials
    repeaterID?: string
    shared?: boolean
    wsProtocols?: string[]
  }

  interface RfbConnectEvent extends Event {
    detail?: Record<string, unknown>
  }

  interface RfbDisconnectEvent extends Event {
    detail?: { clean?: boolean }
  }

  interface RfbClipboardEvent extends Event {
    detail?: { text?: string }
  }

  interface RfbCredentialsRequiredEvent extends Event {
    detail?: { types?: string[] }
  }

  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, urlOrChannel: string | WebSocket | RTCDataChannel, options?: RfbOptions)

    background: string
    clipViewport: boolean
    compressionLevel: number
    dragViewport: boolean
    focusOnClick: boolean
    qualityLevel: number
    resizeSession: boolean
    scaleViewport: boolean
    viewOnly: boolean

    blur(): void
    clipboardPasteFrom(text: string): void
    disconnect(): void
    focus(options?: FocusOptions): void
    sendCredentials(credentials: RfbCredentials): void
    sendCtrlAltDel(): void
  }
}

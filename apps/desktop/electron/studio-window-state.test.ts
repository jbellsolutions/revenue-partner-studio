import { expect, it } from 'vitest'
import { studioRestoredWindowState } from './studio-window-state'
const displays = [{workArea: {x: 0, y: 25, width: 2560, height: 1357}}]
it('recovers the reported almost-full-display geometry into a normal resizable window', () => {
  expect(studioRestoredWindowState({x:0,y:25,width:2540,height:1337,isMaximized:false}, displays)).toEqual({width:1220,height:800,isMaximized:false})
  expect(studioRestoredWindowState({width:2560,height:1357,isMaximized:true}, displays)?.isMaximized).toBe(false)
})
it('keeps ordinary user placement and caps the reset to a smaller display', () => {
  const ordinary = {x:80,y:80,width:1000,height:700,isMaximized:false}
  expect(studioRestoredWindowState(ordinary, displays)).toEqual(ordinary)
  expect(studioRestoredWindowState({...ordinary,isMaximized:true}, [{workArea:{width:1100,height:750}}])).toEqual({width:1100,height:750,isMaximized:false})
})

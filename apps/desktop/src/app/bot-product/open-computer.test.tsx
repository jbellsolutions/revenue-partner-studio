import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { it, expect, vi } from 'vitest'
import { OpenComputerButton } from './open-computer'
const id='22222222-2222-4222-8222-222222222222'
it('opens another computer using the current key without sending a replacement key',async()=>{
 const openComputer=vi.fn().mockResolvedValue({opened:true,mode:'desktop'})
 Object.defineProperty(window,'hermesDesktop',{configurable:true,value:{orgoDesktop:{openComputer}}})
 render(<OpenComputerButton />)
 fireEvent.click(screen.getByRole('button',{name:'Open another computer'}))
 expect((screen.getByRole('button',{name:'Open computer window'}) as HTMLButtonElement).disabled).toBe(true)
 fireEvent.change(screen.getByLabelText('Computer ID'),{target:{value:id}})
 fireEvent.click(screen.getByRole('button',{name:'Open computer window'}))
 await waitFor(()=>expect(openComputer).toHaveBeenCalledWith({computerId:id}))
 await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull())
})
it('keeps an actionable error without rebinding the current window',async()=>{
 const openComputer=vi.fn().mockRejectedValue(new Error('Computer not found'))
 Object.defineProperty(window,'hermesDesktop',{configurable:true,value:{orgoDesktop:{openComputer}}})
 render(<OpenComputerButton />);fireEvent.click(screen.getByRole('button',{name:'Open another computer'}))
 fireEvent.change(screen.getByLabelText('Computer ID'),{target:{value:id}})
 fireEvent.click(screen.getByRole('button',{name:'Open computer window'}))
 expect((await screen.findByRole('alert')).textContent).toContain('Computer not found')
 expect((screen.getByLabelText('Computer ID') as HTMLInputElement).value).toBe(id)
})

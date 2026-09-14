import {expect,it,vi} from 'vitest'
import {connectExistingHermes,existingHermesInspection} from './hermes-existing-connection'
const id='22222222-2222-4222-8222-222222222222'
const fixture=(over={})=>({computerId:id,ssh:{exec:vi.fn().mockResolvedValue(JSON.stringify({computerId:id,port:41234,token:'a'.repeat(43),version:'0.18',hermesPath:'/existing/python',...over})),forward:vi.fn(),cancelForward:vi.fn()},pickLocalPort:vi.fn().mockResolvedValue(42000),waitForHermes:vi.fn()})
it('attaches an existing service without owning or changing its lifetime',async()=>{
 const d=fixture();const r=await connectExistingHermes(d)
 expect(r.reused).toBe(true);expect(r.pid).toBeNull()
 expect(d.ssh.forward).toHaveBeenCalledWith(42000,41234)
 expect(d.ssh.exec.mock.calls[0][0]).not.toMatch(/nohup|kill|supervisorctl|pip install|write_text/)
 expect(existingHermesInspection(id)).toContain('orgo-computer/computer.json')
})
it.each([{computerId:'wrong'},{port:22},{token:''},{port:'41234'}])('fails before forwarding invalid identity %j',async value=>{
 const d=fixture(value);await expect(connectExistingHermes(d)).rejects.toThrow('identity');expect(d.ssh.forward).not.toHaveBeenCalled()
})
it('cancels only its forward if readiness fails',async()=>{
 const d=fixture();d.waitForHermes.mockRejectedValue(new Error('offline'))
 await expect(connectExistingHermes(d)).rejects.toThrow('offline')
 expect(d.ssh.cancelForward).toHaveBeenCalledWith(42000,41234)
})

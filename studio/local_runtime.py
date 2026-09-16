"""Load the compatible Studio extension around the installed native Hermes.

The native source and credentials are not copied or rewritten. This entrypoint
uses the installed Hermes Python and API contract, with a private Studio queue.
"""
import argparse
import importlib.util
import os
from pathlib import Path
import sys


def protect_dispatch(server):
    """Keep extension work off the native transport reader, including on Macs."""
    if not hasattr(server, '_LONG_HANDLERS'):
        raise RuntimeError('This Hermes version lacks compatible background RPC dispatch.')
    server._LONG_HANDLERS = frozenset(server._LONG_HANDLERS) | {
        'studio.operation', 'studio.snapshot', 'studio.a2a', 'studio.events',
        'session.create', 'session.resume', 'session.list', 'session.activate', 'studio.sessions.recover', 'studio.session.bind',
    }

def prepare(native):
    native=Path(native).resolve()
    if not (native/'tui_gateway/server.py').is_file():raise RuntimeError('The installed Hermes runtime could not be found.')
    sys.path.insert(0,str(native))
    import tui_gateway.server as server
    required={'session.create','session.resume','session.list','session.activate','prompt.submit','session.interrupt','profiles.create'}
    missing=required-set(server._methods)
    if missing:raise RuntimeError('This Hermes version lacks required Studio operations: '+', '.join(sorted(missing)))
    protect_dispatch(server)
    import toolsets
    toolsets.TOOLSETS['studio']={'description':'Persistent Studio teammates and conversation recall','tools':['studio_team','studio_history'],'includes':[]}
    original=server._gui_surface_toolsets
    server._gui_surface_toolsets=lambda platform:{'studio'} if platform=='studio' else original(platform)
    from .service import register
    register(server)
    # Stopping access from the Mac also interrupts Studio's active turns. This
    # process owns only its Studio sessions, never other native Hermes services.
    import threading,time
    from hermes_cli.config import get_hermes_home
    def watch_stop():
        was_stopped=False
        while True:
            stopped=(Path(get_hermes_home())/'studio-cloud/access-paused').exists()
            if stopped and not was_stopped:
                for runtime in list(server._sessions):
                    try:server._methods['session.interrupt']('local-stop',{'session_id':runtime})
                    except Exception:pass
            was_stopped=stopped;time.sleep(0.5)
    threading.Thread(target=watch_stop,daemon=True,name='studio-local-stop').start()
    # Register only the Studio tool; use native Hermes for all other tools.
    script=Path(__file__).resolve().parent.parent/'tools/studio_tools.py'
    spec=importlib.util.spec_from_file_location('studio.native_team_tool',script)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return server

def main():
    p=argparse.ArgumentParser();p.add_argument('--native',required=True);p.add_argument('--port',type=int,default=8791);p.add_argument('--check',action='store_true')
    args=p.parse_args()
    os.environ['HERMES_STUDIO_RUNTIME']='1';os.environ['STUDIO_COMPUTER_KIND']='local'
    import faulthandler
    faulthandler.dump_traceback_later(20)
    server=prepare(args.native)
    if args.check:
        import json
        from .service import current
        current().snapshot()
        faulthandler.cancel_dump_traceback_later()
        print(json.dumps({'compatible':True,'methods':sorted(m for m in server._methods if m.startswith('studio.'))}))
        return
    from hermes_cli import web_server
    # A private stack trace makes startup stalls diagnosable without touching
    # native Hermes files or dumping profile settings/credentials.
    original_started = web_server._on_server_started
    def started(*a, **kw):
        result = original_started(*a, **kw)
        faulthandler.cancel_dump_traceback_later()
        return result
    web_server._on_server_started = started
    web_server.start_server(host='127.0.0.1',port=args.port,open_browser=False,headless=True)

if __name__=='__main__':main()

"""Load the compatible Studio extension around the installed native Hermes.

The native source and credentials are not copied or rewritten. This entrypoint
uses the installed Hermes Python and API contract, with a private Studio queue.
"""
import argparse
import importlib.util
import os
from pathlib import Path
import sys

def prepare(native):
    native=Path(native).resolve()
    if not (native/'tui_gateway/server.py').is_file():raise RuntimeError('The installed Hermes runtime could not be found.')
    sys.path.insert(0,str(native))
    import tui_gateway.server as server
    required={'session.create','session.resume','session.list','prompt.submit','session.interrupt','profiles.create'}
    missing=required-set(server._methods)
    if missing:raise RuntimeError('This Hermes version lacks required Studio operations: '+', '.join(sorted(missing)))
    import toolsets
    toolsets.TOOLSETS['studio']={'description':'Persistent Studio teammates','tools':['studio_team'],'includes':[]}
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
    server=prepare(args.native)
    if args.check:
        import json
        from .service import current
        current().snapshot()
        print(json.dumps({'compatible':True,'methods':sorted(m for m in server._methods if m.startswith('studio.'))}))
        return
    from hermes_cli.web_server import start_server
    start_server(host='127.0.0.1',port=args.port,open_browser=False,headless=True)

if __name__=='__main__':main()

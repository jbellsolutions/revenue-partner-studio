"""Read private credentials inside the supervised process, never its arguments."""
import json
import os
from pathlib import Path
import sys

config=json.loads(Path(sys.argv[1]).read_text())
os.environ.update({'HERMES_HOME':config['hermesHome'],'PYTHONPATH':config['sourceDir'],'STUDIO_COMPUTER_KIND':'local','STUDIO_COMPUTER_ID':config['computerId'],'HERMES_STUDIO_RUNTIME':'1'})
sys.path.insert(0,config['sourceDir'])
if sys.argv[2]=='runtime':
    os.environ['HERMES_DASHBOARD_SESSION_TOKEN']=Path(config['hermesTokenFile']).read_text().strip()
    sys.argv=[sys.argv[0],'--native',config['nativeSource'],'--port',str(config['port'])]
    from studio.local_runtime import main
else:
    sys.argv=[sys.argv[0],'--config',sys.argv[1]]
    from studio.cloud_connector import main
main()

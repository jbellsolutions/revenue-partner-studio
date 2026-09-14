"""Inspect/control the existing dedicated Studio service without owning its lifetime."""
import argparse
import json
from pathlib import Path
import sys
from websockets.sync.client import connect


def main():
    if sys.platform != 'linux':
        raise RuntimeError('This helper runs only on the dedicated Orgo host')
    binding = json.loads(Path('/root/.hermes/orgo-computer/computer.json').read_text())
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('method')
    parser.add_argument('params', nargs='?', default='{}')
    parser.add_argument('--computer-id', required=True, help='Expected installation computer UUID')
    args = parser.parse_args()
    if binding['computerId'] != args.computer_id:
        raise RuntimeError('Wrong computer')
    token = Path('/root/.hermes/studio/gateway-token').read_text().strip()
    with connect(f'ws://127.0.0.1:8787/api/ws?token={token}', max_size=None,
                 additional_headers={'Origin':'http://127.0.0.1:8787'}) as ws:
        ws.send(json.dumps({'jsonrpc':'2.0','id':'studio-rpc','method':args.method,'params':json.loads(args.params)}))
        while True:
            reply = json.loads(ws.recv(timeout=90))
            if reply.get('id') == 'studio-rpc':
                print(json.dumps(reply, ensure_ascii=False))
                if 'error' in reply:
                    raise SystemExit(1)
                return


if __name__ == '__main__':
    main()

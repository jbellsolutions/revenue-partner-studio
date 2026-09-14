"""Resolve only Orgo's credential on the cloud host, including named profiles."""
import os
from dotenv import dotenv_values
from hermes_cli.orgo_screens import verify_binding


def main():
    verify_binding()
    key = os.environ.get('ORGO_API_KEY', '')
    if not key or key.startswith('${env:'):
        key = dotenv_values('/root/.hermes/.env').get('ORGO_API_KEY', '')
    if not key:
        raise RuntimeError('The bound cloud computer has no Orgo credential configured')
    binary = '/root/.hermes/codex-worker/node_modules/.bin/orgo-mcp-server'
    os.execve(binary, [binary], {**os.environ, 'ORGO_API_KEY': key})


if __name__ == '__main__':
    main()

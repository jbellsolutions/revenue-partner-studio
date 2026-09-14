"""Read the selected Orgo host's own desktop credential; never log it."""
import ctypes
import ctypes.util
import json
import os
from pathlib import Path
import sys

config=json.loads(Path(sys.argv[1]).read_text())
if len(sys.argv) > 2 and sys.argv[2] not in {'status','capacity','hold','drop','cancel'}:
    source=Path('/tmp/.vncpasswd').read_bytes()[:8]
    if len(source)!=8:raise RuntimeError('Computer desktop credential unavailable')
    lib=ctypes.CDLL(ctypes.util.find_library('crypto') or 'libcrypto.so.3')
    key=(ctypes.c_ubyte*8)(*bytes.fromhex('e84ad660c4721ae0'));data=(ctypes.c_ubyte*8)(*source);out=(ctypes.c_ubyte*8)();ks=(ctypes.c_ubyte*256)()
    lib.DES_set_key_unchecked(ctypes.byref(key),ctypes.byref(ks))
    lib.DES_ecb_encrypt(ctypes.byref(data),ctypes.byref(out),ctypes.byref(ks),0)
    p=Path(config['screenPasswordFile']);p.write_bytes(bytes(out).split(bytes([0]))[0]);p.chmod(0o600)
os.environ.update({'PYTHONPATH':config['sourceDir'],'HERMES_HOME':config['hermesHome'],'ORGO_DEFAULT_COMPUTER_ID':config['computerId']})
os.execv(config['python'],[config['python'],'-m','hermes_cli.orgo_screens',*sys.argv[2:]])

"""Resumable, conversation-owned attachments stored only on the Orgo host."""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import zipfile

CHUNK = 512 * 1024
MAX_FILE = 25 * 1024 * 1024
MAX_MESSAGE = 100 * 1024 * 1024
EXTENSIONS = {'.png', '.jpg', '.jpeg', '.webp', '.pdf', '.txt', '.md', '.csv', '.tsv', '.json', '.docx', '.xlsx'}
IMAGES = {'.png', '.jpg', '.jpeg', '.webp'}


class Files:
    def __init__(self, home, computer, agent, conversation):
        self.home = Path(home)
        self.owner = {'computerId': computer, 'agentId': agent, 'sessionId': conversation}
        if not isinstance(conversation, str) or not conversation or len(conversation) > 200:
            raise ValueError('Open a conversation before attaching files')
        self.root = self.home / 'attachments' / 'studio'
        if self.root.resolve() != self.root:
            raise ValueError('Attachment directory must not be a symbolic link')
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)

    def folder(self, identity):
        if not isinstance(identity, str) or not re.fullmatch('[a-f0-9]{64}', identity):
            raise ValueError('Invalid attachment identity')
        path = self.root / identity
        if path.resolve() != path:
            raise ValueError('Attachment path must not be a symbolic link')
        return path

    def metadata(self, identity):
        path = self.folder(identity) / 'metadata.json'
        if path.is_symlink() or not path.is_file():
            raise ValueError('Attachment is unavailable on this computer')
        value = json.loads(path.read_text())
        if any(value.get(k) != v for k, v in self.owner.items()):
            raise ValueError('Attachment belongs to another computer, agent or conversation')
        return value

    def save(self, value):
        folder = self.folder(value['id'])
        temp = folder / 'metadata.tmp'
        temp.write_text(json.dumps(value)); temp.chmod(0o600)
        temp.replace(folder / 'metadata.json')

    def path(self, value):
        path = self.folder(value['id']) / ('file-' + value['name'])
        if path.parent != self.folder(value['id']) or path.resolve() != path:
            raise ValueError('Invalid attachment path')
        return path

    def begin(self, params, request_id):
        name = params.get('name', '')
        if not isinstance(name, str) or not 1 <= len(name) <= 180 or name in {'.', '..'} or any(c in name for c in '/\\\r\n\x00'):
            raise ValueError('Choose a file with a simple filename')
        if Path(name).suffix.lower() not in EXTENSIONS:
            raise ValueError('Supported files: images, PDF, text, CSV, DOCX and XLSX')
        size = params.get('size')
        checksum = params.get('sha256', '')
        if not isinstance(size, int) or not 0 < size <= MAX_FILE:
            raise ValueError('Each attachment must be between 1 byte and 25 MB')
        if not isinstance(checksum, str) or not re.fullmatch('[a-f0-9]{64}', checksum):
            raise ValueError('A file checksum is required')
        identity = hashlib.sha256((json.dumps(self.owner, sort_keys=True) + '\n' + request_id).encode()).hexdigest()
        folder = self.folder(identity)
        expected = {**self.owner, 'id': identity, 'name': name, 'size': size, 'sha256': checksum}
        if (folder / 'metadata.json').exists():
            value = self.metadata(identity)
            if any(value.get(k) != v for k, v in expected.items()):
                raise ValueError('Upload identity already belongs to different content')
        else:
            if shutil.disk_usage(self.root).free < size + 512 * 1024 * 1024:
                raise ValueError('This computer needs more free storage before uploading')
            folder.mkdir(mode=0o700, exist_ok=True)
            value = {**expected, 'ready': False}
            self.save(value)
        path = self.path(value)
        return {**value, 'offset': path.stat().st_size if path.exists() else 0, 'chunkSize': CHUNK}

    def append(self, identity, offset, encoded):
        value = self.metadata(identity)
        if not isinstance(offset, int) or offset < 0 or not isinstance(encoded, str) or len(encoded) > CHUNK * 2:
            raise ValueError('Invalid upload chunk')
        try: data = base64.b64decode(encoded, validate=True)
        except ValueError: raise ValueError('Invalid upload encoding') from None
        if not 0 < len(data) <= CHUNK or offset + len(data) > value['size']:
            raise ValueError('Upload exceeds its declared size')
        path = self.path(value)
        current = path.stat().st_size if path.exists() else 0
        if offset > current: raise ValueError('Upload chunk is out of order')
        with path.open('r+b' if path.exists() else 'w+b') as stream:
            path.chmod(0o600)
            overlap = min(len(data), current - offset)
            stream.seek(offset)
            if stream.read(overlap) != data[:overlap]:
                raise ValueError('Retry contains different file bytes')
            stream.seek(current)
            stream.write(data[overlap:]); stream.flush(); os.fsync(stream.fileno())
        return {'offset': max(current, offset + len(data))}

    def finish(self, identity):
        value = self.metadata(identity); path = self.path(value)
        if not path.is_file() or path.stat().st_size != value['size']:
            raise ValueError('Upload is incomplete')
        content = path.read_bytes()
        if hashlib.sha256(content).hexdigest() != value['sha256']:
            raise ValueError('File checksum did not match; upload the original file again')
        ext = path.suffix.lower()
        valid = True
        if ext == '.png': valid = content.startswith(b'\x89PNG\r\n\x1a\n')
        elif ext in {'.jpg', '.jpeg'}: valid = content.startswith(b'\xff\xd8\xff')
        elif ext == '.webp': valid = content[:4] == b'RIFF' and content[8:12] == b'WEBP'
        elif ext == '.pdf': valid = content.startswith(b'%PDF-')
        elif ext in {'.docx', '.xlsx'}:
            try:
                with zipfile.ZipFile(path) as archive:
                    valid = ('word/document.xml' if ext == '.docx' else 'xl/workbook.xml') in archive.namelist()
                    valid = valid and sum(i.file_size for i in archive.infolist()) <= 200 * 1024 * 1024
            except (ValueError, zipfile.BadZipFile): valid = False
        else:
            try: content.decode('utf-8')
            except UnicodeError: valid = False
        if not valid: raise ValueError('File contents do not match a supported format')
        value['ready'] = True; self.save(value)
        return value

    def resolve(self, identities):
        if not isinstance(identities, list) or len(identities) > 10 or not all(isinstance(i, str) for i in identities) or len(set(identities)) != len(identities):
            raise ValueError('Choose at most ten distinct attachments')
        values = []
        for identity in identities:
            value = self.metadata(identity)
            if not value['ready']: raise ValueError('Wait for attachments to finish uploading')
            path = self.path(value)
            if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != value['sha256']:
                raise ValueError('Attachment changed since upload; attach it again')
            values.append(value)
        if sum(v['size'] for v in values) > MAX_MESSAGE:
            raise ValueError('A message can contain at most 100 MB of attachments')
        return values

    def listing(self):
        values = []
        for path in sorted(self.root.glob('*/metadata.json'), key=lambda p: p.stat().st_mtime, reverse=True):
            try:
                value = self.metadata(path.parent.name)
                if value['ready']:
                    values.append({k: value[k] for k in ('id', 'name', 'size', 'sessionId')})
            except (ValueError, OSError):
                continue
            if len(values) >= 100: break
        return {'files': values}

    def read(self, identity, offset=0):
        value = self.metadata(identity)
        if not value['ready']: raise ValueError('Attachment upload is incomplete')
        if not isinstance(offset, int) or not 0 <= offset < value['size']: raise ValueError('Invalid file offset')
        with self.path(value).open('rb') as stream:
            stream.seek(offset); data = stream.read(CHUNK)
        return {'data': base64.b64encode(data).decode(), 'size': value['size'], 'name': value['name'], 'offset': offset}

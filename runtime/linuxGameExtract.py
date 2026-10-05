"""Extract ZIP/7z game files without letting archive paths choose write targets."""
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import resource
import signal
import stat
import subprocess
import sys
import threading
import zipfile

archive, destination = map(Path, sys.argv[1:3])
seven = sys.argv[3]
redist = len(sys.argv) == 5 and sys.argv[4] == 'microsoft-redist'
max_members = 256 if redist else 200000
max_bytes = 512 * 1024**2 if redist else 512 * 1024**3
child = None

def stop(*_args):
    if child is not None and child.poll() is None:
        child.kill()
        child.wait()
    os._exit(1)

# Closing the launcher's pipe stops a surviving extractor after an app crash.
def watch_parent():
    # A daemon blocked in BufferedReader.read holds Python's stdin lock at
    # interpreter shutdown. Raw reads preserve EOF cancellation without that
    # fatal shutdown race after a successful extraction.
    try:
        while os.read(0, 1024):
            pass
    finally:
        stop()

threading.Thread(target=watch_parent, daemon=True).start()
signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGALRM, stop)
signal.alarm(180 if redist else 7200)
resource.setrlimit(resource.RLIMIT_AS, (2 * 1024**3, 2 * 1024**3))
assert destination.is_dir() and not destination.is_symlink() and not list(destination.iterdir())
assert destination.stat().st_uid == os.getuid() and destination.stat().st_mode & 0o077 == 0
assert archive.is_file() and not archive.is_symlink()

def member_path(name):
    if not name or any(ord(c) < 32 or ord(c) == 127 for c in name) or len(name.encode()) > 4096:
        raise ValueError('Invalid archive member name')
    # Windows archive separators are paths too, rather than literal Linux names.
    name = name.replace('\\', '/')
    value = PurePosixPath(name)
    if value.is_absolute() or '..' in value.parts or len(value.parts) > 32 or ':' in name:
        raise ValueError('Archive member escapes the game folder')
    clean = '/'.join(value.parts)
    if clean in ('', '.'):
        raise ValueError('Invalid empty archive member')
    return clean

members = {}
total = 0
def add(name, size, directory, executable, original):
    global total
    clean = member_path(name)
    if clean in members or len(members) >= max_members or size < 0 or size > max_bytes:
        raise ValueError('Duplicate or excessive archive members')
    total += size
    if total > max_bytes:
        raise ValueError('Archive exceeds the extracted size limit')
    members[clean] = (size, directory, executable, original)

def read_process(args, limit):
    global child
    child = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    data = bytearray()
    try:
        while True:
            chunk = child.stdout.read(65536)
            if not chunk:
                break
            data.extend(chunk)
            if len(data) > limit:
                raise ValueError('Archive listing exceeds its limit')
        if child.wait() != 0:
            raise ValueError('Archive is damaged, encrypted, or missing a volume')
        return bytes(data)
    finally:
        if child.poll() is None:
            child.kill()
        child.wait()

package = None
if zipfile.is_zipfile(archive):
    package = zipfile.ZipFile(archive)
    for item in package.infolist():
        mode = item.external_attr >> 16
        if item.flag_bits & 1 or stat.S_ISLNK(mode) or (stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR)):
            raise ValueError('Encrypted archives, links, and special files are unsupported')
        add(item.filename, item.file_size, item.is_dir(), bool(mode & 0o111), item)
else:
    listing = read_process([seven, 'l', '-slt', '-ba', '-sccUTF-8', '-pSail-No-Archive-Password', '--', str(archive)], 32 * 1024**2).decode('utf-8', 'strict')
    for block in listing.strip().split('\n\n'):
        fields = {}
        for line in block.splitlines():
            if ' = ' not in line:
                raise ValueError('Unsupported archive listing')
            key, value = line.split(' = ', 1)
            if key in fields:
                raise ValueError('Ambiguous archive member')
            fields[key] = value
        attrs = fields.get('Attributes', '')
        if fields.get('Encrypted') == '+' or any(k in fields for k in ('Symbolic Link', 'Hard Link')) or 'l' in attrs:
            raise ValueError('Encrypted archives and links are unsupported')
        name = fields.get('Path', '')
        add(name, int(fields.get('Size', '0')), fields.get('Folder') == '+' or attrs.startswith('D'), 'x' in attrs, name)

if not members or shutil.disk_usage(destination).free < total + 128 * 1024**2:
    raise ValueError('Archive is empty or there is not enough free space')
for name in members:
    for parent in PurePosixPath(name).parents:
        if str(parent) in members and not members[str(parent)][1]:
            raise ValueError('An archive parent is not a directory')

for name, (size, directory, executable, original) in members.items():
    target = destination / name
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if directory:
        target.mkdir(exist_ok=True, mode=0o700)
        continue
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o700 if executable else 0o600)
    with os.fdopen(fd, 'wb') as output:
        if package is not None:
            source = package.open(original)
        else:
            # Extract one validated member to a pipe. 7za never writes a path.
            child = subprocess.Popen([seven, 'x', '-so', '-spd', '-pSail-No-Archive-Password', '--', str(archive), original],
                                     stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            source = child.stdout
        written = 0
        try:
            while True:
                chunk = source.read(1024 * 1024)
                if not chunk:
                    break
                written += len(chunk)
                if written > size:
                    raise ValueError('Archive member exceeds its declared size')
                output.write(chunk)
            if written != size or (package is None and child.wait() != 0):
                raise ValueError('Archive member did not extract completely')
            output.flush()
            os.fsync(output.fileno())
        finally:
            source.close()
            if package is None:
                if child.poll() is None:
                    child.kill()
                child.wait()
if package is not None:
    package.close()
print(json.dumps({'count': len(members), 'bytes': total}), flush=True)

"""Extract official runtime archives into an empty, private staging folder.

Files precede links, and links may only resolve to another archive member.
Downloaded programs are never executed by the installer.
"""
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import signal
import stat
import sys
import tarfile

# Survives a forced exit of the parent application during extraction.
signal.alarm(180)

archive, destination = map(Path, sys.argv[1:3])
kind = sys.argv[3]
assert kind in ('umu', 'proton')
assert destination.is_dir() and not destination.is_symlink() and not list(destination.iterdir())
assert destination.stat().st_uid == os.getuid() and destination.stat().st_mode & 0o077 == 0

def member_path(name):
    if not name or '\x00' in name or '\\' in name or len(name.encode()) > 4096:
        raise ValueError('Invalid runtime archive path')
    value = PurePosixPath(name)
    if value.is_absolute() or '..' in value.parts or len(value.parts) > 64:
        raise ValueError('Runtime archive path escapes the installation')
    return '/'.join(value.parts)

with tarfile.open(archive, 'r:*') as package:
    members = {}
    total = 0
    for item in package:
        name = member_path(item.name)
        if not name or name == '.':
            if item.isdir():
                continue
            raise ValueError('Invalid empty runtime archive path')
        if name in members or len(members) >= 200000:
            raise ValueError('Duplicate or excessive runtime archive members')
        if not (item.isdir() or item.isfile() or item.issym() or item.islnk()) or item.mode & 0o7000:
            raise ValueError('Unsupported runtime archive member')
        total += item.size
        if item.size < 0 or total > 8 * 1024**3:
            raise ValueError('Runtime archive exceeds its extracted size limit')
        members[name] = item
    if shutil.disk_usage(destination).free < total + 128 * 1024**2:
        raise ValueError('Not enough free space to extract this runtime')

    # A link can never be a parent of an extracted file or another link.
    for name, item in members.items():
        for parent in PurePosixPath(name).parents:
            ancestor = members.get(str(parent))
            if ancestor and not ancestor.isdir():
                raise ValueError('A runtime archive parent is not a directory')

    targets = {}
    for name, item in members.items():
        if not (item.issym() or item.islnk()):
            continue
        link = item.linkname
        if not link or '\x00' in link or '\\' in link or len(link.encode()) > 4096 or link.startswith('/'):
            raise ValueError('Invalid runtime archive link')
        base = [] if item.islnk() else list(PurePosixPath(name).parent.parts)
        for part in PurePosixPath(link).parts:
            if part == '..':
                if not base:
                    raise ValueError('Runtime archive link escapes the installation')
                base.pop()
            elif part != '.':
                base.append(part)
        targets[name] = '/'.join(base)

    def resolve_link(name, chain=()):
        if name in chain or len(chain) >= 64:
            raise ValueError('Runtime archive contains a link cycle')
        parts = PurePosixPath(name).parts
        for index in range(1, len(parts) + 1):
            prefix = '/'.join(parts[:index])
            if prefix in targets:
                suffix = '/'.join(parts[index:])
                return resolve_link(targets[prefix] + ('/' + suffix if suffix else ''), chain + (prefix,))
        if name not in members and not any(value.startswith(name + '/') for value in members):
            raise ValueError('Runtime archive contains an unresolved link')
        return name

    for name in targets:
        final = resolve_link(name)
        if members[name].islnk() and (final not in members or not members[final].isfile()):
            raise ValueError('Runtime archive hard link does not target a file')

    for name, item in members.items():
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if item.isdir():
            target.mkdir(exist_ok=True, mode=0o700)
        elif item.isfile():
            fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o700 if item.mode & 0o111 else 0o600)
            with os.fdopen(fd, 'wb') as output, package.extractfile(item) as source:
                shutil.copyfileobj(source, output, 1024 * 1024)
                output.flush()
                os.fsync(output.fileno())
    for name, item in members.items():
        if item.issym():
            os.symlink(item.linkname, destination / name)
        elif item.islnk():
            os.link(destination / resolve_link(name), destination / name, follow_symlinks=False)

    if kind == 'umu':
        candidates = [name for name, item in members.items() if PurePosixPath(name).name == 'umu-run' and item.isfile() and item.mode & 0o111]
    else:
        candidates = [str(PurePosixPath(name).parent) for name, item in members.items()
                      if PurePosixPath(name).name == 'proton' and item.isfile() and item.mode & 0o111
                      and str(PurePosixPath(name).parent / 'toolmanifest.vdf') in members]
    if len(candidates) != 1:
        raise ValueError('The archive does not contain one compatible runtime')
    print(json.dumps({'relativePath': candidates[0], 'files': len(members), 'bytes': total}))

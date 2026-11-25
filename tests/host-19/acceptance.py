# SPDX-License-Identifier: MPL-2.0
"""python3 tests/host-19/acceptance.py /absolute/path/to/official/omp [--installed-loader /path/to/index.ts]

Requires Bun 1.4.3 and the repo's frozen dependencies. Real installer, unbound
loopback broker, compiled host, PTY and TSP frames; not a physical Tern UI.
No user config, clipboard, model prompt, tool execution, or approval response.
Installed-loader mode observes a new session and local PNG paste only; it does not bind a client or send to the deployed broker.
"""
import argparse
import base64
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import struct
import subprocess
import sys
import tempfile
import termios
import time

REPO = Path(__file__).resolve().parents[2]
CLI = str(REPO / 'src/cli.ts')
PROBE = str(Path(__file__).with_name('probe.ts').resolve())
# Official https://github.com/can1357/oh-my-pi/releases/tag/v19.2.1 assets.
SHA256 = {
    'e8b937f9bf023baa147bdd300ad5421af0a6ef8b1f350c47a9a93d5fca94feca',  # linux-x64
    '43943119837612b2da72250ab7efe22ff8ca239eabebd4f702f34e3a144fdd3d',  # darwin-arm64
}
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfuoAAAAASUVORK5CYII=')
BLOB = hashlib.sha256(PNG).hexdigest()
START, END = b'\x1b_tsp;', b'\x1b\\'


class NativePane:
    """Observe the live focused editor, its decorations, and the destination in host frames."""
    def __init__(self, fd, root):
        self.fd, self.root = fd, root
        self.buffer = self.tail = b''
        self.chunks, self.nodes, self.blobs = {}, {}, {}
        self.focus = None

    def send(self, verb, data):
        os.write(self.fd, START + verb + b';' + json.dumps(data, separators=(',', ':')).encode() + END)

    def add(self, sf, parent, node):
        key = (sf, node['id'])
        self.nodes[key] = (parent, node['k'], node.get('p', {}))
        for child in node.get('c', []):
            self.add(sf, key, child)

    def remove(self, key):
        self.nodes.pop(key, None)
        for child in [child for child, node in self.nodes.items() if node[0] == key]:
            self.remove(child)

    def frame(self, msg):
        sf = msg['sf']
        for op, *args in msg['ops']:
            key = (sf, args[0]) if args else None
            if op == 'add':
                self.add(sf, (sf, args[1]), args[3])
            elif op == 'del':
                self.remove(key)
            elif op == 'focus':
                self.focus = key
            elif key in self.nodes:
                parent, kind, props = self.nodes[key]
                if op == 'move':
                    self.nodes[key] = ((sf, args[1]), kind, props)
                if op == 'set':
                    props.update(args[1])
                elif op == 'text':
                    props['text'] = (props.get('text', '') if args[1] == 'append' else '') + args[2]
                elif op == 'splice':
                    _, at, count, text = args
                    old = props['text']
                    props['text'] = old[:at] + text + old[at + count:]
        self.send(b'e', {'ev': 'ack', 'sf': sf, 's': msg['s']})

    def message(self, message):
        verb, body = message.split(b';', 1)
        params = {}
        while match := re.match(rb'^(\w+)=([^;]*);', body):
            params[match[1]] = match[2]
            body = body[match.end():]
        if b'c' in params:
            head, parts = self.chunks.setdefault(params[b'c'], (params, []))
            parts.append(body)
            if params.get(b'm') == b'1':
                return
            del self.chunks[params[b'c']]
            params, body = head, b''.join(parts)
        if verb == b'q':
            query = json.loads(body)
            if query['q'] == 'hello':
                self.send(b'r', {'r': 'hello', 'v': 1, 'term': 'bridge-acceptance', 'cols': 120,
                                 'kinds': ['col', 'row', 'editor', 'text', 'image', 'card', 'rows'],
                                 'features': ['blobs'], 'credits': 4, 'apc': 1024 * 1024})
            elif query['q'] == 'blobs':
                self.send(b'r', {'r': 'blobs', 'have': []})
        elif verb == b'f':
            self.frame(json.loads(body))
        elif verb == b'b':
            self.blobs[params[b'id'].decode()] = base64.b64decode(body, validate=True)

    def wait(self, label, condition, timeout=40):
        end = time.monotonic() + timeout
        while True:
            if (self.root / 'unexpected-submit').exists():
                raise AssertionError('bridge submitted input without a user gesture')
            result = self.root / 'activation.json'
            if result.exists():
                report = json.loads(result.read_text())
                if 'error' in report:
                    raise AssertionError(report['error'])
            if condition():
                return
            if time.monotonic() >= end:
                raise TimeoutError(f'{label}: editor={self.editor!r}; terminal tail={self.tail[-1500:]!r}')
            if not select.select([self.fd], [], [], 0.15)[0]:
                continue
            try:
                data = os.read(self.fd, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                data = b''
            if not data:
                raise RuntimeError(f'OMP exited waiting for {label}: {self.tail[-1500:]!r}')
            self.tail = (self.tail + data)[-4000:]
            self.buffer += data
            while True:
                start = self.buffer.find(START)
                if start < 0:
                    self.buffer = self.buffer[-len(START):]
                    break
                self.buffer = self.buffer[start:]
                stop = self.buffer.find(END, len(START))
                if stop < 0:
                    break
                self.message(self.buffer[len(START):stop])
                self.buffer = self.buffer[stop + len(END):]

    @property
    def editor(self):
        node = self.nodes.get(self.focus)
        return node[2] if node and node[1] == 'editor' else {}

    def locator(self):
        return next((p['href'] for _, _, p in self.nodes.values()
                     if p.get('role') == 'omp.client-bridge.destination' and p.get('hidden') is True
                     and re.fullmatch(r'omp-bridge-target://[\w-]+', p.get('href', ''))), None)

    def paste(self, text):
        os.write(self.fd, b'\x1b[200~' + text.encode() + b'\x1b[201~')

    def edit(self, start, stop, text):
        sf, field = self.focus
        self.send(b'e', {'ev': 'edit', 'sf': sf, 'id': field, 'from': start, 'to': stop,
                         'text': text, 'cursor': start + len(text), 'len': len(self.editor['text'])})


def exercise(root, env):
    master, slave = pty.openpty()
    try:
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 38, 120, 0, 0))

        def controlling_tty():
            os.setsid()
            fcntl.ioctl(0, termios.TIOCSCTTY, 0)

        args = ['omp', '--offline', '--model', 'openai/gpt-4o-mini', '--no-session', '--no-title',
                '--no-spotlight', '--no-prewalk', '--no-judge', '--no-lsp', '--no-skills', '--no-rules',
                '--no-context-files', '--no-extensions', '-e', PROBE]
        child = subprocess.Popen(args, cwd=root, env=env, stdin=slave, stdout=slave, stderr=slave, preexec_fn=controlling_tty)
        try:
            os.close(slave)
            slave = -1
            pane = NativePane(master, root)
            pane.wait('real session activation and visible native draft locator',
                      lambda: (root / 'activation.json').exists() and pane.locator() and pane.editor)
            destination = pane.locator()
            image = root / 'attached.png'
            image.write_bytes(PNG)
            draft = 'before SELECT after'
            pane.paste(draft)
            pane.wait('ordinary paste', lambda: pane.editor.get('text') == draft)
            pane.edit(7, 13, str(image))
            # TSP edit is an authoritative literal replacement in 19.2.1: not a
            # paste event. Do not reinterpret it, attach twice, or eat selection.
            literal = f'before {image} after'
            pane.wait('literal selected-text edit', lambda: pane.editor.get('text') == literal)
            if any(d.get('blob') for d in pane.editor.get('decor') or []):
                raise AssertionError('literal edit incorrectly attached an image')

            def attached(count):
                return (sum(d.get('blob') == BLOB for d in pane.editor.get('decor') or []) == count
                        and pane.blobs.get(BLOB) == PNG)

            pane.paste(str(image))
            pane.wait('native path paste with actual image bytes', lambda: attached(1))
            first = pane.editor['text']
            if not first.startswith(f'before {image}') or not first.endswith(' after'):
                raise AssertionError(f'image paste lost existing draft: {first!r}')
            if 'BRIDGE_ACCEPTANCE_LOADER' in env:
                if pane.locator() != destination:
                    raise AssertionError('native paste unexpectedly rotated the unsent draft')
                print(f"Installed loader {env['BRIDGE_ACCEPTANCE_LOADER']}: {json.loads((root / 'activation.json').read_text())}; "
                      'native locator, literal selected text, one verified unsent PNG; no client binding or transfer')
                return
            ordinary = root / 'ordinary.txt'
            ordinary.write_bytes(b'Private synthetic transfer fixture.\n')
            sender = subprocess.Popen(['bun', str(Path(PROBE).with_name('transfer.ts')), destination.split('://', 1)[1]],
                                      cwd=root, env=env)
            try:
                def delivered():
                    if sender.poll() not in (None, 0):
                        raise AssertionError(f'fixture client exited {sender.returncode}')
                    return attached(2) and (root / 'transfer-finished').exists()
                pane.wait('directed image + ordinary file with receipt and both native image chips', delivered)
                sender.wait(timeout=8)
                if sender.returncode:
                    raise AssertionError(f'fixture client exited {sender.returncode}')
            finally:
                if sender.poll() is None:
                    sender.kill()
                    sender.wait()
            text = pane.editor['text']
            staged, = (root / 'bridge/imports').glob('*/*-ordinary.txt')
            if (staged.read_bytes() != ordinary.read_bytes() or str(staged) not in text
                    or 'Temporary receiving inbox' not in text or f'before {image}' not in text or ' after' not in text):
                raise AssertionError('ordinary file bytes/path/reminder or existing draft missing after mixed upload')
            if pane.locator() != destination:
                raise AssertionError('unsent draft destination unexpectedly rotated')
            print(f"OMP 19.2.1: {json.loads((root / 'activation.json').read_text())}; "
                  'native locator, ordinary paste, literal selection edit, PNG path paste and directed mixed transfer; two unsent attachments')
        finally:
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=6)
                except subprocess.TimeoutExpired:
                    child.kill()
            child.wait()
    finally:
        os.close(master)
        if slave >= 0:
            os.close(slave)


def main(binary, installed_loader):
    with binary.open('rb') as stream:
        sha = hashlib.sha256()
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            sha.update(chunk)
    if sha.hexdigest() not in SHA256:
        raise ValueError('expected official 19.2.1 omp-linux-x64 or omp-darwin-arm64; refusing to launch')
    bun = shutil.which('bun')
    if not bun:
        raise ValueError('Bun 1.4.3 required on PATH')
    with tempfile.TemporaryDirectory(prefix='bridge-host19-') as temp:
        root = Path(temp).resolve()
        for subdir in ('bin', 'agent', 'tmp', 'home'):
            (root / subdir).mkdir(mode=0o700)
        (root / 'bin/omp').symlink_to(binary)
        (root / 'bin/bun').symlink_to(Path(bun).resolve())
        # Whitelist, don't inherit user credentials, plugin discovery, relay or signing configuration.
        env = {'HOME': str(root / 'home'), 'USERPROFILE': str(root / 'home'), 'PATH': f'{root}/bin:{os.defpath}',
               'TMPDIR': str(root / 'tmp'), 'PI_CODING_AGENT_DIR': str(root / 'agent'), 'TERM': 'xterm-256color',
               'TERM_PROGRAM': 'tern', 'LANG': 'en_US.UTF-8', 'OMP_SKIP_SETUP': '1', 'OTEL_SDK_DISABLED': 'true',
               'TERN_OMP_BRIDGE_HOME': str(root / 'bridge'), 'BRIDGE_ACCEPTANCE_ROOT': str(root),
               'OPENAI_API_KEY': 'synthetic-not-used', 'SSH_TTY': '/dev/fixture-no-local-clipboard',
               'HTTP_PROXY': 'http://127.0.0.1:1', 'HTTPS_PROXY': 'http://127.0.0.1:1', 'NO_PROXY': 'localhost,127.0.0.1'}
        (root / 'agent/config.yml').write_text('bash:\n  patterns:\n    - match: "bridge-policy-probe *"\n      approval: deny\n'
                                                'tools:\n  approvalMode: always-ask-cached\n'
                                                'composer:\n  predictions: false\nimages:\n  autoResize: false\n')
        (root / 'agent/models.yml').write_text('providers:\n  openai:\n    baseUrl: http://127.0.0.1:1/v1\n')
        if installed_loader is not None:
            env['BRIDGE_ACCEPTANCE_LOADER'] = str(installed_loader)
            exercise(root, env)
            return
        subprocess.run([bun, CLI, 'install-omp', '--target', str(root / 'agent'), '--state-dir', str(root / 'bridge')],
                       env=env, cwd=root, stdin=subprocess.DEVNULL, check=True, timeout=60)
        broker = subprocess.Popen([bun, CLI, 'server', '--state-dir', str(root / 'bridge')], cwd=root, env=env,
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        try:
            if not select.select([broker.stdout], [], [], 20)[0] or json.loads(broker.stdout.readline())['kind'] != 'broker-ready':
                raise RuntimeError('isolated broker did not become ready')
            exercise(root, env)
        finally:
            broker.stdin.close()  # Native bridge service shutdown contract.
            try:
                broker.wait(timeout=8)
            except subprocess.TimeoutExpired:
                broker.kill()
                broker.wait()
            broker.stdout.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('binary', type=Path)
    parser.add_argument('--installed-loader', type=Path)
    args = parser.parse_args()
    main(args.binary.resolve(strict=True), args.installed_loader.resolve(strict=True) if args.installed_loader else None)

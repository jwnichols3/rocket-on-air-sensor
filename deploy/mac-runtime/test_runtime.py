import argparse
import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import plistlib
import time
import uuid
import subprocess
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('onair_runtime', HERE / 'runtime.py')
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


class NativeLauncherTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix='onair-launcher-test-')
        cls.root = Path(cls.temporary.name)
        cls.app = cls.root / 'Example App.app'
        mac = cls.app / 'Contents/MacOS'
        helper = cls.app / 'Contents/Helpers'
        mac.mkdir(parents=True); helper.mkdir(parents=True)
        cls.exe = mac / 'OnAirReceiver'
        subprocess.run(['xcrun', 'swiftc', '-swift-version', '5', str(HERE / 'Launcher.swift'), '-o', str(cls.exe)], check=True)
        (helper / 'node').symlink_to(shutil.which('node'))

    @classmethod
    def tearDownClass(cls): cls.temporary.cleanup()

    def test_arguments_environment_and_working_directory(self):
        env = {**os.environ, 'ONAIR_LAUNCHER_TEST': 'inherited'}
        result = subprocess.run([str(self.exe), '-e', 'console.log(JSON.stringify({args:process.argv.slice(1),value:process.env.ONAIR_LAUNCHER_TEST,cwd:process.cwd()}))', 'with spaces', 'literal $HOME'], cwd=self.root, env=env, capture_output=True, text=True, check=True)
        body = json.loads(result.stdout)
        self.assertEqual(body['args'], ['with spaces', 'literal $HOME'])
        self.assertEqual(body['value'], 'inherited')
        self.assertEqual(Path(body['cwd']).resolve(), self.root.resolve())

    def test_child_exit_status(self):
        self.assertEqual(subprocess.run([str(self.exe), '-e', 'process.exit(37)']).returncode, 37)

    def test_launcher_info_reports_the_actual_executable_and_parent(self):
        result = subprocess.run([str(self.exe), '--launcher-info'], capture_output=True, text=True, check=True)
        body = json.loads(result.stdout)
        self.assertEqual(body['phase'], 'launcher')
        self.assertEqual(Path(body['executablePath']).resolve(), self.exe.resolve())
        self.assertEqual(body['parentPid'], os.getpid())
        self.assertGreater(body['pid'], 0)

    def test_termination_reaches_child_and_waits_for_cleanup(self):
        marker = self.root / 'terminated.txt'
        script = "process.on('SIGTERM',()=>{require('fs').appendFileSync(process.argv[1],' cleaned');process.exit(23)});require('fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)"
        proc = subprocess.Popen([str(self.exe), '-e', script, str(marker)])
        try:
            import time
            deadline = time.monotonic() + 5
            while not marker.exists() and time.monotonic() < deadline: time.sleep(.02)
            self.assertTrue(marker.exists(), 'child must start before signalling its supervisor')
            child = int(marker.read_text())
            proc.send_signal(signal.SIGTERM)
            self.assertEqual(proc.wait(timeout=5), 23)
            self.assertIn('cleaned', marker.read_text())
            with self.assertRaises(ProcessLookupError): os.kill(child, 0)
        finally:
            if proc.poll() is None: proc.kill(); proc.wait()

    def test_ignored_termination_is_bounded(self):
        marker = self.root / ('ignore-' + uuid.uuid4().hex)
        script = "process.on('SIGTERM',()=>{});require('fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)"
        proc = subprocess.Popen([str(self.exe), '-e', script, str(marker)])
        child = None
        try:
            deadline = time.monotonic() + 5
            while not marker.exists() and time.monotonic() < deadline: time.sleep(.02)
            self.assertTrue(marker.exists())
            child = int(marker.read_text())
            started = time.monotonic()
            proc.send_signal(signal.SIGTERM)
            self.assertEqual(proc.wait(timeout=4.5), 137)
            self.assertLess(time.monotonic() - started, 4.5)
            with self.assertRaises(ProcessLookupError): os.kill(child, 0)
        finally:
            if child:
                try: os.kill(child, signal.SIGKILL)
                except ProcessLookupError: pass
            if proc.poll() is None: proc.wait(timeout=5)

    def test_launchd_hard_restart_cleans_node_and_grandchild(self):
        marker = self.root / ('launchd-' + uuid.uuid4().hex + '.json')
        label = 'com.rocket.onair.lifecycle-test.' + uuid.uuid4().hex
        target = f'gui/{os.getuid()}/{label}'
        child_script = "process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)"
        parent_script = "process.on('SIGTERM',()=>{});const p=require('child_process').spawn(process.execPath,['-e',process.argv[2]],{stdio:['ignore','pipe','ignore']});p.stdout.once('data',()=>require('fs').writeFileSync(process.argv[1],JSON.stringify([process.ppid,process.pid,p.pid])));setInterval(()=>{},1000)"
        plist = self.root / (label + '.plist')
        plist.write_bytes(plistlib.dumps({'Label': label, 'ProgramArguments': [str(self.exe), '-e', parent_script, str(marker), child_script],
                                        'RunAtLoad': True, 'ExitTimeOut': 5, 'AbandonProcessGroup': False,
                                        'ThrottleInterval': 1}))
        recorded = []
        def ready(previous=None):
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                try:
                    value = json.loads(marker.read_text())
                    if previous is None or value[0] != previous[0]: return value
                except (OSError, ValueError): pass
                time.sleep(.02)
            self.fail('temporary launchd job did not become ready')
        subprocess.run(['launchctl', 'bootstrap', f'gui/{os.getuid()}', str(plist)], check=True)
        try:
            old = ready(); recorded.append(old)
            groups = {os.getpgid(pid) for pid in old}
            self.assertEqual(len(groups), 1, 'runtime must inherit the launchd job process group')
            self.assertNotIn(os.getpgrp(), groups, 'temporary job must not share the test runner group')
            subprocess.run(['launchctl', 'kickstart', '-k', target], check=True)
            new = ready(old); recorded.append(new)
            deadline = time.monotonic() + 3
            living = []
            while time.monotonic() < deadline:
                living = []
                for pid in old:
                    try: os.kill(pid, 0); living.append(pid)
                    except ProcessLookupError: pass
                if not living: break
                time.sleep(.02)
            details = subprocess.run(['ps', '-o', 'pid=,ppid=,pgid=,state=,comm=', '-p', ','.join(map(str, living))],
                                     capture_output=True, text=True).stdout if living else ''
            self.assertEqual(living, [], 'hard restart left old runtime processes alive: ' + details)
            os.kill(new[0], signal.SIGKILL)
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline:
                living = []
                for pid in new:
                    try: os.kill(pid, 0); living.append(pid)
                    except ProcessLookupError: pass
                if not living: break
                time.sleep(.02)
            self.assertEqual(living, [], 'SIGKILL of supervisor left runtime descendants alive')
            subprocess.run(['launchctl', 'kickstart', target], check=True)
            newest = ready(new); recorded.append(newest)
            subprocess.run(['launchctl', 'kill', 'SIGTERM', target], check=True)
            deadline = time.monotonic() + 4.5
            while time.monotonic() < deadline:
                living = []
                for pid in newest:
                    try: os.kill(pid, 0); living.append(pid)
                    except ProcessLookupError: pass
                if not living: break
                time.sleep(.02)
            self.assertEqual(living, [], 'bounded TERM shutdown left runtime descendants alive')
        finally:
            subprocess.run(['launchctl', 'bootout', target], capture_output=True)
            for group in recorded:
                for pid in group:
                    try: os.kill(pid, signal.SIGKILL)
                    except ProcessLookupError: pass

    def test_probe_rejects_credentials_without_network_access(self):
        result = subprocess.run([str(self.exe), '--probe', 'http://user:password@127.0.0.1/'], capture_output=True)
        self.assertEqual(result.returncode, 125)


class PackagingTest(unittest.TestCase):
    def test_permission_probe_rejects_root_context(self):
        with patch.object(runtime.os, 'getuid', return_value=0):
            with self.assertRaisesRegex(RuntimeError, 'not root'):
                runtime.probe(argparse.Namespace())

    def test_ad_hoc_request_is_rejected_before_build(self):
        with self.assertRaisesRegex(RuntimeError, 'Apple-issued'):
            runtime.build(argparse.Namespace(identity='-'))

    def test_bad_archive_is_rejected_before_extract_or_sign(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); archive = root / 'bad.tar.gz'; archive.write_bytes(b'not the pinned artifact')
            args = argparse.Namespace(identity='test identity', output=str(root / 'Example.app'), manifest=str(HERE / 'runtime.json'), archive=str(archive))
            with self.assertRaisesRegex(RuntimeError, 'checksum'):
                runtime.build(args)
            self.assertFalse(Path(args.output).exists())

    def test_requirement_can_be_emitted_on_stdout(self):
        result = subprocess.CompletedProcess([], 0, 'designated => identifier "example" and anchor apple generic', '')
        with patch.object(runtime.subprocess, 'run', return_value=result):
            self.assertIn('apple generic', runtime.signed_requirement('example'))

    def test_failed_install_restores_previous_runtime(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); source = root / 'candidate.app'; active = root / 'active.app'
            source.mkdir(); active.mkdir()
            (source / 'version').write_text('new'); (active / 'version').write_text('old')
            args = argparse.Namespace(app=str(source), destination=str(active))
            with patch.object(runtime, 'verify', return_value={}), patch.object(runtime, 'run', side_effect=RuntimeError('registration failed')):
                with self.assertRaisesRegex(RuntimeError, 'registration failed'): runtime.install(args)
            self.assertEqual((active / 'version').read_text(), 'old')
            self.assertEqual((source / 'version').read_text(), 'new')

    def test_signal_after_displacing_old_app_restores_it(self):
        for number in [signal.SIGTERM, signal.SIGINT]:
            with self.subTest(signal=number), tempfile.TemporaryDirectory() as directory:
                root = Path(directory); source = root / 'candidate.app'; active = root / 'active.app'
                source.mkdir(); active.mkdir()
                (source / 'version').write_text('new'); (active / 'version').write_text('old')
                script = """
import argparse, importlib.util, os
from pathlib import Path
spec=importlib.util.spec_from_file_location('runtime', %r)
runtime=importlib.util.module_from_spec(spec); spec.loader.exec_module(runtime)
runtime.verify=lambda app: {}
runtime.run=lambda *args: ''
active=Path(%r).resolve()
original=Path.rename
def interrupted_rename(self, target):
    result=original(self,target)
    if self == active and str(target).endswith('.previous'):
        os.kill(os.getpid(), %d)
    return result
Path.rename=interrupted_rename
runtime.install(argparse.Namespace(app=%r, destination=str(active)))
""" % (str(HERE / 'runtime.py'), str(active), number, str(source))
                result = subprocess.run([os.sys.executable, '-c', script], capture_output=True, text=True)
                self.assertEqual(result.returncode, 128 + number, result.stderr)
                self.assertEqual((active / 'version').read_text(), 'old')
                self.assertEqual((source / 'version').read_text(), 'new')

    def test_install_restores_callers_signal_handlers(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); source = root / 'candidate.app'; active = root / 'active.app'
            source.mkdir()
            previous = {number: signal.getsignal(number) for number in [signal.SIGINT, signal.SIGTERM]}
            with patch.object(runtime, 'verify', return_value={}), patch.object(runtime, 'run', return_value=''):
                runtime.install(argparse.Namespace(app=str(source), destination=str(active)))
            self.assertEqual({number: signal.getsignal(number) for number in previous}, previous)


if __name__ == '__main__': unittest.main()

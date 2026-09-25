"""Offline contract checks for the Apps2Samsung workflow (no release is created)."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = (ROOT / '.github/workflows/tizen-wgt.yml').read_text()
CONFIG = (ROOT / 'vite.config.ts').read_text()
PACKAGE = json.loads((ROOT / 'package.json').read_text())


class TizenWorkflowContract(unittest.TestCase):
    def test_web_build_keeps_root_base_and_widget_build_is_relative(self):
        self.assertIn('vite build --mode tizen', PACKAGE['scripts']['build:wgt'])
        self.assertIn("mode === 'tizen'", CONFIG)
        self.assertRegex(CONFIG, r"base:\s*[^\n]*\?\s*'\./'\s*:\s*'/'")
        self.assertIn('npm run build:wgt', WORKFLOW)
        self.assertIn('npm run build:tizen5', WORKFLOW)

    def test_archive_guard_does_not_use_grep_q_on_a_pipe(self):
        guard = WORKFLOW.split('ENTRIES="$(unzip -Z -1 "$WGT")"', 1)[1].split('cmp dist/config.xml', 1)[0]
        self.assertNotRegex(guard, r'\|\s*grep\s+-[^\s]*q')
        self.assertIn('config.xml', guard)
        self.assertIn('index.html', guard)

    def test_workflow_checks_packaged_widget_asset_urls(self):
        build = WORKFLOW.split('      - name: Build, validate and package', 1)[1].split('      - name: Release metadata', 1)[0]
        self.assertIn('dist/index.html', build)
        self.assertIn('relative asset', build)
        self.assertIn('dist/sw.js', build)

    def test_local_widget_html_strips_crossorigin_from_assets(self):
        self.assertIn('tizenLocalAssets()', CONFIG)

    def test_release_is_draft_until_both_assets_are_read_back(self):
        release = WORKFLOW.split('      - name: Publish release', 1)[1]
        self.assertRegex(release, r'gh release create[\s\S]*?--target "\$SHA"')
        self.assertRegex(release, r'gh release create[\s\S]*?--draft')
        self.assertIn('gh release view', release)
        self.assertIn('gh release edit', release)
        self.assertIn('gh release delete', release)
        self.assertLess(release.index('gh release view'), release.index('gh release edit'))
        self.assertIn('StreamVault-default-unsigned.wgt', release)
        self.assertIn('StreamVault-tizen5-unsigned.wgt', release)


class ReleaseTransaction(unittest.TestCase):
    """Execute the actual workflow shell with a fake gh; never contact GitHub."""

    def run_release(self, scenario):
        release = WORKFLOW.split('      - name: Publish release', 1)[1]
        script = release.split('        run: |\n', 1)[1]
        script = '\n'.join(line[10:] if line.startswith('          ') else line
                           for line in script.splitlines()) + '\n'
        stub = '''#!/usr/bin/env python3
import os, sys
from pathlib import Path
args = sys.argv[1:]
log = Path(os.environ['GH_LOG'])
with log.open('a') as f:
    f.write(' '.join(args) + '\\n')
action = args[1]
if action == 'view':
    if '--json' not in args:
        sys.exit(0 if os.environ['GH_SCENARIO'] == 'preexisting' else 1)
    if os.environ['GH_SCENARIO'] == 'missing_asset':
        print('StreamVault-default-unsigned.wgt')
    elif os.environ['GH_SCENARIO'] == 'readback_error':
        sys.exit(1)
    else:
        print('StreamVault-default-unsigned.wgt\\nStreamVault-tizen5-unsigned.wgt')
if action == 'upload' and os.environ['GH_SCENARIO'] == 'upload_fail': sys.exit(1)
if action == 'create' and os.environ['GH_SCENARIO'] == 'create_fail': sys.exit(1)
'''
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            (path / 'bin').mkdir()
            gh = path / 'bin/gh'
            gh.write_text(stub)
            gh.chmod(0o755)
            (path / 'out').mkdir()
            for target in ('default', 'tizen5'):
                with zipfile.ZipFile(path / f'out/StreamVault-{target}-unsigned.wgt', 'w') as z:
                    z.writestr('config.xml', '<widget/>')
            log = path / 'gh.log'
            result = subprocess.run(['bash', '-e', '-o', 'pipefail', '-c', script], cwd=path,
                                    capture_output=True, text=True,
                                    env={**os.environ, 'PATH': str(path / 'bin') + os.pathsep + os.environ['PATH'],
                                         'GH_LOG': str(log), 'GH_SCENARIO': scenario, 'REPO': 'owner/repo',
                                         'SHA': 'abcdef123', 'VERSION': '1.0', 'RUN_ID': '123', 'RUN_ATTEMPT': '1'})
            return result, log.read_text().splitlines()

    def test_success_reads_both_assets_before_publishing(self):
        result, calls = self.run_release('success')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('--target abcdef123', next(c for c in calls if c.startswith('release create ')))
        self.assertIn('--draft', next(c for c in calls if c.startswith('release create ')))
        self.assertLess(next(i for i, c in enumerate(calls) if 'view ' in c and '--json' in c),
                        next(i for i, c in enumerate(calls) if c.startswith('release edit ')))
        self.assertFalse(any(c.startswith('release delete ') for c in calls))

    def test_failed_upload_deletes_draft_and_tag_without_publishing(self):
        result, calls = self.run_release('upload_fail')
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(any(c.startswith('release delete ') and '--cleanup-tag' in c for c in calls))
        self.assertFalse(any(c.startswith('release edit ') for c in calls))

    def test_missing_asset_deletes_draft_and_tag_without_publishing(self):
        result, calls = self.run_release('missing_asset')
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(any(c.startswith('release delete ') for c in calls))
        self.assertFalse(any(c.startswith('release edit ') for c in calls))

    def test_failed_create_attempts_cleanup(self):
        result, calls = self.run_release('create_fail')
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(any(c.startswith('release delete ') for c in calls))

    def test_readback_failure_deletes_draft(self):
        result, calls = self.run_release('readback_error')
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(any(c.startswith('release delete ') for c in calls))
        self.assertFalse(any(c.startswith('release edit ') for c in calls))

    def test_preexisting_release_is_never_deleted(self):
        result, calls = self.run_release('preexisting')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(len(calls), 1)
        self.assertTrue(calls[0].startswith('release view '))


if __name__ == '__main__':
    unittest.main()

#!/usr/bin/env python3
"""Fail closed on stale native metadata or non-store signing before TestFlight upload."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path, PurePosixPath
import plistlib
import stat
import subprocess
import tempfile
import zipfile


def validate_entries(entries):
    if len(entries) > 20000 or sum(e.file_size for e in entries) > 2 * 1024**3:
        raise ValueError('IPA exceeds inspection limits')
    names = set()
    for entry in entries:
        path = PurePosixPath(entry.filename)
        if path.is_absolute() or '..' in path.parts or '\\' in entry.filename or entry.filename in names:
            raise ValueError('Unsafe or duplicate IPA path')
        if stat.S_ISLNK(entry.external_attr >> 16):
            raise ValueError('Symlinks in IPA require manual inspection')
        names.add(entry.filename)


def validate_metadata(info, profile, entitlements, version, build, bundle, team):
    expected = {'CFBundleIdentifier': bundle, 'CFBundleShortVersionString': version, 'CFBundleVersion': build}
    for key, value in expected.items():
        if info.get(key) != value:
            raise ValueError(f'Stale or incorrect native {key}: expected {value}, got {info.get(key)}')
    if profile.get('ProvisionedDevices') is not None or profile.get('ProvisionsAllDevices'):
        raise ValueError('TestFlight requires App Store distribution, not development/ad-hoc/enterprise signing')
    if profile.get('TeamIdentifier') != [team]:
        raise ValueError('Unexpected signing team')
    if profile.get('ExpirationDate', datetime.min).replace(tzinfo=timezone.utc) <= datetime.now(timezone.utc):
        raise ValueError('Provisioning profile expired')
    for value in [profile.get('Entitlements', {}), entitlements]:
        if value.get('get-task-allow') is not False or value.get('application-identifier') != f'{team}.{bundle}' or value.get('com.apple.developer.team-identifier') != team:
            raise ValueError('Invalid store signing entitlements')


def run(args):
    return subprocess.run(args, check=True, capture_output=True, timeout=120).stdout


def verify(ipa, version, build, bundle, team):
    ipa = Path(ipa).resolve()
    if ipa.stat().st_size > 1024**3:
        raise ValueError('IPA exceeds 1 GiB')
    with zipfile.ZipFile(ipa) as archive:
        validate_entries(archive.infolist())
        apps = [n for n in archive.namelist() if n.startswith('Payload/') and n.count('/') == 2 and n.endswith('.app/Info.plist')]
        if len(apps) != 1:
            raise ValueError('Expected exactly one Payload application')
        app_path = str(PurePosixPath(apps[0]).parent)
        info = plistlib.loads(archive.read(apps[0]))
        bundle_path = app_path + '/main.jsbundle'
        if archive.getinfo(bundle_path).file_size < 1024:
            raise ValueError('Standalone JavaScript bundle missing or empty')
    with tempfile.TemporaryDirectory(prefix='zana-ipa-verify-') as directory:
        run(['/usr/bin/ditto', '-x', '-k', str(ipa), directory])
        app = Path(directory) / app_path
        run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(app)])
        profile = plistlib.loads(run(['/usr/bin/security', 'cms', '-D', '-i', str(app / 'embedded.mobileprovision')]))
        entitlements = plistlib.loads(run(['/usr/bin/codesign', '-d', '--entitlements', ':-', str(app)]))
        validate_metadata(info, profile, entitlements, version, build, bundle, team)
        certificate_prefix = str(Path(directory) / 'signer-')
        run(['/usr/bin/codesign', '-d', '--extract-certificates=' + certificate_prefix, str(app)])
        certificate = Path(certificate_prefix + '0').read_bytes()
        if certificate not in profile.get('DeveloperCertificates', []):
            raise ValueError('App signer is not authorized by the provisioning profile')
    hasher = hashlib.sha256()
    with ipa.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            hasher.update(chunk)
    digest = hasher.hexdigest()
    return {'version': version, 'build': build, 'bundle': bundle, 'team': team, 'sha256': digest}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('ipa')
    for name in ['version', 'build', 'team']:
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--bundle', default='ai.zana.mobile')
    args = parser.parse_args()
    print(json.dumps(verify(**vars(args)), indent=2))

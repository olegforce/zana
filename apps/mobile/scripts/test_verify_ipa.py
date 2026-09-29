import importlib.util
from pathlib import Path
from datetime import datetime, timedelta
import stat
import tempfile
import plistlib
from unittest.mock import patch
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('verify_ipa', Path(__file__).with_name('verify-ipa.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class VerificationTests(unittest.TestCase):
    def setUp(self):
        self.info = {'CFBundleIdentifier': 'ai.zana.mobile', 'CFBundleShortVersionString': '2.3.0', 'CFBundleVersion': '42'}
        self.entitlements = {'get-task-allow': False, 'application-identifier': 'TEAM123456.ai.zana.mobile', 'com.apple.developer.team-identifier': 'TEAM123456'}
        self.profile = {'TeamIdentifier': ['TEAM123456'], 'ExpirationDate': datetime.now() + timedelta(days=1), 'Entitlements': self.entitlements, 'DeveloperCertificates': [b'certificate']}

    def check(self, info=None, profile=None, entitlements=None):
        module.validate_metadata(info or self.info, profile or self.profile, entitlements or self.entitlements, '2.3.0', '42', 'ai.zana.mobile', 'TEAM123456')

    def test_exact_native_metadata(self):
        self.check()
        for key, value in [('CFBundleVersion', '1'), ('CFBundleShortVersionString', '0.1.0'), ('CFBundleIdentifier', 'wrong.app')]:
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, 'native'):
                self.check(info={**self.info, key: value})

    def test_store_only_valid_signing(self):
        for patch in [{'ProvisionedDevices': ['phone']}, {'ProvisionedDevices': []}, {'ProvisionsAllDevices': True}, {'TeamIdentifier': ['OTHER']}, {'ExpirationDate': datetime.now() - timedelta(days=1)}, {'Entitlements': {}}, {'Entitlements': {**self.entitlements, 'get-task-allow': True}}]:
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                self.check(profile={**self.profile, **patch})
        with self.assertRaises(ValueError):
            self.check(entitlements={**self.entitlements, 'application-identifier': 'OTHER.ai.zana.mobile'})

    def test_safe_archive_paths_and_limits(self):
        module.validate_entries([zipfile.ZipInfo('Payload/Zana.app/Info.plist')])
        for path in ['../../escape', '/absolute', 'Payload/../escape', 'Payload\\escape']:
            with self.subTest(path=path), self.assertRaises(ValueError):
                module.validate_entries([zipfile.ZipInfo(path)])
        with self.assertRaises(ValueError):
            module.validate_entries([zipfile.ZipInfo('duplicate')] * 2)
        link = zipfile.ZipInfo('link'); link.external_attr = (stat.S_IFLNK | 0o777) << 16
        with self.assertRaises(ValueError): module.validate_entries([link])
        huge = zipfile.ZipInfo('huge'); huge.file_size = 3 * 1024**3
        with self.assertRaises(ValueError): module.validate_entries([huge])
        with self.assertRaises(ValueError): module.validate_entries([zipfile.ZipInfo('x')] * 20001)

    def test_archive_inspection_and_signature_check(self):
        with tempfile.TemporaryDirectory() as directory:
            ipa = Path(directory) / 'Zana.ipa'
            with zipfile.ZipFile(ipa, 'w') as archive:
                archive.writestr('Payload/Zana.app/Info.plist', plistlib.dumps(self.info))
                archive.writestr('Payload/Zana.app/main.jsbundle', b'x' * 2048)
            def native(args):
                if 'cms' in args: return plistlib.dumps(self.profile)
                if '--entitlements' in args: return plistlib.dumps(self.entitlements)
                # codesign's optional prefix must be attached with '='; a separate
                # argument is interpreted as an application path on macOS.
                self.assertNotIn('--extract-certificates', args)
                for arg in args:
                    if arg.startswith('--extract-certificates='):
                        Path(arg.split('=', 1)[1] + '0').write_bytes(b'certificate')
                return b''
            with patch.object(module, 'run', side_effect=native) as run:
                result = module.verify(ipa, '2.3.0', '42', 'ai.zana.mobile', 'TEAM123456')
                self.assertEqual(result['version'], '2.3.0')
                self.assertEqual(len(result['sha256']), 64)
                self.assertTrue(any('--strict' in call.args[0] for call in run.call_args_list))
            self.profile['DeveloperCertificates'] = []
            with patch.object(module, 'run', side_effect=native), self.assertRaisesRegex(ValueError, 'App signer'):
                module.verify(ipa, '2.3.0', '42', 'ai.zana.mobile', 'TEAM123456')
            with zipfile.ZipFile(ipa, 'w') as archive:
                archive.writestr('Payload/Zana.app/Info.plist', plistlib.dumps(self.info))
                archive.writestr('Payload/Zana.app/main.jsbundle', b'')
            with self.assertRaisesRegex(ValueError, 'JavaScript'):
                module.verify(ipa, '2.3.0', '42', 'ai.zana.mobile', 'TEAM123456')
            with zipfile.ZipFile(ipa, 'w') as archive:
                archive.writestr('wrong.txt', b'x')
            with self.assertRaisesRegex(ValueError, 'exactly one'):
                module.verify(ipa, '2.3.0', '42', 'ai.zana.mobile', 'TEAM123456')

if __name__ == '__main__': unittest.main()

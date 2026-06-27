// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

import 'package:slopcafe_cli/src/config.dart';
import 'package:slopcafe_cli/src/format.dart';
import 'package:test/test.dart';

void main() {
  group('mergeConfig precedence', () {
    final file = ConfigFile(
      defaultProfile: 'prod',
      profiles: {
        'prod': ProfileEntry(base: 'https://file.example', key: 'awh_file'),
        'dev': ProfileEntry(base: 'http://localhost:8787', key: 'awh_dev'),
      },
    );

    test('flag beats env beats file', () {
      final c = mergeConfig(
        baseFlag: 'https://flag.example',
        keyFlag: 'awh_flag',
        env: {'SLOPCAFE_BASE': 'https://env.example', 'SLOPCAFE_KEY': 'awh_env'},
        file: file,
      );
      expect(c.baseUrl, 'https://flag.example');
      expect(c.key, 'awh_flag');
    });

    test('SLOPCAFE_* env beats AWH_* env beats file', () {
      final c = mergeConfig(
        env: {
          'SLOPCAFE_KEY': 'awh_sc',
          'AWH_KEY': 'awh_awh',
          'AWH_BASE': 'https://awh.example',
        },
        file: file,
      );
      expect(c.key, 'awh_sc'); // SLOPCAFE_ wins
      expect(c.baseUrl, 'https://awh.example'); // no SLOPCAFE_BASE → AWH_BASE
    });

    test('AWH_* env used when no SLOPCAFE_*', () {
      final c = mergeConfig(env: {'AWH_KEY': 'awh_awh'}, file: file);
      expect(c.key, 'awh_awh');
    });

    test('falls back to the selected profile from the file', () {
      final c = mergeConfig(env: const {}, file: file);
      expect(c.profile, 'prod'); // file default_profile
      expect(c.baseUrl, 'https://file.example');
      expect(c.key, 'awh_file');
    });

    test('--profile selects a different profile', () {
      final c = mergeConfig(profileFlag: 'dev', env: const {}, file: file);
      expect(c.profile, 'dev');
      expect(c.baseUrl, 'http://localhost:8787');
      expect(c.key, 'awh_dev');
    });

    test('SLOPCAFE_PROFILE env selects the profile', () {
      final c = mergeConfig(env: {'SLOPCAFE_PROFILE': 'dev'}, file: file);
      expect(c.profile, 'dev');
      expect(c.key, 'awh_dev');
    });

    test('no file, no env → default base, null key, "default" profile', () {
      final c = mergeConfig(env: const {}, file: null);
      expect(c.baseUrl, defaultBaseUrl);
      expect(c.key, isNull);
      expect(c.profile, 'default');
    });

    test('trailing slashes stripped from base', () {
      final c = mergeConfig(baseFlag: 'https://x.example///', env: const {});
      expect(c.baseUrl, 'https://x.example');
    });

    test('empty string key treated as unset', () {
      final c = mergeConfig(keyFlag: '', env: const {});
      expect(c.key, isNull);
    });
  });

  group('configPathFor', () {
    test('honors XDG_CONFIG_HOME', () {
      expect(
        configPathFor({'XDG_CONFIG_HOME': '/cfg', 'HOME': '/home/u'}),
        '/cfg/slopcafe/config.json',
      );
    });
    test('falls back to HOME/.config', () {
      expect(
        configPathFor({'HOME': '/home/u'}),
        '/home/u/.config/slopcafe/config.json',
      );
    });
  });

  group('ConfigFile json round-trip', () {
    test('serializes and parses back', () {
      final f = ConfigFile(
        defaultProfile: 'prod',
        profiles: {'prod': ProfileEntry(base: 'https://b', key: 'awh_k')},
      );
      final back = ConfigFile.fromJson(f.toJson());
      expect(back.defaultProfile, 'prod');
      expect(back.profiles['prod']!.base, 'https://b');
      expect(back.profiles['prod']!.key, 'awh_k');
    });
  });

  group('redactKey', () {
    test('masks the secret half but keeps a recognizable head', () {
      final r = redactKey('awh_abc123.SUPERSECRETVALUE');
      expect(r, startsWith('awh_'));
      expect(r, isNot(contains('SUPERSECRET')));
      expect(r, contains('…'));
    });
    test('unset → marker', () {
      expect(redactKey(null), '(unset)');
      expect(redactKey(''), '(unset)');
    });
  });
}

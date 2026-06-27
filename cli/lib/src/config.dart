// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

import 'dart:convert';
import 'dart:io';

import 'format.dart';

/// The on-disk config: a default profile name plus a map of named profiles,
/// each holding a `base` and/or `key`. Stored as JSON at
/// `$XDG_CONFIG_HOME/slopcafe/config.json` (or `~/.config/slopcafe/config.json`).
///
/// ```json
/// { "default_profile": "prod",
///   "profiles": { "prod": { "base": "https://slopcafe.com", "key": "awh_…" } } }
/// ```
class ConfigFile {
  ConfigFile({this.defaultProfile, Map<String, ProfileEntry>? profiles})
    : profiles = profiles ?? {};

  final String? defaultProfile;
  final Map<String, ProfileEntry> profiles;

  factory ConfigFile.fromJson(Map<String, dynamic> json) {
    final rawProfiles = json['profiles'];
    final profiles = <String, ProfileEntry>{};
    if (rawProfiles is Map) {
      rawProfiles.forEach((name, value) {
        if (value is Map) {
          profiles['$name'] = ProfileEntry(
            base: value['base'] as String?,
            key: value['key'] as String?,
          );
        }
      });
    }
    return ConfigFile(
      defaultProfile: json['default_profile'] as String?,
      profiles: profiles,
    );
  }

  Map<String, dynamic> toJson() => {
    if (defaultProfile != null) 'default_profile': defaultProfile,
    'profiles': {
      for (final e in profiles.entries) e.key: e.value.toJson(),
    },
  };
}

/// One profile's stored settings.
class ProfileEntry {
  ProfileEntry({this.base, this.key});

  final String? base;
  final String? key;

  Map<String, dynamic> toJson() => {
    if (base != null) 'base': base,
    if (key != null) 'key': key,
  };
}

/// The effective settings for a single invocation, after merging flags, env,
/// and the config file.
class ResolvedConfig {
  ResolvedConfig({
    required this.baseUrl,
    required this.key,
    required this.profile,
  });

  final String baseUrl;
  final String? key;

  /// The profile name that was consulted (for diagnostics / `config` output).
  final String profile;
}

/// Pure precedence merge — the single source of truth for "what wins". No I/O,
/// so it is exhaustively unit-tested.
///
/// Precedence, highest first:
///   1. explicit flag (`--base` / `--key` / `--profile`)
///   2. `SLOPCAFE_BASE` / `SLOPCAFE_KEY` / `SLOPCAFE_PROFILE` env
///   3. `AWH_BASE` / `AWH_KEY` env (compat with the repo's existing scripts)
///   4. the selected config-file profile
///   5. built-in default ([defaultBaseUrl]); the key has no default.
///
/// The active profile is itself resolved by precedence (flag → env → file's
/// `default_profile` → `"default"`), then that profile's stored values feed the
/// base/key fallback.
ResolvedConfig mergeConfig({
  String? baseFlag,
  String? keyFlag,
  String? profileFlag,
  required Map<String, String> env,
  ConfigFile? file,
}) {
  final profile =
      profileFlag ??
      env['SLOPCAFE_PROFILE'] ??
      file?.defaultProfile ??
      'default';
  final entry = file?.profiles[profile];

  final baseUrl =
      baseFlag ??
      env['SLOPCAFE_BASE'] ??
      env['AWH_BASE'] ??
      entry?.base ??
      defaultBaseUrl;

  final key =
      keyFlag ?? env['SLOPCAFE_KEY'] ?? env['AWH_KEY'] ?? entry?.key;

  return ResolvedConfig(
    baseUrl: _normalizeBase(baseUrl),
    key: (key != null && key.isEmpty) ? null : key,
    profile: profile,
  );
}

String _normalizeBase(String base) {
  var b = base.trim();
  while (b.endsWith('/')) {
    b = b.substring(0, b.length - 1);
  }
  return b;
}

/// The config-file path, honoring `$XDG_CONFIG_HOME`, then `$HOME`. Pure given
/// its [env] (so it is testable); the impure default reads `Platform`.
String configPathFor(Map<String, String> env) {
  final xdg = env['XDG_CONFIG_HOME'];
  final home = env['HOME'] ?? env['USERPROFILE'] ?? '.';
  final base = (xdg != null && xdg.isNotEmpty) ? xdg : '$home/.config';
  return '$base/slopcafe/config.json';
}

/// Default config path using the real environment.
String defaultConfigPath() => configPathFor(Platform.environment);

/// Load + parse the config file, or null if it doesn't exist. Throws
/// [FormatException] on malformed JSON (the caller surfaces it).
ConfigFile? loadConfigFile(String path) {
  final f = File(path);
  if (!f.existsSync()) return null;
  final json = jsonDecode(f.readAsStringSync());
  if (json is! Map<String, dynamic>) {
    throw const FormatException('config root must be a JSON object');
  }
  return ConfigFile.fromJson(json);
}

/// Persist the config file with owner-only permissions, since it can hold an
/// agent key. The **directory** is locked to 0700 *before* the file is written:
/// that closes the brief window in which the file's own mode is still the
/// umask default (0644) — another user can't traverse a 0700 directory to read
/// it, even for that instant. The file is then pinned to 0600.
void saveConfigFile(String path, ConfigFile config) {
  final f = File(path);
  final dir = f.parent;
  dir.createSync(recursive: true);
  if (!Platform.isWindows) {
    Process.runSync('chmod', ['700', dir.path]);
  }
  f.writeAsStringSync(
    '${const JsonEncoder.withIndent('  ').convert(config.toJson())}\n',
  );
  if (!Platform.isWindows) {
    Process.runSync('chmod', ['600', path]);
  }
}

/// Redact a secret for display: keep the `awh_<prefix>` head, mask the rest.
String redactKey(String? key) {
  if (key == null || key.isEmpty) return '(unset)';
  if (key.length <= 12) return '${key.substring(0, key.length.clamp(0, 4))}…';
  return '${key.substring(0, 12)}…${key.substring(key.length - 2)}';
}

// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

import '../command_base.dart';
import '../config.dart';
import '../errors.dart';

/// `slopcafe config <subcommand>` — manage the persisted config file.
class ConfigCommand extends SlopcafeCommand {
  ConfigCommand() {
    addSubcommand(_ConfigPath());
    addSubcommand(_ConfigList());
    addSubcommand(_ConfigGet());
    addSubcommand(_ConfigSet());
  }

  @override
  String get name => 'config';

  @override
  String get description => 'Manage CLI configuration (base URL, key, profiles).';
}

class _ConfigPath extends SlopcafeCommand {
  @override
  String get name => 'path';
  @override
  String get description => 'Print the config-file path.';

  @override
  Future<int> run() async {
    final path = configPathFor(env);
    out.result({'path': path}, () => path);
    return ExitCodes.ok;
  }
}

class _ConfigList extends SlopcafeCommand {
  @override
  String get name => 'list';
  @override
  String get description => 'Show the effective (merged) configuration.';

  @override
  Future<int> run() async {
    final c = resolveConfig();
    out.result(
      {
        'base': c.baseUrl,
        'profile': c.profile,
        'key': c.key == null ? null : redactKey(c.key),
        'config_path': configPathFor(env),
      },
      () => [
        'base:    ${c.baseUrl}',
        'profile: ${c.profile}',
        'key:     ${redactKey(c.key)}',
        'config:  ${configPathFor(env)}',
      ].join('\n'),
    );
    return ExitCodes.ok;
  }
}

class _ConfigGet extends SlopcafeCommand {
  _ConfigGet() {
    argParser.addFlag('reveal',
        negatable: false, help: 'Print the key in full instead of redacted.');
  }

  @override
  String get name => 'get';
  @override
  String get description => 'Print one resolved setting: base | key | profile.';
  @override
  String get invocation => 'slopcafe config get <base|key|profile>';

  @override
  Future<int> run() async {
    final rest = argResults!.rest;
    if (rest.length != 1) {
      throw CliException.usage('expected one of: base, key, profile');
    }
    final c = resolveConfig();
    final field = rest.single;
    final String? value;
    switch (field) {
      case 'base':
        value = c.baseUrl;
      case 'profile':
        value = c.profile;
      case 'key':
        value = c.key == null
            ? null
            : (argResults!['reveal'] as bool ? c.key : redactKey(c.key));
      default:
        throw CliException.usage("unknown field '$field' (base | key | profile)",
            fields: {'field': field});
    }
    out.result({field: value}, () => value ?? '(unset)');
    return ExitCodes.ok;
  }
}

class _ConfigSet extends SlopcafeCommand {
  _ConfigSet() {
    argParser.addOption('profile',
        help: 'Profile to write to (default: the resolved profile).');
  }

  @override
  String get name => 'set';
  @override
  String get description =>
      'Persist a setting: base | key | default-profile.';
  @override
  String get invocation => 'slopcafe config set <base|key|default-profile> <value>';

  @override
  Future<int> run() async {
    final rest = argResults!.rest;
    if (rest.length != 2) {
      throw CliException.usage(
        'expected <field> <value> (field: base | key | default-profile)',
      );
    }
    final field = rest[0];
    final value = rest[1];
    final path = configPathFor(env);

    ConfigFile file;
    try {
      file = loadConfigFile(path) ?? ConfigFile();
    } on FormatException catch (e) {
      throw CliException.usage('malformed config at $path: ${e.message}');
    }

    // The profile to write to: explicit --profile, else the file's default,
    // else "default".
    final profileName = (argResults!['profile'] as String?) ??
        file.defaultProfile ??
        'default';

    switch (field) {
      case 'default-profile':
        file = ConfigFile(defaultProfile: value, profiles: file.profiles);
      case 'base':
      case 'key':
        final entry = file.profiles[profileName] ?? ProfileEntry();
        file.profiles[profileName] = ProfileEntry(
          base: field == 'base' ? value : entry.base,
          key: field == 'key' ? value : entry.key,
        );
        // First write to a fresh file establishes the default profile.
        if (file.defaultProfile == null) {
          file = ConfigFile(defaultProfile: profileName, profiles: file.profiles);
        }
      default:
        throw CliException.usage(
          "unknown field '$field' (base | key | default-profile)",
          fields: {'field': field},
        );
    }

    saveConfigFile(path, file);
    final shown = field == 'key' ? redactKey(value) : value;
    out.result(
      {'set': field, 'profile': profileName, 'value': field == 'key' ? redactKey(value) : value},
      () => '✓ set $field = $shown'
          '${field == 'default-profile' ? '' : ' (profile $profileName)'}\n  $path',
    );
    return ExitCodes.ok;
  }
}

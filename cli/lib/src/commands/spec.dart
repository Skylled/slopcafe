// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

import 'dart:convert';

import '../command_base.dart';
import '../errors.dart';

/// `slopcafe spec` — fetch the backend's OpenAPI document (`GET /openapi.json`).
class SpecCommand extends SlopcafeCommand {
  SpecCommand() {
    argParser.addOption('output',
        abbr: 'o', help: 'Write the spec to a file instead of stdout.');
  }

  @override
  String get name => 'spec';

  @override
  String get description =>
      'Fetch the live OpenAPI 3.1 spec (GET /openapi.json).';

  @override
  Future<int> run() async {
    final client = buildClient();
    try {
      final spec = await client.openapi();
      final pretty = const JsonEncoder.withIndent('  ').convert(spec);
      emitBody(utf8.encode(pretty), argResults!['output'] as String?);
      return ExitCodes.ok;
    } finally {
      client.close();
    }
  }
}

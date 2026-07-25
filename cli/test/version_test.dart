// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

import 'dart:convert';
import 'dart:io';

import 'package:slopcafe_cli/src/runner.dart';
import 'package:test/test.dart';

/// Drift guard for the two places the build identifies itself.
///
/// `cliVersion` (runner.dart) is what `--version` prints; `pubspec.yaml`'s
/// `version:` is what `dart pub global list` prints. They once said 0.3.0 and
/// 0.1.0 — so an operator debugging a field report could not tell which build
/// was installed from either number. Dart can't read the pubspec at runtime
/// without a build step, so the constant leads and this test enforces the
/// mirror. Bumping a release means editing both.
void main() {
  test('cliVersion matches the pubspec version', () {
    final pubspec = File('pubspec.yaml').readAsStringSync();
    final match = RegExp(
      r'^version:\s*(\S+)\s*$',
      multiLine: true,
    ).firstMatch(pubspec);
    expect(match, isNotNull, reason: 'pubspec.yaml has no `version:` line');
    expect(
      match!.group(1),
      cliVersion,
      reason: 'pubspec.yaml `version:` must mirror cliVersion in '
          'lib/src/runner.dart — bump both together',
    );
  });

  test('contractVersion matches the pinned tool/CONTRACT_VERSION', () {
    final pinned = File('tool/CONTRACT_VERSION').readAsStringSync().trim();
    expect(
      pinned,
      contractVersion,
      reason: 'tool/CONTRACT_VERSION is the spec lib/api/ was generated from; '
          're-pin it and contractVersion together',
    );
  });

  // The two above compare hand-edited constants to each other, which cannot
  // catch the failure that actually happened: the pin sat at 1.5.0 while the
  // backend moved to 2.0.0, and every test stayed green because nothing
  // compared a pin to the SPEC or to the GENERATED output. These two close
  // that loop — the cheapest insurance against repeating the same drift at 3.0.
  test('CONTRACT_VERSION matches the pinned spec it names', () {
    final spec = jsonDecode(File('tool/openapi.json').readAsStringSync())
        as Map<String, dynamic>;
    final specVersion = (spec['info'] as Map<String, dynamic>)['version'];
    expect(
      specVersion,
      contractVersion,
      reason: 'tool/openapi.json declares info.version $specVersion but the CLI '
          'claims contract $contractVersion — re-copy the spec, or fix the pin',
    );
  });

  test('generated lib/api/ was regenerated from the current pin', () {
    // The generator stamps the contract version into every file it writes, so
    // a stale banner means `dart run tool/generate_api.dart` was not re-run
    // after the pin moved — i.e. the models on disk describe an older wire.
    for (final f in ['lib/api/models.dart', 'lib/api/error_code.dart']) {
      final header = File(f).readAsLinesSync().take(4).join('\n');
      expect(
        header,
        contains('contract $contractVersion'),
        reason: '$f was generated from a different contract than '
            'contractVersion ($contractVersion) — re-run the generator '
            '(see cli/README.md "Development")',
      );
    }
  });
}

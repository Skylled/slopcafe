// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

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
}

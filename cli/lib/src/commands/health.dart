// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

import '../../api/api.dart';
import '../command_base.dart';
import '../errors.dart';

/// `slopcafe health` — `GET /healthz` (public).
class HealthCommand extends SlopcafeCommand {
  @override
  String get name => 'health';

  @override
  String get description => 'Check service health (GET /healthz).';

  @override
  Future<int> run() async {
    final client = buildClient();
    try {
      final r = await client.health();
      out.result(r.toJson(), () => _human(r));
      return r.ok ? ExitCodes.ok : ExitCodes.failure;
    } finally {
      client.close();
    }
  }

  String _human(HealthzResponse r) {
    return [
      '${r.ok ? '✓' : '✗'} ${r.service} — ${r.ok ? 'healthy' : 'UNHEALTHY'}',
      '  sanitizer ${r.sanitizerVersion} · storage cap ${r.storageCapBytes} bytes',
      '  d1: documents=${r.d1.documents ?? '?'} agents=${r.d1.agents ?? '?'}',
      '  r2: reachable=${r.r2.bucketReachable} sample=${r.r2.sampleObjectCount}',
    ].join('\n');
  }
}

/// `slopcafe whoami` — verify the configured key is accepted (auth probe).
class WhoamiCommand extends SlopcafeCommand {
  @override
  String get name => 'whoami';

  @override
  String get description =>
      'Verify the configured agent key is accepted by the server.';

  @override
  Future<int> run() async {
    final c = resolveConfig();
    final client = buildClient();
    try {
      final accepted = await client.probeAuth();
      out.result(
        {'base': c.baseUrl, 'profile': c.profile, 'accepted': accepted},
        () => accepted
            ? '✓ key accepted by ${c.baseUrl} (profile ${c.profile})'
            : '✗ key rejected by ${c.baseUrl} (401)',
      );
      return accepted ? ExitCodes.ok : ExitCodes.noPermission;
    } finally {
      client.close();
    }
  }
}

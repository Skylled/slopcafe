// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

import '../../api/api.dart';
import '../client.dart';
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

/// `slopcafe whoami` — verify that the configured base URL really is a Slopcafe
/// instance **and** that the configured key is accepted there.
///
/// Both halves matter. Confirming only "not a 401" made any other answer read
/// as success: a base pointing at a proxy that 200s everything, a parked
/// domain, or a Cloudflare challenge page all printed "✓ key accepted" — after
/// the agent key had already been sent to the wrong host. So the probe first
/// asks the public `GET /healthz` for the service envelope, and the report
/// always names the base URL it checked.
class WhoamiCommand extends SlopcafeCommand {
  @override
  String get name => 'whoami';

  @override
  String get description =>
      'Verify the configured base URL is a Slopcafe instance and the key is accepted.';

  @override
  Future<int> run() async {
    final c = resolveConfig();
    final client = buildClient();
    try {
      final r = await client.probeAuth();
      final json = {
        'base': c.baseUrl,
        'profile': c.profile,
        'service': r.service,
        'status': r.statusCode,
        'accepted': r.accepted,
      };
      switch (r.outcome) {
        case ProbeOutcome.accepted:
          out.result(
            json,
            () => '✓ key accepted by ${c.baseUrl} '
                '(service ${r.service}, profile ${c.profile})',
          );
          return ExitCodes.ok;
        case ProbeOutcome.rejected:
          out.result(
            json,
            () => '✗ key rejected by ${c.baseUrl} '
                '(HTTP ${r.statusCode}, profile ${c.profile})',
          );
          return ExitCodes.noPermission;
        case ProbeOutcome.notSlopcafe:
          throw CliException(
            '${c.baseUrl} does not look like a Slopcafe instance — '
            'GET /healthz answered HTTP ${r.statusCode ?? '?'} without the '
            'service envelope. Check --base / SLOPCAFE_BASE / the '
            '"${c.profile}" profile before sending your key there.',
            errorCode: CliErrorCodes.notSlopcafe,
            status: r.statusCode,
            fields: {'base': c.baseUrl, 'profile': c.profile},
          );
        case ProbeOutcome.unexpected:
          throw CliException(
            'could not verify the key against ${c.baseUrl}: the auth probe '
            'answered HTTP ${r.statusCode ?? '?'}, which is neither accepted '
            '(404/2xx) nor rejected (401/403).',
            errorCode: CliErrorCodes.badResponse,
            status: r.statusCode,
            fields: {'base': c.baseUrl, 'profile': c.profile},
          );
      }
    } finally {
      client.close();
    }
  }
}

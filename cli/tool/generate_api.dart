// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

// Slopcafe API model generator.
//
// A dev-only, pure-Dart script (no Flutter imports) that reads the pinned
// OpenAPI spec at `tool/openapi.json` and emits Dart source under `lib/api/`:
//
//   * lib/api/models.dart      — freezed + json_serializable data classes for
//                                every JSON request/response body the spec
//                                models, with correct OpenAPI-3.1 nullability.
//   * lib/api/error_code.dart  — the `ErrorCode` enum, derived from the 28
//                                discriminants of the `ErrorBody` oneOf union.
//
// After running this, the EXISTING build_runner + freezed pipeline turns
// models.dart into models.freezed.dart / models.g.dart. The full reproducible
// flow (see GEMINI.md) is:
//
//   dart run tool/generate_api.dart
//   dart run build_runner build --delete-conflicting-outputs
//
// Why a bespoke generator instead of swagger_dart_code_generator: that package
// does not support OpenAPI 3.1, emits NON-nullable fields for the spec's
// `{"anyOf":[{"type":T},{"type":"null"}]}` nullables (a runtime crash on revoked
// docs), cannot turn the `oneOf` error envelope into an enum, and produces
// Chopper + json_annotation output that clashes with this repo's freezed/dio
// stack. This focused script handles exactly the constructs this one pinned
// spec uses and emits idiomatic freezed that matches the existing toolchain.
//
// Re-pin + re-run whenever the backend bumps `info.version` (recorded in
// tool/CONTRACT_VERSION).

import 'dart:convert';
import 'dart:io';

// ---------------------------------------------------------------------------
// Configuration — the small amount of app-specific knowledge the spec can't
// encode. Everything else is derived generically from components.schemas.
// ---------------------------------------------------------------------------

/// Component schemas that are string enums in the spec. The app keeps these as
/// plain `String`s (the values are preserved) to avoid churning the ~15
/// `visibility == 'public'` / `matchedField.toUpperCase()` call sites; the task
/// mandates only the `ErrorCode` enum. Referenced via `$ref` -> `String`.
const _stringEnumSchemas = {
  'Visibility',
  'SourceFormat',
  'SlugReject',
  'DocumentStatus',
};

/// oneOf unions we do not emit as plain data classes. `ErrorBody` becomes the
/// `ErrorCode` enum (handled separately); `DeleteOAuthClientResponse` is an
/// either-or shape whose body the app never reads (the delete returns void).
const _skipSchemas = {'ErrorBody', 'DeleteOAuthClientResponse'};

/// `type: number` properties that should be Dart `double` rather than `int`.
/// Everything else (versions, sizes, counts) is an integer in practice.
const _doubleProps = {'score'};

/// Names for inline array-item / nested objects, keyed by `Schema.property`.
/// These give the app the ergonomic class names it already uses; anything not
/// listed gets an auto-derived `ParentProperty` name.
const _inlineNames = {
  'ListAgentsResponse.agents': 'AgentListing',
  'ListAgentKeysResponse.keys': 'AgentKey',
};

void main() {
  final root = Directory.current.path;
  final spec =
      jsonDecode(File('$root/tool/openapi.json').readAsStringSync())
          as Map<String, dynamic>;
  final contractVersion = File('$root/tool/CONTRACT_VERSION').existsSync()
      ? File('$root/tool/CONTRACT_VERSION').readAsStringSync().trim()
      : (spec['info']?['version']?.toString() ?? 'unknown');

  final schemas = (spec['components']['schemas'] as Map)
      .cast<String, dynamic>();

  final gen = _Generator(schemas, contractVersion);
  gen.run();

  Directory('$root/lib/api').createSync(recursive: true);
  const modelsPath = 'lib/api/models.dart';
  const errorPath = 'lib/api/error_code.dart';
  File('$root/$modelsPath').writeAsStringSync(gen.modelsSource());
  File('$root/$errorPath').writeAsStringSync(gen.errorSource());

  // Normalise formatting so the emitted source is idempotent under `dart format`
  // and matches the rest of the repo.
  final fmt = Process.runSync('dart', ['format', modelsPath, errorPath]);
  if (fmt.exitCode != 0) {
    stderr.writeln('Warning: dart format failed:\n${fmt.stderr}');
  }

  stdout.writeln(
    'Generated $modelsPath (${gen.classCount} classes) '
    'and $errorPath (${gen.errorCodeCount} codes) '
    'from contract $contractVersion.',
  );
}

/// One Dart field of a generated class.
class _Field {
  _Field(this.dartName, this.jsonKey, this.type, this.required);
  final String dartName;
  final String jsonKey;
  final String type; // e.g. 'String', 'int?', 'List<String>', 'AgentKey'
  final bool required; // emit `required` (non-nullable, no default)
}

class _Generator {
  _Generator(this.schemas, this.contractVersion);

  final Map<String, dynamic> schemas;
  final String contractVersion;

  /// className -> ordered fields. Insertion order is the emit order.
  final Map<String, List<_Field>> _classes = {};

  int get classCount => _classes.length;
  int get errorCodeCount => _errorCodes.length;

  late final List<MapEntry<String, String>> _errorCodes; // wire -> dartName

  void run() {
    // Top-level object schemas (skip enums + the oneOf unions).
    for (final entry in schemas.entries) {
      final name = entry.key;
      if (_stringEnumSchemas.contains(name) || _skipSchemas.contains(name)) {
        continue;
      }
      final schema = entry.value as Map<String, dynamic>;
      if (schema['type'] == 'object' && schema['properties'] is Map) {
        _registerObject(name, schema);
      }
    }
    _errorCodes = _collectErrorCodes();
  }

  /// Register an object schema (and recursively any inline object properties)
  /// as a generated class.
  void _registerObject(String className, Map<String, dynamic> schema) {
    if (_classes.containsKey(className)) return;
    _classes[className] = []; // reserve name to break recursion
    final props = (schema['properties'] as Map).cast<String, dynamic>();
    final requiredList =
        (schema['required'] as List?)?.cast<String>() ?? const [];

    final fields = <_Field>[];
    props.forEach((jsonKey, rawProp) {
      final prop = rawProp as Map<String, dynamic>;
      final (type, nullable) = _resolveType(prop, className, jsonKey);
      // A property is `required` (non-nullable, no default) only when the spec
      // lists it as required AND it is not an anyOf-null nullable.
      final isRequired = requiredList.contains(jsonKey) && !nullable;
      // `dynamic` is already nullable; never decorate it with `?`.
      final dartType = (nullable && type != 'dynamic' && !type.endsWith('?'))
          ? '$type?'
          : type;
      fields.add(_Field(_camel(jsonKey), jsonKey, dartType, isRequired));
    });
    _classes[className] = fields;
  }

  /// Resolve a property schema to a Dart type. Returns (type, nullable).
  (String, bool) _resolveType(
    Map<String, dynamic> prop,
    String owner,
    String jsonKey,
  ) {
    // 3.1 nullability: {"anyOf":[{...}, {"type":"null"}]} -> nullable inner.
    if (prop['anyOf'] is List) {
      final branches = (prop['anyOf'] as List).cast<Map<String, dynamic>>();
      final nonNull = branches.where((b) => b['type'] != 'null').toList();
      final hasNull = branches.any((b) => b['type'] == 'null');
      if (nonNull.length == 1) {
        final (t, innerNull) = _resolveType(nonNull.first, owner, jsonKey);
        return (t, hasNull || innerNull);
      }
      // Unexpected multi-branch anyOf — fall back to dynamic (none in this spec).
      return ('dynamic', true);
    }

    if (prop[r'$ref'] is String) {
      final refName = (prop[r'$ref'] as String).split('/').last;
      if (_stringEnumSchemas.contains(refName)) return ('String', false);
      // Reference to another object schema — ensure it is emitted.
      final target = schemas[refName];
      if (target is Map<String, dynamic> && target['type'] == 'object') {
        _registerObject(refName, target);
        return (refName, false);
      }
      return ('dynamic', false);
    }

    final type = prop['type'];

    if (type == 'array') {
      final items =
          (prop['items'] as Map?)?.cast<String, dynamic>() ?? const {};
      // Resolve the item under the array's own key so inline-object items pick
      // up `_inlineNames['Owner.prop']` overrides (e.g. agents -> AgentListing).
      final (itemType, _) = _resolveType(items, owner, jsonKey);
      return ('List<$itemType>', false);
    }

    if (type == 'object' && prop['properties'] is Map) {
      // Inline nested object — emit a dedicated class.
      final inlineName =
          _inlineNames['$owner.$jsonKey'] ?? '$owner${_pascal(jsonKey)}';
      _registerObject(inlineName, prop);
      return (inlineName, false);
    }

    switch (type) {
      case 'string':
        // Date-time fields are spec-typed as plain strings; the `_at` suffix is
        // the app's long-standing convention for ISO-8601 timestamps.
        if (jsonKey.endsWith('_at')) return ('DateTime', false);
        return ('String', false);
      case 'number':
      case 'integer':
        return (_doubleProps.contains(jsonKey) ? 'double' : 'int', false);
      case 'boolean':
        return ('bool', false);
      case 'null':
        return ('dynamic', true);
      default:
        // enum-only inline (e.g. matched_field) or untyped -> String/dynamic.
        if (prop['enum'] is List) return ('String', false);
        return ('dynamic', false);
    }
  }

  /// Collect the 28 `error` const discriminants from the ErrorBody oneOf.
  List<MapEntry<String, String>> _collectErrorCodes() {
    final errorBody = schemas['ErrorBody'] as Map<String, dynamic>?;
    final variants = (errorBody?['oneOf'] as List?) ?? const [];
    final out = <MapEntry<String, String>>[];
    final seen = <String>{};
    for (final v in variants) {
      final wire = (v as Map)['properties']?['error']?['const'] as String?;
      if (wire == null || !seen.add(wire)) continue;
      out.add(MapEntry(wire, _camel(wire)));
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  String _banner() =>
      '// GENERATED by tool/generate_api.dart from tool/openapi.json\n'
      '// (Slopcafe API contract $contractVersion). DO NOT EDIT BY HAND.\n'
      '// Re-run `dart run tool/generate_api.dart && dart run build_runner build`\n'
      '// after re-pinning the spec. See GEMINI.md.\n';

  String modelsSource() {
    final b = StringBuffer();
    b.writeln(_banner());
    b.writeln('// ignore_for_file: invalid_annotation_target');
    b.writeln();
    b.writeln("import 'package:freezed_annotation/freezed_annotation.dart';");
    b.writeln();
    b.writeln("part 'models.freezed.dart';");
    b.writeln("part 'models.g.dart';");
    b.writeln();
    for (final entry in _classes.entries) {
      b.write(_renderClass(entry.key, entry.value));
      b.writeln();
    }
    return b.toString();
  }

  String _renderClass(String name, List<_Field> fields) {
    final extras = _extraMembers(name, fields);
    final b = StringBuffer();
    b.writeln('@freezed');
    b.writeln('abstract class $name with _\$$name {');
    // Private ctor is required to host custom getters / convenience factories.
    if (extras.isNotEmpty) b.writeln('  const $name._();');
    b.writeln('  const factory $name({');
    // Emit required (non-nullable) fields first, then optionals, so generated
    // constructors read naturally.
    final ordered = [
      ...fields.where((f) => f.required),
      ...fields.where((f) => !f.required),
    ];
    for (final f in ordered) {
      final req = f.required ? 'required ' : '';
      b.writeln(
        "    @JsonKey(name: '${f.jsonKey}') $req${f.type} ${f.dartName},",
      );
    }
    b.writeln('  }) = _$name;');
    if (extras.isNotEmpty) {
      b.writeln();
      for (final m in extras) {
        b.writeln('  $m');
      }
    }
    b.writeln();
    b.writeln('  factory $name.fromJson(Map<String, dynamic> json) =>');
    b.writeln('      _\$${name}FromJson(json);');
    b.writeln('}');
    return b.toString();
  }

  /// App-specific convenience members injected into a few generated classes.
  List<String> _extraMembers(String name, List<_Field> fields) {
    switch (name) {
      case 'DocumentListing':
        return ['bool get isRevoked => revokedAt != null;'];
      case 'AgentKey':
        // A key authenticates only while not revoked AND not expired (the
        // server-computed `expired` flag, per the HTTP API contract); this
        // mirrors the backend's `active_keys` accounting. `isActive` is the
        // surface the UI buckets on so a lapsed (but un-revoked) short-lived
        // publish credential is no longer shown as a live, revocable key.
        return [
          'bool get isRevoked => revokedAt != null;',
          'bool get isActive => !isRevoked && !expired;',
        ];
      case 'SearchHit':
        return _searchHitExtras(fields);
      default:
        return const [];
    }
  }

  /// `SearchHit` is flat in the spec (every DocumentListing field inline, plus
  /// score/matched_field/snippet). The app reads `hit.document` as a
  /// DocumentListing and builds hits locally for the offline-search fallback,
  /// so expose a `document` view + a `fromDocument` factory over the flat shape.
  List<String> _searchHitExtras(List<_Field> hitFields) {
    final docFields = _classes['DocumentListing'] ?? const [];
    final getterArgs = docFields
        .map((f) => '        ${f.dartName}: ${f.dartName},')
        .join('\n');
    final factoryArgs = docFields
        .map((f) => '      ${f.dartName}: doc.${f.dartName},')
        .join('\n');
    return [
      '/// The listing slice of this hit (the fields shared with DocumentListing).\n'
          '  DocumentListing get document => DocumentListing(\n$getterArgs\n      );',
      '/// Build a hit from a listing — used by the offline local-search fallback.\n'
          '  factory SearchHit.fromDocument(\n'
          '    DocumentListing doc, {\n'
          '    required double score,\n'
          '    required String matchedField,\n'
          '    required String snippet,\n'
          '  }) =>\n'
          '      SearchHit(\n$factoryArgs\n'
          '        score: score,\n'
          '        matchedField: matchedField,\n'
          '        snippet: snippet,\n'
          '      );',
    ];
  }

  String errorSource() {
    final b = StringBuffer();
    b.writeln(_banner());
    b.writeln(
      '/// Canonical Slopcafe API error codes — the discriminants of the',
    );
    b.writeln(
      '/// `ErrorBody` oneOf union (the `error` field). Parse a wire value',
    );
    b.writeln(
      '/// with [ErrorCode.fromWire]; unknown/forward-compat codes resolve to',
    );
    b.writeln(
      '/// [ErrorCode.unknown]. See lib/api/api_error.dart for envelope parsing.',
    );
    b.writeln('enum ErrorCode {');
    for (final e in _errorCodes) {
      b.writeln("  ${e.value}('${e.key}'),");
    }
    b.writeln(
      '  /// Not part of the contract — a code this build does not recognise.',
    );
    b.writeln("  unknown('');");
    b.writeln();
    b.writeln('  const ErrorCode(this.wire);');
    b.writeln();
    b.writeln('  /// The on-the-wire string sent by the backend.');
    b.writeln('  final String wire;');
    b.writeln();
    b.writeln(
      '  /// Resolve a wire string to a code, falling back to [unknown].',
    );
    b.writeln('  static ErrorCode fromWire(String? wire) {');
    b.writeln('    if (wire == null) return ErrorCode.unknown;');
    b.writeln('    for (final c in ErrorCode.values) {');
    b.writeln('      if (c.wire == wire) return c;');
    b.writeln('    }');
    b.writeln('    return ErrorCode.unknown;');
    b.writeln('  }');
    b.writeln('}');
    return b.toString();
  }

  // -------------------------------------------------------------------------
  // Name helpers
  // -------------------------------------------------------------------------

  static String _camel(String snake) {
    final parts = snake.split(RegExp(r'[_\s]+'));
    final head = parts.first;
    final tail = parts.skip(1).map(_capitalize).join();
    return '$head$tail';
  }

  static String _pascal(String snake) => _capitalize(_camel(snake));

  static String _capitalize(String s) =>
      s.isEmpty ? s : '${s[0].toUpperCase()}${s.substring(1)}';
}

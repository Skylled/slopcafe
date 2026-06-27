// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

import 'package:dio/dio.dart';

import 'error_code.dart';

/// A typed, app-facing view over the backend's `ErrorBody` JSON envelope
/// (`{ "error": <code>, "message": <text>, ...extra }`).
///
/// This is the hand-written glue that bridges the generated [ErrorCode] enum
/// (lib/api/error_code.dart) to the way the app actually receives failures —
/// thrown [DioException]s. JSON-modelled admin/write/listing routes return the
/// envelope; raw/HTML routes (e.g. `/d/{id}/raw`) do not, in which case the
/// code falls back to [ErrorCode.unknown] and callers should rely on the HTTP
/// status code instead.
class ApiError implements Exception {
  const ApiError({
    required this.code,
    this.message,
    this.statusCode,
    this.fields = const {},
  });

  /// The contract error code (or [ErrorCode.unknown] for non-envelope bodies).
  final ErrorCode code;

  /// The server-supplied human message, if any.
  final String? message;

  /// The HTTP status code, when known.
  final int? statusCode;

  /// The full decoded envelope, exposing discriminant-specific extras
  /// (`slug`, `client_id`, `hint`, `limit`, ...). Empty for non-JSON bodies.
  final Map<String, dynamic> fields;

  /// Parse from a decoded response body + status code.
  factory ApiError.fromResponse(int? statusCode, Object? data) {
    if (data is Map) {
      final map = Map<String, dynamic>.from(data);
      final error = map['error'];
      final message = map['message'];
      return ApiError(
        code: ErrorCode.fromWire(error is String ? error : null),
        message: message is String ? message : null,
        statusCode: statusCode,
        fields: map,
      );
    }
    return ApiError(code: ErrorCode.unknown, statusCode: statusCode);
  }

  /// Parse from a thrown error. Recognises [DioException] (the common case) and
  /// passes [ApiError] through; anything else becomes an [ErrorCode.unknown]
  /// error carrying the raw text.
  factory ApiError.fromException(Object error) {
    if (error is ApiError) return error;
    if (error is DioException) {
      return ApiError.fromResponse(
        error.response?.statusCode,
        error.response?.data,
      );
    }
    return ApiError(code: ErrorCode.unknown, message: error.toString());
  }

  /// Best-effort human-readable string for surfacing in toasts/banners: the
  /// backend's `message` when present, otherwise the raw error text. Lets call
  /// sites drop `e.toString()` (which renders ugly `DioException [...]` text)
  /// in favour of the contract's own message.
  static String describe(Object error) {
    final apiError = ApiError.fromException(error);
    final message = apiError.message;
    if (message != null && message.isNotEmpty) return message;
    return error.toString();
  }

  // Discriminant-specific fields, present only for the relevant codes.
  String? get slug => fields['slug'] as String?;
  String? get clientId => fields['client_id'] as String?;
  String? get hint => fields['hint'] as String?;

  @override
  String toString() {
    final label = code == ErrorCode.unknown ? 'unknown' : code.wire;
    return 'ApiError($label${message != null ? ': $message' : ''})';
  }
}

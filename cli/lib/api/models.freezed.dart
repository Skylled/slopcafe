// GENERATED CODE - DO NOT MODIFY BY HAND
// coverage:ignore-file
// ignore_for_file: type=lint
// ignore_for_file: unused_element, deprecated_member_use, deprecated_member_use_from_same_package, use_function_type_syntax_for_parameters, unnecessary_const, avoid_init_to_null, invalid_override_different_default_values_named, prefer_expression_function_bodies, annotate_overrides, invalid_annotation_target, unnecessary_question_mark

part of 'models.dart';

// **************************************************************************
// FreezedGenerator
// **************************************************************************

// dart format off
T _$identity<T>(T value) => value;

/// @nodoc
mixin _$BackfillResponse {

@JsonKey(name: 'mode') String get mode;@JsonKey(name: 'scanned') int get scanned;@JsonKey(name: 'embedded') int get embedded;@JsonKey(name: 'vectors') int get vectors;@JsonKey(name: 'skipped') int get skipped;@JsonKey(name: 'next_cursor') String? get nextCursor;
/// Create a copy of BackfillResponse
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$BackfillResponseCopyWith<BackfillResponse> get copyWith => _$BackfillResponseCopyWithImpl<BackfillResponse>(this as BackfillResponse, _$identity);

  /// Serializes this BackfillResponse to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is BackfillResponse&&(identical(other.mode, mode) || other.mode == mode)&&(identical(other.scanned, scanned) || other.scanned == scanned)&&(identical(other.embedded, embedded) || other.embedded == embedded)&&(identical(other.vectors, vectors) || other.vectors == vectors)&&(identical(other.skipped, skipped) || other.skipped == skipped)&&(identical(other.nextCursor, nextCursor) || other.nextCursor == nextCursor));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,mode,scanned,embedded,vectors,skipped,nextCursor);

@override
String toString() {
  return 'BackfillResponse(mode: $mode, scanned: $scanned, embedded: $embedded, vectors: $vectors, skipped: $skipped, nextCursor: $nextCursor)';
}


}

/// @nodoc
abstract mixin class $BackfillResponseCopyWith<$Res>  {
  factory $BackfillResponseCopyWith(BackfillResponse value, $Res Function(BackfillResponse) _then) = _$BackfillResponseCopyWithImpl;
@useResult
$Res call({
@JsonKey(name: 'mode') String mode,@JsonKey(name: 'scanned') int scanned,@JsonKey(name: 'embedded') int embedded,@JsonKey(name: 'vectors') int vectors,@JsonKey(name: 'skipped') int skipped,@JsonKey(name: 'next_cursor') String? nextCursor
});




}
/// @nodoc
class _$BackfillResponseCopyWithImpl<$Res>
    implements $BackfillResponseCopyWith<$Res> {
  _$BackfillResponseCopyWithImpl(this._self, this._then);

  final BackfillResponse _self;
  final $Res Function(BackfillResponse) _then;

/// Create a copy of BackfillResponse
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? mode = null,Object? scanned = null,Object? embedded = null,Object? vectors = null,Object? skipped = null,Object? nextCursor = freezed,}) {
  return _then(_self.copyWith(
mode: null == mode ? _self.mode : mode // ignore: cast_nullable_to_non_nullable
as String,scanned: null == scanned ? _self.scanned : scanned // ignore: cast_nullable_to_non_nullable
as int,embedded: null == embedded ? _self.embedded : embedded // ignore: cast_nullable_to_non_nullable
as int,vectors: null == vectors ? _self.vectors : vectors // ignore: cast_nullable_to_non_nullable
as int,skipped: null == skipped ? _self.skipped : skipped // ignore: cast_nullable_to_non_nullable
as int,nextCursor: freezed == nextCursor ? _self.nextCursor : nextCursor // ignore: cast_nullable_to_non_nullable
as String?,
  ));
}

}


/// Adds pattern-matching-related methods to [BackfillResponse].
extension BackfillResponsePatterns on BackfillResponse {
/// A variant of `map` that fallback to returning `orElse`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _BackfillResponse value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _BackfillResponse() when $default != null:
return $default(_that);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// Callbacks receives the raw object, upcasted.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case final Subclass2 value:
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _BackfillResponse value)  $default,){
final _that = this;
switch (_that) {
case _BackfillResponse():
return $default(_that);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `map` that fallback to returning `null`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _BackfillResponse value)?  $default,){
final _that = this;
switch (_that) {
case _BackfillResponse() when $default != null:
return $default(_that);case _:
  return null;

}
}
/// A variant of `when` that fallback to an `orElse` callback.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function(@JsonKey(name: 'mode')  String mode, @JsonKey(name: 'scanned')  int scanned, @JsonKey(name: 'embedded')  int embedded, @JsonKey(name: 'vectors')  int vectors, @JsonKey(name: 'skipped')  int skipped, @JsonKey(name: 'next_cursor')  String? nextCursor)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _BackfillResponse() when $default != null:
return $default(_that.mode,_that.scanned,_that.embedded,_that.vectors,_that.skipped,_that.nextCursor);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// As opposed to `map`, this offers destructuring.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case Subclass2(:final field2):
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function(@JsonKey(name: 'mode')  String mode, @JsonKey(name: 'scanned')  int scanned, @JsonKey(name: 'embedded')  int embedded, @JsonKey(name: 'vectors')  int vectors, @JsonKey(name: 'skipped')  int skipped, @JsonKey(name: 'next_cursor')  String? nextCursor)  $default,) {final _that = this;
switch (_that) {
case _BackfillResponse():
return $default(_that.mode,_that.scanned,_that.embedded,_that.vectors,_that.skipped,_that.nextCursor);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `when` that fallback to returning `null`
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function(@JsonKey(name: 'mode')  String mode, @JsonKey(name: 'scanned')  int scanned, @JsonKey(name: 'embedded')  int embedded, @JsonKey(name: 'vectors')  int vectors, @JsonKey(name: 'skipped')  int skipped, @JsonKey(name: 'next_cursor')  String? nextCursor)?  $default,) {final _that = this;
switch (_that) {
case _BackfillResponse() when $default != null:
return $default(_that.mode,_that.scanned,_that.embedded,_that.vectors,_that.skipped,_that.nextCursor);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _BackfillResponse implements BackfillResponse {
  const _BackfillResponse({@JsonKey(name: 'mode') required this.mode, @JsonKey(name: 'scanned') required this.scanned, @JsonKey(name: 'embedded') required this.embedded, @JsonKey(name: 'vectors') required this.vectors, @JsonKey(name: 'skipped') required this.skipped, @JsonKey(name: 'next_cursor') this.nextCursor});
  factory _BackfillResponse.fromJson(Map<String, dynamic> json) => _$BackfillResponseFromJson(json);

@override@JsonKey(name: 'mode') final  String mode;
@override@JsonKey(name: 'scanned') final  int scanned;
@override@JsonKey(name: 'embedded') final  int embedded;
@override@JsonKey(name: 'vectors') final  int vectors;
@override@JsonKey(name: 'skipped') final  int skipped;
@override@JsonKey(name: 'next_cursor') final  String? nextCursor;

/// Create a copy of BackfillResponse
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$BackfillResponseCopyWith<_BackfillResponse> get copyWith => __$BackfillResponseCopyWithImpl<_BackfillResponse>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$BackfillResponseToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _BackfillResponse&&(identical(other.mode, mode) || other.mode == mode)&&(identical(other.scanned, scanned) || other.scanned == scanned)&&(identical(other.embedded, embedded) || other.embedded == embedded)&&(identical(other.vectors, vectors) || other.vectors == vectors)&&(identical(other.skipped, skipped) || other.skipped == skipped)&&(identical(other.nextCursor, nextCursor) || other.nextCursor == nextCursor));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,mode,scanned,embedded,vectors,skipped,nextCursor);

@override
String toString() {
  return 'BackfillResponse(mode: $mode, scanned: $scanned, embedded: $embedded, vectors: $vectors, skipped: $skipped, nextCursor: $nextCursor)';
}


}

/// @nodoc
abstract mixin class _$BackfillResponseCopyWith<$Res> implements $BackfillResponseCopyWith<$Res> {
  factory _$BackfillResponseCopyWith(_BackfillResponse value, $Res Function(_BackfillResponse) _then) = __$BackfillResponseCopyWithImpl;
@override @useResult
$Res call({
@JsonKey(name: 'mode') String mode,@JsonKey(name: 'scanned') int scanned,@JsonKey(name: 'embedded') int embedded,@JsonKey(name: 'vectors') int vectors,@JsonKey(name: 'skipped') int skipped,@JsonKey(name: 'next_cursor') String? nextCursor
});




}
/// @nodoc
class __$BackfillResponseCopyWithImpl<$Res>
    implements _$BackfillResponseCopyWith<$Res> {
  __$BackfillResponseCopyWithImpl(this._self, this._then);

  final _BackfillResponse _self;
  final $Res Function(_BackfillResponse) _then;

/// Create a copy of BackfillResponse
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? mode = null,Object? scanned = null,Object? embedded = null,Object? vectors = null,Object? skipped = null,Object? nextCursor = freezed,}) {
  return _then(_BackfillResponse(
mode: null == mode ? _self.mode : mode // ignore: cast_nullable_to_non_nullable
as String,scanned: null == scanned ? _self.scanned : scanned // ignore: cast_nullable_to_non_nullable
as int,embedded: null == embedded ? _self.embedded : embedded // ignore: cast_nullable_to_non_nullable
as int,vectors: null == vectors ? _self.vectors : vectors // ignore: cast_nullable_to_non_nullable
as int,skipped: null == skipped ? _self.skipped : skipped // ignore: cast_nullable_to_non_nullable
as int,nextCursor: freezed == nextCursor ? _self.nextCursor : nextCursor // ignore: cast_nullable_to_non_nullable
as String?,
  ));
}


}


/// @nodoc
mixin _$ClearSlugRedirectResponse {

@JsonKey(name: 'slug') String get slug;@JsonKey(name: 'redirect_to') dynamic get redirectTo;
/// Create a copy of ClearSlugRedirectResponse
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$ClearSlugRedirectResponseCopyWith<ClearSlugRedirectResponse> get copyWith => _$ClearSlugRedirectResponseCopyWithImpl<ClearSlugRedirectResponse>(this as ClearSlugRedirectResponse, _$identity);

  /// Serializes this ClearSlugRedirectResponse to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ClearSlugRedirectResponse&&(identical(other.slug, slug) || other.slug == slug)&&const DeepCollectionEquality().equals(other.redirectTo, redirectTo));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,slug,const DeepCollectionEquality().hash(redirectTo));

@override
String toString() {
  return 'ClearSlugRedirectResponse(slug: $slug, redirectTo: $redirectTo)';
}


}

/// @nodoc
abstract mixin class $ClearSlugRedirectResponseCopyWith<$Res>  {
  factory $ClearSlugRedirectResponseCopyWith(ClearSlugRedirectResponse value, $Res Function(ClearSlugRedirectResponse) _then) = _$ClearSlugRedirectResponseCopyWithImpl;
@useResult
$Res call({
@JsonKey(name: 'slug') String slug,@JsonKey(name: 'redirect_to') dynamic redirectTo
});




}
/// @nodoc
class _$ClearSlugRedirectResponseCopyWithImpl<$Res>
    implements $ClearSlugRedirectResponseCopyWith<$Res> {
  _$ClearSlugRedirectResponseCopyWithImpl(this._self, this._then);

  final ClearSlugRedirectResponse _self;
  final $Res Function(ClearSlugRedirectResponse) _then;

/// Create a copy of ClearSlugRedirectResponse
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? slug = null,Object? redirectTo = freezed,}) {
  return _then(_self.copyWith(
slug: null == slug ? _self.slug : slug // ignore: cast_nullable_to_non_nullable
as String,redirectTo: freezed == redirectTo ? _self.redirectTo : redirectTo // ignore: cast_nullable_to_non_nullable
as dynamic,
  ));
}

}


/// Adds pattern-matching-related methods to [ClearSlugRedirectResponse].
extension ClearSlugRedirectResponsePatterns on ClearSlugRedirectResponse {
/// A variant of `map` that fallback to returning `orElse`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _ClearSlugRedirectResponse value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _ClearSlugRedirectResponse() when $default != null:
return $default(_that);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// Callbacks receives the raw object, upcasted.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case final Subclass2 value:
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _ClearSlugRedirectResponse value)  $default,){
final _that = this;
switch (_that) {
case _ClearSlugRedirectResponse():
return $default(_that);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `map` that fallback to returning `null`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _ClearSlugRedirectResponse value)?  $default,){
final _that = this;
switch (_that) {
case _ClearSlugRedirectResponse() when $default != null:
return $default(_that);case _:
  return null;

}
}
/// A variant of `when` that fallback to an `orElse` callback.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function(@JsonKey(name: 'slug')  String slug, @JsonKey(name: 'redirect_to')  dynamic redirectTo)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _ClearSlugRedirectResponse() when $default != null:
return $default(_that.slug,_that.redirectTo);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// As opposed to `map`, this offers destructuring.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case Subclass2(:final field2):
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function(@JsonKey(name: 'slug')  String slug, @JsonKey(name: 'redirect_to')  dynamic redirectTo)  $default,) {final _that = this;
switch (_that) {
case _ClearSlugRedirectResponse():
return $default(_that.slug,_that.redirectTo);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `when` that fallback to returning `null`
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function(@JsonKey(name: 'slug')  String slug, @JsonKey(name: 'redirect_to')  dynamic redirectTo)?  $default,) {final _that = this;
switch (_that) {
case _ClearSlugRedirectResponse() when $default != null:
return $default(_that.slug,_that.redirectTo);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _ClearSlugRedirectResponse implements ClearSlugRedirectResponse {
  const _ClearSlugRedirectResponse({@JsonKey(name: 'slug') required this.slug, @JsonKey(name: 'redirect_to') this.redirectTo});
  factory _ClearSlugRedirectResponse.fromJson(Map<String, dynamic> json) => _$ClearSlugRedirectResponseFromJson(json);

@override@JsonKey(name: 'slug') final  String slug;
@override@JsonKey(name: 'redirect_to') final  dynamic redirectTo;

/// Create a copy of ClearSlugRedirectResponse
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$ClearSlugRedirectResponseCopyWith<_ClearSlugRedirectResponse> get copyWith => __$ClearSlugRedirectResponseCopyWithImpl<_ClearSlugRedirectResponse>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$ClearSlugRedirectResponseToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _ClearSlugRedirectResponse&&(identical(other.slug, slug) || other.slug == slug)&&const DeepCollectionEquality().equals(other.redirectTo, redirectTo));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,slug,const DeepCollectionEquality().hash(redirectTo));

@override
String toString() {
  return 'ClearSlugRedirectResponse(slug: $slug, redirectTo: $redirectTo)';
}


}

/// @nodoc
abstract mixin class _$ClearSlugRedirectResponseCopyWith<$Res> implements $ClearSlugRedirectResponseCopyWith<$Res> {
  factory _$ClearSlugRedirectResponseCopyWith(_ClearSlugRedirectResponse value, $Res Function(_ClearSlugRedirectResponse) _then) = __$ClearSlugRedirectResponseCopyWithImpl;
@override @useResult
$Res call({
@JsonKey(name: 'slug') String slug,@JsonKey(name: 'redirect_to') dynamic redirectTo
});




}
/// @nodoc
class __$ClearSlugRedirectResponseCopyWithImpl<$Res>
    implements _$ClearSlugRedirectResponseCopyWith<$Res> {
  __$ClearSlugRedirectResponseCopyWithImpl(this._self, this._then);

  final _ClearSlugRedirectResponse _self;
  final $Res Function(_ClearSlugRedirectResponse) _then;

/// Create a copy of ClearSlugRedirectResponse
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? slug = null,Object? redirectTo = freezed,}) {
  return _then(_ClearSlugRedirectResponse(
slug: null == slug ? _self.slug : slug // ignore: cast_nullable_to_non_nullable
as String,redirectTo: freezed == redirectTo ? _self.redirectTo : redirectTo // ignore: cast_nullable_to_non_nullable
as dynamic,
  ));
}


}


/// @nodoc
mixin _$CreateOAuthClientResponse {

@JsonKey(name: 'client_id') String get clientId;@JsonKey(name: 'client_secret') String get clientSecret;@JsonKey(name: 'mcp_url') String get mcpUrl;@JsonKey(name: 'agent_id') String get agentId;@JsonKey(name: 'agent_name') String get agentName;@JsonKey(name: 'note') String get note;
/// Create a copy of CreateOAuthClientResponse
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$CreateOAuthClientResponseCopyWith<CreateOAuthClientResponse> get copyWith => _$CreateOAuthClientResponseCopyWithImpl<CreateOAuthClientResponse>(this as CreateOAuthClientResponse, _$identity);

  /// Serializes this CreateOAuthClientResponse to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is CreateOAuthClientResponse&&(identical(other.clientId, clientId) || other.clientId == clientId)&&(identical(other.clientSecret, clientSecret) || other.clientSecret == clientSecret)&&(identical(other.mcpUrl, mcpUrl) || other.mcpUrl == mcpUrl)&&(identical(other.agentId, agentId) || other.agentId == agentId)&&(identical(other.agentName, agentName) || other.agentName == agentName)&&(identical(other.note, note) || other.note == note));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,clientId,clientSecret,mcpUrl,agentId,agentName,note);

@override
String toString() {
  return 'CreateOAuthClientResponse(clientId: $clientId, clientSecret: $clientSecret, mcpUrl: $mcpUrl, agentId: $agentId, agentName: $agentName, note: $note)';
}


}

/// @nodoc
abstract mixin class $CreateOAuthClientResponseCopyWith<$Res>  {
  factory $CreateOAuthClientResponseCopyWith(CreateOAuthClientResponse value, $Res Function(CreateOAuthClientResponse) _then) = _$CreateOAuthClientResponseCopyWithImpl;
@useResult
$Res call({
@JsonKey(name: 'client_id') String clientId,@JsonKey(name: 'client_secret') String clientSecret,@JsonKey(name: 'mcp_url') String mcpUrl,@JsonKey(name: 'agent_id') String agentId,@JsonKey(name: 'agent_name') String agentName,@JsonKey(name: 'note') String note
});




}
/// @nodoc
class _$CreateOAuthClientResponseCopyWithImpl<$Res>
    implements $CreateOAuthClientResponseCopyWith<$Res> {
  _$CreateOAuthClientResponseCopyWithImpl(this._self, this._then);

  final CreateOAuthClientResponse _self;
  final $Res Function(CreateOAuthClientResponse) _then;

/// Create a copy of CreateOAuthClientResponse
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? clientId = null,Object? clientSecret = null,Object? mcpUrl = null,Object? agentId = null,Object? agentName = null,Object? note = null,}) {
  return _then(_self.copyWith(
clientId: null == clientId ? _self.clientId : clientId // ignore: cast_nullable_to_non_nullable
as String,clientSecret: null == clientSecret ? _self.clientSecret : clientSecret // ignore: cast_nullable_to_non_nullable
as String,mcpUrl: null == mcpUrl ? _self.mcpUrl : mcpUrl // ignore: cast_nullable_to_non_nullable
as String,agentId: null == agentId ? _self.agentId : agentId // ignore: cast_nullable_to_non_nullable
as String,agentName: null == agentName ? _self.agentName : agentName // ignore: cast_nullable_to_non_nullable
as String,note: null == note ? _self.note : note // ignore: cast_nullable_to_non_nullable
as String,
  ));
}

}


/// Adds pattern-matching-related methods to [CreateOAuthClientResponse].
extension CreateOAuthClientResponsePatterns on CreateOAuthClientResponse {
/// A variant of `map` that fallback to returning `orElse`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _CreateOAuthClientResponse value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _CreateOAuthClientResponse() when $default != null:
return $default(_that);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// Callbacks receives the raw object, upcasted.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case final Subclass2 value:
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _CreateOAuthClientResponse value)  $default,){
final _that = this;
switch (_that) {
case _CreateOAuthClientResponse():
return $default(_that);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `map` that fallback to returning `null`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _CreateOAuthClientResponse value)?  $default,){
final _that = this;
switch (_that) {
case _CreateOAuthClientResponse() when $default != null:
return $default(_that);case _:
  return null;

}
}
/// A variant of `when` that fallback to an `orElse` callback.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function(@JsonKey(name: 'client_id')  String clientId, @JsonKey(name: 'client_secret')  String clientSecret, @JsonKey(name: 'mcp_url')  String mcpUrl, @JsonKey(name: 'agent_id')  String agentId, @JsonKey(name: 'agent_name')  String agentName, @JsonKey(name: 'note')  String note)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _CreateOAuthClientResponse() when $default != null:
return $default(_that.clientId,_that.clientSecret,_that.mcpUrl,_that.agentId,_that.agentName,_that.note);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// As opposed to `map`, this offers destructuring.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case Subclass2(:final field2):
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function(@JsonKey(name: 'client_id')  String clientId, @JsonKey(name: 'client_secret')  String clientSecret, @JsonKey(name: 'mcp_url')  String mcpUrl, @JsonKey(name: 'agent_id')  String agentId, @JsonKey(name: 'agent_name')  String agentName, @JsonKey(name: 'note')  String note)  $default,) {final _that = this;
switch (_that) {
case _CreateOAuthClientResponse():
return $default(_that.clientId,_that.clientSecret,_that.mcpUrl,_that.agentId,_that.agentName,_that.note);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `when` that fallback to returning `null`
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function(@JsonKey(name: 'client_id')  String clientId, @JsonKey(name: 'client_secret')  String clientSecret, @JsonKey(name: 'mcp_url')  String mcpUrl, @JsonKey(name: 'agent_id')  String agentId, @JsonKey(name: 'agent_name')  String agentName, @JsonKey(name: 'note')  String note)?  $default,) {final _that = this;
switch (_that) {
case _CreateOAuthClientResponse() when $default != null:
return $default(_that.clientId,_that.clientSecret,_that.mcpUrl,_that.agentId,_that.agentName,_that.note);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _CreateOAuthClientResponse implements CreateOAuthClientResponse {
  const _CreateOAuthClientResponse({@JsonKey(name: 'client_id') required this.clientId, @JsonKey(name: 'client_secret') required this.clientSecret, @JsonKey(name: 'mcp_url') required this.mcpUrl, @JsonKey(name: 'agent_id') required this.agentId, @JsonKey(name: 'agent_name') required this.agentName, @JsonKey(name: 'note') required this.note});
  factory _CreateOAuthClientResponse.fromJson(Map<String, dynamic> json) => _$CreateOAuthClientResponseFromJson(json);

@override@JsonKey(name: 'client_id') final  String clientId;
@override@JsonKey(name: 'client_secret') final  String clientSecret;
@override@JsonKey(name: 'mcp_url') final  String mcpUrl;
@override@JsonKey(name: 'agent_id') final  String agentId;
@override@JsonKey(name: 'agent_name') final  String agentName;
@override@JsonKey(name: 'note') final  String note;

/// Create a copy of CreateOAuthClientResponse
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$CreateOAuthClientResponseCopyWith<_CreateOAuthClientResponse> get copyWith => __$CreateOAuthClientResponseCopyWithImpl<_CreateOAuthClientResponse>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$CreateOAuthClientResponseToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _CreateOAuthClientResponse&&(identical(other.clientId, clientId) || other.clientId == clientId)&&(identical(other.clientSecret, clientSecret) || other.clientSecret == clientSecret)&&(identical(other.mcpUrl, mcpUrl) || other.mcpUrl == mcpUrl)&&(identical(other.agentId, agentId) || other.agentId == agentId)&&(identical(other.agentName, agentName) || other.agentName == agentName)&&(identical(other.note, note) || other.note == note));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,clientId,clientSecret,mcpUrl,agentId,agentName,note);

@override
String toString() {
  return 'CreateOAuthClientResponse(clientId: $clientId, clientSecret: $clientSecret, mcpUrl: $mcpUrl, agentId: $agentId, agentName: $agentName, note: $note)';
}


}

/// @nodoc
abstract mixin class _$CreateOAuthClientResponseCopyWith<$Res> implements $CreateOAuthClientResponseCopyWith<$Res> {
  factory _$CreateOAuthClientResponseCopyWith(_CreateOAuthClientResponse value, $Res Function(_CreateOAuthClientResponse) _then) = __$CreateOAuthClientResponseCopyWithImpl;
@override @useResult
$Res call({
@JsonKey(name: 'client_id') String clientId,@JsonKey(name: 'client_secret') String clientSecret,@JsonKey(name: 'mcp_url') String mcpUrl,@JsonKey(name: 'agent_id') String agentId,@JsonKey(name: 'agent_name') String agentName,@JsonKey(name: 'note') String note
});




}
/// @nodoc
class __$CreateOAuthClientResponseCopyWithImpl<$Res>
    implements _$CreateOAuthClientResponseCopyWith<$Res> {
  __$CreateOAuthClientResponseCopyWithImpl(this._self, this._then);

  final _CreateOAuthClientResponse _self;
  final $Res Function(_CreateOAuthClientResponse) _then;

/// Create a copy of CreateOAuthClientResponse
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? clientId = null,Object? clientSecret = null,Object? mcpUrl = null,Object? agentId = null,Object? agentName = null,Object? note = null,}) {
  return _then(_CreateOAuthClientResponse(
clientId: null == clientId ? _self.clientId : clientId // ignore: cast_nullable_to_non_nullable
as String,clientSecret: null == clientSecret ? _self.clientSecret : clientSecret // ignore: cast_nullable_to_non_nullable
as String,mcpUrl: null == mcpUrl ? _self.mcpUrl : mcpUrl // ignore: cast_nullable_to_non_nullable
as String,agentId: null == agentId ? _self.agentId : agentId // ignore: cast_nullable_to_non_nullable
as String,agentName: null == agentName ? _self.agentName : agentName // ignore: cast_nullable_to_non_nullable
as String,note: null == note ? _self.note : note // ignore: cast_nullable_to_non_nullable
as String,
  ));
}


}


/// @nodoc
mixin _$CreateUnboundOAuthClientResponse {

@JsonKey(name: 'client_id') String get clientId;@JsonKey(name: 'client_secret') String get clientSecret;@JsonKey(name: 'mcp_url') String get mcpUrl;@JsonKey(name: 'note') String get note;
/// Create a copy of CreateUnboundOAuthClientResponse
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$CreateUnboundOAuthClientResponseCopyWith<CreateUnboundOAuthClientResponse> get copyWith => _$CreateUnboundOAuthClientResponseCopyWithImpl<CreateUnboundOAuthClientResponse>(this as CreateUnboundOAuthClientResponse, _$identity);

  /// Serializes this CreateUnboundOAuthClientResponse to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is CreateUnboundOAuthClientResponse&&(identical(other.clientId, clientId) || other.clientId == clientId)&&(identical(other.clientSecret, clientSecret) || other.clientSecret == clientSecret)&&(identical(other.mcpUrl, mcpUrl) || other.mcpUrl == mcpUrl)&&(identical(other.note, note) || other.note == note));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,clientId,clientSecret,mcpUrl,note);

@override
String toString() {
  return 'CreateUnboundOAuthClientResponse(clientId: $clientId, clientSecret: $clientSecret, mcpUrl: $mcpUrl, note: $note)';
}


}

/// @nodoc
abstract mixin class $CreateUnboundOAuthClientResponseCopyWith<$Res>  {
  factory $CreateUnboundOAuthClientResponseCopyWith(CreateUnboundOAuthClientResponse value, $Res Function(CreateUnboundOAuthClientResponse) _then) = _$CreateUnboundOAuthClientResponseCopyWithImpl;
@useResult
$Res call({
@JsonKey(name: 'client_id') String clientId,@JsonKey(name: 'client_secret') String clientSecret,@JsonKey(name: 'mcp_url') String mcpUrl,@JsonKey(name: 'note') String note
});




}
/// @nodoc
class _$CreateUnboundOAuthClientResponseCopyWithImpl<$Res>
    implements $CreateUnboundOAuthClientResponseCopyWith<$Res> {
  _$CreateUnboundOAuthClientResponseCopyWithImpl(this._self, this._then);

  final CreateUnboundOAuthClientResponse _self;
  final $Res Function(CreateUnboundOAuthClientResponse) _then;

/// Create a copy of CreateUnboundOAuthClientResponse
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? clientId = null,Object? clientSecret = null,Object? mcpUrl = null,Object? note = null,}) {
  return _then(_self.copyWith(
clientId: null == clientId ? _self.clientId : clientId // ignore: cast_nullable_to_non_nullable
as String,clientSecret: null == clientSecret ? _self.clientSecret : clientSecret // ignore: cast_nullable_to_non_nullable
as String,mcpUrl: null == mcpUrl ? _self.mcpUrl : mcpUrl // ignore: cast_nullable_to_non_nullable
as String,note: null == note ? _self.note : note // ignore: cast_nullable_to_non_nullable
as String,
  ));
}

}


/// Adds pattern-matching-related methods to [CreateUnboundOAuthClientResponse].
extension CreateUnboundOAuthClientResponsePatterns on CreateUnboundOAuthClientResponse {
/// A variant of `map` that fallback to returning `orElse`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _CreateUnboundOAuthClientResponse value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _CreateUnboundOAuthClientResponse() when $default != null:
return $default(_that);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// Callbacks receives the raw object, upcasted.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case final Subclass2 value:
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _CreateUnboundOAuthClientResponse value)  $default,){
final _that = this;
switch (_that) {
case _CreateUnboundOAuthClientResponse():
return $default(_that);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `map` that fallback to returning `null`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _CreateUnboundOAuthClientResponse value)?  $default,){
final _that = this;
switch (_that) {
case _CreateUnboundOAuthClientResponse() when $default != null:
return $default(_that);case _:
  return null;

}
}
/// A variant of `when` that fallback to an `orElse` callback.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function(@JsonKey(name: 'client_id')  String clientId, @JsonKey(name: 'client_secret')  String clientSecret, @JsonKey(name: 'mcp_url')  String mcpUrl, @JsonKey(name: 'note')  String note)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _CreateUnboundOAuthClientResponse() when $default != null:
return $default(_that.clientId,_that.clientSecret,_that.mcpUrl,_that.note);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// As opposed to `map`, this offers destructuring.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case Subclass2(:final field2):
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function(@JsonKey(name: 'client_id')  String clientId, @JsonKey(name: 'client_secret')  String clientSecret, @JsonKey(name: 'mcp_url')  String mcpUrl, @JsonKey(name: 'note')  String note)  $default,) {final _that = this;
switch (_that) {
case _CreateUnboundOAuthClientResponse():
return $default(_that.clientId,_that.clientSecret,_that.mcpUrl,_that.note);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `when` that fallback to returning `null`
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function(@JsonKey(name: 'client_id')  String clientId, @JsonKey(name: 'client_secret')  String clientSecret, @JsonKey(name: 'mcp_url')  String mcpUrl, @JsonKey(name: 'note')  String note)?  $default,) {final _that = this;
switch (_that) {
case _CreateUnboundOAuthClientResponse() when $default != null:
return $default(_that.clientId,_that.clientSecret,_that.mcpUrl,_that.note);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _CreateUnboundOAuthClientResponse implements CreateUnboundOAuthClientResponse {
  const _CreateUnboundOAuthClientResponse({@JsonKey(name: 'client_id') required this.clientId, @JsonKey(name: 'client_secret') required this.clientSecret, @JsonKey(name: 'mcp_url') required this.mcpUrl, @JsonKey(name: 'note') required this.note});
  factory _CreateUnboundOAuthClientResponse.fromJson(Map<String, dynamic> json) => _$CreateUnboundOAuthClientResponseFromJson(json);

@override@JsonKey(name: 'client_id') final  String clientId;
@override@JsonKey(name: 'client_secret') final  String clientSecret;
@override@JsonKey(name: 'mcp_url') final  String mcpUrl;
@override@JsonKey(name: 'note') final  String note;

/// Create a copy of CreateUnboundOAuthClientResponse
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$CreateUnboundOAuthClientResponseCopyWith<_CreateUnboundOAuthClientResponse> get copyWith => __$CreateUnboundOAuthClientResponseCopyWithImpl<_CreateUnboundOAuthClientResponse>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$CreateUnboundOAuthClientResponseToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _CreateUnboundOAuthClientResponse&&(identical(other.clientId, clientId) || other.clientId == clientId)&&(identical(other.clientSecret, clientSecret) || other.clientSecret == clientSecret)&&(identical(other.mcpUrl, mcpUrl) || other.mcpUrl == mcpUrl)&&(identical(other.note, note) || other.note == note));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,clientId,clientSecret,mcpUrl,note);

@override
String toString() {
  return 'CreateUnboundOAuthClientResponse(clientId: $clientId, clientSecret: $clientSecret, mcpUrl: $mcpUrl, note: $note)';
}


}

/// @nodoc
abstract mixin class _$CreateUnboundOAuthClientResponseCopyWith<$Res> implements $CreateUnboundOAuthClientResponseCopyWith<$Res> {
  factory _$CreateUnboundOAuthClientResponseCopyWith(_CreateUnboundOAuthClientResponse value, $Res Function(_CreateUnboundOAuthClientResponse) _then) = __$CreateUnboundOAuthClientResponseCopyWithImpl;
@override @useResult
$Res call({
@JsonKey(name: 'client_id') String clientId,@JsonKey(name: 'client_secret') String clientSecret,@JsonKey(name: 'mcp_url') String mcpUrl,@JsonKey(name: 'note') String note
});




}
/// @nodoc
class __$CreateUnboundOAuthClientResponseCopyWithImpl<$Res>
    implements _$CreateUnboundOAuthClientResponseCopyWith<$Res> {
  __$CreateUnboundOAuthClientResponseCopyWithImpl(this._self, this._then);

  final _CreateUnboundOAuthClientResponse _self;
  final $Res Function(_CreateUnboundOAuthClientResponse) _then;

/// Create a copy of CreateUnboundOAuthClientResponse
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? clientId = null,Object? clientSecret = null,Object? mcpUrl = null,Object? note = null,}) {
  return _then(_CreateUnboundOAuthClientResponse(
clientId: null == clientId ? _self.clientId : clientId // ignore: cast_nullable_to_non_nullable
as String,clientSecret: null == clientSecret ? _self.clientSecret : clientSecret // ignore: cast_nullable_to_non_nullable
as String,mcpUrl: null == mcpUrl ? _self.mcpUrl : mcpUrl // ignore: cast_nullable_to_non_nullable
as String,note: null == note ? _self.note : note // ignore: cast_nullable_to_non_nullable
as String,
  ));
}


}


/// @nodoc
mixin _$DocumentLinksResponse {

@JsonKey(name: 'public_id') String get publicId;@JsonKey(name: 'backlinks') List<DocumentListing> get backlinks;@JsonKey(name: 'outbound') List<OutboundLink> get outbound;
/// Create a copy of DocumentLinksResponse
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$DocumentLinksResponseCopyWith<DocumentLinksResponse> get copyWith => _$DocumentLinksResponseCopyWithImpl<DocumentLinksResponse>(this as DocumentLinksResponse, _$identity);

  /// Serializes this DocumentLinksResponse to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is DocumentLinksResponse&&(identical(other.publicId, publicId) || other.publicId == publicId)&&const DeepCollectionEquality().equals(other.backlinks, backlinks)&&const DeepCollectionEquality().equals(other.outbound, outbound));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,publicId,const DeepCollectionEquality().hash(backlinks),const DeepCollectionEquality().hash(outbound));

@override
String toString() {
  return 'DocumentLinksResponse(publicId: $publicId, backlinks: $backlinks, outbound: $outbound)';
}


}

/// @nodoc
abstract mixin class $DocumentLinksResponseCopyWith<$Res>  {
  factory $DocumentLinksResponseCopyWith(DocumentLinksResponse value, $Res Function(DocumentLinksResponse) _then) = _$DocumentLinksResponseCopyWithImpl;
@useResult
$Res call({
@JsonKey(name: 'public_id') String publicId,@JsonKey(name: 'backlinks') List<DocumentListing> backlinks,@JsonKey(name: 'outbound') List<OutboundLink> outbound
});




}
/// @nodoc
class _$DocumentLinksResponseCopyWithImpl<$Res>
    implements $DocumentLinksResponseCopyWith<$Res> {
  _$DocumentLinksResponseCopyWithImpl(this._self, this._then);

  final DocumentLinksResponse _self;
  final $Res Function(DocumentLinksResponse) _then;

/// Create a copy of DocumentLinksResponse
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? publicId = null,Object? backlinks = null,Object? outbound = null,}) {
  return _then(_self.copyWith(
publicId: null == publicId ? _self.publicId : publicId // ignore: cast_nullable_to_non_nullable
as String,backlinks: null == backlinks ? _self.backlinks : backlinks // ignore: cast_nullable_to_non_nullable
as List<DocumentListing>,outbound: null == outbound ? _self.outbound : outbound // ignore: cast_nullable_to_non_nullable
as List<OutboundLink>,
  ));
}

}


/// Adds pattern-matching-related methods to [DocumentLinksResponse].
extension DocumentLinksResponsePatterns on DocumentLinksResponse {
/// A variant of `map` that fallback to returning `orElse`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _DocumentLinksResponse value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _DocumentLinksResponse() when $default != null:
return $default(_that);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// Callbacks receives the raw object, upcasted.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case final Subclass2 value:
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _DocumentLinksResponse value)  $default,){
final _that = this;
switch (_that) {
case _DocumentLinksResponse():
return $default(_that);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `map` that fallback to returning `null`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _DocumentLinksResponse value)?  $default,){
final _that = this;
switch (_that) {
case _DocumentLinksResponse() when $default != null:
return $default(_that);case _:
  return null;

}
}
/// A variant of `when` that fallback to an `orElse` callback.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function(@JsonKey(name: 'public_id')  String publicId, @JsonKey(name: 'backlinks')  List<DocumentListing> backlinks, @JsonKey(name: 'outbound')  List<OutboundLink> outbound)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _DocumentLinksResponse() when $default != null:
return $default(_that.publicId,_that.backlinks,_that.outbound);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// As opposed to `map`, this offers destructuring.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case Subclass2(:final field2):
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function(@JsonKey(name: 'public_id')  String publicId, @JsonKey(name: 'backlinks')  List<DocumentListing> backlinks, @JsonKey(name: 'outbound')  List<OutboundLink> outbound)  $default,) {final _that = this;
switch (_that) {
case _DocumentLinksResponse():
return $default(_that.publicId,_that.backlinks,_that.outbound);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `when` that fallback to returning `null`
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function(@JsonKey(name: 'public_id')  String publicId, @JsonKey(name: 'backlinks')  List<DocumentListing> backlinks, @JsonKey(name: 'outbound')  List<OutboundLink> outbound)?  $default,) {final _that = this;
switch (_that) {
case _DocumentLinksResponse() when $default != null:
return $default(_that.publicId,_that.backlinks,_that.outbound);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _DocumentLinksResponse implements DocumentLinksResponse {
  const _DocumentLinksResponse({@JsonKey(name: 'public_id') required this.publicId, @JsonKey(name: 'backlinks') required final  List<DocumentListing> backlinks, @JsonKey(name: 'outbound') required final  List<OutboundLink> outbound}): _backlinks = backlinks,_outbound = outbound;
  factory _DocumentLinksResponse.fromJson(Map<String, dynamic> json) => _$DocumentLinksResponseFromJson(json);

@override@JsonKey(name: 'public_id') final  String publicId;
 final  List<DocumentListing> _backlinks;
@override@JsonKey(name: 'backlinks') List<DocumentListing> get backlinks {
  if (_backlinks is EqualUnmodifiableListView) return _backlinks;
  // ignore: implicit_dynamic_type
  return EqualUnmodifiableListView(_backlinks);
}

 final  List<OutboundLink> _outbound;
@override@JsonKey(name: 'outbound') List<OutboundLink> get outbound {
  if (_outbound is EqualUnmodifiableListView) return _outbound;
  // ignore: implicit_dynamic_type
  return EqualUnmodifiableListView(_outbound);
}


/// Create a copy of DocumentLinksResponse
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$DocumentLinksResponseCopyWith<_DocumentLinksResponse> get copyWith => __$DocumentLinksResponseCopyWithImpl<_DocumentLinksResponse>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$DocumentLinksResponseToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _DocumentLinksResponse&&(identical(other.publicId, publicId) || other.publicId == publicId)&&const DeepCollectionEquality().equals(other._backlinks, _backlinks)&&const DeepCollectionEquality().equals(other._outbound, _outbound));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,publicId,const DeepCollectionEquality().hash(_backlinks),const DeepCollectionEquality().hash(_outbound));

@override
String toString() {
  return 'DocumentLinksResponse(publicId: $publicId, backlinks: $backlinks, outbound: $outbound)';
}


}

/// @nodoc
abstract mixin class _$DocumentLinksResponseCopyWith<$Res> implements $DocumentLinksResponseCopyWith<$Res> {
  factory _$DocumentLinksResponseCopyWith(_DocumentLinksResponse value, $Res Function(_DocumentLinksResponse) _then) = __$DocumentLinksResponseCopyWithImpl;
@override @useResult
$Res call({
@JsonKey(name: 'public_id') String publicId,@JsonKey(name: 'backlinks') List<DocumentListing> backlinks,@JsonKey(name: 'outbound') List<OutboundLink> outbound
});




}
/// @nodoc
class __$DocumentLinksResponseCopyWithImpl<$Res>
    implements _$DocumentLinksResponseCopyWith<$Res> {
  __$DocumentLinksResponseCopyWithImpl(this._self, this._then);

  final _DocumentLinksResponse _self;
  final $Res Function(_DocumentLinksResponse) _then;

/// Create a copy of DocumentLinksResponse
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? publicId = null,Object? backlinks = null,Object? outbound = null,}) {
  return _then(_DocumentLinksResponse(
publicId: null == publicId ? _self.publicId : publicId // ignore: cast_nullable_to_non_nullable
as String,backlinks: null == backlinks ? _self._backlinks : backlinks // ignore: cast_nullable_to_non_nullable
as List<DocumentListing>,outbound: null == outbound ? _self._outbound : outbound // ignore: cast_nullable_to_non_nullable
as List<OutboundLink>,
  ));
}


}


/// @nodoc
mixin _$DocumentListing {

@JsonKey(name: 'public_id') String get publicId;@JsonKey(name: 'created_at') DateTime get createdAt;@JsonKey(name: 'created_by_kind') String get createdByKind;@JsonKey(name: 'tags') List<String> get tags;@JsonKey(name: 'status') String get status;@JsonKey(name: 'visibility') String get visibility;@JsonKey(name: 'current_ver') int? get currentVer;@JsonKey(name: 'created_by_id') String? get createdById;@JsonKey(name: 'created_by_name') String? get createdByName;@JsonKey(name: 'current_size') int? get currentSize;@JsonKey(name: 'current_source_sha256') String? get currentSourceSha256;@JsonKey(name: 'revoked_at') DateTime? get revokedAt;@JsonKey(name: 'title') String? get title;@JsonKey(name: 'description') String? get description;@JsonKey(name: 'slug') String? get slug;@JsonKey(name: 'superseded_by') String? get supersededBy;
/// Create a copy of DocumentListing
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$DocumentListingCopyWith<DocumentListing> get copyWith => _$DocumentListingCopyWithImpl<DocumentListing>(this as DocumentListing, _$identity);

  /// Serializes this DocumentListing to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is DocumentListing&&(identical(other.publicId, publicId) || other.publicId == publicId)&&(identical(other.createdAt, createdAt) || other.createdAt == createdAt)&&(identical(other.createdByKind, createdByKind) || other.createdByKind == createdByKind)&&const DeepCollectionEquality().equals(other.tags, tags)&&(identical(other.status, status) || other.status == status)&&(identical(other.visibility, visibility) || other.visibility == visibility)&&(identical(other.currentVer, currentVer) || other.currentVer == currentVer)&&(identical(other.createdById, createdById) || other.createdById == createdById)&&(identical(other.createdByName, createdByName) || other.createdByName == createdByName)&&(identical(other.currentSize, currentSize) || other.currentSize == currentSize)&&(identical(other.currentSourceSha256, currentSourceSha256) || other.currentSourceSha256 == currentSourceSha256)&&(identical(other.revokedAt, revokedAt) || other.revokedAt == revokedAt)&&(identical(other.title, title) || other.title == title)&&(identical(other.description, description) || other.description == description)&&(identical(other.slug, slug) || other.slug == slug)&&(identical(other.supersededBy, supersededBy) || other.supersededBy == supersededBy));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,publicId,createdAt,createdByKind,const DeepCollectionEquality().hash(tags),status,visibility,currentVer,createdById,createdByName,currentSize,currentSourceSha256,revokedAt,title,description,slug,supersededBy);

@override
String toString() {
  return 'DocumentListing(publicId: $publicId, createdAt: $createdAt, createdByKind: $createdByKind, tags: $tags, status: $status, visibility: $visibility, currentVer: $currentVer, createdById: $createdById, createdByName: $createdByName, currentSize: $currentSize, currentSourceSha256: $currentSourceSha256, revokedAt: $revokedAt, title: $title, description: $description, slug: $slug, supersededBy: $supersededBy)';
}


}

/// @nodoc
abstract mixin class $DocumentListingCopyWith<$Res>  {
  factory $DocumentListingCopyWith(DocumentListing value, $Res Function(DocumentListing) _then) = _$DocumentListingCopyWithImpl;
@useResult
$Res call({
@JsonKey(name: 'public_id') String publicId,@JsonKey(name: 'created_at') DateTime createdAt,@JsonKey(name: 'created_by_kind') String createdByKind,@JsonKey(name: 'tags') List<String> tags,@JsonKey(name: 'status') String status,@JsonKey(name: 'visibility') String visibility,@JsonKey(name: 'current_ver') int? currentVer,@JsonKey(name: 'created_by_id') String? createdById,@JsonKey(name: 'created_by_name') String? createdByName,@JsonKey(name: 'current_size') int? currentSize,@JsonKey(name: 'current_source_sha256') String? currentSourceSha256,@JsonKey(name: 'revoked_at') DateTime? revokedAt,@JsonKey(name: 'title') String? title,@JsonKey(name: 'description') String? description,@JsonKey(name: 'slug') String? slug,@JsonKey(name: 'superseded_by') String? supersededBy
});




}
/// @nodoc
class _$DocumentListingCopyWithImpl<$Res>
    implements $DocumentListingCopyWith<$Res> {
  _$DocumentListingCopyWithImpl(this._self, this._then);

  final DocumentListing _self;
  final $Res Function(DocumentListing) _then;

/// Create a copy of DocumentListing
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? publicId = null,Object? createdAt = null,Object? createdByKind = null,Object? tags = null,Object? status = null,Object? visibility = null,Object? currentVer = freezed,Object? createdById = freezed,Object? createdByName = freezed,Object? currentSize = freezed,Object? currentSourceSha256 = freezed,Object? revokedAt = freezed,Object? title = freezed,Object? description = freezed,Object? slug = freezed,Object? supersededBy = freezed,}) {
  return _then(_self.copyWith(
publicId: null == publicId ? _self.publicId : publicId // ignore: cast_nullable_to_non_nullable
as String,createdAt: null == createdAt ? _self.createdAt : createdAt // ignore: cast_nullable_to_non_nullable
as DateTime,createdByKind: null == createdByKind ? _self.createdByKind : createdByKind // ignore: cast_nullable_to_non_nullable
as String,tags: null == tags ? _self.tags : tags // ignore: cast_nullable_to_non_nullable
as List<String>,status: null == status ? _self.status : status // ignore: cast_nullable_to_non_nullable
as String,visibility: null == visibility ? _self.visibility : visibility // ignore: cast_nullable_to_non_nullable
as String,currentVer: freezed == currentVer ? _self.currentVer : currentVer // ignore: cast_nullable_to_non_nullable
as int?,createdById: freezed == createdById ? _self.createdById : createdById // ignore: cast_nullable_to_non_nullable
as String?,createdByName: freezed == createdByName ? _self.createdByName : createdByName // ignore: cast_nullable_to_non_nullable
as String?,currentSize: freezed == currentSize ? _self.currentSize : currentSize // ignore: cast_nullable_to_non_nullable
as int?,currentSourceSha256: freezed == currentSourceSha256 ? _self.currentSourceSha256 : currentSourceSha256 // ignore: cast_nullable_to_non_nullable
as String?,revokedAt: freezed == revokedAt ? _self.revokedAt : revokedAt // ignore: cast_nullable_to_non_nullable
as DateTime?,title: freezed == title ? _self.title : title // ignore: cast_nullable_to_non_nullable
as String?,description: freezed == description ? _self.description : description // ignore: cast_nullable_to_non_nullable
as String?,slug: freezed == slug ? _self.slug : slug // ignore: cast_nullable_to_non_nullable
as String?,supersededBy: freezed == supersededBy ? _self.supersededBy : supersededBy // ignore: cast_nullable_to_non_nullable
as String?,
  ));
}

}


/// Adds pattern-matching-related methods to [DocumentListing].
extension DocumentListingPatterns on DocumentListing {
/// A variant of `map` that fallback to returning `orElse`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _DocumentListing value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _DocumentListing() when $default != null:
return $default(_that);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// Callbacks receives the raw object, upcasted.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case final Subclass2 value:
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _DocumentListing value)  $default,){
final _that = this;
switch (_that) {
case _DocumentListing():
return $default(_that);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `map` that fallback to returning `null`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _DocumentListing value)?  $default,){
final _that = this;
switch (_that) {
case _DocumentListing() when $default != null:
return $default(_that);case _:
  return null;

}
}
/// A variant of `when` that fallback to an `orElse` callback.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function(@JsonKey(name: 'public_id')  String publicId, @JsonKey(name: 'created_at')  DateTime createdAt, @JsonKey(name: 'created_by_kind')  String createdByKind, @JsonKey(name: 'tags')  List<String> tags, @JsonKey(name: 'status')  String status, @JsonKey(name: 'visibility')  String visibility, @JsonKey(name: 'current_ver')  int? currentVer, @JsonKey(name: 'created_by_id')  String? createdById, @JsonKey(name: 'created_by_name')  String? createdByName, @JsonKey(name: 'current_size')  int? currentSize, @JsonKey(name: 'current_source_sha256')  String? currentSourceSha256, @JsonKey(name: 'revoked_at')  DateTime? revokedAt, @JsonKey(name: 'title')  String? title, @JsonKey(name: 'description')  String? description, @JsonKey(name: 'slug')  String? slug, @JsonKey(name: 'superseded_by')  String? supersededBy)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _DocumentListing() when $default != null:
return $default(_that.publicId,_that.createdAt,_that.createdByKind,_that.tags,_that.status,_that.visibility,_that.currentVer,_that.createdById,_that.createdByName,_that.currentSize,_that.currentSourceSha256,_that.revokedAt,_that.title,_that.description,_that.slug,_that.supersededBy);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// As opposed to `map`, this offers destructuring.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case Subclass2(:final field2):
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function(@JsonKey(name: 'public_id')  String publicId, @JsonKey(name: 'created_at')  DateTime createdAt, @JsonKey(name: 'created_by_kind')  String createdByKind, @JsonKey(name: 'tags')  List<String> tags, @JsonKey(name: 'status')  String status, @JsonKey(name: 'visibility')  String visibility, @JsonKey(name: 'current_ver')  int? currentVer, @JsonKey(name: 'created_by_id')  String? createdById, @JsonKey(name: 'created_by_name')  String? createdByName, @JsonKey(name: 'current_size')  int? currentSize, @JsonKey(name: 'current_source_sha256')  String? currentSourceSha256, @JsonKey(name: 'revoked_at')  DateTime? revokedAt, @JsonKey(name: 'title')  String? title, @JsonKey(name: 'description')  String? description, @JsonKey(name: 'slug')  String? slug, @JsonKey(name: 'superseded_by')  String? supersededBy)  $default,) {final _that = this;
switch (_that) {
case _DocumentListing():
return $default(_that.publicId,_that.createdAt,_that.createdByKind,_that.tags,_that.status,_that.visibility,_that.currentVer,_that.createdById,_that.createdByName,_that.currentSize,_that.currentSourceSha256,_that.revokedAt,_that.title,_that.description,_that.slug,_that.supersededBy);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `when` that fallback to returning `null`
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function(@JsonKey(name: 'public_id')  String publicId, @JsonKey(name: 'created_at')  DateTime createdAt, @JsonKey(name: 'created_by_kind')  String createdByKind, @JsonKey(name: 'tags')  List<String> tags, @JsonKey(name: 'status')  String status, @JsonKey(name: 'visibility')  String visibility, @JsonKey(name: 'current_ver')  int? currentVer, @JsonKey(name: 'created_by_id')  String? createdById, @JsonKey(name: 'created_by_name')  String? createdByName, @JsonKey(name: 'current_size')  int? currentSize, @JsonKey(name: 'current_source_sha256')  String? currentSourceSha256, @JsonKey(name: 'revoked_at')  DateTime? revokedAt, @JsonKey(name: 'title')  String? title, @JsonKey(name: 'description')  String? description, @JsonKey(name: 'slug')  String? slug, @JsonKey(name: 'superseded_by')  String? supersededBy)?  $default,) {final _that = this;
switch (_that) {
case _DocumentListing() when $default != null:
return $default(_that.publicId,_that.createdAt,_that.createdByKind,_that.tags,_that.status,_that.visibility,_that.currentVer,_that.createdById,_that.createdByName,_that.currentSize,_that.currentSourceSha256,_that.revokedAt,_that.title,_that.description,_that.slug,_that.supersededBy);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _DocumentListing extends DocumentListing {
  const _DocumentListing({@JsonKey(name: 'public_id') required this.publicId, @JsonKey(name: 'created_at') required this.createdAt, @JsonKey(name: 'created_by_kind') required this.createdByKind, @JsonKey(name: 'tags') required final  List<String> tags, @JsonKey(name: 'status') required this.status, @JsonKey(name: 'visibility') required this.visibility, @JsonKey(name: 'current_ver') this.currentVer, @JsonKey(name: 'created_by_id') this.createdById, @JsonKey(name: 'created_by_name') this.createdByName, @JsonKey(name: 'current_size') this.currentSize, @JsonKey(name: 'current_source_sha256') this.currentSourceSha256, @JsonKey(name: 'revoked_at') this.revokedAt, @JsonKey(name: 'title') this.title, @JsonKey(name: 'description') this.description, @JsonKey(name: 'slug') this.slug, @JsonKey(name: 'superseded_by') this.supersededBy}): _tags = tags,super._();
  factory _DocumentListing.fromJson(Map<String, dynamic> json) => _$DocumentListingFromJson(json);

@override@JsonKey(name: 'public_id') final  String publicId;
@override@JsonKey(name: 'created_at') final  DateTime createdAt;
@override@JsonKey(name: 'created_by_kind') final  String createdByKind;
 final  List<String> _tags;
@override@JsonKey(name: 'tags') List<String> get tags {
  if (_tags is EqualUnmodifiableListView) return _tags;
  // ignore: implicit_dynamic_type
  return EqualUnmodifiableListView(_tags);
}

@override@JsonKey(name: 'status') final  String status;
@override@JsonKey(name: 'visibility') final  String visibility;
@override@JsonKey(name: 'current_ver') final  int? currentVer;
@override@JsonKey(name: 'created_by_id') final  String? createdById;
@override@JsonKey(name: 'created_by_name') final  String? createdByName;
@override@JsonKey(name: 'current_size') final  int? currentSize;
@override@JsonKey(name: 'current_source_sha256') final  String? currentSourceSha256;
@override@JsonKey(name: 'revoked_at') final  DateTime? revokedAt;
@override@JsonKey(name: 'title') final  String? title;
@override@JsonKey(name: 'description') final  String? description;
@override@JsonKey(name: 'slug') final  String? slug;
@override@JsonKey(name: 'superseded_by') final  String? supersededBy;

/// Create a copy of DocumentListing
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$DocumentListingCopyWith<_DocumentListing> get copyWith => __$DocumentListingCopyWithImpl<_DocumentListing>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$DocumentListingToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _DocumentListing&&(identical(other.publicId, publicId) || other.publicId == publicId)&&(identical(other.createdAt, createdAt) || other.createdAt == createdAt)&&(identical(other.createdByKind, createdByKind) || other.createdByKind == createdByKind)&&const DeepCollectionEquality().equals(other._tags, _tags)&&(identical(other.status, status) || other.status == status)&&(identical(other.visibility, visibility) || other.visibility == visibility)&&(identical(other.currentVer, currentVer) || other.currentVer == currentVer)&&(identical(other.createdById, createdById) || other.createdById == createdById)&&(identical(other.createdByName, createdByName) || other.createdByName == createdByName)&&(identical(other.currentSize, currentSize) || other.currentSize == currentSize)&&(identical(other.currentSourceSha256, currentSourceSha256) || other.currentSourceSha256 == currentSourceSha256)&&(identical(other.revokedAt, revokedAt) || other.revokedAt == revokedAt)&&(identical(other.title, title) || other.title == title)&&(identical(other.description, description) || other.description == description)&&(identical(other.slug, slug) || other.slug == slug)&&(identical(other.supersededBy, supersededBy) || other.supersededBy == supersededBy));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,publicId,createdAt,createdByKind,const DeepCollectionEquality().hash(_tags),status,visibility,currentVer,createdById,createdByName,currentSize,currentSourceSha256,revokedAt,title,description,slug,supersededBy);

@override
String toString() {
  return 'DocumentListing(publicId: $publicId, createdAt: $createdAt, createdByKind: $createdByKind, tags: $tags, status: $status, visibility: $visibility, currentVer: $currentVer, createdById: $createdById, createdByName: $createdByName, currentSize: $currentSize, currentSourceSha256: $currentSourceSha256, revokedAt: $revokedAt, title: $title, description: $description, slug: $slug, supersededBy: $supersededBy)';
}


}

/// @nodoc
abstract mixin class _$DocumentListingCopyWith<$Res> implements $DocumentListingCopyWith<$Res> {
  factory _$DocumentListingCopyWith(_DocumentListing value, $Res Function(_DocumentListing) _then) = __$DocumentListingCopyWithImpl;
@override @useResult
$Res call({
@JsonKey(name: 'public_id') String publicId,@JsonKey(name: 'created_at') DateTime createdAt,@JsonKey(name: 'created_by_kind') String createdByKind,@JsonKey(name: 'tags') List<String> tags,@JsonKey(name: 'status') String status,@JsonKey(name: 'visibility') String visibility,@JsonKey(name: 'current_ver') int? currentVer,@JsonKey(name: 'created_by_id') String? createdById,@JsonKey(name: 'created_by_name') String? createdByName,@JsonKey(name: 'current_size') int? currentSize,@JsonKey(name: 'current_source_sha256') String? currentSourceSha256,@JsonKey(name: 'revoked_at') DateTime? revokedAt,@JsonKey(name: 'title') String? title,@JsonKey(name: 'description') String? description,@JsonKey(name: 'slug') String? slug,@JsonKey(name: 'superseded_by') String? supersededBy
});




}
/// @nodoc
class __$DocumentListingCopyWithImpl<$Res>
    implements _$DocumentListingCopyWith<$Res> {
  __$DocumentListingCopyWithImpl(this._self, this._then);

  final _DocumentListing _self;
  final $Res Function(_DocumentListing) _then;

/// Create a copy of DocumentListing
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? publicId = null,Object? createdAt = null,Object? createdByKind = null,Object? tags = null,Object? status = null,Object? visibility = null,Object? currentVer = freezed,Object? createdById = freezed,Object? createdByName = freezed,Object? currentSize = freezed,Object? currentSourceSha256 = freezed,Object? revokedAt = freezed,Object? title = freezed,Object? description = freezed,Object? slug = freezed,Object? supersededBy = freezed,}) {
  return _then(_DocumentListing(
publicId: null == publicId ? _self.publicId : publicId // ignore: cast_nullable_to_non_nullable
as String,createdAt: null == createdAt ? _self.createdAt : createdAt // ignore: cast_nullable_to_non_nullable
as DateTime,createdByKind: null == createdByKind ? _self.createdByKind : createdByKind // ignore: cast_nullable_to_non_nullable
as String,tags: null == tags ? _self._tags : tags // ignore: cast_nullable_to_non_nullable
as List<String>,status: null == status ? _self.status : status // ignore: cast_nullable_to_non_nullable
as String,visibility: null == visibility ? _self.visibility : visibility // ignore: cast_nullable_to_non_nullable
as String,currentVer: freezed == currentVer ? _self.currentVer : currentVer // ignore: cast_nullable_to_non_nullable
as int?,createdById: freezed == createdById ? _self.createdById : createdById // ignore: cast_nullable_to_non_nullable
as String?,createdByName: freezed == createdByName ? _self.createdByName : createdByName // ignore: cast_nullable_to_non_nullable
as String?,currentSize: freezed == currentSize ? _self.currentSize : currentSize // ignore: cast_nullable_to_non_nullable
as int?,currentSourceSha256: freezed == currentSourceSha256 ? _self.currentSourceSha256 : currentSourceSha256 // ignore: cast_nullable_to_non_nullable
as String?,revokedAt: freezed == revokedAt ? _self.revokedAt : revokedAt // ignore: cast_nullable_to_non_nullable
as DateTime?,title: freezed == title ? _self.title : title // ignore: cast_nullable_to_non_nullable
as String?,description: freezed == description ? _self.description : description // ignore: cast_nullable_to_non_nullable
as String?,slug: freezed == slug ? _self.slug : slug // ignore: cast_nullable_to_non_nullable
as String?,supersededBy: freezed == supersededBy ? _self.supersededBy : supersededBy // ignore: cast_nullable_to_non_nullable
as String?,
  ));
}


}


/// @nodoc
mixin _$OutboundLink {

@JsonKey(name: 'kind') String get kind;@JsonKey(name: 'value') String get value;@JsonKey(name: 'state') String get state;@JsonKey(name: 'target_public_id') String? get targetPublicId;@JsonKey(name: 'title') String? get title;
/// Create a copy of OutboundLink
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$OutboundLinkCopyWith<OutboundLink> get copyWith => _$OutboundLinkCopyWithImpl<OutboundLink>(this as OutboundLink, _$identity);

  /// Serializes this OutboundLink to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is OutboundLink&&(identical(other.kind, kind) || other.kind == kind)&&(identical(other.value, value) || other.value == value)&&(identical(other.state, state) || other.state == state)&&(identical(other.targetPublicId, targetPublicId) || other.targetPublicId == targetPublicId)&&(identical(other.title, title) || other.title == title));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,kind,value,state,targetPublicId,title);

@override
String toString() {
  return 'OutboundLink(kind: $kind, value: $value, state: $state, targetPublicId: $targetPublicId, title: $title)';
}


}

/// @nodoc
abstract mixin class $OutboundLinkCopyWith<$Res>  {
  factory $OutboundLinkCopyWith(OutboundLink value, $Res Function(OutboundLink) _then) = _$OutboundLinkCopyWithImpl;
@useResult
$Res call({
@JsonKey(name: 'kind') String kind,@JsonKey(name: 'value') String value,@JsonKey(name: 'state') String state,@JsonKey(name: 'target_public_id') String? targetPublicId,@JsonKey(name: 'title') String? title
});




}
/// @nodoc
class _$OutboundLinkCopyWithImpl<$Res>
    implements $OutboundLinkCopyWith<$Res> {
  _$OutboundLinkCopyWithImpl(this._self, this._then);

  final OutboundLink _self;
  final $Res Function(OutboundLink) _then;

/// Create a copy of OutboundLink
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? kind = null,Object? value = null,Object? state = null,Object? targetPublicId = freezed,Object? title = freezed,}) {
  return _then(_self.copyWith(
kind: null == kind ? _self.kind : kind // ignore: cast_nullable_to_non_nullable
as String,value: null == value ? _self.value : value // ignore: cast_nullable_to_non_nullable
as String,state: null == state ? _self.state : state // ignore: cast_nullable_to_non_nullable
as String,targetPublicId: freezed == targetPublicId ? _self.targetPublicId : targetPublicId // ignore: cast_nullable_to_non_nullable
as String?,title: freezed == title ? _self.title : title // ignore: cast_nullable_to_non_nullable
as String?,
  ));
}

}


/// Adds pattern-matching-related methods to [OutboundLink].
extension OutboundLinkPatterns on OutboundLink {
/// A variant of `map` that fallback to returning `orElse`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _OutboundLink value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _OutboundLink() when $default != null:
return $default(_that);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// Callbacks receives the raw object, upcasted.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case final Subclass2 value:
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _OutboundLink value)  $default,){
final _that = this;
switch (_that) {
case _OutboundLink():
return $default(_that);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `map` that fallback to returning `null`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _OutboundLink value)?  $default,){
final _that = this;
switch (_that) {
case _OutboundLink() when $default != null:
return $default(_that);case _:
  return null;

}
}
/// A variant of `when` that fallback to an `orElse` callback.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function(@JsonKey(name: 'kind')  String kind, @JsonKey(name: 'value')  String value, @JsonKey(name: 'state')  String state, @JsonKey(name: 'target_public_id')  String? targetPublicId, @JsonKey(name: 'title')  String? title)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _OutboundLink() when $default != null:
return $default(_that.kind,_that.value,_that.state,_that.targetPublicId,_that.title);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// As opposed to `map`, this offers destructuring.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case Subclass2(:final field2):
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function(@JsonKey(name: 'kind')  String kind, @JsonKey(name: 'value')  String value, @JsonKey(name: 'state')  String state, @JsonKey(name: 'target_public_id')  String? targetPublicId, @JsonKey(name: 'title')  String? title)  $default,) {final _that = this;
switch (_that) {
case _OutboundLink():
return $default(_that.kind,_that.value,_that.state,_that.targetPublicId,_that.title);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `when` that fallback to returning `null`
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function(@JsonKey(name: 'kind')  String kind, @JsonKey(name: 'value')  String value, @JsonKey(name: 'state')  String state, @JsonKey(name: 'target_public_id')  String? targetPublicId, @JsonKey(name: 'title')  String? title)?  $default,) {final _that = this;
switch (_that) {
case _OutboundLink() when $default != null:
return $default(_that.kind,_that.value,_that.state,_that.targetPublicId,_that.title);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _OutboundLink implements OutboundLink {
  const _OutboundLink({@JsonKey(name: 'kind') required this.kind, @JsonKey(name: 'value') required this.value, @JsonKey(name: 'state') required this.state, @JsonKey(name: 'target_public_id') this.targetPublicId, @JsonKey(name: 'title') this.title});
  factory _OutboundLink.fromJson(Map<String, dynamic> json) => _$OutboundLinkFromJson(json);

@override@JsonKey(name: 'kind') final  String kind;
@override@JsonKey(name: 'value') final  String value;
@override@JsonKey(name: 'state') final  String state;
@override@JsonKey(name: 'target_public_id') final  String? targetPublicId;
@override@JsonKey(name: 'title') final  String? title;

/// Create a copy of OutboundLink
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$OutboundLinkCopyWith<_OutboundLink> get copyWith => __$OutboundLinkCopyWithImpl<_OutboundLink>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$OutboundLinkToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _OutboundLink&&(identical(other.kind, kind) || other.kind == kind)&&(identical(other.value, value) || other.value == value)&&(identical(other.state, state) || other.state == state)&&(identical(other.targetPublicId, targetPublicId) || other.targetPublicId == targetPublicId)&&(identical(other.title, title) || other.title == title));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,kind,value,state,targetPublicId,title);

@override
String toString() {
  return 'OutboundLink(kind: $kind, value: $value, state: $state, targetPublicId: $targetPublicId, title: $title)';
}


}

/// @nodoc
abstract mixin class _$OutboundLinkCopyWith<$Res> implements $OutboundLinkCopyWith<$Res> {
  factory _$OutboundLinkCopyWith(_OutboundLink value, $Res Function(_OutboundLink) _then) = __$OutboundLinkCopyWithImpl;
@override @useResult
$Res call({
@JsonKey(name: 'kind') String kind,@JsonKey(name: 'value') String value,@JsonKey(name: 'state') String state,@JsonKey(name: 'target_public_id') String? targetPublicId,@JsonKey(name: 'title') String? title
});




}
/// @nodoc
class __$OutboundLinkCopyWithImpl<$Res>
    implements _$OutboundLinkCopyWith<$Res> {
  __$OutboundLinkCopyWithImpl(this._self, this._then);

  final _OutboundLink _self;
  final $Res Function(_OutboundLink) _then;

/// Create a copy of OutboundLink
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? kind = null,Object? value = null,Object? state = null,Object? targetPublicId = freezed,Object? title = freezed,}) {
  return _then(_OutboundLink(
kind: null == kind ? _self.kind : kind // ignore: cast_nullable_to_non_nullable
as String,value: null == value ? _self.value : value // ignore: cast_nullable_to_non_nullable
as String,state: null == state ? _self.state : state // ignore: cast_nullable_to_non_nullable
as String,targetPublicId: freezed == targetPublicId ? _self.targetPublicId : targetPublicId // ignore: cast_nullable_to_non_nullable
as String?,title: freezed == title ? _self.title : title // ignore: cast_nullable_to_non_nullable
as String?,
  ));
}


}


/// @nodoc
mixin _$HealthzResponse {

@JsonKey(name: 'ok') bool get ok;@JsonKey(name: 'service') String get service;@JsonKey(name: 'sanitizer_version') String get sanitizerVersion;@JsonKey(name: 'storage_cap_bytes') int get storageCapBytes;@JsonKey(name: 'd1') HealthzResponseD1 get d1;@JsonKey(name: 'r2') HealthzResponseR2 get r2;
/// Create a copy of HealthzResponse
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$HealthzResponseCopyWith<HealthzResponse> get copyWith => _$HealthzResponseCopyWithImpl<HealthzResponse>(this as HealthzResponse, _$identity);

  /// Serializes this HealthzResponse to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is HealthzResponse&&(identical(other.ok, ok) || other.ok == ok)&&(identical(other.service, service) || other.service == service)&&(identical(other.sanitizerVersion, sanitizerVersion) || other.sanitizerVersion == sanitizerVersion)&&(identical(other.storageCapBytes, storageCapBytes) || other.storageCapBytes == storageCapBytes)&&(identical(other.d1, d1) || other.d1 == d1)&&(identical(other.r2, r2) || other.r2 == r2));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,ok,service,sanitizerVersion,storageCapBytes,d1,r2);

@override
String toString() {
  return 'HealthzResponse(ok: $ok, service: $service, sanitizerVersion: $sanitizerVersion, storageCapBytes: $storageCapBytes, d1: $d1, r2: $r2)';
}


}

/// @nodoc
abstract mixin class $HealthzResponseCopyWith<$Res>  {
  factory $HealthzResponseCopyWith(HealthzResponse value, $Res Function(HealthzResponse) _then) = _$HealthzResponseCopyWithImpl;
@useResult
$Res call({
@JsonKey(name: 'ok') bool ok,@JsonKey(name: 'service') String service,@JsonKey(name: 'sanitizer_version') String sanitizerVersion,@JsonKey(name: 'storage_cap_bytes') int storageCapBytes,@JsonKey(name: 'd1') HealthzResponseD1 d1,@JsonKey(name: 'r2') HealthzResponseR2 r2
});


$HealthzResponseD1CopyWith<$Res> get d1;$HealthzResponseR2CopyWith<$Res> get r2;

}
/// @nodoc
class _$HealthzResponseCopyWithImpl<$Res>
    implements $HealthzResponseCopyWith<$Res> {
  _$HealthzResponseCopyWithImpl(this._self, this._then);

  final HealthzResponse _self;
  final $Res Function(HealthzResponse) _then;

/// Create a copy of HealthzResponse
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? ok = null,Object? service = null,Object? sanitizerVersion = null,Object? storageCapBytes = null,Object? d1 = null,Object? r2 = null,}) {
  return _then(_self.copyWith(
ok: null == ok ? _self.ok : ok // ignore: cast_nullable_to_non_nullable
as bool,service: null == service ? _self.service : service // ignore: cast_nullable_to_non_nullable
as String,sanitizerVersion: null == sanitizerVersion ? _self.sanitizerVersion : sanitizerVersion // ignore: cast_nullable_to_non_nullable
as String,storageCapBytes: null == storageCapBytes ? _self.storageCapBytes : storageCapBytes // ignore: cast_nullable_to_non_nullable
as int,d1: null == d1 ? _self.d1 : d1 // ignore: cast_nullable_to_non_nullable
as HealthzResponseD1,r2: null == r2 ? _self.r2 : r2 // ignore: cast_nullable_to_non_nullable
as HealthzResponseR2,
  ));
}
/// Create a copy of HealthzResponse
/// with the given fields replaced by the non-null parameter values.
@override
@pragma('vm:prefer-inline')
$HealthzResponseD1CopyWith<$Res> get d1 {
  
  return $HealthzResponseD1CopyWith<$Res>(_self.d1, (value) {
    return _then(_self.copyWith(d1: value));
  });
}/// Create a copy of HealthzResponse
/// with the given fields replaced by the non-null parameter values.
@override
@pragma('vm:prefer-inline')
$HealthzResponseR2CopyWith<$Res> get r2 {
  
  return $HealthzResponseR2CopyWith<$Res>(_self.r2, (value) {
    return _then(_self.copyWith(r2: value));
  });
}
}


/// Adds pattern-matching-related methods to [HealthzResponse].
extension HealthzResponsePatterns on HealthzResponse {
/// A variant of `map` that fallback to returning `orElse`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _HealthzResponse value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _HealthzResponse() when $default != null:
return $default(_that);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// Callbacks receives the raw object, upcasted.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case final Subclass2 value:
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _HealthzResponse value)  $default,){
final _that = this;
switch (_that) {
case _HealthzResponse():
return $default(_that);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `map` that fallback to returning `null`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _HealthzResponse value)?  $default,){
final _that = this;
switch (_that) {
case _HealthzResponse() when $default != null:
return $default(_that);case _:
  return null;

}
}
/// A variant of `when` that fallback to an `orElse` callback.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function(@JsonKey(name: 'ok')  bool ok, @JsonKey(name: 'service')  String service, @JsonKey(name: 'sanitizer_version')  String sanitizerVersion, @JsonKey(name: 'storage_cap_bytes')  int storageCapBytes, @JsonKey(name: 'd1')  HealthzResponseD1 d1, @JsonKey(name: 'r2')  HealthzResponseR2 r2)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _HealthzResponse() when $default != null:
return $default(_that.ok,_that.service,_that.sanitizerVersion,_that.storageCapBytes,_that.d1,_that.r2);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// As opposed to `map`, this offers destructuring.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case Subclass2(:final field2):
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function(@JsonKey(name: 'ok')  bool ok, @JsonKey(name: 'service')  String service, @JsonKey(name: 'sanitizer_version')  String sanitizerVersion, @JsonKey(name: 'storage_cap_bytes')  int storageCapBytes, @JsonKey(name: 'd1')  HealthzResponseD1 d1, @JsonKey(name: 'r2')  HealthzResponseR2 r2)  $default,) {final _that = this;
switch (_that) {
case _HealthzResponse():
return $default(_that.ok,_that.service,_that.sanitizerVersion,_that.storageCapBytes,_that.d1,_that.r2);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `when` that fallback to returning `null`
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function(@JsonKey(name: 'ok')  bool ok, @JsonKey(name: 'service')  String service, @JsonKey(name: 'sanitizer_version')  String sanitizerVersion, @JsonKey(name: 'storage_cap_bytes')  int storageCapBytes, @JsonKey(name: 'd1')  HealthzResponseD1 d1, @JsonKey(name: 'r2')  HealthzResponseR2 r2)?  $default,) {final _that = this;
switch (_that) {
case _HealthzResponse() when $default != null:
return $default(_that.ok,_that.service,_that.sanitizerVersion,_that.storageCapBytes,_that.d1,_that.r2);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _HealthzResponse implements HealthzResponse {
  const _HealthzResponse({@JsonKey(name: 'ok') required this.ok, @JsonKey(name: 'service') required this.service, @JsonKey(name: 'sanitizer_version') required this.sanitizerVersion, @JsonKey(name: 'storage_cap_bytes') required this.storageCapBytes, @JsonKey(name: 'd1') required this.d1, @JsonKey(name: 'r2') required this.r2});
  factory _HealthzResponse.fromJson(Map<String, dynamic> json) => _$HealthzResponseFromJson(json);

@override@JsonKey(name: 'ok') final  bool ok;
@override@JsonKey(name: 'service') final  String service;
@override@JsonKey(name: 'sanitizer_version') final  String sanitizerVersion;
@override@JsonKey(name: 'storage_cap_bytes') final  int storageCapBytes;
@override@JsonKey(name: 'd1') final  HealthzResponseD1 d1;
@override@JsonKey(name: 'r2') final  HealthzResponseR2 r2;

/// Create a copy of HealthzResponse
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$HealthzResponseCopyWith<_HealthzResponse> get copyWith => __$HealthzResponseCopyWithImpl<_HealthzResponse>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$HealthzResponseToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _HealthzResponse&&(identical(other.ok, ok) || other.ok == ok)&&(identical(other.service, service) || other.service == service)&&(identical(other.sanitizerVersion, sanitizerVersion) || other.sanitizerVersion == sanitizerVersion)&&(identical(other.storageCapBytes, storageCapBytes) || other.storageCapBytes == storageCapBytes)&&(identical(other.d1, d1) || other.d1 == d1)&&(identical(other.r2, r2) || other.r2 == r2));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,ok,service,sanitizerVersion,storageCapBytes,d1,r2);

@override
String toString() {
  return 'HealthzResponse(ok: $ok, service: $service, sanitizerVersion: $sanitizerVersion, storageCapBytes: $storageCapBytes, d1: $d1, r2: $r2)';
}


}

/// @nodoc
abstract mixin class _$HealthzResponseCopyWith<$Res> implements $HealthzResponseCopyWith<$Res> {
  factory _$HealthzResponseCopyWith(_HealthzResponse value, $Res Function(_HealthzResponse) _then) = __$HealthzResponseCopyWithImpl;
@override @useResult
$Res call({
@JsonKey(name: 'ok') bool ok,@JsonKey(name: 'service') String service,@JsonKey(name: 'sanitizer_version') String sanitizerVersion,@JsonKey(name: 'storage_cap_bytes') int storageCapBytes,@JsonKey(name: 'd1') HealthzResponseD1 d1,@JsonKey(name: 'r2') HealthzResponseR2 r2
});


@override $HealthzResponseD1CopyWith<$Res> get d1;@override $HealthzResponseR2CopyWith<$Res> get r2;

}
/// @nodoc
class __$HealthzResponseCopyWithImpl<$Res>
    implements _$HealthzResponseCopyWith<$Res> {
  __$HealthzResponseCopyWithImpl(this._self, this._then);

  final _HealthzResponse _self;
  final $Res Function(_HealthzResponse) _then;

/// Create a copy of HealthzResponse
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? ok = null,Object? service = null,Object? sanitizerVersion = null,Object? storageCapBytes = null,Object? d1 = null,Object? r2 = null,}) {
  return _then(_HealthzResponse(
ok: null == ok ? _self.ok : ok // ignore: cast_nullable_to_non_nullable
as bool,service: null == service ? _self.service : service // ignore: cast_nullable_to_non_nullable
as String,sanitizerVersion: null == sanitizerVersion ? _self.sanitizerVersion : sanitizerVersion // ignore: cast_nullable_to_non_nullable
as String,storageCapBytes: null == storageCapBytes ? _self.storageCapBytes : storageCapBytes // ignore: cast_nullable_to_non_nullable
as int,d1: null == d1 ? _self.d1 : d1 // ignore: cast_nullable_to_non_nullable
as HealthzResponseD1,r2: null == r2 ? _self.r2 : r2 // ignore: cast_nullable_to_non_nullable
as HealthzResponseR2,
  ));
}

/// Create a copy of HealthzResponse
/// with the given fields replaced by the non-null parameter values.
@override
@pragma('vm:prefer-inline')
$HealthzResponseD1CopyWith<$Res> get d1 {
  
  return $HealthzResponseD1CopyWith<$Res>(_self.d1, (value) {
    return _then(_self.copyWith(d1: value));
  });
}/// Create a copy of HealthzResponse
/// with the given fields replaced by the non-null parameter values.
@override
@pragma('vm:prefer-inline')
$HealthzResponseR2CopyWith<$Res> get r2 {
  
  return $HealthzResponseR2CopyWith<$Res>(_self.r2, (value) {
    return _then(_self.copyWith(r2: value));
  });
}
}


/// @nodoc
mixin _$HealthzResponseD1 {

@JsonKey(name: 'documents') int? get documents;@JsonKey(name: 'agents') int? get agents;
/// Create a copy of HealthzResponseD1
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$HealthzResponseD1CopyWith<HealthzResponseD1> get copyWith => _$HealthzResponseD1CopyWithImpl<HealthzResponseD1>(this as HealthzResponseD1, _$identity);

  /// Serializes this HealthzResponseD1 to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is HealthzResponseD1&&(identical(other.documents, documents) || other.documents == documents)&&(identical(other.agents, agents) || other.agents == agents));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,documents,agents);

@override
String toString() {
  return 'HealthzResponseD1(documents: $documents, agents: $agents)';
}


}

/// @nodoc
abstract mixin class $HealthzResponseD1CopyWith<$Res>  {
  factory $HealthzResponseD1CopyWith(HealthzResponseD1 value, $Res Function(HealthzResponseD1) _then) = _$HealthzResponseD1CopyWithImpl;
@useResult
$Res call({
@JsonKey(name: 'documents') int? documents,@JsonKey(name: 'agents') int? agents
});




}
/// @nodoc
class _$HealthzResponseD1CopyWithImpl<$Res>
    implements $HealthzResponseD1CopyWith<$Res> {
  _$HealthzResponseD1CopyWithImpl(this._self, this._then);

  final HealthzResponseD1 _self;
  final $Res Function(HealthzResponseD1) _then;

/// Create a copy of HealthzResponseD1
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? documents = freezed,Object? agents = freezed,}) {
  return _then(_self.copyWith(
documents: freezed == documents ? _self.documents : documents // ignore: cast_nullable_to_non_nullable
as int?,agents: freezed == agents ? _self.agents : agents // ignore: cast_nullable_to_non_nullable
as int?,
  ));
}

}


/// Adds pattern-matching-related methods to [HealthzResponseD1].
extension HealthzResponseD1Patterns on HealthzResponseD1 {
/// A variant of `map` that fallback to returning `orElse`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _HealthzResponseD1 value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _HealthzResponseD1() when $default != null:
return $default(_that);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// Callbacks receives the raw object, upcasted.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case final Subclass2 value:
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _HealthzResponseD1 value)  $default,){
final _that = this;
switch (_that) {
case _HealthzResponseD1():
return $default(_that);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `map` that fallback to returning `null`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _HealthzResponseD1 value)?  $default,){
final _that = this;
switch (_that) {
case _HealthzResponseD1() when $default != null:
return $default(_that);case _:
  return null;

}
}
/// A variant of `when` that fallback to an `orElse` callback.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function(@JsonKey(name: 'documents')  int? documents, @JsonKey(name: 'agents')  int? agents)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _HealthzResponseD1() when $default != null:
return $default(_that.documents,_that.agents);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// As opposed to `map`, this offers destructuring.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case Subclass2(:final field2):
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function(@JsonKey(name: 'documents')  int? documents, @JsonKey(name: 'agents')  int? agents)  $default,) {final _that = this;
switch (_that) {
case _HealthzResponseD1():
return $default(_that.documents,_that.agents);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `when` that fallback to returning `null`
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function(@JsonKey(name: 'documents')  int? documents, @JsonKey(name: 'agents')  int? agents)?  $default,) {final _that = this;
switch (_that) {
case _HealthzResponseD1() when $default != null:
return $default(_that.documents,_that.agents);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _HealthzResponseD1 implements HealthzResponseD1 {
  const _HealthzResponseD1({@JsonKey(name: 'documents') this.documents, @JsonKey(name: 'agents') this.agents});
  factory _HealthzResponseD1.fromJson(Map<String, dynamic> json) => _$HealthzResponseD1FromJson(json);

@override@JsonKey(name: 'documents') final  int? documents;
@override@JsonKey(name: 'agents') final  int? agents;

/// Create a copy of HealthzResponseD1
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$HealthzResponseD1CopyWith<_HealthzResponseD1> get copyWith => __$HealthzResponseD1CopyWithImpl<_HealthzResponseD1>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$HealthzResponseD1ToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _HealthzResponseD1&&(identical(other.documents, documents) || other.documents == documents)&&(identical(other.agents, agents) || other.agents == agents));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,documents,agents);

@override
String toString() {
  return 'HealthzResponseD1(documents: $documents, agents: $agents)';
}


}

/// @nodoc
abstract mixin class _$HealthzResponseD1CopyWith<$Res> implements $HealthzResponseD1CopyWith<$Res> {
  factory _$HealthzResponseD1CopyWith(_HealthzResponseD1 value, $Res Function(_HealthzResponseD1) _then) = __$HealthzResponseD1CopyWithImpl;
@override @useResult
$Res call({
@JsonKey(name: 'documents') int? documents,@JsonKey(name: 'agents') int? agents
});




}
/// @nodoc
class __$HealthzResponseD1CopyWithImpl<$Res>
    implements _$HealthzResponseD1CopyWith<$Res> {
  __$HealthzResponseD1CopyWithImpl(this._self, this._then);

  final _HealthzResponseD1 _self;
  final $Res Function(_HealthzResponseD1) _then;

/// Create a copy of HealthzResponseD1
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? documents = freezed,Object? agents = freezed,}) {
  return _then(_HealthzResponseD1(
documents: freezed == documents ? _self.documents : documents // ignore: cast_nullable_to_non_nullable
as int?,agents: freezed == agents ? _self.agents : agents // ignore: cast_nullable_to_non_nullable
as int?,
  ));
}


}


/// @nodoc
mixin _$HealthzResponseR2 {

@JsonKey(name: 'bucket_reachable') bool get bucketReachable;@JsonKey(name: 'sample_object_count') int get sampleObjectCount;
/// Create a copy of HealthzResponseR2
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$HealthzResponseR2CopyWith<HealthzResponseR2> get copyWith => _$HealthzResponseR2CopyWithImpl<HealthzResponseR2>(this as HealthzResponseR2, _$identity);

  /// Serializes this HealthzResponseR2 to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is HealthzResponseR2&&(identical(other.bucketReachable, bucketReachable) || other.bucketReachable == bucketReachable)&&(identical(other.sampleObjectCount, sampleObjectCount) || other.sampleObjectCount == sampleObjectCount));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,bucketReachable,sampleObjectCount);

@override
String toString() {
  return 'HealthzResponseR2(bucketReachable: $bucketReachable, sampleObjectCount: $sampleObjectCount)';
}


}

/// @nodoc
abstract mixin class $HealthzResponseR2CopyWith<$Res>  {
  factory $HealthzResponseR2CopyWith(HealthzResponseR2 value, $Res Function(HealthzResponseR2) _then) = _$HealthzResponseR2CopyWithImpl;
@useResult
$Res call({
@JsonKey(name: 'bucket_reachable') bool bucketReachable,@JsonKey(name: 'sample_object_count') int sampleObjectCount
});




}
/// @nodoc
class _$HealthzResponseR2CopyWithImpl<$Res>
    implements $HealthzResponseR2CopyWith<$Res> {
  _$HealthzResponseR2CopyWithImpl(this._self, this._then);

  final HealthzResponseR2 _self;
  final $Res Function(HealthzResponseR2) _then;

/// Create a copy of HealthzResponseR2
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? bucketReachable = null,Object? sampleObjectCount = null,}) {
  return _then(_self.copyWith(
bucketReachable: null == bucketReachable ? _self.bucketReachable : bucketReachable // ignore: cast_nullable_to_non_nullable
as bool,sampleObjectCount: null == sampleObjectCount ? _self.sampleObjectCount : sampleObjectCount // ignore: cast_nullable_to_non_nullable
as int,
  ));
}

}


/// Adds pattern-matching-related methods to [HealthzResponseR2].
extension HealthzResponseR2Patterns on HealthzResponseR2 {
/// A variant of `map` that fallback to returning `orElse`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _HealthzResponseR2 value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _HealthzResponseR2() when $default != null:
return $default(_that);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// Callbacks receives the raw object, upcasted.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case final Subclass2 value:
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _HealthzResponseR2 value)  $default,){
final _that = this;
switch (_that) {
case _HealthzResponseR2():
return $default(_that);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `map` that fallback to returning `null`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _HealthzResponseR2 value)?  $default,){
final _that = this;
switch (_that) {
case _HealthzResponseR2() when $default != null:
return $default(_that);case _:
  return null;

}
}
/// A variant of `when` that fallback to an `orElse` callback.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function(@JsonKey(name: 'bucket_reachable')  bool bucketReachable, @JsonKey(name: 'sample_object_count')  int sampleObjectCount)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _HealthzResponseR2() when $default != null:
return $default(_that.bucketReachable,_that.sampleObjectCount);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// As opposed to `map`, this offers destructuring.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case Subclass2(:final field2):
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function(@JsonKey(name: 'bucket_reachable')  bool bucketReachable, @JsonKey(name: 'sample_object_count')  int sampleObjectCount)  $default,) {final _that = this;
switch (_that) {
case _HealthzResponseR2():
return $default(_that.bucketReachable,_that.sampleObjectCount);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `when` that fallback to returning `null`
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function(@JsonKey(name: 'bucket_reachable')  bool bucketReachable, @JsonKey(name: 'sample_object_count')  int sampleObjectCount)?  $default,) {final _that = this;
switch (_that) {
case _HealthzResponseR2() when $default != null:
return $default(_that.bucketReachable,_that.sampleObjectCount);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _HealthzResponseR2 implements HealthzResponseR2 {
  const _HealthzResponseR2({@JsonKey(name: 'bucket_reachable') required this.bucketReachable, @JsonKey(name: 'sample_object_count') required this.sampleObjectCount});
  factory _HealthzResponseR2.fromJson(Map<String, dynamic> json) => _$HealthzResponseR2FromJson(json);

@override@JsonKey(name: 'bucket_reachable') final  bool bucketReachable;
@override@JsonKey(name: 'sample_object_count') final  int sampleObjectCount;

/// Create a copy of HealthzResponseR2
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$HealthzResponseR2CopyWith<_HealthzResponseR2> get copyWith => __$HealthzResponseR2CopyWithImpl<_HealthzResponseR2>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$HealthzResponseR2ToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _HealthzResponseR2&&(identical(other.bucketReachable, bucketReachable) || other.bucketReachable == bucketReachable)&&(identical(other.sampleObjectCount, sampleObjectCount) || other.sampleObjectCount == sampleObjectCount));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,bucketReachable,sampleObjectCount);

@override
String toString() {
  return 'HealthzResponseR2(bucketReachable: $bucketReachable, sampleObjectCount: $sampleObjectCount)';
}


}

/// @nodoc
abstract mixin class _$HealthzResponseR2CopyWith<$Res> implements $HealthzResponseR2CopyWith<$Res> {
  factory _$HealthzResponseR2CopyWith(_HealthzResponseR2 value, $Res Function(_HealthzResponseR2) _then) = __$HealthzResponseR2CopyWithImpl;
@override @useResult
$Res call({
@JsonKey(name: 'bucket_reachable') bool bucketReachable,@JsonKey(name: 'sample_object_count') int sampleObjectCount
});




}
/// @nodoc
class __$HealthzResponseR2CopyWithImpl<$Res>
    implements _$HealthzResponseR2CopyWith<$Res> {
  __$HealthzResponseR2CopyWithImpl(this._self, this._then);

  final _HealthzResponseR2 _self;
  final $Res Function(_HealthzResponseR2) _then;

/// Create a copy of HealthzResponseR2
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? bucketReachable = null,Object? sampleObjectCount = null,}) {
  return _then(_HealthzResponseR2(
bucketReachable: null == bucketReachable ? _self.bucketReachable : bucketReachable // ignore: cast_nullable_to_non_nullable
as bool,sampleObjectCount: null == sampleObjectCount ? _self.sampleObjectCount : sampleObjectCount // ignore: cast_nullable_to_non_nullable
as int,
  ));
}


}


/// @nodoc
mixin _$LinksBackfillResponse {

@JsonKey(name: 'scanned') int get scanned;@JsonKey(name: 'updated') int get updated;@JsonKey(name: 'links') int get links;@JsonKey(name: 'next_cursor') String? get nextCursor;
/// Create a copy of LinksBackfillResponse
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$LinksBackfillResponseCopyWith<LinksBackfillResponse> get copyWith => _$LinksBackfillResponseCopyWithImpl<LinksBackfillResponse>(this as LinksBackfillResponse, _$identity);

  /// Serializes this LinksBackfillResponse to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is LinksBackfillResponse&&(identical(other.scanned, scanned) || other.scanned == scanned)&&(identical(other.updated, updated) || other.updated == updated)&&(identical(other.links, links) || other.links == links)&&(identical(other.nextCursor, nextCursor) || other.nextCursor == nextCursor));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,scanned,updated,links,nextCursor);

@override
String toString() {
  return 'LinksBackfillResponse(scanned: $scanned, updated: $updated, links: $links, nextCursor: $nextCursor)';
}


}

/// @nodoc
abstract mixin class $LinksBackfillResponseCopyWith<$Res>  {
  factory $LinksBackfillResponseCopyWith(LinksBackfillResponse value, $Res Function(LinksBackfillResponse) _then) = _$LinksBackfillResponseCopyWithImpl;
@useResult
$Res call({
@JsonKey(name: 'scanned') int scanned,@JsonKey(name: 'updated') int updated,@JsonKey(name: 'links') int links,@JsonKey(name: 'next_cursor') String? nextCursor
});




}
/// @nodoc
class _$LinksBackfillResponseCopyWithImpl<$Res>
    implements $LinksBackfillResponseCopyWith<$Res> {
  _$LinksBackfillResponseCopyWithImpl(this._self, this._then);

  final LinksBackfillResponse _self;
  final $Res Function(LinksBackfillResponse) _then;

/// Create a copy of LinksBackfillResponse
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? scanned = null,Object? updated = null,Object? links = null,Object? nextCursor = freezed,}) {
  return _then(_self.copyWith(
scanned: null == scanned ? _self.scanned : scanned // ignore: cast_nullable_to_non_nullable
as int,updated: null == updated ? _self.updated : updated // ignore: cast_nullable_to_non_nullable
as int,links: null == links ? _self.links : links // ignore: cast_nullable_to_non_nullable
as int,nextCursor: freezed == nextCursor ? _self.nextCursor : nextCursor // ignore: cast_nullable_to_non_nullable
as String?,
  ));
}

}


/// Adds pattern-matching-related methods to [LinksBackfillResponse].
extension LinksBackfillResponsePatterns on LinksBackfillResponse {
/// A variant of `map` that fallback to returning `orElse`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _LinksBackfillResponse value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _LinksBackfillResponse() when $default != null:
return $default(_that);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// Callbacks receives the raw object, upcasted.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case final Subclass2 value:
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _LinksBackfillResponse value)  $default,){
final _that = this;
switch (_that) {
case _LinksBackfillResponse():
return $default(_that);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `map` that fallback to returning `null`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _LinksBackfillResponse value)?  $default,){
final _that = this;
switch (_that) {
case _LinksBackfillResponse() when $default != null:
return $default(_that);case _:
  return null;

}
}
/// A variant of `when` that fallback to an `orElse` callback.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function(@JsonKey(name: 'scanned')  int scanned, @JsonKey(name: 'updated')  int updated, @JsonKey(name: 'links')  int links, @JsonKey(name: 'next_cursor')  String? nextCursor)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _LinksBackfillResponse() when $default != null:
return $default(_that.scanned,_that.updated,_that.links,_that.nextCursor);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// As opposed to `map`, this offers destructuring.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case Subclass2(:final field2):
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function(@JsonKey(name: 'scanned')  int scanned, @JsonKey(name: 'updated')  int updated, @JsonKey(name: 'links')  int links, @JsonKey(name: 'next_cursor')  String? nextCursor)  $default,) {final _that = this;
switch (_that) {
case _LinksBackfillResponse():
return $default(_that.scanned,_that.updated,_that.links,_that.nextCursor);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `when` that fallback to returning `null`
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function(@JsonKey(name: 'scanned')  int scanned, @JsonKey(name: 'updated')  int updated, @JsonKey(name: 'links')  int links, @JsonKey(name: 'next_cursor')  String? nextCursor)?  $default,) {final _that = this;
switch (_that) {
case _LinksBackfillResponse() when $default != null:
return $default(_that.scanned,_that.updated,_that.links,_that.nextCursor);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _LinksBackfillResponse implements LinksBackfillResponse {
  const _LinksBackfillResponse({@JsonKey(name: 'scanned') required this.scanned, @JsonKey(name: 'updated') required this.updated, @JsonKey(name: 'links') required this.links, @JsonKey(name: 'next_cursor') this.nextCursor});
  factory _LinksBackfillResponse.fromJson(Map<String, dynamic> json) => _$LinksBackfillResponseFromJson(json);

@override@JsonKey(name: 'scanned') final  int scanned;
@override@JsonKey(name: 'updated') final  int updated;
@override@JsonKey(name: 'links') final  int links;
@override@JsonKey(name: 'next_cursor') final  String? nextCursor;

/// Create a copy of LinksBackfillResponse
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$LinksBackfillResponseCopyWith<_LinksBackfillResponse> get copyWith => __$LinksBackfillResponseCopyWithImpl<_LinksBackfillResponse>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$LinksBackfillResponseToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _LinksBackfillResponse&&(identical(other.scanned, scanned) || other.scanned == scanned)&&(identical(other.updated, updated) || other.updated == updated)&&(identical(other.links, links) || other.links == links)&&(identical(other.nextCursor, nextCursor) || other.nextCursor == nextCursor));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,scanned,updated,links,nextCursor);

@override
String toString() {
  return 'LinksBackfillResponse(scanned: $scanned, updated: $updated, links: $links, nextCursor: $nextCursor)';
}


}

/// @nodoc
abstract mixin class _$LinksBackfillResponseCopyWith<$Res> implements $LinksBackfillResponseCopyWith<$Res> {
  factory _$LinksBackfillResponseCopyWith(_LinksBackfillResponse value, $Res Function(_LinksBackfillResponse) _then) = __$LinksBackfillResponseCopyWithImpl;
@override @useResult
$Res call({
@JsonKey(name: 'scanned') int scanned,@JsonKey(name: 'updated') int updated,@JsonKey(name: 'links') int links,@JsonKey(name: 'next_cursor') String? nextCursor
});




}
/// @nodoc
class __$LinksBackfillResponseCopyWithImpl<$Res>
    implements _$LinksBackfillResponseCopyWith<$Res> {
  __$LinksBackfillResponseCopyWithImpl(this._self, this._then);

  final _LinksBackfillResponse _self;
  final $Res Function(_LinksBackfillResponse) _then;

/// Create a copy of LinksBackfillResponse
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? scanned = null,Object? updated = null,Object? links = null,Object? nextCursor = freezed,}) {
  return _then(_LinksBackfillResponse(
scanned: null == scanned ? _self.scanned : scanned // ignore: cast_nullable_to_non_nullable
as int,updated: null == updated ? _self.updated : updated // ignore: cast_nullable_to_non_nullable
as int,links: null == links ? _self.links : links // ignore: cast_nullable_to_non_nullable
as int,nextCursor: freezed == nextCursor ? _self.nextCursor : nextCursor // ignore: cast_nullable_to_non_nullable
as String?,
  ));
}


}


/// @nodoc
mixin _$ListAgentKeysResponse {

@JsonKey(name: 'agent_id') String get agentId;@JsonKey(name: 'name') String get name;@JsonKey(name: 'keys') List<AgentKey> get keys;@JsonKey(name: 'next_cursor') String? get nextCursor;
/// Create a copy of ListAgentKeysResponse
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$ListAgentKeysResponseCopyWith<ListAgentKeysResponse> get copyWith => _$ListAgentKeysResponseCopyWithImpl<ListAgentKeysResponse>(this as ListAgentKeysResponse, _$identity);

  /// Serializes this ListAgentKeysResponse to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ListAgentKeysResponse&&(identical(other.agentId, agentId) || other.agentId == agentId)&&(identical(other.name, name) || other.name == name)&&const DeepCollectionEquality().equals(other.keys, keys)&&(identical(other.nextCursor, nextCursor) || other.nextCursor == nextCursor));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,agentId,name,const DeepCollectionEquality().hash(keys),nextCursor);

@override
String toString() {
  return 'ListAgentKeysResponse(agentId: $agentId, name: $name, keys: $keys, nextCursor: $nextCursor)';
}


}

/// @nodoc
abstract mixin class $ListAgentKeysResponseCopyWith<$Res>  {
  factory $ListAgentKeysResponseCopyWith(ListAgentKeysResponse value, $Res Function(ListAgentKeysResponse) _then) = _$ListAgentKeysResponseCopyWithImpl;
@useResult
$Res call({
@JsonKey(name: 'agent_id') String agentId,@JsonKey(name: 'name') String name,@JsonKey(name: 'keys') List<AgentKey> keys,@JsonKey(name: 'next_cursor') String? nextCursor
});




}
/// @nodoc
class _$ListAgentKeysResponseCopyWithImpl<$Res>
    implements $ListAgentKeysResponseCopyWith<$Res> {
  _$ListAgentKeysResponseCopyWithImpl(this._self, this._then);

  final ListAgentKeysResponse _self;
  final $Res Function(ListAgentKeysResponse) _then;

/// Create a copy of ListAgentKeysResponse
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? agentId = null,Object? name = null,Object? keys = null,Object? nextCursor = freezed,}) {
  return _then(_self.copyWith(
agentId: null == agentId ? _self.agentId : agentId // ignore: cast_nullable_to_non_nullable
as String,name: null == name ? _self.name : name // ignore: cast_nullable_to_non_nullable
as String,keys: null == keys ? _self.keys : keys // ignore: cast_nullable_to_non_nullable
as List<AgentKey>,nextCursor: freezed == nextCursor ? _self.nextCursor : nextCursor // ignore: cast_nullable_to_non_nullable
as String?,
  ));
}

}


/// Adds pattern-matching-related methods to [ListAgentKeysResponse].
extension ListAgentKeysResponsePatterns on ListAgentKeysResponse {
/// A variant of `map` that fallback to returning `orElse`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _ListAgentKeysResponse value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _ListAgentKeysResponse() when $default != null:
return $default(_that);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// Callbacks receives the raw object, upcasted.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case final Subclass2 value:
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _ListAgentKeysResponse value)  $default,){
final _that = this;
switch (_that) {
case _ListAgentKeysResponse():
return $default(_that);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `map` that fallback to returning `null`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _ListAgentKeysResponse value)?  $default,){
final _that = this;
switch (_that) {
case _ListAgentKeysResponse() when $default != null:
return $default(_that);case _:
  return null;

}
}
/// A variant of `when` that fallback to an `orElse` callback.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function(@JsonKey(name: 'agent_id')  String agentId, @JsonKey(name: 'name')  String name, @JsonKey(name: 'keys')  List<AgentKey> keys, @JsonKey(name: 'next_cursor')  String? nextCursor)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _ListAgentKeysResponse() when $default != null:
return $default(_that.agentId,_that.name,_that.keys,_that.nextCursor);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// As opposed to `map`, this offers destructuring.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case Subclass2(:final field2):
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function(@JsonKey(name: 'agent_id')  String agentId, @JsonKey(name: 'name')  String name, @JsonKey(name: 'keys')  List<AgentKey> keys, @JsonKey(name: 'next_cursor')  String? nextCursor)  $default,) {final _that = this;
switch (_that) {
case _ListAgentKeysResponse():
return $default(_that.agentId,_that.name,_that.keys,_that.nextCursor);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `when` that fallback to returning `null`
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function(@JsonKey(name: 'agent_id')  String agentId, @JsonKey(name: 'name')  String name, @JsonKey(name: 'keys')  List<AgentKey> keys, @JsonKey(name: 'next_cursor')  String? nextCursor)?  $default,) {final _that = this;
switch (_that) {
case _ListAgentKeysResponse() when $default != null:
return $default(_that.agentId,_that.name,_that.keys,_that.nextCursor);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _ListAgentKeysResponse implements ListAgentKeysResponse {
  const _ListAgentKeysResponse({@JsonKey(name: 'agent_id') required this.agentId, @JsonKey(name: 'name') required this.name, @JsonKey(name: 'keys') required final  List<AgentKey> keys, @JsonKey(name: 'next_cursor') this.nextCursor}): _keys = keys;
  factory _ListAgentKeysResponse.fromJson(Map<String, dynamic> json) => _$ListAgentKeysResponseFromJson(json);

@override@JsonKey(name: 'agent_id') final  String agentId;
@override@JsonKey(name: 'name') final  String name;
 final  List<AgentKey> _keys;
@override@JsonKey(name: 'keys') List<AgentKey> get keys {
  if (_keys is EqualUnmodifiableListView) return _keys;
  // ignore: implicit_dynamic_type
  return EqualUnmodifiableListView(_keys);
}

@override@JsonKey(name: 'next_cursor') final  String? nextCursor;

/// Create a copy of ListAgentKeysResponse
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$ListAgentKeysResponseCopyWith<_ListAgentKeysResponse> get copyWith => __$ListAgentKeysResponseCopyWithImpl<_ListAgentKeysResponse>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$ListAgentKeysResponseToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _ListAgentKeysResponse&&(identical(other.agentId, agentId) || other.agentId == agentId)&&(identical(other.name, name) || other.name == name)&&const DeepCollectionEquality().equals(other._keys, _keys)&&(identical(other.nextCursor, nextCursor) || other.nextCursor == nextCursor));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,agentId,name,const DeepCollectionEquality().hash(_keys),nextCursor);

@override
String toString() {
  return 'ListAgentKeysResponse(agentId: $agentId, name: $name, keys: $keys, nextCursor: $nextCursor)';
}


}

/// @nodoc
abstract mixin class _$ListAgentKeysResponseCopyWith<$Res> implements $ListAgentKeysResponseCopyWith<$Res> {
  factory _$ListAgentKeysResponseCopyWith(_ListAgentKeysResponse value, $Res Function(_ListAgentKeysResponse) _then) = __$ListAgentKeysResponseCopyWithImpl;
@override @useResult
$Res call({
@JsonKey(name: 'agent_id') String agentId,@JsonKey(name: 'name') String name,@JsonKey(name: 'keys') List<AgentKey> keys,@JsonKey(name: 'next_cursor') String? nextCursor
});




}
/// @nodoc
class __$ListAgentKeysResponseCopyWithImpl<$Res>
    implements _$ListAgentKeysResponseCopyWith<$Res> {
  __$ListAgentKeysResponseCopyWithImpl(this._self, this._then);

  final _ListAgentKeysResponse _self;
  final $Res Function(_ListAgentKeysResponse) _then;

/// Create a copy of ListAgentKeysResponse
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? agentId = null,Object? name = null,Object? keys = null,Object? nextCursor = freezed,}) {
  return _then(_ListAgentKeysResponse(
agentId: null == agentId ? _self.agentId : agentId // ignore: cast_nullable_to_non_nullable
as String,name: null == name ? _self.name : name // ignore: cast_nullable_to_non_nullable
as String,keys: null == keys ? _self._keys : keys // ignore: cast_nullable_to_non_nullable
as List<AgentKey>,nextCursor: freezed == nextCursor ? _self.nextCursor : nextCursor // ignore: cast_nullable_to_non_nullable
as String?,
  ));
}


}


/// @nodoc
mixin _$AgentKey {

@JsonKey(name: 'id') String get id;@JsonKey(name: 'key_prefix') String get keyPrefix;@JsonKey(name: 'created_at') DateTime get createdAt;@JsonKey(name: 'expired') bool get expired;@JsonKey(name: 'revoked_at') DateTime? get revokedAt;@JsonKey(name: 'expires_at') DateTime? get expiresAt;
/// Create a copy of AgentKey
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$AgentKeyCopyWith<AgentKey> get copyWith => _$AgentKeyCopyWithImpl<AgentKey>(this as AgentKey, _$identity);

  /// Serializes this AgentKey to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is AgentKey&&(identical(other.id, id) || other.id == id)&&(identical(other.keyPrefix, keyPrefix) || other.keyPrefix == keyPrefix)&&(identical(other.createdAt, createdAt) || other.createdAt == createdAt)&&(identical(other.expired, expired) || other.expired == expired)&&(identical(other.revokedAt, revokedAt) || other.revokedAt == revokedAt)&&(identical(other.expiresAt, expiresAt) || other.expiresAt == expiresAt));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,id,keyPrefix,createdAt,expired,revokedAt,expiresAt);

@override
String toString() {
  return 'AgentKey(id: $id, keyPrefix: $keyPrefix, createdAt: $createdAt, expired: $expired, revokedAt: $revokedAt, expiresAt: $expiresAt)';
}


}

/// @nodoc
abstract mixin class $AgentKeyCopyWith<$Res>  {
  factory $AgentKeyCopyWith(AgentKey value, $Res Function(AgentKey) _then) = _$AgentKeyCopyWithImpl;
@useResult
$Res call({
@JsonKey(name: 'id') String id,@JsonKey(name: 'key_prefix') String keyPrefix,@JsonKey(name: 'created_at') DateTime createdAt,@JsonKey(name: 'expired') bool expired,@JsonKey(name: 'revoked_at') DateTime? revokedAt,@JsonKey(name: 'expires_at') DateTime? expiresAt
});




}
/// @nodoc
class _$AgentKeyCopyWithImpl<$Res>
    implements $AgentKeyCopyWith<$Res> {
  _$AgentKeyCopyWithImpl(this._self, this._then);

  final AgentKey _self;
  final $Res Function(AgentKey) _then;

/// Create a copy of AgentKey
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? id = null,Object? keyPrefix = null,Object? createdAt = null,Object? expired = null,Object? revokedAt = freezed,Object? expiresAt = freezed,}) {
  return _then(_self.copyWith(
id: null == id ? _self.id : id // ignore: cast_nullable_to_non_nullable
as String,keyPrefix: null == keyPrefix ? _self.keyPrefix : keyPrefix // ignore: cast_nullable_to_non_nullable
as String,createdAt: null == createdAt ? _self.createdAt : createdAt // ignore: cast_nullable_to_non_nullable
as DateTime,expired: null == expired ? _self.expired : expired // ignore: cast_nullable_to_non_nullable
as bool,revokedAt: freezed == revokedAt ? _self.revokedAt : revokedAt // ignore: cast_nullable_to_non_nullable
as DateTime?,expiresAt: freezed == expiresAt ? _self.expiresAt : expiresAt // ignore: cast_nullable_to_non_nullable
as DateTime?,
  ));
}

}


/// Adds pattern-matching-related methods to [AgentKey].
extension AgentKeyPatterns on AgentKey {
/// A variant of `map` that fallback to returning `orElse`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _AgentKey value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _AgentKey() when $default != null:
return $default(_that);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// Callbacks receives the raw object, upcasted.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case final Subclass2 value:
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _AgentKey value)  $default,){
final _that = this;
switch (_that) {
case _AgentKey():
return $default(_that);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `map` that fallback to returning `null`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _AgentKey value)?  $default,){
final _that = this;
switch (_that) {
case _AgentKey() when $default != null:
return $default(_that);case _:
  return null;

}
}
/// A variant of `when` that fallback to an `orElse` callback.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function(@JsonKey(name: 'id')  String id, @JsonKey(name: 'key_prefix')  String keyPrefix, @JsonKey(name: 'created_at')  DateTime createdAt, @JsonKey(name: 'expired')  bool expired, @JsonKey(name: 'revoked_at')  DateTime? revokedAt, @JsonKey(name: 'expires_at')  DateTime? expiresAt)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _AgentKey() when $default != null:
return $default(_that.id,_that.keyPrefix,_that.createdAt,_that.expired,_that.revokedAt,_that.expiresAt);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// As opposed to `map`, this offers destructuring.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case Subclass2(:final field2):
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function(@JsonKey(name: 'id')  String id, @JsonKey(name: 'key_prefix')  String keyPrefix, @JsonKey(name: 'created_at')  DateTime createdAt, @JsonKey(name: 'expired')  bool expired, @JsonKey(name: 'revoked_at')  DateTime? revokedAt, @JsonKey(name: 'expires_at')  DateTime? expiresAt)  $default,) {final _that = this;
switch (_that) {
case _AgentKey():
return $default(_that.id,_that.keyPrefix,_that.createdAt,_that.expired,_that.revokedAt,_that.expiresAt);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `when` that fallback to returning `null`
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function(@JsonKey(name: 'id')  String id, @JsonKey(name: 'key_prefix')  String keyPrefix, @JsonKey(name: 'created_at')  DateTime createdAt, @JsonKey(name: 'expired')  bool expired, @JsonKey(name: 'revoked_at')  DateTime? revokedAt, @JsonKey(name: 'expires_at')  DateTime? expiresAt)?  $default,) {final _that = this;
switch (_that) {
case _AgentKey() when $default != null:
return $default(_that.id,_that.keyPrefix,_that.createdAt,_that.expired,_that.revokedAt,_that.expiresAt);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _AgentKey extends AgentKey {
  const _AgentKey({@JsonKey(name: 'id') required this.id, @JsonKey(name: 'key_prefix') required this.keyPrefix, @JsonKey(name: 'created_at') required this.createdAt, @JsonKey(name: 'expired') required this.expired, @JsonKey(name: 'revoked_at') this.revokedAt, @JsonKey(name: 'expires_at') this.expiresAt}): super._();
  factory _AgentKey.fromJson(Map<String, dynamic> json) => _$AgentKeyFromJson(json);

@override@JsonKey(name: 'id') final  String id;
@override@JsonKey(name: 'key_prefix') final  String keyPrefix;
@override@JsonKey(name: 'created_at') final  DateTime createdAt;
@override@JsonKey(name: 'expired') final  bool expired;
@override@JsonKey(name: 'revoked_at') final  DateTime? revokedAt;
@override@JsonKey(name: 'expires_at') final  DateTime? expiresAt;

/// Create a copy of AgentKey
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$AgentKeyCopyWith<_AgentKey> get copyWith => __$AgentKeyCopyWithImpl<_AgentKey>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$AgentKeyToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _AgentKey&&(identical(other.id, id) || other.id == id)&&(identical(other.keyPrefix, keyPrefix) || other.keyPrefix == keyPrefix)&&(identical(other.createdAt, createdAt) || other.createdAt == createdAt)&&(identical(other.expired, expired) || other.expired == expired)&&(identical(other.revokedAt, revokedAt) || other.revokedAt == revokedAt)&&(identical(other.expiresAt, expiresAt) || other.expiresAt == expiresAt));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,id,keyPrefix,createdAt,expired,revokedAt,expiresAt);

@override
String toString() {
  return 'AgentKey(id: $id, keyPrefix: $keyPrefix, createdAt: $createdAt, expired: $expired, revokedAt: $revokedAt, expiresAt: $expiresAt)';
}


}

/// @nodoc
abstract mixin class _$AgentKeyCopyWith<$Res> implements $AgentKeyCopyWith<$Res> {
  factory _$AgentKeyCopyWith(_AgentKey value, $Res Function(_AgentKey) _then) = __$AgentKeyCopyWithImpl;
@override @useResult
$Res call({
@JsonKey(name: 'id') String id,@JsonKey(name: 'key_prefix') String keyPrefix,@JsonKey(name: 'created_at') DateTime createdAt,@JsonKey(name: 'expired') bool expired,@JsonKey(name: 'revoked_at') DateTime? revokedAt,@JsonKey(name: 'expires_at') DateTime? expiresAt
});




}
/// @nodoc
class __$AgentKeyCopyWithImpl<$Res>
    implements _$AgentKeyCopyWith<$Res> {
  __$AgentKeyCopyWithImpl(this._self, this._then);

  final _AgentKey _self;
  final $Res Function(_AgentKey) _then;

/// Create a copy of AgentKey
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? id = null,Object? keyPrefix = null,Object? createdAt = null,Object? expired = null,Object? revokedAt = freezed,Object? expiresAt = freezed,}) {
  return _then(_AgentKey(
id: null == id ? _self.id : id // ignore: cast_nullable_to_non_nullable
as String,keyPrefix: null == keyPrefix ? _self.keyPrefix : keyPrefix // ignore: cast_nullable_to_non_nullable
as String,createdAt: null == createdAt ? _self.createdAt : createdAt // ignore: cast_nullable_to_non_nullable
as DateTime,expired: null == expired ? _self.expired : expired // ignore: cast_nullable_to_non_nullable
as bool,revokedAt: freezed == revokedAt ? _self.revokedAt : revokedAt // ignore: cast_nullable_to_non_nullable
as DateTime?,expiresAt: freezed == expiresAt ? _self.expiresAt : expiresAt // ignore: cast_nullable_to_non_nullable
as DateTime?,
  ));
}


}


/// @nodoc
mixin _$ListAgentsResponse {

@JsonKey(name: 'agents') List<AgentListing> get agents;@JsonKey(name: 'next_cursor') String? get nextCursor;
/// Create a copy of ListAgentsResponse
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$ListAgentsResponseCopyWith<ListAgentsResponse> get copyWith => _$ListAgentsResponseCopyWithImpl<ListAgentsResponse>(this as ListAgentsResponse, _$identity);

  /// Serializes this ListAgentsResponse to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ListAgentsResponse&&const DeepCollectionEquality().equals(other.agents, agents)&&(identical(other.nextCursor, nextCursor) || other.nextCursor == nextCursor));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,const DeepCollectionEquality().hash(agents),nextCursor);

@override
String toString() {
  return 'ListAgentsResponse(agents: $agents, nextCursor: $nextCursor)';
}


}

/// @nodoc
abstract mixin class $ListAgentsResponseCopyWith<$Res>  {
  factory $ListAgentsResponseCopyWith(ListAgentsResponse value, $Res Function(ListAgentsResponse) _then) = _$ListAgentsResponseCopyWithImpl;
@useResult
$Res call({
@JsonKey(name: 'agents') List<AgentListing> agents,@JsonKey(name: 'next_cursor') String? nextCursor
});




}
/// @nodoc
class _$ListAgentsResponseCopyWithImpl<$Res>
    implements $ListAgentsResponseCopyWith<$Res> {
  _$ListAgentsResponseCopyWithImpl(this._self, this._then);

  final ListAgentsResponse _self;
  final $Res Function(ListAgentsResponse) _then;

/// Create a copy of ListAgentsResponse
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? agents = null,Object? nextCursor = freezed,}) {
  return _then(_self.copyWith(
agents: null == agents ? _self.agents : agents // ignore: cast_nullable_to_non_nullable
as List<AgentListing>,nextCursor: freezed == nextCursor ? _self.nextCursor : nextCursor // ignore: cast_nullable_to_non_nullable
as String?,
  ));
}

}


/// Adds pattern-matching-related methods to [ListAgentsResponse].
extension ListAgentsResponsePatterns on ListAgentsResponse {
/// A variant of `map` that fallback to returning `orElse`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _ListAgentsResponse value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _ListAgentsResponse() when $default != null:
return $default(_that);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// Callbacks receives the raw object, upcasted.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case final Subclass2 value:
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _ListAgentsResponse value)  $default,){
final _that = this;
switch (_that) {
case _ListAgentsResponse():
return $default(_that);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `map` that fallback to returning `null`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _ListAgentsResponse value)?  $default,){
final _that = this;
switch (_that) {
case _ListAgentsResponse() when $default != null:
return $default(_that);case _:
  return null;

}
}
/// A variant of `when` that fallback to an `orElse` callback.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function(@JsonKey(name: 'agents')  List<AgentListing> agents, @JsonKey(name: 'next_cursor')  String? nextCursor)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _ListAgentsResponse() when $default != null:
return $default(_that.agents,_that.nextCursor);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// As opposed to `map`, this offers destructuring.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case Subclass2(:final field2):
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function(@JsonKey(name: 'agents')  List<AgentListing> agents, @JsonKey(name: 'next_cursor')  String? nextCursor)  $default,) {final _that = this;
switch (_that) {
case _ListAgentsResponse():
return $default(_that.agents,_that.nextCursor);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `when` that fallback to returning `null`
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function(@JsonKey(name: 'agents')  List<AgentListing> agents, @JsonKey(name: 'next_cursor')  String? nextCursor)?  $default,) {final _that = this;
switch (_that) {
case _ListAgentsResponse() when $default != null:
return $default(_that.agents,_that.nextCursor);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _ListAgentsResponse implements ListAgentsResponse {
  const _ListAgentsResponse({@JsonKey(name: 'agents') required final  List<AgentListing> agents, @JsonKey(name: 'next_cursor') this.nextCursor}): _agents = agents;
  factory _ListAgentsResponse.fromJson(Map<String, dynamic> json) => _$ListAgentsResponseFromJson(json);

 final  List<AgentListing> _agents;
@override@JsonKey(name: 'agents') List<AgentListing> get agents {
  if (_agents is EqualUnmodifiableListView) return _agents;
  // ignore: implicit_dynamic_type
  return EqualUnmodifiableListView(_agents);
}

@override@JsonKey(name: 'next_cursor') final  String? nextCursor;

/// Create a copy of ListAgentsResponse
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$ListAgentsResponseCopyWith<_ListAgentsResponse> get copyWith => __$ListAgentsResponseCopyWithImpl<_ListAgentsResponse>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$ListAgentsResponseToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _ListAgentsResponse&&const DeepCollectionEquality().equals(other._agents, _agents)&&(identical(other.nextCursor, nextCursor) || other.nextCursor == nextCursor));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,const DeepCollectionEquality().hash(_agents),nextCursor);

@override
String toString() {
  return 'ListAgentsResponse(agents: $agents, nextCursor: $nextCursor)';
}


}

/// @nodoc
abstract mixin class _$ListAgentsResponseCopyWith<$Res> implements $ListAgentsResponseCopyWith<$Res> {
  factory _$ListAgentsResponseCopyWith(_ListAgentsResponse value, $Res Function(_ListAgentsResponse) _then) = __$ListAgentsResponseCopyWithImpl;
@override @useResult
$Res call({
@JsonKey(name: 'agents') List<AgentListing> agents,@JsonKey(name: 'next_cursor') String? nextCursor
});




}
/// @nodoc
class __$ListAgentsResponseCopyWithImpl<$Res>
    implements _$ListAgentsResponseCopyWith<$Res> {
  __$ListAgentsResponseCopyWithImpl(this._self, this._then);

  final _ListAgentsResponse _self;
  final $Res Function(_ListAgentsResponse) _then;

/// Create a copy of ListAgentsResponse
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? agents = null,Object? nextCursor = freezed,}) {
  return _then(_ListAgentsResponse(
agents: null == agents ? _self._agents : agents // ignore: cast_nullable_to_non_nullable
as List<AgentListing>,nextCursor: freezed == nextCursor ? _self.nextCursor : nextCursor // ignore: cast_nullable_to_non_nullable
as String?,
  ));
}


}


/// @nodoc
mixin _$AgentListing {

@JsonKey(name: 'id') String get id;@JsonKey(name: 'name') String get name;@JsonKey(name: 'created_at') DateTime get createdAt;@JsonKey(name: 'active_keys') int get activeKeys;@JsonKey(name: 'total_keys') int get totalKeys;@JsonKey(name: 'live_docs') int get liveDocs;
/// Create a copy of AgentListing
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$AgentListingCopyWith<AgentListing> get copyWith => _$AgentListingCopyWithImpl<AgentListing>(this as AgentListing, _$identity);

  /// Serializes this AgentListing to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is AgentListing&&(identical(other.id, id) || other.id == id)&&(identical(other.name, name) || other.name == name)&&(identical(other.createdAt, createdAt) || other.createdAt == createdAt)&&(identical(other.activeKeys, activeKeys) || other.activeKeys == activeKeys)&&(identical(other.totalKeys, totalKeys) || other.totalKeys == totalKeys)&&(identical(other.liveDocs, liveDocs) || other.liveDocs == liveDocs));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,id,name,createdAt,activeKeys,totalKeys,liveDocs);

@override
String toString() {
  return 'AgentListing(id: $id, name: $name, createdAt: $createdAt, activeKeys: $activeKeys, totalKeys: $totalKeys, liveDocs: $liveDocs)';
}


}

/// @nodoc
abstract mixin class $AgentListingCopyWith<$Res>  {
  factory $AgentListingCopyWith(AgentListing value, $Res Function(AgentListing) _then) = _$AgentListingCopyWithImpl;
@useResult
$Res call({
@JsonKey(name: 'id') String id,@JsonKey(name: 'name') String name,@JsonKey(name: 'created_at') DateTime createdAt,@JsonKey(name: 'active_keys') int activeKeys,@JsonKey(name: 'total_keys') int totalKeys,@JsonKey(name: 'live_docs') int liveDocs
});




}
/// @nodoc
class _$AgentListingCopyWithImpl<$Res>
    implements $AgentListingCopyWith<$Res> {
  _$AgentListingCopyWithImpl(this._self, this._then);

  final AgentListing _self;
  final $Res Function(AgentListing) _then;

/// Create a copy of AgentListing
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? id = null,Object? name = null,Object? createdAt = null,Object? activeKeys = null,Object? totalKeys = null,Object? liveDocs = null,}) {
  return _then(_self.copyWith(
id: null == id ? _self.id : id // ignore: cast_nullable_to_non_nullable
as String,name: null == name ? _self.name : name // ignore: cast_nullable_to_non_nullable
as String,createdAt: null == createdAt ? _self.createdAt : createdAt // ignore: cast_nullable_to_non_nullable
as DateTime,activeKeys: null == activeKeys ? _self.activeKeys : activeKeys // ignore: cast_nullable_to_non_nullable
as int,totalKeys: null == totalKeys ? _self.totalKeys : totalKeys // ignore: cast_nullable_to_non_nullable
as int,liveDocs: null == liveDocs ? _self.liveDocs : liveDocs // ignore: cast_nullable_to_non_nullable
as int,
  ));
}

}


/// Adds pattern-matching-related methods to [AgentListing].
extension AgentListingPatterns on AgentListing {
/// A variant of `map` that fallback to returning `orElse`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _AgentListing value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _AgentListing() when $default != null:
return $default(_that);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// Callbacks receives the raw object, upcasted.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case final Subclass2 value:
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _AgentListing value)  $default,){
final _that = this;
switch (_that) {
case _AgentListing():
return $default(_that);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `map` that fallback to returning `null`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _AgentListing value)?  $default,){
final _that = this;
switch (_that) {
case _AgentListing() when $default != null:
return $default(_that);case _:
  return null;

}
}
/// A variant of `when` that fallback to an `orElse` callback.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function(@JsonKey(name: 'id')  String id, @JsonKey(name: 'name')  String name, @JsonKey(name: 'created_at')  DateTime createdAt, @JsonKey(name: 'active_keys')  int activeKeys, @JsonKey(name: 'total_keys')  int totalKeys, @JsonKey(name: 'live_docs')  int liveDocs)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _AgentListing() when $default != null:
return $default(_that.id,_that.name,_that.createdAt,_that.activeKeys,_that.totalKeys,_that.liveDocs);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// As opposed to `map`, this offers destructuring.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case Subclass2(:final field2):
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function(@JsonKey(name: 'id')  String id, @JsonKey(name: 'name')  String name, @JsonKey(name: 'created_at')  DateTime createdAt, @JsonKey(name: 'active_keys')  int activeKeys, @JsonKey(name: 'total_keys')  int totalKeys, @JsonKey(name: 'live_docs')  int liveDocs)  $default,) {final _that = this;
switch (_that) {
case _AgentListing():
return $default(_that.id,_that.name,_that.createdAt,_that.activeKeys,_that.totalKeys,_that.liveDocs);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `when` that fallback to returning `null`
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function(@JsonKey(name: 'id')  String id, @JsonKey(name: 'name')  String name, @JsonKey(name: 'created_at')  DateTime createdAt, @JsonKey(name: 'active_keys')  int activeKeys, @JsonKey(name: 'total_keys')  int totalKeys, @JsonKey(name: 'live_docs')  int liveDocs)?  $default,) {final _that = this;
switch (_that) {
case _AgentListing() when $default != null:
return $default(_that.id,_that.name,_that.createdAt,_that.activeKeys,_that.totalKeys,_that.liveDocs);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _AgentListing implements AgentListing {
  const _AgentListing({@JsonKey(name: 'id') required this.id, @JsonKey(name: 'name') required this.name, @JsonKey(name: 'created_at') required this.createdAt, @JsonKey(name: 'active_keys') required this.activeKeys, @JsonKey(name: 'total_keys') required this.totalKeys, @JsonKey(name: 'live_docs') required this.liveDocs});
  factory _AgentListing.fromJson(Map<String, dynamic> json) => _$AgentListingFromJson(json);

@override@JsonKey(name: 'id') final  String id;
@override@JsonKey(name: 'name') final  String name;
@override@JsonKey(name: 'created_at') final  DateTime createdAt;
@override@JsonKey(name: 'active_keys') final  int activeKeys;
@override@JsonKey(name: 'total_keys') final  int totalKeys;
@override@JsonKey(name: 'live_docs') final  int liveDocs;

/// Create a copy of AgentListing
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$AgentListingCopyWith<_AgentListing> get copyWith => __$AgentListingCopyWithImpl<_AgentListing>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$AgentListingToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _AgentListing&&(identical(other.id, id) || other.id == id)&&(identical(other.name, name) || other.name == name)&&(identical(other.createdAt, createdAt) || other.createdAt == createdAt)&&(identical(other.activeKeys, activeKeys) || other.activeKeys == activeKeys)&&(identical(other.totalKeys, totalKeys) || other.totalKeys == totalKeys)&&(identical(other.liveDocs, liveDocs) || other.liveDocs == liveDocs));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,id,name,createdAt,activeKeys,totalKeys,liveDocs);

@override
String toString() {
  return 'AgentListing(id: $id, name: $name, createdAt: $createdAt, activeKeys: $activeKeys, totalKeys: $totalKeys, liveDocs: $liveDocs)';
}


}

/// @nodoc
abstract mixin class _$AgentListingCopyWith<$Res> implements $AgentListingCopyWith<$Res> {
  factory _$AgentListingCopyWith(_AgentListing value, $Res Function(_AgentListing) _then) = __$AgentListingCopyWithImpl;
@override @useResult
$Res call({
@JsonKey(name: 'id') String id,@JsonKey(name: 'name') String name,@JsonKey(name: 'created_at') DateTime createdAt,@JsonKey(name: 'active_keys') int activeKeys,@JsonKey(name: 'total_keys') int totalKeys,@JsonKey(name: 'live_docs') int liveDocs
});




}
/// @nodoc
class __$AgentListingCopyWithImpl<$Res>
    implements _$AgentListingCopyWith<$Res> {
  __$AgentListingCopyWithImpl(this._self, this._then);

  final _AgentListing _self;
  final $Res Function(_AgentListing) _then;

/// Create a copy of AgentListing
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? id = null,Object? name = null,Object? createdAt = null,Object? activeKeys = null,Object? totalKeys = null,Object? liveDocs = null,}) {
  return _then(_AgentListing(
id: null == id ? _self.id : id // ignore: cast_nullable_to_non_nullable
as String,name: null == name ? _self.name : name // ignore: cast_nullable_to_non_nullable
as String,createdAt: null == createdAt ? _self.createdAt : createdAt // ignore: cast_nullable_to_non_nullable
as DateTime,activeKeys: null == activeKeys ? _self.activeKeys : activeKeys // ignore: cast_nullable_to_non_nullable
as int,totalKeys: null == totalKeys ? _self.totalKeys : totalKeys // ignore: cast_nullable_to_non_nullable
as int,liveDocs: null == liveDocs ? _self.liveDocs : liveDocs // ignore: cast_nullable_to_non_nullable
as int,
  ));
}


}


/// @nodoc
mixin _$ListDocumentsResponse {

@JsonKey(name: 'documents') List<DocumentListing> get documents;@JsonKey(name: 'next_cursor') String? get nextCursor;
/// Create a copy of ListDocumentsResponse
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$ListDocumentsResponseCopyWith<ListDocumentsResponse> get copyWith => _$ListDocumentsResponseCopyWithImpl<ListDocumentsResponse>(this as ListDocumentsResponse, _$identity);

  /// Serializes this ListDocumentsResponse to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ListDocumentsResponse&&const DeepCollectionEquality().equals(other.documents, documents)&&(identical(other.nextCursor, nextCursor) || other.nextCursor == nextCursor));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,const DeepCollectionEquality().hash(documents),nextCursor);

@override
String toString() {
  return 'ListDocumentsResponse(documents: $documents, nextCursor: $nextCursor)';
}


}

/// @nodoc
abstract mixin class $ListDocumentsResponseCopyWith<$Res>  {
  factory $ListDocumentsResponseCopyWith(ListDocumentsResponse value, $Res Function(ListDocumentsResponse) _then) = _$ListDocumentsResponseCopyWithImpl;
@useResult
$Res call({
@JsonKey(name: 'documents') List<DocumentListing> documents,@JsonKey(name: 'next_cursor') String? nextCursor
});




}
/// @nodoc
class _$ListDocumentsResponseCopyWithImpl<$Res>
    implements $ListDocumentsResponseCopyWith<$Res> {
  _$ListDocumentsResponseCopyWithImpl(this._self, this._then);

  final ListDocumentsResponse _self;
  final $Res Function(ListDocumentsResponse) _then;

/// Create a copy of ListDocumentsResponse
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? documents = null,Object? nextCursor = freezed,}) {
  return _then(_self.copyWith(
documents: null == documents ? _self.documents : documents // ignore: cast_nullable_to_non_nullable
as List<DocumentListing>,nextCursor: freezed == nextCursor ? _self.nextCursor : nextCursor // ignore: cast_nullable_to_non_nullable
as String?,
  ));
}

}


/// Adds pattern-matching-related methods to [ListDocumentsResponse].
extension ListDocumentsResponsePatterns on ListDocumentsResponse {
/// A variant of `map` that fallback to returning `orElse`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _ListDocumentsResponse value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _ListDocumentsResponse() when $default != null:
return $default(_that);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// Callbacks receives the raw object, upcasted.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case final Subclass2 value:
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _ListDocumentsResponse value)  $default,){
final _that = this;
switch (_that) {
case _ListDocumentsResponse():
return $default(_that);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `map` that fallback to returning `null`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _ListDocumentsResponse value)?  $default,){
final _that = this;
switch (_that) {
case _ListDocumentsResponse() when $default != null:
return $default(_that);case _:
  return null;

}
}
/// A variant of `when` that fallback to an `orElse` callback.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function(@JsonKey(name: 'documents')  List<DocumentListing> documents, @JsonKey(name: 'next_cursor')  String? nextCursor)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _ListDocumentsResponse() when $default != null:
return $default(_that.documents,_that.nextCursor);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// As opposed to `map`, this offers destructuring.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case Subclass2(:final field2):
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function(@JsonKey(name: 'documents')  List<DocumentListing> documents, @JsonKey(name: 'next_cursor')  String? nextCursor)  $default,) {final _that = this;
switch (_that) {
case _ListDocumentsResponse():
return $default(_that.documents,_that.nextCursor);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `when` that fallback to returning `null`
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function(@JsonKey(name: 'documents')  List<DocumentListing> documents, @JsonKey(name: 'next_cursor')  String? nextCursor)?  $default,) {final _that = this;
switch (_that) {
case _ListDocumentsResponse() when $default != null:
return $default(_that.documents,_that.nextCursor);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _ListDocumentsResponse implements ListDocumentsResponse {
  const _ListDocumentsResponse({@JsonKey(name: 'documents') required final  List<DocumentListing> documents, @JsonKey(name: 'next_cursor') this.nextCursor}): _documents = documents;
  factory _ListDocumentsResponse.fromJson(Map<String, dynamic> json) => _$ListDocumentsResponseFromJson(json);

 final  List<DocumentListing> _documents;
@override@JsonKey(name: 'documents') List<DocumentListing> get documents {
  if (_documents is EqualUnmodifiableListView) return _documents;
  // ignore: implicit_dynamic_type
  return EqualUnmodifiableListView(_documents);
}

@override@JsonKey(name: 'next_cursor') final  String? nextCursor;

/// Create a copy of ListDocumentsResponse
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$ListDocumentsResponseCopyWith<_ListDocumentsResponse> get copyWith => __$ListDocumentsResponseCopyWithImpl<_ListDocumentsResponse>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$ListDocumentsResponseToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _ListDocumentsResponse&&const DeepCollectionEquality().equals(other._documents, _documents)&&(identical(other.nextCursor, nextCursor) || other.nextCursor == nextCursor));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,const DeepCollectionEquality().hash(_documents),nextCursor);

@override
String toString() {
  return 'ListDocumentsResponse(documents: $documents, nextCursor: $nextCursor)';
}


}

/// @nodoc
abstract mixin class _$ListDocumentsResponseCopyWith<$Res> implements $ListDocumentsResponseCopyWith<$Res> {
  factory _$ListDocumentsResponseCopyWith(_ListDocumentsResponse value, $Res Function(_ListDocumentsResponse) _then) = __$ListDocumentsResponseCopyWithImpl;
@override @useResult
$Res call({
@JsonKey(name: 'documents') List<DocumentListing> documents,@JsonKey(name: 'next_cursor') String? nextCursor
});




}
/// @nodoc
class __$ListDocumentsResponseCopyWithImpl<$Res>
    implements _$ListDocumentsResponseCopyWith<$Res> {
  __$ListDocumentsResponseCopyWithImpl(this._self, this._then);

  final _ListDocumentsResponse _self;
  final $Res Function(_ListDocumentsResponse) _then;

/// Create a copy of ListDocumentsResponse
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? documents = null,Object? nextCursor = freezed,}) {
  return _then(_ListDocumentsResponse(
documents: null == documents ? _self._documents : documents // ignore: cast_nullable_to_non_nullable
as List<DocumentListing>,nextCursor: freezed == nextCursor ? _self.nextCursor : nextCursor // ignore: cast_nullable_to_non_nullable
as String?,
  ));
}


}


/// @nodoc
mixin _$MintAgentKeyResponse {

@JsonKey(name: 'agent_id') String get agentId;@JsonKey(name: 'key_id') String get keyId;@JsonKey(name: 'key') String get key;@JsonKey(name: 'note') String get note;
/// Create a copy of MintAgentKeyResponse
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$MintAgentKeyResponseCopyWith<MintAgentKeyResponse> get copyWith => _$MintAgentKeyResponseCopyWithImpl<MintAgentKeyResponse>(this as MintAgentKeyResponse, _$identity);

  /// Serializes this MintAgentKeyResponse to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is MintAgentKeyResponse&&(identical(other.agentId, agentId) || other.agentId == agentId)&&(identical(other.keyId, keyId) || other.keyId == keyId)&&(identical(other.key, key) || other.key == key)&&(identical(other.note, note) || other.note == note));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,agentId,keyId,key,note);

@override
String toString() {
  return 'MintAgentKeyResponse(agentId: $agentId, keyId: $keyId, key: $key, note: $note)';
}


}

/// @nodoc
abstract mixin class $MintAgentKeyResponseCopyWith<$Res>  {
  factory $MintAgentKeyResponseCopyWith(MintAgentKeyResponse value, $Res Function(MintAgentKeyResponse) _then) = _$MintAgentKeyResponseCopyWithImpl;
@useResult
$Res call({
@JsonKey(name: 'agent_id') String agentId,@JsonKey(name: 'key_id') String keyId,@JsonKey(name: 'key') String key,@JsonKey(name: 'note') String note
});




}
/// @nodoc
class _$MintAgentKeyResponseCopyWithImpl<$Res>
    implements $MintAgentKeyResponseCopyWith<$Res> {
  _$MintAgentKeyResponseCopyWithImpl(this._self, this._then);

  final MintAgentKeyResponse _self;
  final $Res Function(MintAgentKeyResponse) _then;

/// Create a copy of MintAgentKeyResponse
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? agentId = null,Object? keyId = null,Object? key = null,Object? note = null,}) {
  return _then(_self.copyWith(
agentId: null == agentId ? _self.agentId : agentId // ignore: cast_nullable_to_non_nullable
as String,keyId: null == keyId ? _self.keyId : keyId // ignore: cast_nullable_to_non_nullable
as String,key: null == key ? _self.key : key // ignore: cast_nullable_to_non_nullable
as String,note: null == note ? _self.note : note // ignore: cast_nullable_to_non_nullable
as String,
  ));
}

}


/// Adds pattern-matching-related methods to [MintAgentKeyResponse].
extension MintAgentKeyResponsePatterns on MintAgentKeyResponse {
/// A variant of `map` that fallback to returning `orElse`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _MintAgentKeyResponse value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _MintAgentKeyResponse() when $default != null:
return $default(_that);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// Callbacks receives the raw object, upcasted.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case final Subclass2 value:
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _MintAgentKeyResponse value)  $default,){
final _that = this;
switch (_that) {
case _MintAgentKeyResponse():
return $default(_that);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `map` that fallback to returning `null`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _MintAgentKeyResponse value)?  $default,){
final _that = this;
switch (_that) {
case _MintAgentKeyResponse() when $default != null:
return $default(_that);case _:
  return null;

}
}
/// A variant of `when` that fallback to an `orElse` callback.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function(@JsonKey(name: 'agent_id')  String agentId, @JsonKey(name: 'key_id')  String keyId, @JsonKey(name: 'key')  String key, @JsonKey(name: 'note')  String note)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _MintAgentKeyResponse() when $default != null:
return $default(_that.agentId,_that.keyId,_that.key,_that.note);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// As opposed to `map`, this offers destructuring.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case Subclass2(:final field2):
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function(@JsonKey(name: 'agent_id')  String agentId, @JsonKey(name: 'key_id')  String keyId, @JsonKey(name: 'key')  String key, @JsonKey(name: 'note')  String note)  $default,) {final _that = this;
switch (_that) {
case _MintAgentKeyResponse():
return $default(_that.agentId,_that.keyId,_that.key,_that.note);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `when` that fallback to returning `null`
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function(@JsonKey(name: 'agent_id')  String agentId, @JsonKey(name: 'key_id')  String keyId, @JsonKey(name: 'key')  String key, @JsonKey(name: 'note')  String note)?  $default,) {final _that = this;
switch (_that) {
case _MintAgentKeyResponse() when $default != null:
return $default(_that.agentId,_that.keyId,_that.key,_that.note);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _MintAgentKeyResponse implements MintAgentKeyResponse {
  const _MintAgentKeyResponse({@JsonKey(name: 'agent_id') required this.agentId, @JsonKey(name: 'key_id') required this.keyId, @JsonKey(name: 'key') required this.key, @JsonKey(name: 'note') required this.note});
  factory _MintAgentKeyResponse.fromJson(Map<String, dynamic> json) => _$MintAgentKeyResponseFromJson(json);

@override@JsonKey(name: 'agent_id') final  String agentId;
@override@JsonKey(name: 'key_id') final  String keyId;
@override@JsonKey(name: 'key') final  String key;
@override@JsonKey(name: 'note') final  String note;

/// Create a copy of MintAgentKeyResponse
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$MintAgentKeyResponseCopyWith<_MintAgentKeyResponse> get copyWith => __$MintAgentKeyResponseCopyWithImpl<_MintAgentKeyResponse>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$MintAgentKeyResponseToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _MintAgentKeyResponse&&(identical(other.agentId, agentId) || other.agentId == agentId)&&(identical(other.keyId, keyId) || other.keyId == keyId)&&(identical(other.key, key) || other.key == key)&&(identical(other.note, note) || other.note == note));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,agentId,keyId,key,note);

@override
String toString() {
  return 'MintAgentKeyResponse(agentId: $agentId, keyId: $keyId, key: $key, note: $note)';
}


}

/// @nodoc
abstract mixin class _$MintAgentKeyResponseCopyWith<$Res> implements $MintAgentKeyResponseCopyWith<$Res> {
  factory _$MintAgentKeyResponseCopyWith(_MintAgentKeyResponse value, $Res Function(_MintAgentKeyResponse) _then) = __$MintAgentKeyResponseCopyWithImpl;
@override @useResult
$Res call({
@JsonKey(name: 'agent_id') String agentId,@JsonKey(name: 'key_id') String keyId,@JsonKey(name: 'key') String key,@JsonKey(name: 'note') String note
});




}
/// @nodoc
class __$MintAgentKeyResponseCopyWithImpl<$Res>
    implements _$MintAgentKeyResponseCopyWith<$Res> {
  __$MintAgentKeyResponseCopyWithImpl(this._self, this._then);

  final _MintAgentKeyResponse _self;
  final $Res Function(_MintAgentKeyResponse) _then;

/// Create a copy of MintAgentKeyResponse
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? agentId = null,Object? keyId = null,Object? key = null,Object? note = null,}) {
  return _then(_MintAgentKeyResponse(
agentId: null == agentId ? _self.agentId : agentId // ignore: cast_nullable_to_non_nullable
as String,keyId: null == keyId ? _self.keyId : keyId // ignore: cast_nullable_to_non_nullable
as String,key: null == key ? _self.key : key // ignore: cast_nullable_to_non_nullable
as String,note: null == note ? _self.note : note // ignore: cast_nullable_to_non_nullable
as String,
  ));
}


}


/// @nodoc
mixin _$OrphanDocumentsResponse {

@JsonKey(name: 'documents') List<DocumentListing> get documents;
/// Create a copy of OrphanDocumentsResponse
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$OrphanDocumentsResponseCopyWith<OrphanDocumentsResponse> get copyWith => _$OrphanDocumentsResponseCopyWithImpl<OrphanDocumentsResponse>(this as OrphanDocumentsResponse, _$identity);

  /// Serializes this OrphanDocumentsResponse to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is OrphanDocumentsResponse&&const DeepCollectionEquality().equals(other.documents, documents));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,const DeepCollectionEquality().hash(documents));

@override
String toString() {
  return 'OrphanDocumentsResponse(documents: $documents)';
}


}

/// @nodoc
abstract mixin class $OrphanDocumentsResponseCopyWith<$Res>  {
  factory $OrphanDocumentsResponseCopyWith(OrphanDocumentsResponse value, $Res Function(OrphanDocumentsResponse) _then) = _$OrphanDocumentsResponseCopyWithImpl;
@useResult
$Res call({
@JsonKey(name: 'documents') List<DocumentListing> documents
});




}
/// @nodoc
class _$OrphanDocumentsResponseCopyWithImpl<$Res>
    implements $OrphanDocumentsResponseCopyWith<$Res> {
  _$OrphanDocumentsResponseCopyWithImpl(this._self, this._then);

  final OrphanDocumentsResponse _self;
  final $Res Function(OrphanDocumentsResponse) _then;

/// Create a copy of OrphanDocumentsResponse
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? documents = null,}) {
  return _then(_self.copyWith(
documents: null == documents ? _self.documents : documents // ignore: cast_nullable_to_non_nullable
as List<DocumentListing>,
  ));
}

}


/// Adds pattern-matching-related methods to [OrphanDocumentsResponse].
extension OrphanDocumentsResponsePatterns on OrphanDocumentsResponse {
/// A variant of `map` that fallback to returning `orElse`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _OrphanDocumentsResponse value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _OrphanDocumentsResponse() when $default != null:
return $default(_that);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// Callbacks receives the raw object, upcasted.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case final Subclass2 value:
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _OrphanDocumentsResponse value)  $default,){
final _that = this;
switch (_that) {
case _OrphanDocumentsResponse():
return $default(_that);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `map` that fallback to returning `null`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _OrphanDocumentsResponse value)?  $default,){
final _that = this;
switch (_that) {
case _OrphanDocumentsResponse() when $default != null:
return $default(_that);case _:
  return null;

}
}
/// A variant of `when` that fallback to an `orElse` callback.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function(@JsonKey(name: 'documents')  List<DocumentListing> documents)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _OrphanDocumentsResponse() when $default != null:
return $default(_that.documents);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// As opposed to `map`, this offers destructuring.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case Subclass2(:final field2):
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function(@JsonKey(name: 'documents')  List<DocumentListing> documents)  $default,) {final _that = this;
switch (_that) {
case _OrphanDocumentsResponse():
return $default(_that.documents);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `when` that fallback to returning `null`
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function(@JsonKey(name: 'documents')  List<DocumentListing> documents)?  $default,) {final _that = this;
switch (_that) {
case _OrphanDocumentsResponse() when $default != null:
return $default(_that.documents);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _OrphanDocumentsResponse implements OrphanDocumentsResponse {
  const _OrphanDocumentsResponse({@JsonKey(name: 'documents') required final  List<DocumentListing> documents}): _documents = documents;
  factory _OrphanDocumentsResponse.fromJson(Map<String, dynamic> json) => _$OrphanDocumentsResponseFromJson(json);

 final  List<DocumentListing> _documents;
@override@JsonKey(name: 'documents') List<DocumentListing> get documents {
  if (_documents is EqualUnmodifiableListView) return _documents;
  // ignore: implicit_dynamic_type
  return EqualUnmodifiableListView(_documents);
}


/// Create a copy of OrphanDocumentsResponse
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$OrphanDocumentsResponseCopyWith<_OrphanDocumentsResponse> get copyWith => __$OrphanDocumentsResponseCopyWithImpl<_OrphanDocumentsResponse>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$OrphanDocumentsResponseToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _OrphanDocumentsResponse&&const DeepCollectionEquality().equals(other._documents, _documents));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,const DeepCollectionEquality().hash(_documents));

@override
String toString() {
  return 'OrphanDocumentsResponse(documents: $documents)';
}


}

/// @nodoc
abstract mixin class _$OrphanDocumentsResponseCopyWith<$Res> implements $OrphanDocumentsResponseCopyWith<$Res> {
  factory _$OrphanDocumentsResponseCopyWith(_OrphanDocumentsResponse value, $Res Function(_OrphanDocumentsResponse) _then) = __$OrphanDocumentsResponseCopyWithImpl;
@override @useResult
$Res call({
@JsonKey(name: 'documents') List<DocumentListing> documents
});




}
/// @nodoc
class __$OrphanDocumentsResponseCopyWithImpl<$Res>
    implements _$OrphanDocumentsResponseCopyWith<$Res> {
  __$OrphanDocumentsResponseCopyWithImpl(this._self, this._then);

  final _OrphanDocumentsResponse _self;
  final $Res Function(_OrphanDocumentsResponse) _then;

/// Create a copy of OrphanDocumentsResponse
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? documents = null,}) {
  return _then(_OrphanDocumentsResponse(
documents: null == documents ? _self._documents : documents // ignore: cast_nullable_to_non_nullable
as List<DocumentListing>,
  ));
}


}


/// @nodoc
mixin _$PackDocument {

@JsonKey(name: 'public_id') String get publicId;@JsonKey(name: 'created_at') DateTime get createdAt;@JsonKey(name: 'created_by_kind') String get createdByKind;@JsonKey(name: 'tags') List<String> get tags;@JsonKey(name: 'status') String get status;@JsonKey(name: 'visibility') String get visibility;@JsonKey(name: 'content') String get content;@JsonKey(name: 'format') String get format;@JsonKey(name: 'converter_v') String get converterV;@JsonKey(name: 'version') int get version;@JsonKey(name: 'current_ver') int? get currentVer;@JsonKey(name: 'created_by_id') String? get createdById;@JsonKey(name: 'created_by_name') String? get createdByName;@JsonKey(name: 'current_size') int? get currentSize;@JsonKey(name: 'current_source_sha256') String? get currentSourceSha256;@JsonKey(name: 'revoked_at') DateTime? get revokedAt;@JsonKey(name: 'title') String? get title;@JsonKey(name: 'description') String? get description;@JsonKey(name: 'slug') String? get slug;@JsonKey(name: 'superseded_by') String? get supersededBy;@JsonKey(name: 'score') double? get score;@JsonKey(name: 'matched_field') String? get matchedField;@JsonKey(name: 'snippet') String? get snippet;@JsonKey(name: 'tier') String? get tier;@JsonKey(name: 'hint') String? get hint;
/// Create a copy of PackDocument
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$PackDocumentCopyWith<PackDocument> get copyWith => _$PackDocumentCopyWithImpl<PackDocument>(this as PackDocument, _$identity);

  /// Serializes this PackDocument to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is PackDocument&&(identical(other.publicId, publicId) || other.publicId == publicId)&&(identical(other.createdAt, createdAt) || other.createdAt == createdAt)&&(identical(other.createdByKind, createdByKind) || other.createdByKind == createdByKind)&&const DeepCollectionEquality().equals(other.tags, tags)&&(identical(other.status, status) || other.status == status)&&(identical(other.visibility, visibility) || other.visibility == visibility)&&(identical(other.content, content) || other.content == content)&&(identical(other.format, format) || other.format == format)&&(identical(other.converterV, converterV) || other.converterV == converterV)&&(identical(other.version, version) || other.version == version)&&(identical(other.currentVer, currentVer) || other.currentVer == currentVer)&&(identical(other.createdById, createdById) || other.createdById == createdById)&&(identical(other.createdByName, createdByName) || other.createdByName == createdByName)&&(identical(other.currentSize, currentSize) || other.currentSize == currentSize)&&(identical(other.currentSourceSha256, currentSourceSha256) || other.currentSourceSha256 == currentSourceSha256)&&(identical(other.revokedAt, revokedAt) || other.revokedAt == revokedAt)&&(identical(other.title, title) || other.title == title)&&(identical(other.description, description) || other.description == description)&&(identical(other.slug, slug) || other.slug == slug)&&(identical(other.supersededBy, supersededBy) || other.supersededBy == supersededBy)&&(identical(other.score, score) || other.score == score)&&(identical(other.matchedField, matchedField) || other.matchedField == matchedField)&&(identical(other.snippet, snippet) || other.snippet == snippet)&&(identical(other.tier, tier) || other.tier == tier)&&(identical(other.hint, hint) || other.hint == hint));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hashAll([runtimeType,publicId,createdAt,createdByKind,const DeepCollectionEquality().hash(tags),status,visibility,content,format,converterV,version,currentVer,createdById,createdByName,currentSize,currentSourceSha256,revokedAt,title,description,slug,supersededBy,score,matchedField,snippet,tier,hint]);

@override
String toString() {
  return 'PackDocument(publicId: $publicId, createdAt: $createdAt, createdByKind: $createdByKind, tags: $tags, status: $status, visibility: $visibility, content: $content, format: $format, converterV: $converterV, version: $version, currentVer: $currentVer, createdById: $createdById, createdByName: $createdByName, currentSize: $currentSize, currentSourceSha256: $currentSourceSha256, revokedAt: $revokedAt, title: $title, description: $description, slug: $slug, supersededBy: $supersededBy, score: $score, matchedField: $matchedField, snippet: $snippet, tier: $tier, hint: $hint)';
}


}

/// @nodoc
abstract mixin class $PackDocumentCopyWith<$Res>  {
  factory $PackDocumentCopyWith(PackDocument value, $Res Function(PackDocument) _then) = _$PackDocumentCopyWithImpl;
@useResult
$Res call({
@JsonKey(name: 'public_id') String publicId,@JsonKey(name: 'created_at') DateTime createdAt,@JsonKey(name: 'created_by_kind') String createdByKind,@JsonKey(name: 'tags') List<String> tags,@JsonKey(name: 'status') String status,@JsonKey(name: 'visibility') String visibility,@JsonKey(name: 'content') String content,@JsonKey(name: 'format') String format,@JsonKey(name: 'converter_v') String converterV,@JsonKey(name: 'version') int version,@JsonKey(name: 'current_ver') int? currentVer,@JsonKey(name: 'created_by_id') String? createdById,@JsonKey(name: 'created_by_name') String? createdByName,@JsonKey(name: 'current_size') int? currentSize,@JsonKey(name: 'current_source_sha256') String? currentSourceSha256,@JsonKey(name: 'revoked_at') DateTime? revokedAt,@JsonKey(name: 'title') String? title,@JsonKey(name: 'description') String? description,@JsonKey(name: 'slug') String? slug,@JsonKey(name: 'superseded_by') String? supersededBy,@JsonKey(name: 'score') double? score,@JsonKey(name: 'matched_field') String? matchedField,@JsonKey(name: 'snippet') String? snippet,@JsonKey(name: 'tier') String? tier,@JsonKey(name: 'hint') String? hint
});




}
/// @nodoc
class _$PackDocumentCopyWithImpl<$Res>
    implements $PackDocumentCopyWith<$Res> {
  _$PackDocumentCopyWithImpl(this._self, this._then);

  final PackDocument _self;
  final $Res Function(PackDocument) _then;

/// Create a copy of PackDocument
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? publicId = null,Object? createdAt = null,Object? createdByKind = null,Object? tags = null,Object? status = null,Object? visibility = null,Object? content = null,Object? format = null,Object? converterV = null,Object? version = null,Object? currentVer = freezed,Object? createdById = freezed,Object? createdByName = freezed,Object? currentSize = freezed,Object? currentSourceSha256 = freezed,Object? revokedAt = freezed,Object? title = freezed,Object? description = freezed,Object? slug = freezed,Object? supersededBy = freezed,Object? score = freezed,Object? matchedField = freezed,Object? snippet = freezed,Object? tier = freezed,Object? hint = freezed,}) {
  return _then(_self.copyWith(
publicId: null == publicId ? _self.publicId : publicId // ignore: cast_nullable_to_non_nullable
as String,createdAt: null == createdAt ? _self.createdAt : createdAt // ignore: cast_nullable_to_non_nullable
as DateTime,createdByKind: null == createdByKind ? _self.createdByKind : createdByKind // ignore: cast_nullable_to_non_nullable
as String,tags: null == tags ? _self.tags : tags // ignore: cast_nullable_to_non_nullable
as List<String>,status: null == status ? _self.status : status // ignore: cast_nullable_to_non_nullable
as String,visibility: null == visibility ? _self.visibility : visibility // ignore: cast_nullable_to_non_nullable
as String,content: null == content ? _self.content : content // ignore: cast_nullable_to_non_nullable
as String,format: null == format ? _self.format : format // ignore: cast_nullable_to_non_nullable
as String,converterV: null == converterV ? _self.converterV : converterV // ignore: cast_nullable_to_non_nullable
as String,version: null == version ? _self.version : version // ignore: cast_nullable_to_non_nullable
as int,currentVer: freezed == currentVer ? _self.currentVer : currentVer // ignore: cast_nullable_to_non_nullable
as int?,createdById: freezed == createdById ? _self.createdById : createdById // ignore: cast_nullable_to_non_nullable
as String?,createdByName: freezed == createdByName ? _self.createdByName : createdByName // ignore: cast_nullable_to_non_nullable
as String?,currentSize: freezed == currentSize ? _self.currentSize : currentSize // ignore: cast_nullable_to_non_nullable
as int?,currentSourceSha256: freezed == currentSourceSha256 ? _self.currentSourceSha256 : currentSourceSha256 // ignore: cast_nullable_to_non_nullable
as String?,revokedAt: freezed == revokedAt ? _self.revokedAt : revokedAt // ignore: cast_nullable_to_non_nullable
as DateTime?,title: freezed == title ? _self.title : title // ignore: cast_nullable_to_non_nullable
as String?,description: freezed == description ? _self.description : description // ignore: cast_nullable_to_non_nullable
as String?,slug: freezed == slug ? _self.slug : slug // ignore: cast_nullable_to_non_nullable
as String?,supersededBy: freezed == supersededBy ? _self.supersededBy : supersededBy // ignore: cast_nullable_to_non_nullable
as String?,score: freezed == score ? _self.score : score // ignore: cast_nullable_to_non_nullable
as double?,matchedField: freezed == matchedField ? _self.matchedField : matchedField // ignore: cast_nullable_to_non_nullable
as String?,snippet: freezed == snippet ? _self.snippet : snippet // ignore: cast_nullable_to_non_nullable
as String?,tier: freezed == tier ? _self.tier : tier // ignore: cast_nullable_to_non_nullable
as String?,hint: freezed == hint ? _self.hint : hint // ignore: cast_nullable_to_non_nullable
as String?,
  ));
}

}


/// Adds pattern-matching-related methods to [PackDocument].
extension PackDocumentPatterns on PackDocument {
/// A variant of `map` that fallback to returning `orElse`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _PackDocument value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _PackDocument() when $default != null:
return $default(_that);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// Callbacks receives the raw object, upcasted.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case final Subclass2 value:
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _PackDocument value)  $default,){
final _that = this;
switch (_that) {
case _PackDocument():
return $default(_that);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `map` that fallback to returning `null`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _PackDocument value)?  $default,){
final _that = this;
switch (_that) {
case _PackDocument() when $default != null:
return $default(_that);case _:
  return null;

}
}
/// A variant of `when` that fallback to an `orElse` callback.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function(@JsonKey(name: 'public_id')  String publicId, @JsonKey(name: 'created_at')  DateTime createdAt, @JsonKey(name: 'created_by_kind')  String createdByKind, @JsonKey(name: 'tags')  List<String> tags, @JsonKey(name: 'status')  String status, @JsonKey(name: 'visibility')  String visibility, @JsonKey(name: 'content')  String content, @JsonKey(name: 'format')  String format, @JsonKey(name: 'converter_v')  String converterV, @JsonKey(name: 'version')  int version, @JsonKey(name: 'current_ver')  int? currentVer, @JsonKey(name: 'created_by_id')  String? createdById, @JsonKey(name: 'created_by_name')  String? createdByName, @JsonKey(name: 'current_size')  int? currentSize, @JsonKey(name: 'current_source_sha256')  String? currentSourceSha256, @JsonKey(name: 'revoked_at')  DateTime? revokedAt, @JsonKey(name: 'title')  String? title, @JsonKey(name: 'description')  String? description, @JsonKey(name: 'slug')  String? slug, @JsonKey(name: 'superseded_by')  String? supersededBy, @JsonKey(name: 'score')  double? score, @JsonKey(name: 'matched_field')  String? matchedField, @JsonKey(name: 'snippet')  String? snippet, @JsonKey(name: 'tier')  String? tier, @JsonKey(name: 'hint')  String? hint)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _PackDocument() when $default != null:
return $default(_that.publicId,_that.createdAt,_that.createdByKind,_that.tags,_that.status,_that.visibility,_that.content,_that.format,_that.converterV,_that.version,_that.currentVer,_that.createdById,_that.createdByName,_that.currentSize,_that.currentSourceSha256,_that.revokedAt,_that.title,_that.description,_that.slug,_that.supersededBy,_that.score,_that.matchedField,_that.snippet,_that.tier,_that.hint);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// As opposed to `map`, this offers destructuring.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case Subclass2(:final field2):
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function(@JsonKey(name: 'public_id')  String publicId, @JsonKey(name: 'created_at')  DateTime createdAt, @JsonKey(name: 'created_by_kind')  String createdByKind, @JsonKey(name: 'tags')  List<String> tags, @JsonKey(name: 'status')  String status, @JsonKey(name: 'visibility')  String visibility, @JsonKey(name: 'content')  String content, @JsonKey(name: 'format')  String format, @JsonKey(name: 'converter_v')  String converterV, @JsonKey(name: 'version')  int version, @JsonKey(name: 'current_ver')  int? currentVer, @JsonKey(name: 'created_by_id')  String? createdById, @JsonKey(name: 'created_by_name')  String? createdByName, @JsonKey(name: 'current_size')  int? currentSize, @JsonKey(name: 'current_source_sha256')  String? currentSourceSha256, @JsonKey(name: 'revoked_at')  DateTime? revokedAt, @JsonKey(name: 'title')  String? title, @JsonKey(name: 'description')  String? description, @JsonKey(name: 'slug')  String? slug, @JsonKey(name: 'superseded_by')  String? supersededBy, @JsonKey(name: 'score')  double? score, @JsonKey(name: 'matched_field')  String? matchedField, @JsonKey(name: 'snippet')  String? snippet, @JsonKey(name: 'tier')  String? tier, @JsonKey(name: 'hint')  String? hint)  $default,) {final _that = this;
switch (_that) {
case _PackDocument():
return $default(_that.publicId,_that.createdAt,_that.createdByKind,_that.tags,_that.status,_that.visibility,_that.content,_that.format,_that.converterV,_that.version,_that.currentVer,_that.createdById,_that.createdByName,_that.currentSize,_that.currentSourceSha256,_that.revokedAt,_that.title,_that.description,_that.slug,_that.supersededBy,_that.score,_that.matchedField,_that.snippet,_that.tier,_that.hint);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `when` that fallback to returning `null`
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function(@JsonKey(name: 'public_id')  String publicId, @JsonKey(name: 'created_at')  DateTime createdAt, @JsonKey(name: 'created_by_kind')  String createdByKind, @JsonKey(name: 'tags')  List<String> tags, @JsonKey(name: 'status')  String status, @JsonKey(name: 'visibility')  String visibility, @JsonKey(name: 'content')  String content, @JsonKey(name: 'format')  String format, @JsonKey(name: 'converter_v')  String converterV, @JsonKey(name: 'version')  int version, @JsonKey(name: 'current_ver')  int? currentVer, @JsonKey(name: 'created_by_id')  String? createdById, @JsonKey(name: 'created_by_name')  String? createdByName, @JsonKey(name: 'current_size')  int? currentSize, @JsonKey(name: 'current_source_sha256')  String? currentSourceSha256, @JsonKey(name: 'revoked_at')  DateTime? revokedAt, @JsonKey(name: 'title')  String? title, @JsonKey(name: 'description')  String? description, @JsonKey(name: 'slug')  String? slug, @JsonKey(name: 'superseded_by')  String? supersededBy, @JsonKey(name: 'score')  double? score, @JsonKey(name: 'matched_field')  String? matchedField, @JsonKey(name: 'snippet')  String? snippet, @JsonKey(name: 'tier')  String? tier, @JsonKey(name: 'hint')  String? hint)?  $default,) {final _that = this;
switch (_that) {
case _PackDocument() when $default != null:
return $default(_that.publicId,_that.createdAt,_that.createdByKind,_that.tags,_that.status,_that.visibility,_that.content,_that.format,_that.converterV,_that.version,_that.currentVer,_that.createdById,_that.createdByName,_that.currentSize,_that.currentSourceSha256,_that.revokedAt,_that.title,_that.description,_that.slug,_that.supersededBy,_that.score,_that.matchedField,_that.snippet,_that.tier,_that.hint);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _PackDocument implements PackDocument {
  const _PackDocument({@JsonKey(name: 'public_id') required this.publicId, @JsonKey(name: 'created_at') required this.createdAt, @JsonKey(name: 'created_by_kind') required this.createdByKind, @JsonKey(name: 'tags') required final  List<String> tags, @JsonKey(name: 'status') required this.status, @JsonKey(name: 'visibility') required this.visibility, @JsonKey(name: 'content') required this.content, @JsonKey(name: 'format') required this.format, @JsonKey(name: 'converter_v') required this.converterV, @JsonKey(name: 'version') required this.version, @JsonKey(name: 'current_ver') this.currentVer, @JsonKey(name: 'created_by_id') this.createdById, @JsonKey(name: 'created_by_name') this.createdByName, @JsonKey(name: 'current_size') this.currentSize, @JsonKey(name: 'current_source_sha256') this.currentSourceSha256, @JsonKey(name: 'revoked_at') this.revokedAt, @JsonKey(name: 'title') this.title, @JsonKey(name: 'description') this.description, @JsonKey(name: 'slug') this.slug, @JsonKey(name: 'superseded_by') this.supersededBy, @JsonKey(name: 'score') this.score, @JsonKey(name: 'matched_field') this.matchedField, @JsonKey(name: 'snippet') this.snippet, @JsonKey(name: 'tier') this.tier, @JsonKey(name: 'hint') this.hint}): _tags = tags;
  factory _PackDocument.fromJson(Map<String, dynamic> json) => _$PackDocumentFromJson(json);

@override@JsonKey(name: 'public_id') final  String publicId;
@override@JsonKey(name: 'created_at') final  DateTime createdAt;
@override@JsonKey(name: 'created_by_kind') final  String createdByKind;
 final  List<String> _tags;
@override@JsonKey(name: 'tags') List<String> get tags {
  if (_tags is EqualUnmodifiableListView) return _tags;
  // ignore: implicit_dynamic_type
  return EqualUnmodifiableListView(_tags);
}

@override@JsonKey(name: 'status') final  String status;
@override@JsonKey(name: 'visibility') final  String visibility;
@override@JsonKey(name: 'content') final  String content;
@override@JsonKey(name: 'format') final  String format;
@override@JsonKey(name: 'converter_v') final  String converterV;
@override@JsonKey(name: 'version') final  int version;
@override@JsonKey(name: 'current_ver') final  int? currentVer;
@override@JsonKey(name: 'created_by_id') final  String? createdById;
@override@JsonKey(name: 'created_by_name') final  String? createdByName;
@override@JsonKey(name: 'current_size') final  int? currentSize;
@override@JsonKey(name: 'current_source_sha256') final  String? currentSourceSha256;
@override@JsonKey(name: 'revoked_at') final  DateTime? revokedAt;
@override@JsonKey(name: 'title') final  String? title;
@override@JsonKey(name: 'description') final  String? description;
@override@JsonKey(name: 'slug') final  String? slug;
@override@JsonKey(name: 'superseded_by') final  String? supersededBy;
@override@JsonKey(name: 'score') final  double? score;
@override@JsonKey(name: 'matched_field') final  String? matchedField;
@override@JsonKey(name: 'snippet') final  String? snippet;
@override@JsonKey(name: 'tier') final  String? tier;
@override@JsonKey(name: 'hint') final  String? hint;

/// Create a copy of PackDocument
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$PackDocumentCopyWith<_PackDocument> get copyWith => __$PackDocumentCopyWithImpl<_PackDocument>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$PackDocumentToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _PackDocument&&(identical(other.publicId, publicId) || other.publicId == publicId)&&(identical(other.createdAt, createdAt) || other.createdAt == createdAt)&&(identical(other.createdByKind, createdByKind) || other.createdByKind == createdByKind)&&const DeepCollectionEquality().equals(other._tags, _tags)&&(identical(other.status, status) || other.status == status)&&(identical(other.visibility, visibility) || other.visibility == visibility)&&(identical(other.content, content) || other.content == content)&&(identical(other.format, format) || other.format == format)&&(identical(other.converterV, converterV) || other.converterV == converterV)&&(identical(other.version, version) || other.version == version)&&(identical(other.currentVer, currentVer) || other.currentVer == currentVer)&&(identical(other.createdById, createdById) || other.createdById == createdById)&&(identical(other.createdByName, createdByName) || other.createdByName == createdByName)&&(identical(other.currentSize, currentSize) || other.currentSize == currentSize)&&(identical(other.currentSourceSha256, currentSourceSha256) || other.currentSourceSha256 == currentSourceSha256)&&(identical(other.revokedAt, revokedAt) || other.revokedAt == revokedAt)&&(identical(other.title, title) || other.title == title)&&(identical(other.description, description) || other.description == description)&&(identical(other.slug, slug) || other.slug == slug)&&(identical(other.supersededBy, supersededBy) || other.supersededBy == supersededBy)&&(identical(other.score, score) || other.score == score)&&(identical(other.matchedField, matchedField) || other.matchedField == matchedField)&&(identical(other.snippet, snippet) || other.snippet == snippet)&&(identical(other.tier, tier) || other.tier == tier)&&(identical(other.hint, hint) || other.hint == hint));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hashAll([runtimeType,publicId,createdAt,createdByKind,const DeepCollectionEquality().hash(_tags),status,visibility,content,format,converterV,version,currentVer,createdById,createdByName,currentSize,currentSourceSha256,revokedAt,title,description,slug,supersededBy,score,matchedField,snippet,tier,hint]);

@override
String toString() {
  return 'PackDocument(publicId: $publicId, createdAt: $createdAt, createdByKind: $createdByKind, tags: $tags, status: $status, visibility: $visibility, content: $content, format: $format, converterV: $converterV, version: $version, currentVer: $currentVer, createdById: $createdById, createdByName: $createdByName, currentSize: $currentSize, currentSourceSha256: $currentSourceSha256, revokedAt: $revokedAt, title: $title, description: $description, slug: $slug, supersededBy: $supersededBy, score: $score, matchedField: $matchedField, snippet: $snippet, tier: $tier, hint: $hint)';
}


}

/// @nodoc
abstract mixin class _$PackDocumentCopyWith<$Res> implements $PackDocumentCopyWith<$Res> {
  factory _$PackDocumentCopyWith(_PackDocument value, $Res Function(_PackDocument) _then) = __$PackDocumentCopyWithImpl;
@override @useResult
$Res call({
@JsonKey(name: 'public_id') String publicId,@JsonKey(name: 'created_at') DateTime createdAt,@JsonKey(name: 'created_by_kind') String createdByKind,@JsonKey(name: 'tags') List<String> tags,@JsonKey(name: 'status') String status,@JsonKey(name: 'visibility') String visibility,@JsonKey(name: 'content') String content,@JsonKey(name: 'format') String format,@JsonKey(name: 'converter_v') String converterV,@JsonKey(name: 'version') int version,@JsonKey(name: 'current_ver') int? currentVer,@JsonKey(name: 'created_by_id') String? createdById,@JsonKey(name: 'created_by_name') String? createdByName,@JsonKey(name: 'current_size') int? currentSize,@JsonKey(name: 'current_source_sha256') String? currentSourceSha256,@JsonKey(name: 'revoked_at') DateTime? revokedAt,@JsonKey(name: 'title') String? title,@JsonKey(name: 'description') String? description,@JsonKey(name: 'slug') String? slug,@JsonKey(name: 'superseded_by') String? supersededBy,@JsonKey(name: 'score') double? score,@JsonKey(name: 'matched_field') String? matchedField,@JsonKey(name: 'snippet') String? snippet,@JsonKey(name: 'tier') String? tier,@JsonKey(name: 'hint') String? hint
});




}
/// @nodoc
class __$PackDocumentCopyWithImpl<$Res>
    implements _$PackDocumentCopyWith<$Res> {
  __$PackDocumentCopyWithImpl(this._self, this._then);

  final _PackDocument _self;
  final $Res Function(_PackDocument) _then;

/// Create a copy of PackDocument
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? publicId = null,Object? createdAt = null,Object? createdByKind = null,Object? tags = null,Object? status = null,Object? visibility = null,Object? content = null,Object? format = null,Object? converterV = null,Object? version = null,Object? currentVer = freezed,Object? createdById = freezed,Object? createdByName = freezed,Object? currentSize = freezed,Object? currentSourceSha256 = freezed,Object? revokedAt = freezed,Object? title = freezed,Object? description = freezed,Object? slug = freezed,Object? supersededBy = freezed,Object? score = freezed,Object? matchedField = freezed,Object? snippet = freezed,Object? tier = freezed,Object? hint = freezed,}) {
  return _then(_PackDocument(
publicId: null == publicId ? _self.publicId : publicId // ignore: cast_nullable_to_non_nullable
as String,createdAt: null == createdAt ? _self.createdAt : createdAt // ignore: cast_nullable_to_non_nullable
as DateTime,createdByKind: null == createdByKind ? _self.createdByKind : createdByKind // ignore: cast_nullable_to_non_nullable
as String,tags: null == tags ? _self._tags : tags // ignore: cast_nullable_to_non_nullable
as List<String>,status: null == status ? _self.status : status // ignore: cast_nullable_to_non_nullable
as String,visibility: null == visibility ? _self.visibility : visibility // ignore: cast_nullable_to_non_nullable
as String,content: null == content ? _self.content : content // ignore: cast_nullable_to_non_nullable
as String,format: null == format ? _self.format : format // ignore: cast_nullable_to_non_nullable
as String,converterV: null == converterV ? _self.converterV : converterV // ignore: cast_nullable_to_non_nullable
as String,version: null == version ? _self.version : version // ignore: cast_nullable_to_non_nullable
as int,currentVer: freezed == currentVer ? _self.currentVer : currentVer // ignore: cast_nullable_to_non_nullable
as int?,createdById: freezed == createdById ? _self.createdById : createdById // ignore: cast_nullable_to_non_nullable
as String?,createdByName: freezed == createdByName ? _self.createdByName : createdByName // ignore: cast_nullable_to_non_nullable
as String?,currentSize: freezed == currentSize ? _self.currentSize : currentSize // ignore: cast_nullable_to_non_nullable
as int?,currentSourceSha256: freezed == currentSourceSha256 ? _self.currentSourceSha256 : currentSourceSha256 // ignore: cast_nullable_to_non_nullable
as String?,revokedAt: freezed == revokedAt ? _self.revokedAt : revokedAt // ignore: cast_nullable_to_non_nullable
as DateTime?,title: freezed == title ? _self.title : title // ignore: cast_nullable_to_non_nullable
as String?,description: freezed == description ? _self.description : description // ignore: cast_nullable_to_non_nullable
as String?,slug: freezed == slug ? _self.slug : slug // ignore: cast_nullable_to_non_nullable
as String?,supersededBy: freezed == supersededBy ? _self.supersededBy : supersededBy // ignore: cast_nullable_to_non_nullable
as String?,score: freezed == score ? _self.score : score // ignore: cast_nullable_to_non_nullable
as double?,matchedField: freezed == matchedField ? _self.matchedField : matchedField // ignore: cast_nullable_to_non_nullable
as String?,snippet: freezed == snippet ? _self.snippet : snippet // ignore: cast_nullable_to_non_nullable
as String?,tier: freezed == tier ? _self.tier : tier // ignore: cast_nullable_to_non_nullable
as String?,hint: freezed == hint ? _self.hint : hint // ignore: cast_nullable_to_non_nullable
as String?,
  ));
}


}


/// @nodoc
mixin _$PackInfo {

@JsonKey(name: 'source') String get source;@JsonKey(name: 'budget_bytes') int get budgetBytes;@JsonKey(name: 'max_documents') int get maxDocuments;@JsonKey(name: 'used_bytes') int get usedBytes;@JsonKey(name: 'query') String? get query;@JsonKey(name: 'root') PackRoot? get root;
/// Create a copy of PackInfo
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$PackInfoCopyWith<PackInfo> get copyWith => _$PackInfoCopyWithImpl<PackInfo>(this as PackInfo, _$identity);

  /// Serializes this PackInfo to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is PackInfo&&(identical(other.source, source) || other.source == source)&&(identical(other.budgetBytes, budgetBytes) || other.budgetBytes == budgetBytes)&&(identical(other.maxDocuments, maxDocuments) || other.maxDocuments == maxDocuments)&&(identical(other.usedBytes, usedBytes) || other.usedBytes == usedBytes)&&(identical(other.query, query) || other.query == query)&&(identical(other.root, root) || other.root == root));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,source,budgetBytes,maxDocuments,usedBytes,query,root);

@override
String toString() {
  return 'PackInfo(source: $source, budgetBytes: $budgetBytes, maxDocuments: $maxDocuments, usedBytes: $usedBytes, query: $query, root: $root)';
}


}

/// @nodoc
abstract mixin class $PackInfoCopyWith<$Res>  {
  factory $PackInfoCopyWith(PackInfo value, $Res Function(PackInfo) _then) = _$PackInfoCopyWithImpl;
@useResult
$Res call({
@JsonKey(name: 'source') String source,@JsonKey(name: 'budget_bytes') int budgetBytes,@JsonKey(name: 'max_documents') int maxDocuments,@JsonKey(name: 'used_bytes') int usedBytes,@JsonKey(name: 'query') String? query,@JsonKey(name: 'root') PackRoot? root
});


$PackRootCopyWith<$Res>? get root;

}
/// @nodoc
class _$PackInfoCopyWithImpl<$Res>
    implements $PackInfoCopyWith<$Res> {
  _$PackInfoCopyWithImpl(this._self, this._then);

  final PackInfo _self;
  final $Res Function(PackInfo) _then;

/// Create a copy of PackInfo
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? source = null,Object? budgetBytes = null,Object? maxDocuments = null,Object? usedBytes = null,Object? query = freezed,Object? root = freezed,}) {
  return _then(_self.copyWith(
source: null == source ? _self.source : source // ignore: cast_nullable_to_non_nullable
as String,budgetBytes: null == budgetBytes ? _self.budgetBytes : budgetBytes // ignore: cast_nullable_to_non_nullable
as int,maxDocuments: null == maxDocuments ? _self.maxDocuments : maxDocuments // ignore: cast_nullable_to_non_nullable
as int,usedBytes: null == usedBytes ? _self.usedBytes : usedBytes // ignore: cast_nullable_to_non_nullable
as int,query: freezed == query ? _self.query : query // ignore: cast_nullable_to_non_nullable
as String?,root: freezed == root ? _self.root : root // ignore: cast_nullable_to_non_nullable
as PackRoot?,
  ));
}
/// Create a copy of PackInfo
/// with the given fields replaced by the non-null parameter values.
@override
@pragma('vm:prefer-inline')
$PackRootCopyWith<$Res>? get root {
    if (_self.root == null) {
    return null;
  }

  return $PackRootCopyWith<$Res>(_self.root!, (value) {
    return _then(_self.copyWith(root: value));
  });
}
}


/// Adds pattern-matching-related methods to [PackInfo].
extension PackInfoPatterns on PackInfo {
/// A variant of `map` that fallback to returning `orElse`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _PackInfo value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _PackInfo() when $default != null:
return $default(_that);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// Callbacks receives the raw object, upcasted.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case final Subclass2 value:
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _PackInfo value)  $default,){
final _that = this;
switch (_that) {
case _PackInfo():
return $default(_that);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `map` that fallback to returning `null`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _PackInfo value)?  $default,){
final _that = this;
switch (_that) {
case _PackInfo() when $default != null:
return $default(_that);case _:
  return null;

}
}
/// A variant of `when` that fallback to an `orElse` callback.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function(@JsonKey(name: 'source')  String source, @JsonKey(name: 'budget_bytes')  int budgetBytes, @JsonKey(name: 'max_documents')  int maxDocuments, @JsonKey(name: 'used_bytes')  int usedBytes, @JsonKey(name: 'query')  String? query, @JsonKey(name: 'root')  PackRoot? root)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _PackInfo() when $default != null:
return $default(_that.source,_that.budgetBytes,_that.maxDocuments,_that.usedBytes,_that.query,_that.root);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// As opposed to `map`, this offers destructuring.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case Subclass2(:final field2):
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function(@JsonKey(name: 'source')  String source, @JsonKey(name: 'budget_bytes')  int budgetBytes, @JsonKey(name: 'max_documents')  int maxDocuments, @JsonKey(name: 'used_bytes')  int usedBytes, @JsonKey(name: 'query')  String? query, @JsonKey(name: 'root')  PackRoot? root)  $default,) {final _that = this;
switch (_that) {
case _PackInfo():
return $default(_that.source,_that.budgetBytes,_that.maxDocuments,_that.usedBytes,_that.query,_that.root);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `when` that fallback to returning `null`
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function(@JsonKey(name: 'source')  String source, @JsonKey(name: 'budget_bytes')  int budgetBytes, @JsonKey(name: 'max_documents')  int maxDocuments, @JsonKey(name: 'used_bytes')  int usedBytes, @JsonKey(name: 'query')  String? query, @JsonKey(name: 'root')  PackRoot? root)?  $default,) {final _that = this;
switch (_that) {
case _PackInfo() when $default != null:
return $default(_that.source,_that.budgetBytes,_that.maxDocuments,_that.usedBytes,_that.query,_that.root);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _PackInfo implements PackInfo {
  const _PackInfo({@JsonKey(name: 'source') required this.source, @JsonKey(name: 'budget_bytes') required this.budgetBytes, @JsonKey(name: 'max_documents') required this.maxDocuments, @JsonKey(name: 'used_bytes') required this.usedBytes, @JsonKey(name: 'query') this.query, @JsonKey(name: 'root') this.root});
  factory _PackInfo.fromJson(Map<String, dynamic> json) => _$PackInfoFromJson(json);

@override@JsonKey(name: 'source') final  String source;
@override@JsonKey(name: 'budget_bytes') final  int budgetBytes;
@override@JsonKey(name: 'max_documents') final  int maxDocuments;
@override@JsonKey(name: 'used_bytes') final  int usedBytes;
@override@JsonKey(name: 'query') final  String? query;
@override@JsonKey(name: 'root') final  PackRoot? root;

/// Create a copy of PackInfo
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$PackInfoCopyWith<_PackInfo> get copyWith => __$PackInfoCopyWithImpl<_PackInfo>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$PackInfoToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _PackInfo&&(identical(other.source, source) || other.source == source)&&(identical(other.budgetBytes, budgetBytes) || other.budgetBytes == budgetBytes)&&(identical(other.maxDocuments, maxDocuments) || other.maxDocuments == maxDocuments)&&(identical(other.usedBytes, usedBytes) || other.usedBytes == usedBytes)&&(identical(other.query, query) || other.query == query)&&(identical(other.root, root) || other.root == root));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,source,budgetBytes,maxDocuments,usedBytes,query,root);

@override
String toString() {
  return 'PackInfo(source: $source, budgetBytes: $budgetBytes, maxDocuments: $maxDocuments, usedBytes: $usedBytes, query: $query, root: $root)';
}


}

/// @nodoc
abstract mixin class _$PackInfoCopyWith<$Res> implements $PackInfoCopyWith<$Res> {
  factory _$PackInfoCopyWith(_PackInfo value, $Res Function(_PackInfo) _then) = __$PackInfoCopyWithImpl;
@override @useResult
$Res call({
@JsonKey(name: 'source') String source,@JsonKey(name: 'budget_bytes') int budgetBytes,@JsonKey(name: 'max_documents') int maxDocuments,@JsonKey(name: 'used_bytes') int usedBytes,@JsonKey(name: 'query') String? query,@JsonKey(name: 'root') PackRoot? root
});


@override $PackRootCopyWith<$Res>? get root;

}
/// @nodoc
class __$PackInfoCopyWithImpl<$Res>
    implements _$PackInfoCopyWith<$Res> {
  __$PackInfoCopyWithImpl(this._self, this._then);

  final _PackInfo _self;
  final $Res Function(_PackInfo) _then;

/// Create a copy of PackInfo
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? source = null,Object? budgetBytes = null,Object? maxDocuments = null,Object? usedBytes = null,Object? query = freezed,Object? root = freezed,}) {
  return _then(_PackInfo(
source: null == source ? _self.source : source // ignore: cast_nullable_to_non_nullable
as String,budgetBytes: null == budgetBytes ? _self.budgetBytes : budgetBytes // ignore: cast_nullable_to_non_nullable
as int,maxDocuments: null == maxDocuments ? _self.maxDocuments : maxDocuments // ignore: cast_nullable_to_non_nullable
as int,usedBytes: null == usedBytes ? _self.usedBytes : usedBytes // ignore: cast_nullable_to_non_nullable
as int,query: freezed == query ? _self.query : query // ignore: cast_nullable_to_non_nullable
as String?,root: freezed == root ? _self.root : root // ignore: cast_nullable_to_non_nullable
as PackRoot?,
  ));
}

/// Create a copy of PackInfo
/// with the given fields replaced by the non-null parameter values.
@override
@pragma('vm:prefer-inline')
$PackRootCopyWith<$Res>? get root {
    if (_self.root == null) {
    return null;
  }

  return $PackRootCopyWith<$Res>(_self.root!, (value) {
    return _then(_self.copyWith(root: value));
  });
}
}


/// @nodoc
mixin _$PackRoot {

@JsonKey(name: 'public_id') String get publicId;@JsonKey(name: 'content') String get content;@JsonKey(name: 'format') String get format;@JsonKey(name: 'slug') String? get slug;@JsonKey(name: 'title') String? get title;
/// Create a copy of PackRoot
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$PackRootCopyWith<PackRoot> get copyWith => _$PackRootCopyWithImpl<PackRoot>(this as PackRoot, _$identity);

  /// Serializes this PackRoot to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is PackRoot&&(identical(other.publicId, publicId) || other.publicId == publicId)&&(identical(other.content, content) || other.content == content)&&(identical(other.format, format) || other.format == format)&&(identical(other.slug, slug) || other.slug == slug)&&(identical(other.title, title) || other.title == title));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,publicId,content,format,slug,title);

@override
String toString() {
  return 'PackRoot(publicId: $publicId, content: $content, format: $format, slug: $slug, title: $title)';
}


}

/// @nodoc
abstract mixin class $PackRootCopyWith<$Res>  {
  factory $PackRootCopyWith(PackRoot value, $Res Function(PackRoot) _then) = _$PackRootCopyWithImpl;
@useResult
$Res call({
@JsonKey(name: 'public_id') String publicId,@JsonKey(name: 'content') String content,@JsonKey(name: 'format') String format,@JsonKey(name: 'slug') String? slug,@JsonKey(name: 'title') String? title
});




}
/// @nodoc
class _$PackRootCopyWithImpl<$Res>
    implements $PackRootCopyWith<$Res> {
  _$PackRootCopyWithImpl(this._self, this._then);

  final PackRoot _self;
  final $Res Function(PackRoot) _then;

/// Create a copy of PackRoot
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? publicId = null,Object? content = null,Object? format = null,Object? slug = freezed,Object? title = freezed,}) {
  return _then(_self.copyWith(
publicId: null == publicId ? _self.publicId : publicId // ignore: cast_nullable_to_non_nullable
as String,content: null == content ? _self.content : content // ignore: cast_nullable_to_non_nullable
as String,format: null == format ? _self.format : format // ignore: cast_nullable_to_non_nullable
as String,slug: freezed == slug ? _self.slug : slug // ignore: cast_nullable_to_non_nullable
as String?,title: freezed == title ? _self.title : title // ignore: cast_nullable_to_non_nullable
as String?,
  ));
}

}


/// Adds pattern-matching-related methods to [PackRoot].
extension PackRootPatterns on PackRoot {
/// A variant of `map` that fallback to returning `orElse`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _PackRoot value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _PackRoot() when $default != null:
return $default(_that);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// Callbacks receives the raw object, upcasted.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case final Subclass2 value:
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _PackRoot value)  $default,){
final _that = this;
switch (_that) {
case _PackRoot():
return $default(_that);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `map` that fallback to returning `null`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _PackRoot value)?  $default,){
final _that = this;
switch (_that) {
case _PackRoot() when $default != null:
return $default(_that);case _:
  return null;

}
}
/// A variant of `when` that fallback to an `orElse` callback.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function(@JsonKey(name: 'public_id')  String publicId, @JsonKey(name: 'content')  String content, @JsonKey(name: 'format')  String format, @JsonKey(name: 'slug')  String? slug, @JsonKey(name: 'title')  String? title)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _PackRoot() when $default != null:
return $default(_that.publicId,_that.content,_that.format,_that.slug,_that.title);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// As opposed to `map`, this offers destructuring.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case Subclass2(:final field2):
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function(@JsonKey(name: 'public_id')  String publicId, @JsonKey(name: 'content')  String content, @JsonKey(name: 'format')  String format, @JsonKey(name: 'slug')  String? slug, @JsonKey(name: 'title')  String? title)  $default,) {final _that = this;
switch (_that) {
case _PackRoot():
return $default(_that.publicId,_that.content,_that.format,_that.slug,_that.title);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `when` that fallback to returning `null`
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function(@JsonKey(name: 'public_id')  String publicId, @JsonKey(name: 'content')  String content, @JsonKey(name: 'format')  String format, @JsonKey(name: 'slug')  String? slug, @JsonKey(name: 'title')  String? title)?  $default,) {final _that = this;
switch (_that) {
case _PackRoot() when $default != null:
return $default(_that.publicId,_that.content,_that.format,_that.slug,_that.title);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _PackRoot implements PackRoot {
  const _PackRoot({@JsonKey(name: 'public_id') required this.publicId, @JsonKey(name: 'content') required this.content, @JsonKey(name: 'format') required this.format, @JsonKey(name: 'slug') this.slug, @JsonKey(name: 'title') this.title});
  factory _PackRoot.fromJson(Map<String, dynamic> json) => _$PackRootFromJson(json);

@override@JsonKey(name: 'public_id') final  String publicId;
@override@JsonKey(name: 'content') final  String content;
@override@JsonKey(name: 'format') final  String format;
@override@JsonKey(name: 'slug') final  String? slug;
@override@JsonKey(name: 'title') final  String? title;

/// Create a copy of PackRoot
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$PackRootCopyWith<_PackRoot> get copyWith => __$PackRootCopyWithImpl<_PackRoot>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$PackRootToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _PackRoot&&(identical(other.publicId, publicId) || other.publicId == publicId)&&(identical(other.content, content) || other.content == content)&&(identical(other.format, format) || other.format == format)&&(identical(other.slug, slug) || other.slug == slug)&&(identical(other.title, title) || other.title == title));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,publicId,content,format,slug,title);

@override
String toString() {
  return 'PackRoot(publicId: $publicId, content: $content, format: $format, slug: $slug, title: $title)';
}


}

/// @nodoc
abstract mixin class _$PackRootCopyWith<$Res> implements $PackRootCopyWith<$Res> {
  factory _$PackRootCopyWith(_PackRoot value, $Res Function(_PackRoot) _then) = __$PackRootCopyWithImpl;
@override @useResult
$Res call({
@JsonKey(name: 'public_id') String publicId,@JsonKey(name: 'content') String content,@JsonKey(name: 'format') String format,@JsonKey(name: 'slug') String? slug,@JsonKey(name: 'title') String? title
});




}
/// @nodoc
class __$PackRootCopyWithImpl<$Res>
    implements _$PackRootCopyWith<$Res> {
  __$PackRootCopyWithImpl(this._self, this._then);

  final _PackRoot _self;
  final $Res Function(_PackRoot) _then;

/// Create a copy of PackRoot
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? publicId = null,Object? content = null,Object? format = null,Object? slug = freezed,Object? title = freezed,}) {
  return _then(_PackRoot(
publicId: null == publicId ? _self.publicId : publicId // ignore: cast_nullable_to_non_nullable
as String,content: null == content ? _self.content : content // ignore: cast_nullable_to_non_nullable
as String,format: null == format ? _self.format : format // ignore: cast_nullable_to_non_nullable
as String,slug: freezed == slug ? _self.slug : slug // ignore: cast_nullable_to_non_nullable
as String?,title: freezed == title ? _self.title : title // ignore: cast_nullable_to_non_nullable
as String?,
  ));
}


}


/// @nodoc
mixin _$PackOmitted {

@JsonKey(name: 'ref') String get ref;@JsonKey(name: 'reason') String get reason;@JsonKey(name: 'public_id') String? get publicId;@JsonKey(name: 'title') String? get title;@JsonKey(name: 'size_bytes') int? get sizeBytes;@JsonKey(name: 'superseded_by') String? get supersededBy;@JsonKey(name: 'hint') String? get hint;
/// Create a copy of PackOmitted
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$PackOmittedCopyWith<PackOmitted> get copyWith => _$PackOmittedCopyWithImpl<PackOmitted>(this as PackOmitted, _$identity);

  /// Serializes this PackOmitted to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is PackOmitted&&(identical(other.ref, ref) || other.ref == ref)&&(identical(other.reason, reason) || other.reason == reason)&&(identical(other.publicId, publicId) || other.publicId == publicId)&&(identical(other.title, title) || other.title == title)&&(identical(other.sizeBytes, sizeBytes) || other.sizeBytes == sizeBytes)&&(identical(other.supersededBy, supersededBy) || other.supersededBy == supersededBy)&&(identical(other.hint, hint) || other.hint == hint));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,ref,reason,publicId,title,sizeBytes,supersededBy,hint);

@override
String toString() {
  return 'PackOmitted(ref: $ref, reason: $reason, publicId: $publicId, title: $title, sizeBytes: $sizeBytes, supersededBy: $supersededBy, hint: $hint)';
}


}

/// @nodoc
abstract mixin class $PackOmittedCopyWith<$Res>  {
  factory $PackOmittedCopyWith(PackOmitted value, $Res Function(PackOmitted) _then) = _$PackOmittedCopyWithImpl;
@useResult
$Res call({
@JsonKey(name: 'ref') String ref,@JsonKey(name: 'reason') String reason,@JsonKey(name: 'public_id') String? publicId,@JsonKey(name: 'title') String? title,@JsonKey(name: 'size_bytes') int? sizeBytes,@JsonKey(name: 'superseded_by') String? supersededBy,@JsonKey(name: 'hint') String? hint
});




}
/// @nodoc
class _$PackOmittedCopyWithImpl<$Res>
    implements $PackOmittedCopyWith<$Res> {
  _$PackOmittedCopyWithImpl(this._self, this._then);

  final PackOmitted _self;
  final $Res Function(PackOmitted) _then;

/// Create a copy of PackOmitted
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? ref = null,Object? reason = null,Object? publicId = freezed,Object? title = freezed,Object? sizeBytes = freezed,Object? supersededBy = freezed,Object? hint = freezed,}) {
  return _then(_self.copyWith(
ref: null == ref ? _self.ref : ref // ignore: cast_nullable_to_non_nullable
as String,reason: null == reason ? _self.reason : reason // ignore: cast_nullable_to_non_nullable
as String,publicId: freezed == publicId ? _self.publicId : publicId // ignore: cast_nullable_to_non_nullable
as String?,title: freezed == title ? _self.title : title // ignore: cast_nullable_to_non_nullable
as String?,sizeBytes: freezed == sizeBytes ? _self.sizeBytes : sizeBytes // ignore: cast_nullable_to_non_nullable
as int?,supersededBy: freezed == supersededBy ? _self.supersededBy : supersededBy // ignore: cast_nullable_to_non_nullable
as String?,hint: freezed == hint ? _self.hint : hint // ignore: cast_nullable_to_non_nullable
as String?,
  ));
}

}


/// Adds pattern-matching-related methods to [PackOmitted].
extension PackOmittedPatterns on PackOmitted {
/// A variant of `map` that fallback to returning `orElse`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _PackOmitted value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _PackOmitted() when $default != null:
return $default(_that);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// Callbacks receives the raw object, upcasted.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case final Subclass2 value:
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _PackOmitted value)  $default,){
final _that = this;
switch (_that) {
case _PackOmitted():
return $default(_that);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `map` that fallback to returning `null`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _PackOmitted value)?  $default,){
final _that = this;
switch (_that) {
case _PackOmitted() when $default != null:
return $default(_that);case _:
  return null;

}
}
/// A variant of `when` that fallback to an `orElse` callback.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function(@JsonKey(name: 'ref')  String ref, @JsonKey(name: 'reason')  String reason, @JsonKey(name: 'public_id')  String? publicId, @JsonKey(name: 'title')  String? title, @JsonKey(name: 'size_bytes')  int? sizeBytes, @JsonKey(name: 'superseded_by')  String? supersededBy, @JsonKey(name: 'hint')  String? hint)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _PackOmitted() when $default != null:
return $default(_that.ref,_that.reason,_that.publicId,_that.title,_that.sizeBytes,_that.supersededBy,_that.hint);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// As opposed to `map`, this offers destructuring.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case Subclass2(:final field2):
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function(@JsonKey(name: 'ref')  String ref, @JsonKey(name: 'reason')  String reason, @JsonKey(name: 'public_id')  String? publicId, @JsonKey(name: 'title')  String? title, @JsonKey(name: 'size_bytes')  int? sizeBytes, @JsonKey(name: 'superseded_by')  String? supersededBy, @JsonKey(name: 'hint')  String? hint)  $default,) {final _that = this;
switch (_that) {
case _PackOmitted():
return $default(_that.ref,_that.reason,_that.publicId,_that.title,_that.sizeBytes,_that.supersededBy,_that.hint);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `when` that fallback to returning `null`
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function(@JsonKey(name: 'ref')  String ref, @JsonKey(name: 'reason')  String reason, @JsonKey(name: 'public_id')  String? publicId, @JsonKey(name: 'title')  String? title, @JsonKey(name: 'size_bytes')  int? sizeBytes, @JsonKey(name: 'superseded_by')  String? supersededBy, @JsonKey(name: 'hint')  String? hint)?  $default,) {final _that = this;
switch (_that) {
case _PackOmitted() when $default != null:
return $default(_that.ref,_that.reason,_that.publicId,_that.title,_that.sizeBytes,_that.supersededBy,_that.hint);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _PackOmitted implements PackOmitted {
  const _PackOmitted({@JsonKey(name: 'ref') required this.ref, @JsonKey(name: 'reason') required this.reason, @JsonKey(name: 'public_id') this.publicId, @JsonKey(name: 'title') this.title, @JsonKey(name: 'size_bytes') this.sizeBytes, @JsonKey(name: 'superseded_by') this.supersededBy, @JsonKey(name: 'hint') this.hint});
  factory _PackOmitted.fromJson(Map<String, dynamic> json) => _$PackOmittedFromJson(json);

@override@JsonKey(name: 'ref') final  String ref;
@override@JsonKey(name: 'reason') final  String reason;
@override@JsonKey(name: 'public_id') final  String? publicId;
@override@JsonKey(name: 'title') final  String? title;
@override@JsonKey(name: 'size_bytes') final  int? sizeBytes;
@override@JsonKey(name: 'superseded_by') final  String? supersededBy;
@override@JsonKey(name: 'hint') final  String? hint;

/// Create a copy of PackOmitted
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$PackOmittedCopyWith<_PackOmitted> get copyWith => __$PackOmittedCopyWithImpl<_PackOmitted>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$PackOmittedToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _PackOmitted&&(identical(other.ref, ref) || other.ref == ref)&&(identical(other.reason, reason) || other.reason == reason)&&(identical(other.publicId, publicId) || other.publicId == publicId)&&(identical(other.title, title) || other.title == title)&&(identical(other.sizeBytes, sizeBytes) || other.sizeBytes == sizeBytes)&&(identical(other.supersededBy, supersededBy) || other.supersededBy == supersededBy)&&(identical(other.hint, hint) || other.hint == hint));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,ref,reason,publicId,title,sizeBytes,supersededBy,hint);

@override
String toString() {
  return 'PackOmitted(ref: $ref, reason: $reason, publicId: $publicId, title: $title, sizeBytes: $sizeBytes, supersededBy: $supersededBy, hint: $hint)';
}


}

/// @nodoc
abstract mixin class _$PackOmittedCopyWith<$Res> implements $PackOmittedCopyWith<$Res> {
  factory _$PackOmittedCopyWith(_PackOmitted value, $Res Function(_PackOmitted) _then) = __$PackOmittedCopyWithImpl;
@override @useResult
$Res call({
@JsonKey(name: 'ref') String ref,@JsonKey(name: 'reason') String reason,@JsonKey(name: 'public_id') String? publicId,@JsonKey(name: 'title') String? title,@JsonKey(name: 'size_bytes') int? sizeBytes,@JsonKey(name: 'superseded_by') String? supersededBy,@JsonKey(name: 'hint') String? hint
});




}
/// @nodoc
class __$PackOmittedCopyWithImpl<$Res>
    implements _$PackOmittedCopyWith<$Res> {
  __$PackOmittedCopyWithImpl(this._self, this._then);

  final _PackOmitted _self;
  final $Res Function(_PackOmitted) _then;

/// Create a copy of PackOmitted
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? ref = null,Object? reason = null,Object? publicId = freezed,Object? title = freezed,Object? sizeBytes = freezed,Object? supersededBy = freezed,Object? hint = freezed,}) {
  return _then(_PackOmitted(
ref: null == ref ? _self.ref : ref // ignore: cast_nullable_to_non_nullable
as String,reason: null == reason ? _self.reason : reason // ignore: cast_nullable_to_non_nullable
as String,publicId: freezed == publicId ? _self.publicId : publicId // ignore: cast_nullable_to_non_nullable
as String?,title: freezed == title ? _self.title : title // ignore: cast_nullable_to_non_nullable
as String?,sizeBytes: freezed == sizeBytes ? _self.sizeBytes : sizeBytes // ignore: cast_nullable_to_non_nullable
as int?,supersededBy: freezed == supersededBy ? _self.supersededBy : supersededBy // ignore: cast_nullable_to_non_nullable
as String?,hint: freezed == hint ? _self.hint : hint // ignore: cast_nullable_to_non_nullable
as String?,
  ));
}


}


/// @nodoc
mixin _$PackResponse {

@JsonKey(name: 'pack') PackInfo get pack;@JsonKey(name: 'documents') List<PackDocument> get documents;@JsonKey(name: 'omitted') List<PackOmitted> get omitted;
/// Create a copy of PackResponse
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$PackResponseCopyWith<PackResponse> get copyWith => _$PackResponseCopyWithImpl<PackResponse>(this as PackResponse, _$identity);

  /// Serializes this PackResponse to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is PackResponse&&(identical(other.pack, pack) || other.pack == pack)&&const DeepCollectionEquality().equals(other.documents, documents)&&const DeepCollectionEquality().equals(other.omitted, omitted));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,pack,const DeepCollectionEquality().hash(documents),const DeepCollectionEquality().hash(omitted));

@override
String toString() {
  return 'PackResponse(pack: $pack, documents: $documents, omitted: $omitted)';
}


}

/// @nodoc
abstract mixin class $PackResponseCopyWith<$Res>  {
  factory $PackResponseCopyWith(PackResponse value, $Res Function(PackResponse) _then) = _$PackResponseCopyWithImpl;
@useResult
$Res call({
@JsonKey(name: 'pack') PackInfo pack,@JsonKey(name: 'documents') List<PackDocument> documents,@JsonKey(name: 'omitted') List<PackOmitted> omitted
});


$PackInfoCopyWith<$Res> get pack;

}
/// @nodoc
class _$PackResponseCopyWithImpl<$Res>
    implements $PackResponseCopyWith<$Res> {
  _$PackResponseCopyWithImpl(this._self, this._then);

  final PackResponse _self;
  final $Res Function(PackResponse) _then;

/// Create a copy of PackResponse
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? pack = null,Object? documents = null,Object? omitted = null,}) {
  return _then(_self.copyWith(
pack: null == pack ? _self.pack : pack // ignore: cast_nullable_to_non_nullable
as PackInfo,documents: null == documents ? _self.documents : documents // ignore: cast_nullable_to_non_nullable
as List<PackDocument>,omitted: null == omitted ? _self.omitted : omitted // ignore: cast_nullable_to_non_nullable
as List<PackOmitted>,
  ));
}
/// Create a copy of PackResponse
/// with the given fields replaced by the non-null parameter values.
@override
@pragma('vm:prefer-inline')
$PackInfoCopyWith<$Res> get pack {
  
  return $PackInfoCopyWith<$Res>(_self.pack, (value) {
    return _then(_self.copyWith(pack: value));
  });
}
}


/// Adds pattern-matching-related methods to [PackResponse].
extension PackResponsePatterns on PackResponse {
/// A variant of `map` that fallback to returning `orElse`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _PackResponse value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _PackResponse() when $default != null:
return $default(_that);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// Callbacks receives the raw object, upcasted.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case final Subclass2 value:
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _PackResponse value)  $default,){
final _that = this;
switch (_that) {
case _PackResponse():
return $default(_that);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `map` that fallback to returning `null`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _PackResponse value)?  $default,){
final _that = this;
switch (_that) {
case _PackResponse() when $default != null:
return $default(_that);case _:
  return null;

}
}
/// A variant of `when` that fallback to an `orElse` callback.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function(@JsonKey(name: 'pack')  PackInfo pack, @JsonKey(name: 'documents')  List<PackDocument> documents, @JsonKey(name: 'omitted')  List<PackOmitted> omitted)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _PackResponse() when $default != null:
return $default(_that.pack,_that.documents,_that.omitted);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// As opposed to `map`, this offers destructuring.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case Subclass2(:final field2):
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function(@JsonKey(name: 'pack')  PackInfo pack, @JsonKey(name: 'documents')  List<PackDocument> documents, @JsonKey(name: 'omitted')  List<PackOmitted> omitted)  $default,) {final _that = this;
switch (_that) {
case _PackResponse():
return $default(_that.pack,_that.documents,_that.omitted);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `when` that fallback to returning `null`
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function(@JsonKey(name: 'pack')  PackInfo pack, @JsonKey(name: 'documents')  List<PackDocument> documents, @JsonKey(name: 'omitted')  List<PackOmitted> omitted)?  $default,) {final _that = this;
switch (_that) {
case _PackResponse() when $default != null:
return $default(_that.pack,_that.documents,_that.omitted);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _PackResponse implements PackResponse {
  const _PackResponse({@JsonKey(name: 'pack') required this.pack, @JsonKey(name: 'documents') required final  List<PackDocument> documents, @JsonKey(name: 'omitted') required final  List<PackOmitted> omitted}): _documents = documents,_omitted = omitted;
  factory _PackResponse.fromJson(Map<String, dynamic> json) => _$PackResponseFromJson(json);

@override@JsonKey(name: 'pack') final  PackInfo pack;
 final  List<PackDocument> _documents;
@override@JsonKey(name: 'documents') List<PackDocument> get documents {
  if (_documents is EqualUnmodifiableListView) return _documents;
  // ignore: implicit_dynamic_type
  return EqualUnmodifiableListView(_documents);
}

 final  List<PackOmitted> _omitted;
@override@JsonKey(name: 'omitted') List<PackOmitted> get omitted {
  if (_omitted is EqualUnmodifiableListView) return _omitted;
  // ignore: implicit_dynamic_type
  return EqualUnmodifiableListView(_omitted);
}


/// Create a copy of PackResponse
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$PackResponseCopyWith<_PackResponse> get copyWith => __$PackResponseCopyWithImpl<_PackResponse>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$PackResponseToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _PackResponse&&(identical(other.pack, pack) || other.pack == pack)&&const DeepCollectionEquality().equals(other._documents, _documents)&&const DeepCollectionEquality().equals(other._omitted, _omitted));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,pack,const DeepCollectionEquality().hash(_documents),const DeepCollectionEquality().hash(_omitted));

@override
String toString() {
  return 'PackResponse(pack: $pack, documents: $documents, omitted: $omitted)';
}


}

/// @nodoc
abstract mixin class _$PackResponseCopyWith<$Res> implements $PackResponseCopyWith<$Res> {
  factory _$PackResponseCopyWith(_PackResponse value, $Res Function(_PackResponse) _then) = __$PackResponseCopyWithImpl;
@override @useResult
$Res call({
@JsonKey(name: 'pack') PackInfo pack,@JsonKey(name: 'documents') List<PackDocument> documents,@JsonKey(name: 'omitted') List<PackOmitted> omitted
});


@override $PackInfoCopyWith<$Res> get pack;

}
/// @nodoc
class __$PackResponseCopyWithImpl<$Res>
    implements _$PackResponseCopyWith<$Res> {
  __$PackResponseCopyWithImpl(this._self, this._then);

  final _PackResponse _self;
  final $Res Function(_PackResponse) _then;

/// Create a copy of PackResponse
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? pack = null,Object? documents = null,Object? omitted = null,}) {
  return _then(_PackResponse(
pack: null == pack ? _self.pack : pack // ignore: cast_nullable_to_non_nullable
as PackInfo,documents: null == documents ? _self._documents : documents // ignore: cast_nullable_to_non_nullable
as List<PackDocument>,omitted: null == omitted ? _self._omitted : omitted // ignore: cast_nullable_to_non_nullable
as List<PackOmitted>,
  ));
}

/// Create a copy of PackResponse
/// with the given fields replaced by the non-null parameter values.
@override
@pragma('vm:prefer-inline')
$PackInfoCopyWith<$Res> get pack {
  
  return $PackInfoCopyWith<$Res>(_self.pack, (value) {
    return _then(_self.copyWith(pack: value));
  });
}
}


/// @nodoc
mixin _$ReadSourceResponse {

@JsonKey(name: 'source') String get source;@JsonKey(name: 'source_format') String get sourceFormat;@JsonKey(name: 'version_no') int get versionNo;@JsonKey(name: 'sanitizer_v') String get sanitizerV;@JsonKey(name: 'stripped') List<String> get stripped;@JsonKey(name: 'will_not_render') List<String> get willNotRender;@JsonKey(name: 'tags') List<String> get tags;@JsonKey(name: 'status') String get status;@JsonKey(name: 'unsanitized') bool get unsanitized;@JsonKey(name: 'source_sha256') String? get sourceSha256;@JsonKey(name: 'title') String? get title;@JsonKey(name: 'description') String? get description;@JsonKey(name: 'slug') String? get slug;@JsonKey(name: 'superseded_by') String? get supersededBy;
/// Create a copy of ReadSourceResponse
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$ReadSourceResponseCopyWith<ReadSourceResponse> get copyWith => _$ReadSourceResponseCopyWithImpl<ReadSourceResponse>(this as ReadSourceResponse, _$identity);

  /// Serializes this ReadSourceResponse to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ReadSourceResponse&&(identical(other.source, source) || other.source == source)&&(identical(other.sourceFormat, sourceFormat) || other.sourceFormat == sourceFormat)&&(identical(other.versionNo, versionNo) || other.versionNo == versionNo)&&(identical(other.sanitizerV, sanitizerV) || other.sanitizerV == sanitizerV)&&const DeepCollectionEquality().equals(other.stripped, stripped)&&const DeepCollectionEquality().equals(other.willNotRender, willNotRender)&&const DeepCollectionEquality().equals(other.tags, tags)&&(identical(other.status, status) || other.status == status)&&(identical(other.unsanitized, unsanitized) || other.unsanitized == unsanitized)&&(identical(other.sourceSha256, sourceSha256) || other.sourceSha256 == sourceSha256)&&(identical(other.title, title) || other.title == title)&&(identical(other.description, description) || other.description == description)&&(identical(other.slug, slug) || other.slug == slug)&&(identical(other.supersededBy, supersededBy) || other.supersededBy == supersededBy));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,source,sourceFormat,versionNo,sanitizerV,const DeepCollectionEquality().hash(stripped),const DeepCollectionEquality().hash(willNotRender),const DeepCollectionEquality().hash(tags),status,unsanitized,sourceSha256,title,description,slug,supersededBy);

@override
String toString() {
  return 'ReadSourceResponse(source: $source, sourceFormat: $sourceFormat, versionNo: $versionNo, sanitizerV: $sanitizerV, stripped: $stripped, willNotRender: $willNotRender, tags: $tags, status: $status, unsanitized: $unsanitized, sourceSha256: $sourceSha256, title: $title, description: $description, slug: $slug, supersededBy: $supersededBy)';
}


}

/// @nodoc
abstract mixin class $ReadSourceResponseCopyWith<$Res>  {
  factory $ReadSourceResponseCopyWith(ReadSourceResponse value, $Res Function(ReadSourceResponse) _then) = _$ReadSourceResponseCopyWithImpl;
@useResult
$Res call({
@JsonKey(name: 'source') String source,@JsonKey(name: 'source_format') String sourceFormat,@JsonKey(name: 'version_no') int versionNo,@JsonKey(name: 'sanitizer_v') String sanitizerV,@JsonKey(name: 'stripped') List<String> stripped,@JsonKey(name: 'will_not_render') List<String> willNotRender,@JsonKey(name: 'tags') List<String> tags,@JsonKey(name: 'status') String status,@JsonKey(name: 'unsanitized') bool unsanitized,@JsonKey(name: 'source_sha256') String? sourceSha256,@JsonKey(name: 'title') String? title,@JsonKey(name: 'description') String? description,@JsonKey(name: 'slug') String? slug,@JsonKey(name: 'superseded_by') String? supersededBy
});




}
/// @nodoc
class _$ReadSourceResponseCopyWithImpl<$Res>
    implements $ReadSourceResponseCopyWith<$Res> {
  _$ReadSourceResponseCopyWithImpl(this._self, this._then);

  final ReadSourceResponse _self;
  final $Res Function(ReadSourceResponse) _then;

/// Create a copy of ReadSourceResponse
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? source = null,Object? sourceFormat = null,Object? versionNo = null,Object? sanitizerV = null,Object? stripped = null,Object? willNotRender = null,Object? tags = null,Object? status = null,Object? unsanitized = null,Object? sourceSha256 = freezed,Object? title = freezed,Object? description = freezed,Object? slug = freezed,Object? supersededBy = freezed,}) {
  return _then(_self.copyWith(
source: null == source ? _self.source : source // ignore: cast_nullable_to_non_nullable
as String,sourceFormat: null == sourceFormat ? _self.sourceFormat : sourceFormat // ignore: cast_nullable_to_non_nullable
as String,versionNo: null == versionNo ? _self.versionNo : versionNo // ignore: cast_nullable_to_non_nullable
as int,sanitizerV: null == sanitizerV ? _self.sanitizerV : sanitizerV // ignore: cast_nullable_to_non_nullable
as String,stripped: null == stripped ? _self.stripped : stripped // ignore: cast_nullable_to_non_nullable
as List<String>,willNotRender: null == willNotRender ? _self.willNotRender : willNotRender // ignore: cast_nullable_to_non_nullable
as List<String>,tags: null == tags ? _self.tags : tags // ignore: cast_nullable_to_non_nullable
as List<String>,status: null == status ? _self.status : status // ignore: cast_nullable_to_non_nullable
as String,unsanitized: null == unsanitized ? _self.unsanitized : unsanitized // ignore: cast_nullable_to_non_nullable
as bool,sourceSha256: freezed == sourceSha256 ? _self.sourceSha256 : sourceSha256 // ignore: cast_nullable_to_non_nullable
as String?,title: freezed == title ? _self.title : title // ignore: cast_nullable_to_non_nullable
as String?,description: freezed == description ? _self.description : description // ignore: cast_nullable_to_non_nullable
as String?,slug: freezed == slug ? _self.slug : slug // ignore: cast_nullable_to_non_nullable
as String?,supersededBy: freezed == supersededBy ? _self.supersededBy : supersededBy // ignore: cast_nullable_to_non_nullable
as String?,
  ));
}

}


/// Adds pattern-matching-related methods to [ReadSourceResponse].
extension ReadSourceResponsePatterns on ReadSourceResponse {
/// A variant of `map` that fallback to returning `orElse`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _ReadSourceResponse value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _ReadSourceResponse() when $default != null:
return $default(_that);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// Callbacks receives the raw object, upcasted.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case final Subclass2 value:
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _ReadSourceResponse value)  $default,){
final _that = this;
switch (_that) {
case _ReadSourceResponse():
return $default(_that);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `map` that fallback to returning `null`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _ReadSourceResponse value)?  $default,){
final _that = this;
switch (_that) {
case _ReadSourceResponse() when $default != null:
return $default(_that);case _:
  return null;

}
}
/// A variant of `when` that fallback to an `orElse` callback.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function(@JsonKey(name: 'source')  String source, @JsonKey(name: 'source_format')  String sourceFormat, @JsonKey(name: 'version_no')  int versionNo, @JsonKey(name: 'sanitizer_v')  String sanitizerV, @JsonKey(name: 'stripped')  List<String> stripped, @JsonKey(name: 'will_not_render')  List<String> willNotRender, @JsonKey(name: 'tags')  List<String> tags, @JsonKey(name: 'status')  String status, @JsonKey(name: 'unsanitized')  bool unsanitized, @JsonKey(name: 'source_sha256')  String? sourceSha256, @JsonKey(name: 'title')  String? title, @JsonKey(name: 'description')  String? description, @JsonKey(name: 'slug')  String? slug, @JsonKey(name: 'superseded_by')  String? supersededBy)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _ReadSourceResponse() when $default != null:
return $default(_that.source,_that.sourceFormat,_that.versionNo,_that.sanitizerV,_that.stripped,_that.willNotRender,_that.tags,_that.status,_that.unsanitized,_that.sourceSha256,_that.title,_that.description,_that.slug,_that.supersededBy);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// As opposed to `map`, this offers destructuring.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case Subclass2(:final field2):
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function(@JsonKey(name: 'source')  String source, @JsonKey(name: 'source_format')  String sourceFormat, @JsonKey(name: 'version_no')  int versionNo, @JsonKey(name: 'sanitizer_v')  String sanitizerV, @JsonKey(name: 'stripped')  List<String> stripped, @JsonKey(name: 'will_not_render')  List<String> willNotRender, @JsonKey(name: 'tags')  List<String> tags, @JsonKey(name: 'status')  String status, @JsonKey(name: 'unsanitized')  bool unsanitized, @JsonKey(name: 'source_sha256')  String? sourceSha256, @JsonKey(name: 'title')  String? title, @JsonKey(name: 'description')  String? description, @JsonKey(name: 'slug')  String? slug, @JsonKey(name: 'superseded_by')  String? supersededBy)  $default,) {final _that = this;
switch (_that) {
case _ReadSourceResponse():
return $default(_that.source,_that.sourceFormat,_that.versionNo,_that.sanitizerV,_that.stripped,_that.willNotRender,_that.tags,_that.status,_that.unsanitized,_that.sourceSha256,_that.title,_that.description,_that.slug,_that.supersededBy);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `when` that fallback to returning `null`
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function(@JsonKey(name: 'source')  String source, @JsonKey(name: 'source_format')  String sourceFormat, @JsonKey(name: 'version_no')  int versionNo, @JsonKey(name: 'sanitizer_v')  String sanitizerV, @JsonKey(name: 'stripped')  List<String> stripped, @JsonKey(name: 'will_not_render')  List<String> willNotRender, @JsonKey(name: 'tags')  List<String> tags, @JsonKey(name: 'status')  String status, @JsonKey(name: 'unsanitized')  bool unsanitized, @JsonKey(name: 'source_sha256')  String? sourceSha256, @JsonKey(name: 'title')  String? title, @JsonKey(name: 'description')  String? description, @JsonKey(name: 'slug')  String? slug, @JsonKey(name: 'superseded_by')  String? supersededBy)?  $default,) {final _that = this;
switch (_that) {
case _ReadSourceResponse() when $default != null:
return $default(_that.source,_that.sourceFormat,_that.versionNo,_that.sanitizerV,_that.stripped,_that.willNotRender,_that.tags,_that.status,_that.unsanitized,_that.sourceSha256,_that.title,_that.description,_that.slug,_that.supersededBy);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _ReadSourceResponse implements ReadSourceResponse {
  const _ReadSourceResponse({@JsonKey(name: 'source') required this.source, @JsonKey(name: 'source_format') required this.sourceFormat, @JsonKey(name: 'version_no') required this.versionNo, @JsonKey(name: 'sanitizer_v') required this.sanitizerV, @JsonKey(name: 'stripped') required final  List<String> stripped, @JsonKey(name: 'will_not_render') required final  List<String> willNotRender, @JsonKey(name: 'tags') required final  List<String> tags, @JsonKey(name: 'status') required this.status, @JsonKey(name: 'unsanitized') required this.unsanitized, @JsonKey(name: 'source_sha256') this.sourceSha256, @JsonKey(name: 'title') this.title, @JsonKey(name: 'description') this.description, @JsonKey(name: 'slug') this.slug, @JsonKey(name: 'superseded_by') this.supersededBy}): _stripped = stripped,_willNotRender = willNotRender,_tags = tags;
  factory _ReadSourceResponse.fromJson(Map<String, dynamic> json) => _$ReadSourceResponseFromJson(json);

@override@JsonKey(name: 'source') final  String source;
@override@JsonKey(name: 'source_format') final  String sourceFormat;
@override@JsonKey(name: 'version_no') final  int versionNo;
@override@JsonKey(name: 'sanitizer_v') final  String sanitizerV;
 final  List<String> _stripped;
@override@JsonKey(name: 'stripped') List<String> get stripped {
  if (_stripped is EqualUnmodifiableListView) return _stripped;
  // ignore: implicit_dynamic_type
  return EqualUnmodifiableListView(_stripped);
}

 final  List<String> _willNotRender;
@override@JsonKey(name: 'will_not_render') List<String> get willNotRender {
  if (_willNotRender is EqualUnmodifiableListView) return _willNotRender;
  // ignore: implicit_dynamic_type
  return EqualUnmodifiableListView(_willNotRender);
}

 final  List<String> _tags;
@override@JsonKey(name: 'tags') List<String> get tags {
  if (_tags is EqualUnmodifiableListView) return _tags;
  // ignore: implicit_dynamic_type
  return EqualUnmodifiableListView(_tags);
}

@override@JsonKey(name: 'status') final  String status;
@override@JsonKey(name: 'unsanitized') final  bool unsanitized;
@override@JsonKey(name: 'source_sha256') final  String? sourceSha256;
@override@JsonKey(name: 'title') final  String? title;
@override@JsonKey(name: 'description') final  String? description;
@override@JsonKey(name: 'slug') final  String? slug;
@override@JsonKey(name: 'superseded_by') final  String? supersededBy;

/// Create a copy of ReadSourceResponse
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$ReadSourceResponseCopyWith<_ReadSourceResponse> get copyWith => __$ReadSourceResponseCopyWithImpl<_ReadSourceResponse>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$ReadSourceResponseToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _ReadSourceResponse&&(identical(other.source, source) || other.source == source)&&(identical(other.sourceFormat, sourceFormat) || other.sourceFormat == sourceFormat)&&(identical(other.versionNo, versionNo) || other.versionNo == versionNo)&&(identical(other.sanitizerV, sanitizerV) || other.sanitizerV == sanitizerV)&&const DeepCollectionEquality().equals(other._stripped, _stripped)&&const DeepCollectionEquality().equals(other._willNotRender, _willNotRender)&&const DeepCollectionEquality().equals(other._tags, _tags)&&(identical(other.status, status) || other.status == status)&&(identical(other.unsanitized, unsanitized) || other.unsanitized == unsanitized)&&(identical(other.sourceSha256, sourceSha256) || other.sourceSha256 == sourceSha256)&&(identical(other.title, title) || other.title == title)&&(identical(other.description, description) || other.description == description)&&(identical(other.slug, slug) || other.slug == slug)&&(identical(other.supersededBy, supersededBy) || other.supersededBy == supersededBy));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,source,sourceFormat,versionNo,sanitizerV,const DeepCollectionEquality().hash(_stripped),const DeepCollectionEquality().hash(_willNotRender),const DeepCollectionEquality().hash(_tags),status,unsanitized,sourceSha256,title,description,slug,supersededBy);

@override
String toString() {
  return 'ReadSourceResponse(source: $source, sourceFormat: $sourceFormat, versionNo: $versionNo, sanitizerV: $sanitizerV, stripped: $stripped, willNotRender: $willNotRender, tags: $tags, status: $status, unsanitized: $unsanitized, sourceSha256: $sourceSha256, title: $title, description: $description, slug: $slug, supersededBy: $supersededBy)';
}


}

/// @nodoc
abstract mixin class _$ReadSourceResponseCopyWith<$Res> implements $ReadSourceResponseCopyWith<$Res> {
  factory _$ReadSourceResponseCopyWith(_ReadSourceResponse value, $Res Function(_ReadSourceResponse) _then) = __$ReadSourceResponseCopyWithImpl;
@override @useResult
$Res call({
@JsonKey(name: 'source') String source,@JsonKey(name: 'source_format') String sourceFormat,@JsonKey(name: 'version_no') int versionNo,@JsonKey(name: 'sanitizer_v') String sanitizerV,@JsonKey(name: 'stripped') List<String> stripped,@JsonKey(name: 'will_not_render') List<String> willNotRender,@JsonKey(name: 'tags') List<String> tags,@JsonKey(name: 'status') String status,@JsonKey(name: 'unsanitized') bool unsanitized,@JsonKey(name: 'source_sha256') String? sourceSha256,@JsonKey(name: 'title') String? title,@JsonKey(name: 'description') String? description,@JsonKey(name: 'slug') String? slug,@JsonKey(name: 'superseded_by') String? supersededBy
});




}
/// @nodoc
class __$ReadSourceResponseCopyWithImpl<$Res>
    implements _$ReadSourceResponseCopyWith<$Res> {
  __$ReadSourceResponseCopyWithImpl(this._self, this._then);

  final _ReadSourceResponse _self;
  final $Res Function(_ReadSourceResponse) _then;

/// Create a copy of ReadSourceResponse
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? source = null,Object? sourceFormat = null,Object? versionNo = null,Object? sanitizerV = null,Object? stripped = null,Object? willNotRender = null,Object? tags = null,Object? status = null,Object? unsanitized = null,Object? sourceSha256 = freezed,Object? title = freezed,Object? description = freezed,Object? slug = freezed,Object? supersededBy = freezed,}) {
  return _then(_ReadSourceResponse(
source: null == source ? _self.source : source // ignore: cast_nullable_to_non_nullable
as String,sourceFormat: null == sourceFormat ? _self.sourceFormat : sourceFormat // ignore: cast_nullable_to_non_nullable
as String,versionNo: null == versionNo ? _self.versionNo : versionNo // ignore: cast_nullable_to_non_nullable
as int,sanitizerV: null == sanitizerV ? _self.sanitizerV : sanitizerV // ignore: cast_nullable_to_non_nullable
as String,stripped: null == stripped ? _self._stripped : stripped // ignore: cast_nullable_to_non_nullable
as List<String>,willNotRender: null == willNotRender ? _self._willNotRender : willNotRender // ignore: cast_nullable_to_non_nullable
as List<String>,tags: null == tags ? _self._tags : tags // ignore: cast_nullable_to_non_nullable
as List<String>,status: null == status ? _self.status : status // ignore: cast_nullable_to_non_nullable
as String,unsanitized: null == unsanitized ? _self.unsanitized : unsanitized // ignore: cast_nullable_to_non_nullable
as bool,sourceSha256: freezed == sourceSha256 ? _self.sourceSha256 : sourceSha256 // ignore: cast_nullable_to_non_nullable
as String?,title: freezed == title ? _self.title : title // ignore: cast_nullable_to_non_nullable
as String?,description: freezed == description ? _self.description : description // ignore: cast_nullable_to_non_nullable
as String?,slug: freezed == slug ? _self.slug : slug // ignore: cast_nullable_to_non_nullable
as String?,supersededBy: freezed == supersededBy ? _self.supersededBy : supersededBy // ignore: cast_nullable_to_non_nullable
as String?,
  ));
}


}


/// @nodoc
mixin _$RedirectTarget {

@JsonKey(name: 'public_id') String get publicId;@JsonKey(name: 'slug') String? get slug;@JsonKey(name: 'title') String? get title;
/// Create a copy of RedirectTarget
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$RedirectTargetCopyWith<RedirectTarget> get copyWith => _$RedirectTargetCopyWithImpl<RedirectTarget>(this as RedirectTarget, _$identity);

  /// Serializes this RedirectTarget to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is RedirectTarget&&(identical(other.publicId, publicId) || other.publicId == publicId)&&(identical(other.slug, slug) || other.slug == slug)&&(identical(other.title, title) || other.title == title));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,publicId,slug,title);

@override
String toString() {
  return 'RedirectTarget(publicId: $publicId, slug: $slug, title: $title)';
}


}

/// @nodoc
abstract mixin class $RedirectTargetCopyWith<$Res>  {
  factory $RedirectTargetCopyWith(RedirectTarget value, $Res Function(RedirectTarget) _then) = _$RedirectTargetCopyWithImpl;
@useResult
$Res call({
@JsonKey(name: 'public_id') String publicId,@JsonKey(name: 'slug') String? slug,@JsonKey(name: 'title') String? title
});




}
/// @nodoc
class _$RedirectTargetCopyWithImpl<$Res>
    implements $RedirectTargetCopyWith<$Res> {
  _$RedirectTargetCopyWithImpl(this._self, this._then);

  final RedirectTarget _self;
  final $Res Function(RedirectTarget) _then;

/// Create a copy of RedirectTarget
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? publicId = null,Object? slug = freezed,Object? title = freezed,}) {
  return _then(_self.copyWith(
publicId: null == publicId ? _self.publicId : publicId // ignore: cast_nullable_to_non_nullable
as String,slug: freezed == slug ? _self.slug : slug // ignore: cast_nullable_to_non_nullable
as String?,title: freezed == title ? _self.title : title // ignore: cast_nullable_to_non_nullable
as String?,
  ));
}

}


/// Adds pattern-matching-related methods to [RedirectTarget].
extension RedirectTargetPatterns on RedirectTarget {
/// A variant of `map` that fallback to returning `orElse`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _RedirectTarget value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _RedirectTarget() when $default != null:
return $default(_that);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// Callbacks receives the raw object, upcasted.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case final Subclass2 value:
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _RedirectTarget value)  $default,){
final _that = this;
switch (_that) {
case _RedirectTarget():
return $default(_that);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `map` that fallback to returning `null`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _RedirectTarget value)?  $default,){
final _that = this;
switch (_that) {
case _RedirectTarget() when $default != null:
return $default(_that);case _:
  return null;

}
}
/// A variant of `when` that fallback to an `orElse` callback.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function(@JsonKey(name: 'public_id')  String publicId, @JsonKey(name: 'slug')  String? slug, @JsonKey(name: 'title')  String? title)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _RedirectTarget() when $default != null:
return $default(_that.publicId,_that.slug,_that.title);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// As opposed to `map`, this offers destructuring.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case Subclass2(:final field2):
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function(@JsonKey(name: 'public_id')  String publicId, @JsonKey(name: 'slug')  String? slug, @JsonKey(name: 'title')  String? title)  $default,) {final _that = this;
switch (_that) {
case _RedirectTarget():
return $default(_that.publicId,_that.slug,_that.title);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `when` that fallback to returning `null`
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function(@JsonKey(name: 'public_id')  String publicId, @JsonKey(name: 'slug')  String? slug, @JsonKey(name: 'title')  String? title)?  $default,) {final _that = this;
switch (_that) {
case _RedirectTarget() when $default != null:
return $default(_that.publicId,_that.slug,_that.title);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _RedirectTarget implements RedirectTarget {
  const _RedirectTarget({@JsonKey(name: 'public_id') required this.publicId, @JsonKey(name: 'slug') this.slug, @JsonKey(name: 'title') this.title});
  factory _RedirectTarget.fromJson(Map<String, dynamic> json) => _$RedirectTargetFromJson(json);

@override@JsonKey(name: 'public_id') final  String publicId;
@override@JsonKey(name: 'slug') final  String? slug;
@override@JsonKey(name: 'title') final  String? title;

/// Create a copy of RedirectTarget
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$RedirectTargetCopyWith<_RedirectTarget> get copyWith => __$RedirectTargetCopyWithImpl<_RedirectTarget>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$RedirectTargetToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _RedirectTarget&&(identical(other.publicId, publicId) || other.publicId == publicId)&&(identical(other.slug, slug) || other.slug == slug)&&(identical(other.title, title) || other.title == title));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,publicId,slug,title);

@override
String toString() {
  return 'RedirectTarget(publicId: $publicId, slug: $slug, title: $title)';
}


}

/// @nodoc
abstract mixin class _$RedirectTargetCopyWith<$Res> implements $RedirectTargetCopyWith<$Res> {
  factory _$RedirectTargetCopyWith(_RedirectTarget value, $Res Function(_RedirectTarget) _then) = __$RedirectTargetCopyWithImpl;
@override @useResult
$Res call({
@JsonKey(name: 'public_id') String publicId,@JsonKey(name: 'slug') String? slug,@JsonKey(name: 'title') String? title
});




}
/// @nodoc
class __$RedirectTargetCopyWithImpl<$Res>
    implements _$RedirectTargetCopyWith<$Res> {
  __$RedirectTargetCopyWithImpl(this._self, this._then);

  final _RedirectTarget _self;
  final $Res Function(_RedirectTarget) _then;

/// Create a copy of RedirectTarget
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? publicId = null,Object? slug = freezed,Object? title = freezed,}) {
  return _then(_RedirectTarget(
publicId: null == publicId ? _self.publicId : publicId // ignore: cast_nullable_to_non_nullable
as String,slug: freezed == slug ? _self.slug : slug // ignore: cast_nullable_to_non_nullable
as String?,title: freezed == title ? _self.title : title // ignore: cast_nullable_to_non_nullable
as String?,
  ));
}


}


/// @nodoc
mixin _$ReleaseSlugTombstoneResponse {

@JsonKey(name: 'released') bool get released;@JsonKey(name: 'slug') String get slug;
/// Create a copy of ReleaseSlugTombstoneResponse
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$ReleaseSlugTombstoneResponseCopyWith<ReleaseSlugTombstoneResponse> get copyWith => _$ReleaseSlugTombstoneResponseCopyWithImpl<ReleaseSlugTombstoneResponse>(this as ReleaseSlugTombstoneResponse, _$identity);

  /// Serializes this ReleaseSlugTombstoneResponse to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ReleaseSlugTombstoneResponse&&(identical(other.released, released) || other.released == released)&&(identical(other.slug, slug) || other.slug == slug));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,released,slug);

@override
String toString() {
  return 'ReleaseSlugTombstoneResponse(released: $released, slug: $slug)';
}


}

/// @nodoc
abstract mixin class $ReleaseSlugTombstoneResponseCopyWith<$Res>  {
  factory $ReleaseSlugTombstoneResponseCopyWith(ReleaseSlugTombstoneResponse value, $Res Function(ReleaseSlugTombstoneResponse) _then) = _$ReleaseSlugTombstoneResponseCopyWithImpl;
@useResult
$Res call({
@JsonKey(name: 'released') bool released,@JsonKey(name: 'slug') String slug
});




}
/// @nodoc
class _$ReleaseSlugTombstoneResponseCopyWithImpl<$Res>
    implements $ReleaseSlugTombstoneResponseCopyWith<$Res> {
  _$ReleaseSlugTombstoneResponseCopyWithImpl(this._self, this._then);

  final ReleaseSlugTombstoneResponse _self;
  final $Res Function(ReleaseSlugTombstoneResponse) _then;

/// Create a copy of ReleaseSlugTombstoneResponse
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? released = null,Object? slug = null,}) {
  return _then(_self.copyWith(
released: null == released ? _self.released : released // ignore: cast_nullable_to_non_nullable
as bool,slug: null == slug ? _self.slug : slug // ignore: cast_nullable_to_non_nullable
as String,
  ));
}

}


/// Adds pattern-matching-related methods to [ReleaseSlugTombstoneResponse].
extension ReleaseSlugTombstoneResponsePatterns on ReleaseSlugTombstoneResponse {
/// A variant of `map` that fallback to returning `orElse`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _ReleaseSlugTombstoneResponse value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _ReleaseSlugTombstoneResponse() when $default != null:
return $default(_that);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// Callbacks receives the raw object, upcasted.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case final Subclass2 value:
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _ReleaseSlugTombstoneResponse value)  $default,){
final _that = this;
switch (_that) {
case _ReleaseSlugTombstoneResponse():
return $default(_that);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `map` that fallback to returning `null`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _ReleaseSlugTombstoneResponse value)?  $default,){
final _that = this;
switch (_that) {
case _ReleaseSlugTombstoneResponse() when $default != null:
return $default(_that);case _:
  return null;

}
}
/// A variant of `when` that fallback to an `orElse` callback.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function(@JsonKey(name: 'released')  bool released, @JsonKey(name: 'slug')  String slug)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _ReleaseSlugTombstoneResponse() when $default != null:
return $default(_that.released,_that.slug);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// As opposed to `map`, this offers destructuring.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case Subclass2(:final field2):
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function(@JsonKey(name: 'released')  bool released, @JsonKey(name: 'slug')  String slug)  $default,) {final _that = this;
switch (_that) {
case _ReleaseSlugTombstoneResponse():
return $default(_that.released,_that.slug);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `when` that fallback to returning `null`
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function(@JsonKey(name: 'released')  bool released, @JsonKey(name: 'slug')  String slug)?  $default,) {final _that = this;
switch (_that) {
case _ReleaseSlugTombstoneResponse() when $default != null:
return $default(_that.released,_that.slug);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _ReleaseSlugTombstoneResponse implements ReleaseSlugTombstoneResponse {
  const _ReleaseSlugTombstoneResponse({@JsonKey(name: 'released') required this.released, @JsonKey(name: 'slug') required this.slug});
  factory _ReleaseSlugTombstoneResponse.fromJson(Map<String, dynamic> json) => _$ReleaseSlugTombstoneResponseFromJson(json);

@override@JsonKey(name: 'released') final  bool released;
@override@JsonKey(name: 'slug') final  String slug;

/// Create a copy of ReleaseSlugTombstoneResponse
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$ReleaseSlugTombstoneResponseCopyWith<_ReleaseSlugTombstoneResponse> get copyWith => __$ReleaseSlugTombstoneResponseCopyWithImpl<_ReleaseSlugTombstoneResponse>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$ReleaseSlugTombstoneResponseToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _ReleaseSlugTombstoneResponse&&(identical(other.released, released) || other.released == released)&&(identical(other.slug, slug) || other.slug == slug));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,released,slug);

@override
String toString() {
  return 'ReleaseSlugTombstoneResponse(released: $released, slug: $slug)';
}


}

/// @nodoc
abstract mixin class _$ReleaseSlugTombstoneResponseCopyWith<$Res> implements $ReleaseSlugTombstoneResponseCopyWith<$Res> {
  factory _$ReleaseSlugTombstoneResponseCopyWith(_ReleaseSlugTombstoneResponse value, $Res Function(_ReleaseSlugTombstoneResponse) _then) = __$ReleaseSlugTombstoneResponseCopyWithImpl;
@override @useResult
$Res call({
@JsonKey(name: 'released') bool released,@JsonKey(name: 'slug') String slug
});




}
/// @nodoc
class __$ReleaseSlugTombstoneResponseCopyWithImpl<$Res>
    implements _$ReleaseSlugTombstoneResponseCopyWith<$Res> {
  __$ReleaseSlugTombstoneResponseCopyWithImpl(this._self, this._then);

  final _ReleaseSlugTombstoneResponse _self;
  final $Res Function(_ReleaseSlugTombstoneResponse) _then;

/// Create a copy of ReleaseSlugTombstoneResponse
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? released = null,Object? slug = null,}) {
  return _then(_ReleaseSlugTombstoneResponse(
released: null == released ? _self.released : released // ignore: cast_nullable_to_non_nullable
as bool,slug: null == slug ? _self.slug : slug // ignore: cast_nullable_to_non_nullable
as String,
  ));
}


}


/// @nodoc
mixin _$RevokeAgentResponse {

@JsonKey(name: 'revoked') bool get revoked;@JsonKey(name: 'agent_id') String get agentId;@JsonKey(name: 'keys_revoked') int get keysRevoked;@JsonKey(name: 'oauth_clients_deleted') int get oauthClientsDeleted;
/// Create a copy of RevokeAgentResponse
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$RevokeAgentResponseCopyWith<RevokeAgentResponse> get copyWith => _$RevokeAgentResponseCopyWithImpl<RevokeAgentResponse>(this as RevokeAgentResponse, _$identity);

  /// Serializes this RevokeAgentResponse to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is RevokeAgentResponse&&(identical(other.revoked, revoked) || other.revoked == revoked)&&(identical(other.agentId, agentId) || other.agentId == agentId)&&(identical(other.keysRevoked, keysRevoked) || other.keysRevoked == keysRevoked)&&(identical(other.oauthClientsDeleted, oauthClientsDeleted) || other.oauthClientsDeleted == oauthClientsDeleted));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,revoked,agentId,keysRevoked,oauthClientsDeleted);

@override
String toString() {
  return 'RevokeAgentResponse(revoked: $revoked, agentId: $agentId, keysRevoked: $keysRevoked, oauthClientsDeleted: $oauthClientsDeleted)';
}


}

/// @nodoc
abstract mixin class $RevokeAgentResponseCopyWith<$Res>  {
  factory $RevokeAgentResponseCopyWith(RevokeAgentResponse value, $Res Function(RevokeAgentResponse) _then) = _$RevokeAgentResponseCopyWithImpl;
@useResult
$Res call({
@JsonKey(name: 'revoked') bool revoked,@JsonKey(name: 'agent_id') String agentId,@JsonKey(name: 'keys_revoked') int keysRevoked,@JsonKey(name: 'oauth_clients_deleted') int oauthClientsDeleted
});




}
/// @nodoc
class _$RevokeAgentResponseCopyWithImpl<$Res>
    implements $RevokeAgentResponseCopyWith<$Res> {
  _$RevokeAgentResponseCopyWithImpl(this._self, this._then);

  final RevokeAgentResponse _self;
  final $Res Function(RevokeAgentResponse) _then;

/// Create a copy of RevokeAgentResponse
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? revoked = null,Object? agentId = null,Object? keysRevoked = null,Object? oauthClientsDeleted = null,}) {
  return _then(_self.copyWith(
revoked: null == revoked ? _self.revoked : revoked // ignore: cast_nullable_to_non_nullable
as bool,agentId: null == agentId ? _self.agentId : agentId // ignore: cast_nullable_to_non_nullable
as String,keysRevoked: null == keysRevoked ? _self.keysRevoked : keysRevoked // ignore: cast_nullable_to_non_nullable
as int,oauthClientsDeleted: null == oauthClientsDeleted ? _self.oauthClientsDeleted : oauthClientsDeleted // ignore: cast_nullable_to_non_nullable
as int,
  ));
}

}


/// Adds pattern-matching-related methods to [RevokeAgentResponse].
extension RevokeAgentResponsePatterns on RevokeAgentResponse {
/// A variant of `map` that fallback to returning `orElse`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _RevokeAgentResponse value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _RevokeAgentResponse() when $default != null:
return $default(_that);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// Callbacks receives the raw object, upcasted.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case final Subclass2 value:
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _RevokeAgentResponse value)  $default,){
final _that = this;
switch (_that) {
case _RevokeAgentResponse():
return $default(_that);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `map` that fallback to returning `null`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _RevokeAgentResponse value)?  $default,){
final _that = this;
switch (_that) {
case _RevokeAgentResponse() when $default != null:
return $default(_that);case _:
  return null;

}
}
/// A variant of `when` that fallback to an `orElse` callback.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function(@JsonKey(name: 'revoked')  bool revoked, @JsonKey(name: 'agent_id')  String agentId, @JsonKey(name: 'keys_revoked')  int keysRevoked, @JsonKey(name: 'oauth_clients_deleted')  int oauthClientsDeleted)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _RevokeAgentResponse() when $default != null:
return $default(_that.revoked,_that.agentId,_that.keysRevoked,_that.oauthClientsDeleted);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// As opposed to `map`, this offers destructuring.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case Subclass2(:final field2):
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function(@JsonKey(name: 'revoked')  bool revoked, @JsonKey(name: 'agent_id')  String agentId, @JsonKey(name: 'keys_revoked')  int keysRevoked, @JsonKey(name: 'oauth_clients_deleted')  int oauthClientsDeleted)  $default,) {final _that = this;
switch (_that) {
case _RevokeAgentResponse():
return $default(_that.revoked,_that.agentId,_that.keysRevoked,_that.oauthClientsDeleted);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `when` that fallback to returning `null`
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function(@JsonKey(name: 'revoked')  bool revoked, @JsonKey(name: 'agent_id')  String agentId, @JsonKey(name: 'keys_revoked')  int keysRevoked, @JsonKey(name: 'oauth_clients_deleted')  int oauthClientsDeleted)?  $default,) {final _that = this;
switch (_that) {
case _RevokeAgentResponse() when $default != null:
return $default(_that.revoked,_that.agentId,_that.keysRevoked,_that.oauthClientsDeleted);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _RevokeAgentResponse implements RevokeAgentResponse {
  const _RevokeAgentResponse({@JsonKey(name: 'revoked') required this.revoked, @JsonKey(name: 'agent_id') required this.agentId, @JsonKey(name: 'keys_revoked') required this.keysRevoked, @JsonKey(name: 'oauth_clients_deleted') required this.oauthClientsDeleted});
  factory _RevokeAgentResponse.fromJson(Map<String, dynamic> json) => _$RevokeAgentResponseFromJson(json);

@override@JsonKey(name: 'revoked') final  bool revoked;
@override@JsonKey(name: 'agent_id') final  String agentId;
@override@JsonKey(name: 'keys_revoked') final  int keysRevoked;
@override@JsonKey(name: 'oauth_clients_deleted') final  int oauthClientsDeleted;

/// Create a copy of RevokeAgentResponse
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$RevokeAgentResponseCopyWith<_RevokeAgentResponse> get copyWith => __$RevokeAgentResponseCopyWithImpl<_RevokeAgentResponse>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$RevokeAgentResponseToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _RevokeAgentResponse&&(identical(other.revoked, revoked) || other.revoked == revoked)&&(identical(other.agentId, agentId) || other.agentId == agentId)&&(identical(other.keysRevoked, keysRevoked) || other.keysRevoked == keysRevoked)&&(identical(other.oauthClientsDeleted, oauthClientsDeleted) || other.oauthClientsDeleted == oauthClientsDeleted));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,revoked,agentId,keysRevoked,oauthClientsDeleted);

@override
String toString() {
  return 'RevokeAgentResponse(revoked: $revoked, agentId: $agentId, keysRevoked: $keysRevoked, oauthClientsDeleted: $oauthClientsDeleted)';
}


}

/// @nodoc
abstract mixin class _$RevokeAgentResponseCopyWith<$Res> implements $RevokeAgentResponseCopyWith<$Res> {
  factory _$RevokeAgentResponseCopyWith(_RevokeAgentResponse value, $Res Function(_RevokeAgentResponse) _then) = __$RevokeAgentResponseCopyWithImpl;
@override @useResult
$Res call({
@JsonKey(name: 'revoked') bool revoked,@JsonKey(name: 'agent_id') String agentId,@JsonKey(name: 'keys_revoked') int keysRevoked,@JsonKey(name: 'oauth_clients_deleted') int oauthClientsDeleted
});




}
/// @nodoc
class __$RevokeAgentResponseCopyWithImpl<$Res>
    implements _$RevokeAgentResponseCopyWith<$Res> {
  __$RevokeAgentResponseCopyWithImpl(this._self, this._then);

  final _RevokeAgentResponse _self;
  final $Res Function(_RevokeAgentResponse) _then;

/// Create a copy of RevokeAgentResponse
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? revoked = null,Object? agentId = null,Object? keysRevoked = null,Object? oauthClientsDeleted = null,}) {
  return _then(_RevokeAgentResponse(
revoked: null == revoked ? _self.revoked : revoked // ignore: cast_nullable_to_non_nullable
as bool,agentId: null == agentId ? _self.agentId : agentId // ignore: cast_nullable_to_non_nullable
as String,keysRevoked: null == keysRevoked ? _self.keysRevoked : keysRevoked // ignore: cast_nullable_to_non_nullable
as int,oauthClientsDeleted: null == oauthClientsDeleted ? _self.oauthClientsDeleted : oauthClientsDeleted // ignore: cast_nullable_to_non_nullable
as int,
  ));
}


}


/// @nodoc
mixin _$RevokeKeyResponse {

@JsonKey(name: 'revoked') bool get revoked;@JsonKey(name: 'key_id') String get keyId;@JsonKey(name: 'agent_id') String get agentId;@JsonKey(name: 'key_prefix') String get keyPrefix;
/// Create a copy of RevokeKeyResponse
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$RevokeKeyResponseCopyWith<RevokeKeyResponse> get copyWith => _$RevokeKeyResponseCopyWithImpl<RevokeKeyResponse>(this as RevokeKeyResponse, _$identity);

  /// Serializes this RevokeKeyResponse to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is RevokeKeyResponse&&(identical(other.revoked, revoked) || other.revoked == revoked)&&(identical(other.keyId, keyId) || other.keyId == keyId)&&(identical(other.agentId, agentId) || other.agentId == agentId)&&(identical(other.keyPrefix, keyPrefix) || other.keyPrefix == keyPrefix));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,revoked,keyId,agentId,keyPrefix);

@override
String toString() {
  return 'RevokeKeyResponse(revoked: $revoked, keyId: $keyId, agentId: $agentId, keyPrefix: $keyPrefix)';
}


}

/// @nodoc
abstract mixin class $RevokeKeyResponseCopyWith<$Res>  {
  factory $RevokeKeyResponseCopyWith(RevokeKeyResponse value, $Res Function(RevokeKeyResponse) _then) = _$RevokeKeyResponseCopyWithImpl;
@useResult
$Res call({
@JsonKey(name: 'revoked') bool revoked,@JsonKey(name: 'key_id') String keyId,@JsonKey(name: 'agent_id') String agentId,@JsonKey(name: 'key_prefix') String keyPrefix
});




}
/// @nodoc
class _$RevokeKeyResponseCopyWithImpl<$Res>
    implements $RevokeKeyResponseCopyWith<$Res> {
  _$RevokeKeyResponseCopyWithImpl(this._self, this._then);

  final RevokeKeyResponse _self;
  final $Res Function(RevokeKeyResponse) _then;

/// Create a copy of RevokeKeyResponse
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? revoked = null,Object? keyId = null,Object? agentId = null,Object? keyPrefix = null,}) {
  return _then(_self.copyWith(
revoked: null == revoked ? _self.revoked : revoked // ignore: cast_nullable_to_non_nullable
as bool,keyId: null == keyId ? _self.keyId : keyId // ignore: cast_nullable_to_non_nullable
as String,agentId: null == agentId ? _self.agentId : agentId // ignore: cast_nullable_to_non_nullable
as String,keyPrefix: null == keyPrefix ? _self.keyPrefix : keyPrefix // ignore: cast_nullable_to_non_nullable
as String,
  ));
}

}


/// Adds pattern-matching-related methods to [RevokeKeyResponse].
extension RevokeKeyResponsePatterns on RevokeKeyResponse {
/// A variant of `map` that fallback to returning `orElse`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _RevokeKeyResponse value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _RevokeKeyResponse() when $default != null:
return $default(_that);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// Callbacks receives the raw object, upcasted.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case final Subclass2 value:
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _RevokeKeyResponse value)  $default,){
final _that = this;
switch (_that) {
case _RevokeKeyResponse():
return $default(_that);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `map` that fallback to returning `null`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _RevokeKeyResponse value)?  $default,){
final _that = this;
switch (_that) {
case _RevokeKeyResponse() when $default != null:
return $default(_that);case _:
  return null;

}
}
/// A variant of `when` that fallback to an `orElse` callback.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function(@JsonKey(name: 'revoked')  bool revoked, @JsonKey(name: 'key_id')  String keyId, @JsonKey(name: 'agent_id')  String agentId, @JsonKey(name: 'key_prefix')  String keyPrefix)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _RevokeKeyResponse() when $default != null:
return $default(_that.revoked,_that.keyId,_that.agentId,_that.keyPrefix);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// As opposed to `map`, this offers destructuring.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case Subclass2(:final field2):
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function(@JsonKey(name: 'revoked')  bool revoked, @JsonKey(name: 'key_id')  String keyId, @JsonKey(name: 'agent_id')  String agentId, @JsonKey(name: 'key_prefix')  String keyPrefix)  $default,) {final _that = this;
switch (_that) {
case _RevokeKeyResponse():
return $default(_that.revoked,_that.keyId,_that.agentId,_that.keyPrefix);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `when` that fallback to returning `null`
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function(@JsonKey(name: 'revoked')  bool revoked, @JsonKey(name: 'key_id')  String keyId, @JsonKey(name: 'agent_id')  String agentId, @JsonKey(name: 'key_prefix')  String keyPrefix)?  $default,) {final _that = this;
switch (_that) {
case _RevokeKeyResponse() when $default != null:
return $default(_that.revoked,_that.keyId,_that.agentId,_that.keyPrefix);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _RevokeKeyResponse implements RevokeKeyResponse {
  const _RevokeKeyResponse({@JsonKey(name: 'revoked') required this.revoked, @JsonKey(name: 'key_id') required this.keyId, @JsonKey(name: 'agent_id') required this.agentId, @JsonKey(name: 'key_prefix') required this.keyPrefix});
  factory _RevokeKeyResponse.fromJson(Map<String, dynamic> json) => _$RevokeKeyResponseFromJson(json);

@override@JsonKey(name: 'revoked') final  bool revoked;
@override@JsonKey(name: 'key_id') final  String keyId;
@override@JsonKey(name: 'agent_id') final  String agentId;
@override@JsonKey(name: 'key_prefix') final  String keyPrefix;

/// Create a copy of RevokeKeyResponse
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$RevokeKeyResponseCopyWith<_RevokeKeyResponse> get copyWith => __$RevokeKeyResponseCopyWithImpl<_RevokeKeyResponse>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$RevokeKeyResponseToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _RevokeKeyResponse&&(identical(other.revoked, revoked) || other.revoked == revoked)&&(identical(other.keyId, keyId) || other.keyId == keyId)&&(identical(other.agentId, agentId) || other.agentId == agentId)&&(identical(other.keyPrefix, keyPrefix) || other.keyPrefix == keyPrefix));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,revoked,keyId,agentId,keyPrefix);

@override
String toString() {
  return 'RevokeKeyResponse(revoked: $revoked, keyId: $keyId, agentId: $agentId, keyPrefix: $keyPrefix)';
}


}

/// @nodoc
abstract mixin class _$RevokeKeyResponseCopyWith<$Res> implements $RevokeKeyResponseCopyWith<$Res> {
  factory _$RevokeKeyResponseCopyWith(_RevokeKeyResponse value, $Res Function(_RevokeKeyResponse) _then) = __$RevokeKeyResponseCopyWithImpl;
@override @useResult
$Res call({
@JsonKey(name: 'revoked') bool revoked,@JsonKey(name: 'key_id') String keyId,@JsonKey(name: 'agent_id') String agentId,@JsonKey(name: 'key_prefix') String keyPrefix
});




}
/// @nodoc
class __$RevokeKeyResponseCopyWithImpl<$Res>
    implements _$RevokeKeyResponseCopyWith<$Res> {
  __$RevokeKeyResponseCopyWithImpl(this._self, this._then);

  final _RevokeKeyResponse _self;
  final $Res Function(_RevokeKeyResponse) _then;

/// Create a copy of RevokeKeyResponse
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? revoked = null,Object? keyId = null,Object? agentId = null,Object? keyPrefix = null,}) {
  return _then(_RevokeKeyResponse(
revoked: null == revoked ? _self.revoked : revoked // ignore: cast_nullable_to_non_nullable
as bool,keyId: null == keyId ? _self.keyId : keyId // ignore: cast_nullable_to_non_nullable
as String,agentId: null == agentId ? _self.agentId : agentId // ignore: cast_nullable_to_non_nullable
as String,keyPrefix: null == keyPrefix ? _self.keyPrefix : keyPrefix // ignore: cast_nullable_to_non_nullable
as String,
  ));
}


}


/// @nodoc
mixin _$RevokeResponse {

@JsonKey(name: 'revoked') bool get revoked;@JsonKey(name: 'public_id') String get publicId;@JsonKey(name: 'r2_objects_purged') int get r2ObjectsPurged;
/// Create a copy of RevokeResponse
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$RevokeResponseCopyWith<RevokeResponse> get copyWith => _$RevokeResponseCopyWithImpl<RevokeResponse>(this as RevokeResponse, _$identity);

  /// Serializes this RevokeResponse to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is RevokeResponse&&(identical(other.revoked, revoked) || other.revoked == revoked)&&(identical(other.publicId, publicId) || other.publicId == publicId)&&(identical(other.r2ObjectsPurged, r2ObjectsPurged) || other.r2ObjectsPurged == r2ObjectsPurged));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,revoked,publicId,r2ObjectsPurged);

@override
String toString() {
  return 'RevokeResponse(revoked: $revoked, publicId: $publicId, r2ObjectsPurged: $r2ObjectsPurged)';
}


}

/// @nodoc
abstract mixin class $RevokeResponseCopyWith<$Res>  {
  factory $RevokeResponseCopyWith(RevokeResponse value, $Res Function(RevokeResponse) _then) = _$RevokeResponseCopyWithImpl;
@useResult
$Res call({
@JsonKey(name: 'revoked') bool revoked,@JsonKey(name: 'public_id') String publicId,@JsonKey(name: 'r2_objects_purged') int r2ObjectsPurged
});




}
/// @nodoc
class _$RevokeResponseCopyWithImpl<$Res>
    implements $RevokeResponseCopyWith<$Res> {
  _$RevokeResponseCopyWithImpl(this._self, this._then);

  final RevokeResponse _self;
  final $Res Function(RevokeResponse) _then;

/// Create a copy of RevokeResponse
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? revoked = null,Object? publicId = null,Object? r2ObjectsPurged = null,}) {
  return _then(_self.copyWith(
revoked: null == revoked ? _self.revoked : revoked // ignore: cast_nullable_to_non_nullable
as bool,publicId: null == publicId ? _self.publicId : publicId // ignore: cast_nullable_to_non_nullable
as String,r2ObjectsPurged: null == r2ObjectsPurged ? _self.r2ObjectsPurged : r2ObjectsPurged // ignore: cast_nullable_to_non_nullable
as int,
  ));
}

}


/// Adds pattern-matching-related methods to [RevokeResponse].
extension RevokeResponsePatterns on RevokeResponse {
/// A variant of `map` that fallback to returning `orElse`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _RevokeResponse value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _RevokeResponse() when $default != null:
return $default(_that);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// Callbacks receives the raw object, upcasted.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case final Subclass2 value:
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _RevokeResponse value)  $default,){
final _that = this;
switch (_that) {
case _RevokeResponse():
return $default(_that);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `map` that fallback to returning `null`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _RevokeResponse value)?  $default,){
final _that = this;
switch (_that) {
case _RevokeResponse() when $default != null:
return $default(_that);case _:
  return null;

}
}
/// A variant of `when` that fallback to an `orElse` callback.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function(@JsonKey(name: 'revoked')  bool revoked, @JsonKey(name: 'public_id')  String publicId, @JsonKey(name: 'r2_objects_purged')  int r2ObjectsPurged)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _RevokeResponse() when $default != null:
return $default(_that.revoked,_that.publicId,_that.r2ObjectsPurged);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// As opposed to `map`, this offers destructuring.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case Subclass2(:final field2):
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function(@JsonKey(name: 'revoked')  bool revoked, @JsonKey(name: 'public_id')  String publicId, @JsonKey(name: 'r2_objects_purged')  int r2ObjectsPurged)  $default,) {final _that = this;
switch (_that) {
case _RevokeResponse():
return $default(_that.revoked,_that.publicId,_that.r2ObjectsPurged);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `when` that fallback to returning `null`
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function(@JsonKey(name: 'revoked')  bool revoked, @JsonKey(name: 'public_id')  String publicId, @JsonKey(name: 'r2_objects_purged')  int r2ObjectsPurged)?  $default,) {final _that = this;
switch (_that) {
case _RevokeResponse() when $default != null:
return $default(_that.revoked,_that.publicId,_that.r2ObjectsPurged);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _RevokeResponse implements RevokeResponse {
  const _RevokeResponse({@JsonKey(name: 'revoked') required this.revoked, @JsonKey(name: 'public_id') required this.publicId, @JsonKey(name: 'r2_objects_purged') required this.r2ObjectsPurged});
  factory _RevokeResponse.fromJson(Map<String, dynamic> json) => _$RevokeResponseFromJson(json);

@override@JsonKey(name: 'revoked') final  bool revoked;
@override@JsonKey(name: 'public_id') final  String publicId;
@override@JsonKey(name: 'r2_objects_purged') final  int r2ObjectsPurged;

/// Create a copy of RevokeResponse
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$RevokeResponseCopyWith<_RevokeResponse> get copyWith => __$RevokeResponseCopyWithImpl<_RevokeResponse>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$RevokeResponseToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _RevokeResponse&&(identical(other.revoked, revoked) || other.revoked == revoked)&&(identical(other.publicId, publicId) || other.publicId == publicId)&&(identical(other.r2ObjectsPurged, r2ObjectsPurged) || other.r2ObjectsPurged == r2ObjectsPurged));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,revoked,publicId,r2ObjectsPurged);

@override
String toString() {
  return 'RevokeResponse(revoked: $revoked, publicId: $publicId, r2ObjectsPurged: $r2ObjectsPurged)';
}


}

/// @nodoc
abstract mixin class _$RevokeResponseCopyWith<$Res> implements $RevokeResponseCopyWith<$Res> {
  factory _$RevokeResponseCopyWith(_RevokeResponse value, $Res Function(_RevokeResponse) _then) = __$RevokeResponseCopyWithImpl;
@override @useResult
$Res call({
@JsonKey(name: 'revoked') bool revoked,@JsonKey(name: 'public_id') String publicId,@JsonKey(name: 'r2_objects_purged') int r2ObjectsPurged
});




}
/// @nodoc
class __$RevokeResponseCopyWithImpl<$Res>
    implements _$RevokeResponseCopyWith<$Res> {
  __$RevokeResponseCopyWithImpl(this._self, this._then);

  final _RevokeResponse _self;
  final $Res Function(_RevokeResponse) _then;

/// Create a copy of RevokeResponse
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? revoked = null,Object? publicId = null,Object? r2ObjectsPurged = null,}) {
  return _then(_RevokeResponse(
revoked: null == revoked ? _self.revoked : revoked // ignore: cast_nullable_to_non_nullable
as bool,publicId: null == publicId ? _self.publicId : publicId // ignore: cast_nullable_to_non_nullable
as String,r2ObjectsPurged: null == r2ObjectsPurged ? _self.r2ObjectsPurged : r2ObjectsPurged // ignore: cast_nullable_to_non_nullable
as int,
  ));
}


}


/// @nodoc
mixin _$SearchDocumentsResponse {

@JsonKey(name: 'documents') List<SearchHit> get documents;
/// Create a copy of SearchDocumentsResponse
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$SearchDocumentsResponseCopyWith<SearchDocumentsResponse> get copyWith => _$SearchDocumentsResponseCopyWithImpl<SearchDocumentsResponse>(this as SearchDocumentsResponse, _$identity);

  /// Serializes this SearchDocumentsResponse to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is SearchDocumentsResponse&&const DeepCollectionEquality().equals(other.documents, documents));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,const DeepCollectionEquality().hash(documents));

@override
String toString() {
  return 'SearchDocumentsResponse(documents: $documents)';
}


}

/// @nodoc
abstract mixin class $SearchDocumentsResponseCopyWith<$Res>  {
  factory $SearchDocumentsResponseCopyWith(SearchDocumentsResponse value, $Res Function(SearchDocumentsResponse) _then) = _$SearchDocumentsResponseCopyWithImpl;
@useResult
$Res call({
@JsonKey(name: 'documents') List<SearchHit> documents
});




}
/// @nodoc
class _$SearchDocumentsResponseCopyWithImpl<$Res>
    implements $SearchDocumentsResponseCopyWith<$Res> {
  _$SearchDocumentsResponseCopyWithImpl(this._self, this._then);

  final SearchDocumentsResponse _self;
  final $Res Function(SearchDocumentsResponse) _then;

/// Create a copy of SearchDocumentsResponse
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? documents = null,}) {
  return _then(_self.copyWith(
documents: null == documents ? _self.documents : documents // ignore: cast_nullable_to_non_nullable
as List<SearchHit>,
  ));
}

}


/// Adds pattern-matching-related methods to [SearchDocumentsResponse].
extension SearchDocumentsResponsePatterns on SearchDocumentsResponse {
/// A variant of `map` that fallback to returning `orElse`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _SearchDocumentsResponse value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _SearchDocumentsResponse() when $default != null:
return $default(_that);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// Callbacks receives the raw object, upcasted.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case final Subclass2 value:
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _SearchDocumentsResponse value)  $default,){
final _that = this;
switch (_that) {
case _SearchDocumentsResponse():
return $default(_that);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `map` that fallback to returning `null`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _SearchDocumentsResponse value)?  $default,){
final _that = this;
switch (_that) {
case _SearchDocumentsResponse() when $default != null:
return $default(_that);case _:
  return null;

}
}
/// A variant of `when` that fallback to an `orElse` callback.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function(@JsonKey(name: 'documents')  List<SearchHit> documents)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _SearchDocumentsResponse() when $default != null:
return $default(_that.documents);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// As opposed to `map`, this offers destructuring.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case Subclass2(:final field2):
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function(@JsonKey(name: 'documents')  List<SearchHit> documents)  $default,) {final _that = this;
switch (_that) {
case _SearchDocumentsResponse():
return $default(_that.documents);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `when` that fallback to returning `null`
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function(@JsonKey(name: 'documents')  List<SearchHit> documents)?  $default,) {final _that = this;
switch (_that) {
case _SearchDocumentsResponse() when $default != null:
return $default(_that.documents);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _SearchDocumentsResponse implements SearchDocumentsResponse {
  const _SearchDocumentsResponse({@JsonKey(name: 'documents') required final  List<SearchHit> documents}): _documents = documents;
  factory _SearchDocumentsResponse.fromJson(Map<String, dynamic> json) => _$SearchDocumentsResponseFromJson(json);

 final  List<SearchHit> _documents;
@override@JsonKey(name: 'documents') List<SearchHit> get documents {
  if (_documents is EqualUnmodifiableListView) return _documents;
  // ignore: implicit_dynamic_type
  return EqualUnmodifiableListView(_documents);
}


/// Create a copy of SearchDocumentsResponse
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$SearchDocumentsResponseCopyWith<_SearchDocumentsResponse> get copyWith => __$SearchDocumentsResponseCopyWithImpl<_SearchDocumentsResponse>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$SearchDocumentsResponseToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _SearchDocumentsResponse&&const DeepCollectionEquality().equals(other._documents, _documents));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,const DeepCollectionEquality().hash(_documents));

@override
String toString() {
  return 'SearchDocumentsResponse(documents: $documents)';
}


}

/// @nodoc
abstract mixin class _$SearchDocumentsResponseCopyWith<$Res> implements $SearchDocumentsResponseCopyWith<$Res> {
  factory _$SearchDocumentsResponseCopyWith(_SearchDocumentsResponse value, $Res Function(_SearchDocumentsResponse) _then) = __$SearchDocumentsResponseCopyWithImpl;
@override @useResult
$Res call({
@JsonKey(name: 'documents') List<SearchHit> documents
});




}
/// @nodoc
class __$SearchDocumentsResponseCopyWithImpl<$Res>
    implements _$SearchDocumentsResponseCopyWith<$Res> {
  __$SearchDocumentsResponseCopyWithImpl(this._self, this._then);

  final _SearchDocumentsResponse _self;
  final $Res Function(_SearchDocumentsResponse) _then;

/// Create a copy of SearchDocumentsResponse
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? documents = null,}) {
  return _then(_SearchDocumentsResponse(
documents: null == documents ? _self._documents : documents // ignore: cast_nullable_to_non_nullable
as List<SearchHit>,
  ));
}


}


/// @nodoc
mixin _$SearchHit {

@JsonKey(name: 'public_id') String get publicId;@JsonKey(name: 'created_at') DateTime get createdAt;@JsonKey(name: 'created_by_kind') String get createdByKind;@JsonKey(name: 'tags') List<String> get tags;@JsonKey(name: 'status') String get status;@JsonKey(name: 'visibility') String get visibility;@JsonKey(name: 'score') double get score;@JsonKey(name: 'matched_field') String get matchedField;@JsonKey(name: 'snippet') String get snippet;@JsonKey(name: 'current_ver') int? get currentVer;@JsonKey(name: 'created_by_id') String? get createdById;@JsonKey(name: 'created_by_name') String? get createdByName;@JsonKey(name: 'current_size') int? get currentSize;@JsonKey(name: 'current_source_sha256') String? get currentSourceSha256;@JsonKey(name: 'revoked_at') DateTime? get revokedAt;@JsonKey(name: 'title') String? get title;@JsonKey(name: 'description') String? get description;@JsonKey(name: 'slug') String? get slug;@JsonKey(name: 'superseded_by') String? get supersededBy;
/// Create a copy of SearchHit
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$SearchHitCopyWith<SearchHit> get copyWith => _$SearchHitCopyWithImpl<SearchHit>(this as SearchHit, _$identity);

  /// Serializes this SearchHit to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is SearchHit&&(identical(other.publicId, publicId) || other.publicId == publicId)&&(identical(other.createdAt, createdAt) || other.createdAt == createdAt)&&(identical(other.createdByKind, createdByKind) || other.createdByKind == createdByKind)&&const DeepCollectionEquality().equals(other.tags, tags)&&(identical(other.status, status) || other.status == status)&&(identical(other.visibility, visibility) || other.visibility == visibility)&&(identical(other.score, score) || other.score == score)&&(identical(other.matchedField, matchedField) || other.matchedField == matchedField)&&(identical(other.snippet, snippet) || other.snippet == snippet)&&(identical(other.currentVer, currentVer) || other.currentVer == currentVer)&&(identical(other.createdById, createdById) || other.createdById == createdById)&&(identical(other.createdByName, createdByName) || other.createdByName == createdByName)&&(identical(other.currentSize, currentSize) || other.currentSize == currentSize)&&(identical(other.currentSourceSha256, currentSourceSha256) || other.currentSourceSha256 == currentSourceSha256)&&(identical(other.revokedAt, revokedAt) || other.revokedAt == revokedAt)&&(identical(other.title, title) || other.title == title)&&(identical(other.description, description) || other.description == description)&&(identical(other.slug, slug) || other.slug == slug)&&(identical(other.supersededBy, supersededBy) || other.supersededBy == supersededBy));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hashAll([runtimeType,publicId,createdAt,createdByKind,const DeepCollectionEquality().hash(tags),status,visibility,score,matchedField,snippet,currentVer,createdById,createdByName,currentSize,currentSourceSha256,revokedAt,title,description,slug,supersededBy]);

@override
String toString() {
  return 'SearchHit(publicId: $publicId, createdAt: $createdAt, createdByKind: $createdByKind, tags: $tags, status: $status, visibility: $visibility, score: $score, matchedField: $matchedField, snippet: $snippet, currentVer: $currentVer, createdById: $createdById, createdByName: $createdByName, currentSize: $currentSize, currentSourceSha256: $currentSourceSha256, revokedAt: $revokedAt, title: $title, description: $description, slug: $slug, supersededBy: $supersededBy)';
}


}

/// @nodoc
abstract mixin class $SearchHitCopyWith<$Res>  {
  factory $SearchHitCopyWith(SearchHit value, $Res Function(SearchHit) _then) = _$SearchHitCopyWithImpl;
@useResult
$Res call({
@JsonKey(name: 'public_id') String publicId,@JsonKey(name: 'created_at') DateTime createdAt,@JsonKey(name: 'created_by_kind') String createdByKind,@JsonKey(name: 'tags') List<String> tags,@JsonKey(name: 'status') String status,@JsonKey(name: 'visibility') String visibility,@JsonKey(name: 'score') double score,@JsonKey(name: 'matched_field') String matchedField,@JsonKey(name: 'snippet') String snippet,@JsonKey(name: 'current_ver') int? currentVer,@JsonKey(name: 'created_by_id') String? createdById,@JsonKey(name: 'created_by_name') String? createdByName,@JsonKey(name: 'current_size') int? currentSize,@JsonKey(name: 'current_source_sha256') String? currentSourceSha256,@JsonKey(name: 'revoked_at') DateTime? revokedAt,@JsonKey(name: 'title') String? title,@JsonKey(name: 'description') String? description,@JsonKey(name: 'slug') String? slug,@JsonKey(name: 'superseded_by') String? supersededBy
});




}
/// @nodoc
class _$SearchHitCopyWithImpl<$Res>
    implements $SearchHitCopyWith<$Res> {
  _$SearchHitCopyWithImpl(this._self, this._then);

  final SearchHit _self;
  final $Res Function(SearchHit) _then;

/// Create a copy of SearchHit
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? publicId = null,Object? createdAt = null,Object? createdByKind = null,Object? tags = null,Object? status = null,Object? visibility = null,Object? score = null,Object? matchedField = null,Object? snippet = null,Object? currentVer = freezed,Object? createdById = freezed,Object? createdByName = freezed,Object? currentSize = freezed,Object? currentSourceSha256 = freezed,Object? revokedAt = freezed,Object? title = freezed,Object? description = freezed,Object? slug = freezed,Object? supersededBy = freezed,}) {
  return _then(_self.copyWith(
publicId: null == publicId ? _self.publicId : publicId // ignore: cast_nullable_to_non_nullable
as String,createdAt: null == createdAt ? _self.createdAt : createdAt // ignore: cast_nullable_to_non_nullable
as DateTime,createdByKind: null == createdByKind ? _self.createdByKind : createdByKind // ignore: cast_nullable_to_non_nullable
as String,tags: null == tags ? _self.tags : tags // ignore: cast_nullable_to_non_nullable
as List<String>,status: null == status ? _self.status : status // ignore: cast_nullable_to_non_nullable
as String,visibility: null == visibility ? _self.visibility : visibility // ignore: cast_nullable_to_non_nullable
as String,score: null == score ? _self.score : score // ignore: cast_nullable_to_non_nullable
as double,matchedField: null == matchedField ? _self.matchedField : matchedField // ignore: cast_nullable_to_non_nullable
as String,snippet: null == snippet ? _self.snippet : snippet // ignore: cast_nullable_to_non_nullable
as String,currentVer: freezed == currentVer ? _self.currentVer : currentVer // ignore: cast_nullable_to_non_nullable
as int?,createdById: freezed == createdById ? _self.createdById : createdById // ignore: cast_nullable_to_non_nullable
as String?,createdByName: freezed == createdByName ? _self.createdByName : createdByName // ignore: cast_nullable_to_non_nullable
as String?,currentSize: freezed == currentSize ? _self.currentSize : currentSize // ignore: cast_nullable_to_non_nullable
as int?,currentSourceSha256: freezed == currentSourceSha256 ? _self.currentSourceSha256 : currentSourceSha256 // ignore: cast_nullable_to_non_nullable
as String?,revokedAt: freezed == revokedAt ? _self.revokedAt : revokedAt // ignore: cast_nullable_to_non_nullable
as DateTime?,title: freezed == title ? _self.title : title // ignore: cast_nullable_to_non_nullable
as String?,description: freezed == description ? _self.description : description // ignore: cast_nullable_to_non_nullable
as String?,slug: freezed == slug ? _self.slug : slug // ignore: cast_nullable_to_non_nullable
as String?,supersededBy: freezed == supersededBy ? _self.supersededBy : supersededBy // ignore: cast_nullable_to_non_nullable
as String?,
  ));
}

}


/// Adds pattern-matching-related methods to [SearchHit].
extension SearchHitPatterns on SearchHit {
/// A variant of `map` that fallback to returning `orElse`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _SearchHit value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _SearchHit() when $default != null:
return $default(_that);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// Callbacks receives the raw object, upcasted.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case final Subclass2 value:
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _SearchHit value)  $default,){
final _that = this;
switch (_that) {
case _SearchHit():
return $default(_that);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `map` that fallback to returning `null`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _SearchHit value)?  $default,){
final _that = this;
switch (_that) {
case _SearchHit() when $default != null:
return $default(_that);case _:
  return null;

}
}
/// A variant of `when` that fallback to an `orElse` callback.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function(@JsonKey(name: 'public_id')  String publicId, @JsonKey(name: 'created_at')  DateTime createdAt, @JsonKey(name: 'created_by_kind')  String createdByKind, @JsonKey(name: 'tags')  List<String> tags, @JsonKey(name: 'status')  String status, @JsonKey(name: 'visibility')  String visibility, @JsonKey(name: 'score')  double score, @JsonKey(name: 'matched_field')  String matchedField, @JsonKey(name: 'snippet')  String snippet, @JsonKey(name: 'current_ver')  int? currentVer, @JsonKey(name: 'created_by_id')  String? createdById, @JsonKey(name: 'created_by_name')  String? createdByName, @JsonKey(name: 'current_size')  int? currentSize, @JsonKey(name: 'current_source_sha256')  String? currentSourceSha256, @JsonKey(name: 'revoked_at')  DateTime? revokedAt, @JsonKey(name: 'title')  String? title, @JsonKey(name: 'description')  String? description, @JsonKey(name: 'slug')  String? slug, @JsonKey(name: 'superseded_by')  String? supersededBy)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _SearchHit() when $default != null:
return $default(_that.publicId,_that.createdAt,_that.createdByKind,_that.tags,_that.status,_that.visibility,_that.score,_that.matchedField,_that.snippet,_that.currentVer,_that.createdById,_that.createdByName,_that.currentSize,_that.currentSourceSha256,_that.revokedAt,_that.title,_that.description,_that.slug,_that.supersededBy);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// As opposed to `map`, this offers destructuring.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case Subclass2(:final field2):
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function(@JsonKey(name: 'public_id')  String publicId, @JsonKey(name: 'created_at')  DateTime createdAt, @JsonKey(name: 'created_by_kind')  String createdByKind, @JsonKey(name: 'tags')  List<String> tags, @JsonKey(name: 'status')  String status, @JsonKey(name: 'visibility')  String visibility, @JsonKey(name: 'score')  double score, @JsonKey(name: 'matched_field')  String matchedField, @JsonKey(name: 'snippet')  String snippet, @JsonKey(name: 'current_ver')  int? currentVer, @JsonKey(name: 'created_by_id')  String? createdById, @JsonKey(name: 'created_by_name')  String? createdByName, @JsonKey(name: 'current_size')  int? currentSize, @JsonKey(name: 'current_source_sha256')  String? currentSourceSha256, @JsonKey(name: 'revoked_at')  DateTime? revokedAt, @JsonKey(name: 'title')  String? title, @JsonKey(name: 'description')  String? description, @JsonKey(name: 'slug')  String? slug, @JsonKey(name: 'superseded_by')  String? supersededBy)  $default,) {final _that = this;
switch (_that) {
case _SearchHit():
return $default(_that.publicId,_that.createdAt,_that.createdByKind,_that.tags,_that.status,_that.visibility,_that.score,_that.matchedField,_that.snippet,_that.currentVer,_that.createdById,_that.createdByName,_that.currentSize,_that.currentSourceSha256,_that.revokedAt,_that.title,_that.description,_that.slug,_that.supersededBy);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `when` that fallback to returning `null`
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function(@JsonKey(name: 'public_id')  String publicId, @JsonKey(name: 'created_at')  DateTime createdAt, @JsonKey(name: 'created_by_kind')  String createdByKind, @JsonKey(name: 'tags')  List<String> tags, @JsonKey(name: 'status')  String status, @JsonKey(name: 'visibility')  String visibility, @JsonKey(name: 'score')  double score, @JsonKey(name: 'matched_field')  String matchedField, @JsonKey(name: 'snippet')  String snippet, @JsonKey(name: 'current_ver')  int? currentVer, @JsonKey(name: 'created_by_id')  String? createdById, @JsonKey(name: 'created_by_name')  String? createdByName, @JsonKey(name: 'current_size')  int? currentSize, @JsonKey(name: 'current_source_sha256')  String? currentSourceSha256, @JsonKey(name: 'revoked_at')  DateTime? revokedAt, @JsonKey(name: 'title')  String? title, @JsonKey(name: 'description')  String? description, @JsonKey(name: 'slug')  String? slug, @JsonKey(name: 'superseded_by')  String? supersededBy)?  $default,) {final _that = this;
switch (_that) {
case _SearchHit() when $default != null:
return $default(_that.publicId,_that.createdAt,_that.createdByKind,_that.tags,_that.status,_that.visibility,_that.score,_that.matchedField,_that.snippet,_that.currentVer,_that.createdById,_that.createdByName,_that.currentSize,_that.currentSourceSha256,_that.revokedAt,_that.title,_that.description,_that.slug,_that.supersededBy);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _SearchHit extends SearchHit {
  const _SearchHit({@JsonKey(name: 'public_id') required this.publicId, @JsonKey(name: 'created_at') required this.createdAt, @JsonKey(name: 'created_by_kind') required this.createdByKind, @JsonKey(name: 'tags') required final  List<String> tags, @JsonKey(name: 'status') required this.status, @JsonKey(name: 'visibility') required this.visibility, @JsonKey(name: 'score') required this.score, @JsonKey(name: 'matched_field') required this.matchedField, @JsonKey(name: 'snippet') required this.snippet, @JsonKey(name: 'current_ver') this.currentVer, @JsonKey(name: 'created_by_id') this.createdById, @JsonKey(name: 'created_by_name') this.createdByName, @JsonKey(name: 'current_size') this.currentSize, @JsonKey(name: 'current_source_sha256') this.currentSourceSha256, @JsonKey(name: 'revoked_at') this.revokedAt, @JsonKey(name: 'title') this.title, @JsonKey(name: 'description') this.description, @JsonKey(name: 'slug') this.slug, @JsonKey(name: 'superseded_by') this.supersededBy}): _tags = tags,super._();
  factory _SearchHit.fromJson(Map<String, dynamic> json) => _$SearchHitFromJson(json);

@override@JsonKey(name: 'public_id') final  String publicId;
@override@JsonKey(name: 'created_at') final  DateTime createdAt;
@override@JsonKey(name: 'created_by_kind') final  String createdByKind;
 final  List<String> _tags;
@override@JsonKey(name: 'tags') List<String> get tags {
  if (_tags is EqualUnmodifiableListView) return _tags;
  // ignore: implicit_dynamic_type
  return EqualUnmodifiableListView(_tags);
}

@override@JsonKey(name: 'status') final  String status;
@override@JsonKey(name: 'visibility') final  String visibility;
@override@JsonKey(name: 'score') final  double score;
@override@JsonKey(name: 'matched_field') final  String matchedField;
@override@JsonKey(name: 'snippet') final  String snippet;
@override@JsonKey(name: 'current_ver') final  int? currentVer;
@override@JsonKey(name: 'created_by_id') final  String? createdById;
@override@JsonKey(name: 'created_by_name') final  String? createdByName;
@override@JsonKey(name: 'current_size') final  int? currentSize;
@override@JsonKey(name: 'current_source_sha256') final  String? currentSourceSha256;
@override@JsonKey(name: 'revoked_at') final  DateTime? revokedAt;
@override@JsonKey(name: 'title') final  String? title;
@override@JsonKey(name: 'description') final  String? description;
@override@JsonKey(name: 'slug') final  String? slug;
@override@JsonKey(name: 'superseded_by') final  String? supersededBy;

/// Create a copy of SearchHit
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$SearchHitCopyWith<_SearchHit> get copyWith => __$SearchHitCopyWithImpl<_SearchHit>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$SearchHitToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _SearchHit&&(identical(other.publicId, publicId) || other.publicId == publicId)&&(identical(other.createdAt, createdAt) || other.createdAt == createdAt)&&(identical(other.createdByKind, createdByKind) || other.createdByKind == createdByKind)&&const DeepCollectionEquality().equals(other._tags, _tags)&&(identical(other.status, status) || other.status == status)&&(identical(other.visibility, visibility) || other.visibility == visibility)&&(identical(other.score, score) || other.score == score)&&(identical(other.matchedField, matchedField) || other.matchedField == matchedField)&&(identical(other.snippet, snippet) || other.snippet == snippet)&&(identical(other.currentVer, currentVer) || other.currentVer == currentVer)&&(identical(other.createdById, createdById) || other.createdById == createdById)&&(identical(other.createdByName, createdByName) || other.createdByName == createdByName)&&(identical(other.currentSize, currentSize) || other.currentSize == currentSize)&&(identical(other.currentSourceSha256, currentSourceSha256) || other.currentSourceSha256 == currentSourceSha256)&&(identical(other.revokedAt, revokedAt) || other.revokedAt == revokedAt)&&(identical(other.title, title) || other.title == title)&&(identical(other.description, description) || other.description == description)&&(identical(other.slug, slug) || other.slug == slug)&&(identical(other.supersededBy, supersededBy) || other.supersededBy == supersededBy));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hashAll([runtimeType,publicId,createdAt,createdByKind,const DeepCollectionEquality().hash(_tags),status,visibility,score,matchedField,snippet,currentVer,createdById,createdByName,currentSize,currentSourceSha256,revokedAt,title,description,slug,supersededBy]);

@override
String toString() {
  return 'SearchHit(publicId: $publicId, createdAt: $createdAt, createdByKind: $createdByKind, tags: $tags, status: $status, visibility: $visibility, score: $score, matchedField: $matchedField, snippet: $snippet, currentVer: $currentVer, createdById: $createdById, createdByName: $createdByName, currentSize: $currentSize, currentSourceSha256: $currentSourceSha256, revokedAt: $revokedAt, title: $title, description: $description, slug: $slug, supersededBy: $supersededBy)';
}


}

/// @nodoc
abstract mixin class _$SearchHitCopyWith<$Res> implements $SearchHitCopyWith<$Res> {
  factory _$SearchHitCopyWith(_SearchHit value, $Res Function(_SearchHit) _then) = __$SearchHitCopyWithImpl;
@override @useResult
$Res call({
@JsonKey(name: 'public_id') String publicId,@JsonKey(name: 'created_at') DateTime createdAt,@JsonKey(name: 'created_by_kind') String createdByKind,@JsonKey(name: 'tags') List<String> tags,@JsonKey(name: 'status') String status,@JsonKey(name: 'visibility') String visibility,@JsonKey(name: 'score') double score,@JsonKey(name: 'matched_field') String matchedField,@JsonKey(name: 'snippet') String snippet,@JsonKey(name: 'current_ver') int? currentVer,@JsonKey(name: 'created_by_id') String? createdById,@JsonKey(name: 'created_by_name') String? createdByName,@JsonKey(name: 'current_size') int? currentSize,@JsonKey(name: 'current_source_sha256') String? currentSourceSha256,@JsonKey(name: 'revoked_at') DateTime? revokedAt,@JsonKey(name: 'title') String? title,@JsonKey(name: 'description') String? description,@JsonKey(name: 'slug') String? slug,@JsonKey(name: 'superseded_by') String? supersededBy
});




}
/// @nodoc
class __$SearchHitCopyWithImpl<$Res>
    implements _$SearchHitCopyWith<$Res> {
  __$SearchHitCopyWithImpl(this._self, this._then);

  final _SearchHit _self;
  final $Res Function(_SearchHit) _then;

/// Create a copy of SearchHit
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? publicId = null,Object? createdAt = null,Object? createdByKind = null,Object? tags = null,Object? status = null,Object? visibility = null,Object? score = null,Object? matchedField = null,Object? snippet = null,Object? currentVer = freezed,Object? createdById = freezed,Object? createdByName = freezed,Object? currentSize = freezed,Object? currentSourceSha256 = freezed,Object? revokedAt = freezed,Object? title = freezed,Object? description = freezed,Object? slug = freezed,Object? supersededBy = freezed,}) {
  return _then(_SearchHit(
publicId: null == publicId ? _self.publicId : publicId // ignore: cast_nullable_to_non_nullable
as String,createdAt: null == createdAt ? _self.createdAt : createdAt // ignore: cast_nullable_to_non_nullable
as DateTime,createdByKind: null == createdByKind ? _self.createdByKind : createdByKind // ignore: cast_nullable_to_non_nullable
as String,tags: null == tags ? _self._tags : tags // ignore: cast_nullable_to_non_nullable
as List<String>,status: null == status ? _self.status : status // ignore: cast_nullable_to_non_nullable
as String,visibility: null == visibility ? _self.visibility : visibility // ignore: cast_nullable_to_non_nullable
as String,score: null == score ? _self.score : score // ignore: cast_nullable_to_non_nullable
as double,matchedField: null == matchedField ? _self.matchedField : matchedField // ignore: cast_nullable_to_non_nullable
as String,snippet: null == snippet ? _self.snippet : snippet // ignore: cast_nullable_to_non_nullable
as String,currentVer: freezed == currentVer ? _self.currentVer : currentVer // ignore: cast_nullable_to_non_nullable
as int?,createdById: freezed == createdById ? _self.createdById : createdById // ignore: cast_nullable_to_non_nullable
as String?,createdByName: freezed == createdByName ? _self.createdByName : createdByName // ignore: cast_nullable_to_non_nullable
as String?,currentSize: freezed == currentSize ? _self.currentSize : currentSize // ignore: cast_nullable_to_non_nullable
as int?,currentSourceSha256: freezed == currentSourceSha256 ? _self.currentSourceSha256 : currentSourceSha256 // ignore: cast_nullable_to_non_nullable
as String?,revokedAt: freezed == revokedAt ? _self.revokedAt : revokedAt // ignore: cast_nullable_to_non_nullable
as DateTime?,title: freezed == title ? _self.title : title // ignore: cast_nullable_to_non_nullable
as String?,description: freezed == description ? _self.description : description // ignore: cast_nullable_to_non_nullable
as String?,slug: freezed == slug ? _self.slug : slug // ignore: cast_nullable_to_non_nullable
as String?,supersededBy: freezed == supersededBy ? _self.supersededBy : supersededBy // ignore: cast_nullable_to_non_nullable
as String?,
  ));
}


}


/// @nodoc
mixin _$SetDocumentSlugResponse {

@JsonKey(name: 'public_id') String get publicId;@JsonKey(name: 'redirected') bool get redirected;@JsonKey(name: 'slug') String? get slug;@JsonKey(name: 'retired') String? get retired;
/// Create a copy of SetDocumentSlugResponse
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$SetDocumentSlugResponseCopyWith<SetDocumentSlugResponse> get copyWith => _$SetDocumentSlugResponseCopyWithImpl<SetDocumentSlugResponse>(this as SetDocumentSlugResponse, _$identity);

  /// Serializes this SetDocumentSlugResponse to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is SetDocumentSlugResponse&&(identical(other.publicId, publicId) || other.publicId == publicId)&&(identical(other.redirected, redirected) || other.redirected == redirected)&&(identical(other.slug, slug) || other.slug == slug)&&(identical(other.retired, retired) || other.retired == retired));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,publicId,redirected,slug,retired);

@override
String toString() {
  return 'SetDocumentSlugResponse(publicId: $publicId, redirected: $redirected, slug: $slug, retired: $retired)';
}


}

/// @nodoc
abstract mixin class $SetDocumentSlugResponseCopyWith<$Res>  {
  factory $SetDocumentSlugResponseCopyWith(SetDocumentSlugResponse value, $Res Function(SetDocumentSlugResponse) _then) = _$SetDocumentSlugResponseCopyWithImpl;
@useResult
$Res call({
@JsonKey(name: 'public_id') String publicId,@JsonKey(name: 'redirected') bool redirected,@JsonKey(name: 'slug') String? slug,@JsonKey(name: 'retired') String? retired
});




}
/// @nodoc
class _$SetDocumentSlugResponseCopyWithImpl<$Res>
    implements $SetDocumentSlugResponseCopyWith<$Res> {
  _$SetDocumentSlugResponseCopyWithImpl(this._self, this._then);

  final SetDocumentSlugResponse _self;
  final $Res Function(SetDocumentSlugResponse) _then;

/// Create a copy of SetDocumentSlugResponse
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? publicId = null,Object? redirected = null,Object? slug = freezed,Object? retired = freezed,}) {
  return _then(_self.copyWith(
publicId: null == publicId ? _self.publicId : publicId // ignore: cast_nullable_to_non_nullable
as String,redirected: null == redirected ? _self.redirected : redirected // ignore: cast_nullable_to_non_nullable
as bool,slug: freezed == slug ? _self.slug : slug // ignore: cast_nullable_to_non_nullable
as String?,retired: freezed == retired ? _self.retired : retired // ignore: cast_nullable_to_non_nullable
as String?,
  ));
}

}


/// Adds pattern-matching-related methods to [SetDocumentSlugResponse].
extension SetDocumentSlugResponsePatterns on SetDocumentSlugResponse {
/// A variant of `map` that fallback to returning `orElse`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _SetDocumentSlugResponse value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _SetDocumentSlugResponse() when $default != null:
return $default(_that);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// Callbacks receives the raw object, upcasted.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case final Subclass2 value:
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _SetDocumentSlugResponse value)  $default,){
final _that = this;
switch (_that) {
case _SetDocumentSlugResponse():
return $default(_that);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `map` that fallback to returning `null`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _SetDocumentSlugResponse value)?  $default,){
final _that = this;
switch (_that) {
case _SetDocumentSlugResponse() when $default != null:
return $default(_that);case _:
  return null;

}
}
/// A variant of `when` that fallback to an `orElse` callback.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function(@JsonKey(name: 'public_id')  String publicId, @JsonKey(name: 'redirected')  bool redirected, @JsonKey(name: 'slug')  String? slug, @JsonKey(name: 'retired')  String? retired)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _SetDocumentSlugResponse() when $default != null:
return $default(_that.publicId,_that.redirected,_that.slug,_that.retired);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// As opposed to `map`, this offers destructuring.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case Subclass2(:final field2):
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function(@JsonKey(name: 'public_id')  String publicId, @JsonKey(name: 'redirected')  bool redirected, @JsonKey(name: 'slug')  String? slug, @JsonKey(name: 'retired')  String? retired)  $default,) {final _that = this;
switch (_that) {
case _SetDocumentSlugResponse():
return $default(_that.publicId,_that.redirected,_that.slug,_that.retired);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `when` that fallback to returning `null`
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function(@JsonKey(name: 'public_id')  String publicId, @JsonKey(name: 'redirected')  bool redirected, @JsonKey(name: 'slug')  String? slug, @JsonKey(name: 'retired')  String? retired)?  $default,) {final _that = this;
switch (_that) {
case _SetDocumentSlugResponse() when $default != null:
return $default(_that.publicId,_that.redirected,_that.slug,_that.retired);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _SetDocumentSlugResponse implements SetDocumentSlugResponse {
  const _SetDocumentSlugResponse({@JsonKey(name: 'public_id') required this.publicId, @JsonKey(name: 'redirected') required this.redirected, @JsonKey(name: 'slug') this.slug, @JsonKey(name: 'retired') this.retired});
  factory _SetDocumentSlugResponse.fromJson(Map<String, dynamic> json) => _$SetDocumentSlugResponseFromJson(json);

@override@JsonKey(name: 'public_id') final  String publicId;
@override@JsonKey(name: 'redirected') final  bool redirected;
@override@JsonKey(name: 'slug') final  String? slug;
@override@JsonKey(name: 'retired') final  String? retired;

/// Create a copy of SetDocumentSlugResponse
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$SetDocumentSlugResponseCopyWith<_SetDocumentSlugResponse> get copyWith => __$SetDocumentSlugResponseCopyWithImpl<_SetDocumentSlugResponse>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$SetDocumentSlugResponseToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _SetDocumentSlugResponse&&(identical(other.publicId, publicId) || other.publicId == publicId)&&(identical(other.redirected, redirected) || other.redirected == redirected)&&(identical(other.slug, slug) || other.slug == slug)&&(identical(other.retired, retired) || other.retired == retired));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,publicId,redirected,slug,retired);

@override
String toString() {
  return 'SetDocumentSlugResponse(publicId: $publicId, redirected: $redirected, slug: $slug, retired: $retired)';
}


}

/// @nodoc
abstract mixin class _$SetDocumentSlugResponseCopyWith<$Res> implements $SetDocumentSlugResponseCopyWith<$Res> {
  factory _$SetDocumentSlugResponseCopyWith(_SetDocumentSlugResponse value, $Res Function(_SetDocumentSlugResponse) _then) = __$SetDocumentSlugResponseCopyWithImpl;
@override @useResult
$Res call({
@JsonKey(name: 'public_id') String publicId,@JsonKey(name: 'redirected') bool redirected,@JsonKey(name: 'slug') String? slug,@JsonKey(name: 'retired') String? retired
});




}
/// @nodoc
class __$SetDocumentSlugResponseCopyWithImpl<$Res>
    implements _$SetDocumentSlugResponseCopyWith<$Res> {
  __$SetDocumentSlugResponseCopyWithImpl(this._self, this._then);

  final _SetDocumentSlugResponse _self;
  final $Res Function(_SetDocumentSlugResponse) _then;

/// Create a copy of SetDocumentSlugResponse
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? publicId = null,Object? redirected = null,Object? slug = freezed,Object? retired = freezed,}) {
  return _then(_SetDocumentSlugResponse(
publicId: null == publicId ? _self.publicId : publicId // ignore: cast_nullable_to_non_nullable
as String,redirected: null == redirected ? _self.redirected : redirected // ignore: cast_nullable_to_non_nullable
as bool,slug: freezed == slug ? _self.slug : slug // ignore: cast_nullable_to_non_nullable
as String?,retired: freezed == retired ? _self.retired : retired // ignore: cast_nullable_to_non_nullable
as String?,
  ));
}


}


/// @nodoc
mixin _$SetDocumentStatusResponse {

@JsonKey(name: 'public_id') String get publicId;@JsonKey(name: 'status') String get status;@JsonKey(name: 'superseded_by') String? get supersededBy;
/// Create a copy of SetDocumentStatusResponse
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$SetDocumentStatusResponseCopyWith<SetDocumentStatusResponse> get copyWith => _$SetDocumentStatusResponseCopyWithImpl<SetDocumentStatusResponse>(this as SetDocumentStatusResponse, _$identity);

  /// Serializes this SetDocumentStatusResponse to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is SetDocumentStatusResponse&&(identical(other.publicId, publicId) || other.publicId == publicId)&&(identical(other.status, status) || other.status == status)&&(identical(other.supersededBy, supersededBy) || other.supersededBy == supersededBy));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,publicId,status,supersededBy);

@override
String toString() {
  return 'SetDocumentStatusResponse(publicId: $publicId, status: $status, supersededBy: $supersededBy)';
}


}

/// @nodoc
abstract mixin class $SetDocumentStatusResponseCopyWith<$Res>  {
  factory $SetDocumentStatusResponseCopyWith(SetDocumentStatusResponse value, $Res Function(SetDocumentStatusResponse) _then) = _$SetDocumentStatusResponseCopyWithImpl;
@useResult
$Res call({
@JsonKey(name: 'public_id') String publicId,@JsonKey(name: 'status') String status,@JsonKey(name: 'superseded_by') String? supersededBy
});




}
/// @nodoc
class _$SetDocumentStatusResponseCopyWithImpl<$Res>
    implements $SetDocumentStatusResponseCopyWith<$Res> {
  _$SetDocumentStatusResponseCopyWithImpl(this._self, this._then);

  final SetDocumentStatusResponse _self;
  final $Res Function(SetDocumentStatusResponse) _then;

/// Create a copy of SetDocumentStatusResponse
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? publicId = null,Object? status = null,Object? supersededBy = freezed,}) {
  return _then(_self.copyWith(
publicId: null == publicId ? _self.publicId : publicId // ignore: cast_nullable_to_non_nullable
as String,status: null == status ? _self.status : status // ignore: cast_nullable_to_non_nullable
as String,supersededBy: freezed == supersededBy ? _self.supersededBy : supersededBy // ignore: cast_nullable_to_non_nullable
as String?,
  ));
}

}


/// Adds pattern-matching-related methods to [SetDocumentStatusResponse].
extension SetDocumentStatusResponsePatterns on SetDocumentStatusResponse {
/// A variant of `map` that fallback to returning `orElse`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _SetDocumentStatusResponse value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _SetDocumentStatusResponse() when $default != null:
return $default(_that);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// Callbacks receives the raw object, upcasted.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case final Subclass2 value:
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _SetDocumentStatusResponse value)  $default,){
final _that = this;
switch (_that) {
case _SetDocumentStatusResponse():
return $default(_that);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `map` that fallback to returning `null`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _SetDocumentStatusResponse value)?  $default,){
final _that = this;
switch (_that) {
case _SetDocumentStatusResponse() when $default != null:
return $default(_that);case _:
  return null;

}
}
/// A variant of `when` that fallback to an `orElse` callback.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function(@JsonKey(name: 'public_id')  String publicId, @JsonKey(name: 'status')  String status, @JsonKey(name: 'superseded_by')  String? supersededBy)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _SetDocumentStatusResponse() when $default != null:
return $default(_that.publicId,_that.status,_that.supersededBy);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// As opposed to `map`, this offers destructuring.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case Subclass2(:final field2):
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function(@JsonKey(name: 'public_id')  String publicId, @JsonKey(name: 'status')  String status, @JsonKey(name: 'superseded_by')  String? supersededBy)  $default,) {final _that = this;
switch (_that) {
case _SetDocumentStatusResponse():
return $default(_that.publicId,_that.status,_that.supersededBy);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `when` that fallback to returning `null`
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function(@JsonKey(name: 'public_id')  String publicId, @JsonKey(name: 'status')  String status, @JsonKey(name: 'superseded_by')  String? supersededBy)?  $default,) {final _that = this;
switch (_that) {
case _SetDocumentStatusResponse() when $default != null:
return $default(_that.publicId,_that.status,_that.supersededBy);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _SetDocumentStatusResponse implements SetDocumentStatusResponse {
  const _SetDocumentStatusResponse({@JsonKey(name: 'public_id') required this.publicId, @JsonKey(name: 'status') required this.status, @JsonKey(name: 'superseded_by') this.supersededBy});
  factory _SetDocumentStatusResponse.fromJson(Map<String, dynamic> json) => _$SetDocumentStatusResponseFromJson(json);

@override@JsonKey(name: 'public_id') final  String publicId;
@override@JsonKey(name: 'status') final  String status;
@override@JsonKey(name: 'superseded_by') final  String? supersededBy;

/// Create a copy of SetDocumentStatusResponse
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$SetDocumentStatusResponseCopyWith<_SetDocumentStatusResponse> get copyWith => __$SetDocumentStatusResponseCopyWithImpl<_SetDocumentStatusResponse>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$SetDocumentStatusResponseToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _SetDocumentStatusResponse&&(identical(other.publicId, publicId) || other.publicId == publicId)&&(identical(other.status, status) || other.status == status)&&(identical(other.supersededBy, supersededBy) || other.supersededBy == supersededBy));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,publicId,status,supersededBy);

@override
String toString() {
  return 'SetDocumentStatusResponse(publicId: $publicId, status: $status, supersededBy: $supersededBy)';
}


}

/// @nodoc
abstract mixin class _$SetDocumentStatusResponseCopyWith<$Res> implements $SetDocumentStatusResponseCopyWith<$Res> {
  factory _$SetDocumentStatusResponseCopyWith(_SetDocumentStatusResponse value, $Res Function(_SetDocumentStatusResponse) _then) = __$SetDocumentStatusResponseCopyWithImpl;
@override @useResult
$Res call({
@JsonKey(name: 'public_id') String publicId,@JsonKey(name: 'status') String status,@JsonKey(name: 'superseded_by') String? supersededBy
});




}
/// @nodoc
class __$SetDocumentStatusResponseCopyWithImpl<$Res>
    implements _$SetDocumentStatusResponseCopyWith<$Res> {
  __$SetDocumentStatusResponseCopyWithImpl(this._self, this._then);

  final _SetDocumentStatusResponse _self;
  final $Res Function(_SetDocumentStatusResponse) _then;

/// Create a copy of SetDocumentStatusResponse
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? publicId = null,Object? status = null,Object? supersededBy = freezed,}) {
  return _then(_SetDocumentStatusResponse(
publicId: null == publicId ? _self.publicId : publicId // ignore: cast_nullable_to_non_nullable
as String,status: null == status ? _self.status : status // ignore: cast_nullable_to_non_nullable
as String,supersededBy: freezed == supersededBy ? _self.supersededBy : supersededBy // ignore: cast_nullable_to_non_nullable
as String?,
  ));
}


}


/// @nodoc
mixin _$SetDocumentTagsResponse {

@JsonKey(name: 'public_id') String get publicId;@JsonKey(name: 'tags') List<String> get tags;
/// Create a copy of SetDocumentTagsResponse
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$SetDocumentTagsResponseCopyWith<SetDocumentTagsResponse> get copyWith => _$SetDocumentTagsResponseCopyWithImpl<SetDocumentTagsResponse>(this as SetDocumentTagsResponse, _$identity);

  /// Serializes this SetDocumentTagsResponse to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is SetDocumentTagsResponse&&(identical(other.publicId, publicId) || other.publicId == publicId)&&const DeepCollectionEquality().equals(other.tags, tags));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,publicId,const DeepCollectionEquality().hash(tags));

@override
String toString() {
  return 'SetDocumentTagsResponse(publicId: $publicId, tags: $tags)';
}


}

/// @nodoc
abstract mixin class $SetDocumentTagsResponseCopyWith<$Res>  {
  factory $SetDocumentTagsResponseCopyWith(SetDocumentTagsResponse value, $Res Function(SetDocumentTagsResponse) _then) = _$SetDocumentTagsResponseCopyWithImpl;
@useResult
$Res call({
@JsonKey(name: 'public_id') String publicId,@JsonKey(name: 'tags') List<String> tags
});




}
/// @nodoc
class _$SetDocumentTagsResponseCopyWithImpl<$Res>
    implements $SetDocumentTagsResponseCopyWith<$Res> {
  _$SetDocumentTagsResponseCopyWithImpl(this._self, this._then);

  final SetDocumentTagsResponse _self;
  final $Res Function(SetDocumentTagsResponse) _then;

/// Create a copy of SetDocumentTagsResponse
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? publicId = null,Object? tags = null,}) {
  return _then(_self.copyWith(
publicId: null == publicId ? _self.publicId : publicId // ignore: cast_nullable_to_non_nullable
as String,tags: null == tags ? _self.tags : tags // ignore: cast_nullable_to_non_nullable
as List<String>,
  ));
}

}


/// Adds pattern-matching-related methods to [SetDocumentTagsResponse].
extension SetDocumentTagsResponsePatterns on SetDocumentTagsResponse {
/// A variant of `map` that fallback to returning `orElse`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _SetDocumentTagsResponse value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _SetDocumentTagsResponse() when $default != null:
return $default(_that);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// Callbacks receives the raw object, upcasted.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case final Subclass2 value:
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _SetDocumentTagsResponse value)  $default,){
final _that = this;
switch (_that) {
case _SetDocumentTagsResponse():
return $default(_that);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `map` that fallback to returning `null`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _SetDocumentTagsResponse value)?  $default,){
final _that = this;
switch (_that) {
case _SetDocumentTagsResponse() when $default != null:
return $default(_that);case _:
  return null;

}
}
/// A variant of `when` that fallback to an `orElse` callback.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function(@JsonKey(name: 'public_id')  String publicId, @JsonKey(name: 'tags')  List<String> tags)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _SetDocumentTagsResponse() when $default != null:
return $default(_that.publicId,_that.tags);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// As opposed to `map`, this offers destructuring.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case Subclass2(:final field2):
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function(@JsonKey(name: 'public_id')  String publicId, @JsonKey(name: 'tags')  List<String> tags)  $default,) {final _that = this;
switch (_that) {
case _SetDocumentTagsResponse():
return $default(_that.publicId,_that.tags);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `when` that fallback to returning `null`
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function(@JsonKey(name: 'public_id')  String publicId, @JsonKey(name: 'tags')  List<String> tags)?  $default,) {final _that = this;
switch (_that) {
case _SetDocumentTagsResponse() when $default != null:
return $default(_that.publicId,_that.tags);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _SetDocumentTagsResponse implements SetDocumentTagsResponse {
  const _SetDocumentTagsResponse({@JsonKey(name: 'public_id') required this.publicId, @JsonKey(name: 'tags') required final  List<String> tags}): _tags = tags;
  factory _SetDocumentTagsResponse.fromJson(Map<String, dynamic> json) => _$SetDocumentTagsResponseFromJson(json);

@override@JsonKey(name: 'public_id') final  String publicId;
 final  List<String> _tags;
@override@JsonKey(name: 'tags') List<String> get tags {
  if (_tags is EqualUnmodifiableListView) return _tags;
  // ignore: implicit_dynamic_type
  return EqualUnmodifiableListView(_tags);
}


/// Create a copy of SetDocumentTagsResponse
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$SetDocumentTagsResponseCopyWith<_SetDocumentTagsResponse> get copyWith => __$SetDocumentTagsResponseCopyWithImpl<_SetDocumentTagsResponse>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$SetDocumentTagsResponseToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _SetDocumentTagsResponse&&(identical(other.publicId, publicId) || other.publicId == publicId)&&const DeepCollectionEquality().equals(other._tags, _tags));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,publicId,const DeepCollectionEquality().hash(_tags));

@override
String toString() {
  return 'SetDocumentTagsResponse(publicId: $publicId, tags: $tags)';
}


}

/// @nodoc
abstract mixin class _$SetDocumentTagsResponseCopyWith<$Res> implements $SetDocumentTagsResponseCopyWith<$Res> {
  factory _$SetDocumentTagsResponseCopyWith(_SetDocumentTagsResponse value, $Res Function(_SetDocumentTagsResponse) _then) = __$SetDocumentTagsResponseCopyWithImpl;
@override @useResult
$Res call({
@JsonKey(name: 'public_id') String publicId,@JsonKey(name: 'tags') List<String> tags
});




}
/// @nodoc
class __$SetDocumentTagsResponseCopyWithImpl<$Res>
    implements _$SetDocumentTagsResponseCopyWith<$Res> {
  __$SetDocumentTagsResponseCopyWithImpl(this._self, this._then);

  final _SetDocumentTagsResponse _self;
  final $Res Function(_SetDocumentTagsResponse) _then;

/// Create a copy of SetDocumentTagsResponse
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? publicId = null,Object? tags = null,}) {
  return _then(_SetDocumentTagsResponse(
publicId: null == publicId ? _self.publicId : publicId // ignore: cast_nullable_to_non_nullable
as String,tags: null == tags ? _self._tags : tags // ignore: cast_nullable_to_non_nullable
as List<String>,
  ));
}


}


/// @nodoc
mixin _$SetDocumentVisibilityResponse {

@JsonKey(name: 'public_id') String get publicId;@JsonKey(name: 'visibility') String get visibility;
/// Create a copy of SetDocumentVisibilityResponse
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$SetDocumentVisibilityResponseCopyWith<SetDocumentVisibilityResponse> get copyWith => _$SetDocumentVisibilityResponseCopyWithImpl<SetDocumentVisibilityResponse>(this as SetDocumentVisibilityResponse, _$identity);

  /// Serializes this SetDocumentVisibilityResponse to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is SetDocumentVisibilityResponse&&(identical(other.publicId, publicId) || other.publicId == publicId)&&(identical(other.visibility, visibility) || other.visibility == visibility));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,publicId,visibility);

@override
String toString() {
  return 'SetDocumentVisibilityResponse(publicId: $publicId, visibility: $visibility)';
}


}

/// @nodoc
abstract mixin class $SetDocumentVisibilityResponseCopyWith<$Res>  {
  factory $SetDocumentVisibilityResponseCopyWith(SetDocumentVisibilityResponse value, $Res Function(SetDocumentVisibilityResponse) _then) = _$SetDocumentVisibilityResponseCopyWithImpl;
@useResult
$Res call({
@JsonKey(name: 'public_id') String publicId,@JsonKey(name: 'visibility') String visibility
});




}
/// @nodoc
class _$SetDocumentVisibilityResponseCopyWithImpl<$Res>
    implements $SetDocumentVisibilityResponseCopyWith<$Res> {
  _$SetDocumentVisibilityResponseCopyWithImpl(this._self, this._then);

  final SetDocumentVisibilityResponse _self;
  final $Res Function(SetDocumentVisibilityResponse) _then;

/// Create a copy of SetDocumentVisibilityResponse
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? publicId = null,Object? visibility = null,}) {
  return _then(_self.copyWith(
publicId: null == publicId ? _self.publicId : publicId // ignore: cast_nullable_to_non_nullable
as String,visibility: null == visibility ? _self.visibility : visibility // ignore: cast_nullable_to_non_nullable
as String,
  ));
}

}


/// Adds pattern-matching-related methods to [SetDocumentVisibilityResponse].
extension SetDocumentVisibilityResponsePatterns on SetDocumentVisibilityResponse {
/// A variant of `map` that fallback to returning `orElse`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _SetDocumentVisibilityResponse value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _SetDocumentVisibilityResponse() when $default != null:
return $default(_that);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// Callbacks receives the raw object, upcasted.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case final Subclass2 value:
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _SetDocumentVisibilityResponse value)  $default,){
final _that = this;
switch (_that) {
case _SetDocumentVisibilityResponse():
return $default(_that);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `map` that fallback to returning `null`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _SetDocumentVisibilityResponse value)?  $default,){
final _that = this;
switch (_that) {
case _SetDocumentVisibilityResponse() when $default != null:
return $default(_that);case _:
  return null;

}
}
/// A variant of `when` that fallback to an `orElse` callback.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function(@JsonKey(name: 'public_id')  String publicId, @JsonKey(name: 'visibility')  String visibility)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _SetDocumentVisibilityResponse() when $default != null:
return $default(_that.publicId,_that.visibility);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// As opposed to `map`, this offers destructuring.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case Subclass2(:final field2):
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function(@JsonKey(name: 'public_id')  String publicId, @JsonKey(name: 'visibility')  String visibility)  $default,) {final _that = this;
switch (_that) {
case _SetDocumentVisibilityResponse():
return $default(_that.publicId,_that.visibility);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `when` that fallback to returning `null`
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function(@JsonKey(name: 'public_id')  String publicId, @JsonKey(name: 'visibility')  String visibility)?  $default,) {final _that = this;
switch (_that) {
case _SetDocumentVisibilityResponse() when $default != null:
return $default(_that.publicId,_that.visibility);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _SetDocumentVisibilityResponse implements SetDocumentVisibilityResponse {
  const _SetDocumentVisibilityResponse({@JsonKey(name: 'public_id') required this.publicId, @JsonKey(name: 'visibility') required this.visibility});
  factory _SetDocumentVisibilityResponse.fromJson(Map<String, dynamic> json) => _$SetDocumentVisibilityResponseFromJson(json);

@override@JsonKey(name: 'public_id') final  String publicId;
@override@JsonKey(name: 'visibility') final  String visibility;

/// Create a copy of SetDocumentVisibilityResponse
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$SetDocumentVisibilityResponseCopyWith<_SetDocumentVisibilityResponse> get copyWith => __$SetDocumentVisibilityResponseCopyWithImpl<_SetDocumentVisibilityResponse>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$SetDocumentVisibilityResponseToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _SetDocumentVisibilityResponse&&(identical(other.publicId, publicId) || other.publicId == publicId)&&(identical(other.visibility, visibility) || other.visibility == visibility));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,publicId,visibility);

@override
String toString() {
  return 'SetDocumentVisibilityResponse(publicId: $publicId, visibility: $visibility)';
}


}

/// @nodoc
abstract mixin class _$SetDocumentVisibilityResponseCopyWith<$Res> implements $SetDocumentVisibilityResponseCopyWith<$Res> {
  factory _$SetDocumentVisibilityResponseCopyWith(_SetDocumentVisibilityResponse value, $Res Function(_SetDocumentVisibilityResponse) _then) = __$SetDocumentVisibilityResponseCopyWithImpl;
@override @useResult
$Res call({
@JsonKey(name: 'public_id') String publicId,@JsonKey(name: 'visibility') String visibility
});




}
/// @nodoc
class __$SetDocumentVisibilityResponseCopyWithImpl<$Res>
    implements _$SetDocumentVisibilityResponseCopyWith<$Res> {
  __$SetDocumentVisibilityResponseCopyWithImpl(this._self, this._then);

  final _SetDocumentVisibilityResponse _self;
  final $Res Function(_SetDocumentVisibilityResponse) _then;

/// Create a copy of SetDocumentVisibilityResponse
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? publicId = null,Object? visibility = null,}) {
  return _then(_SetDocumentVisibilityResponse(
publicId: null == publicId ? _self.publicId : publicId // ignore: cast_nullable_to_non_nullable
as String,visibility: null == visibility ? _self.visibility : visibility // ignore: cast_nullable_to_non_nullable
as String,
  ));
}


}


/// @nodoc
mixin _$SetSlugRedirectResponse {

@JsonKey(name: 'slug') String get slug;@JsonKey(name: 'redirect_to') String get redirectTo;@JsonKey(name: 'target_slug') String? get targetSlug;@JsonKey(name: 'target_title') String? get targetTitle;
/// Create a copy of SetSlugRedirectResponse
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$SetSlugRedirectResponseCopyWith<SetSlugRedirectResponse> get copyWith => _$SetSlugRedirectResponseCopyWithImpl<SetSlugRedirectResponse>(this as SetSlugRedirectResponse, _$identity);

  /// Serializes this SetSlugRedirectResponse to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is SetSlugRedirectResponse&&(identical(other.slug, slug) || other.slug == slug)&&(identical(other.redirectTo, redirectTo) || other.redirectTo == redirectTo)&&(identical(other.targetSlug, targetSlug) || other.targetSlug == targetSlug)&&(identical(other.targetTitle, targetTitle) || other.targetTitle == targetTitle));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,slug,redirectTo,targetSlug,targetTitle);

@override
String toString() {
  return 'SetSlugRedirectResponse(slug: $slug, redirectTo: $redirectTo, targetSlug: $targetSlug, targetTitle: $targetTitle)';
}


}

/// @nodoc
abstract mixin class $SetSlugRedirectResponseCopyWith<$Res>  {
  factory $SetSlugRedirectResponseCopyWith(SetSlugRedirectResponse value, $Res Function(SetSlugRedirectResponse) _then) = _$SetSlugRedirectResponseCopyWithImpl;
@useResult
$Res call({
@JsonKey(name: 'slug') String slug,@JsonKey(name: 'redirect_to') String redirectTo,@JsonKey(name: 'target_slug') String? targetSlug,@JsonKey(name: 'target_title') String? targetTitle
});




}
/// @nodoc
class _$SetSlugRedirectResponseCopyWithImpl<$Res>
    implements $SetSlugRedirectResponseCopyWith<$Res> {
  _$SetSlugRedirectResponseCopyWithImpl(this._self, this._then);

  final SetSlugRedirectResponse _self;
  final $Res Function(SetSlugRedirectResponse) _then;

/// Create a copy of SetSlugRedirectResponse
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? slug = null,Object? redirectTo = null,Object? targetSlug = freezed,Object? targetTitle = freezed,}) {
  return _then(_self.copyWith(
slug: null == slug ? _self.slug : slug // ignore: cast_nullable_to_non_nullable
as String,redirectTo: null == redirectTo ? _self.redirectTo : redirectTo // ignore: cast_nullable_to_non_nullable
as String,targetSlug: freezed == targetSlug ? _self.targetSlug : targetSlug // ignore: cast_nullable_to_non_nullable
as String?,targetTitle: freezed == targetTitle ? _self.targetTitle : targetTitle // ignore: cast_nullable_to_non_nullable
as String?,
  ));
}

}


/// Adds pattern-matching-related methods to [SetSlugRedirectResponse].
extension SetSlugRedirectResponsePatterns on SetSlugRedirectResponse {
/// A variant of `map` that fallback to returning `orElse`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _SetSlugRedirectResponse value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _SetSlugRedirectResponse() when $default != null:
return $default(_that);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// Callbacks receives the raw object, upcasted.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case final Subclass2 value:
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _SetSlugRedirectResponse value)  $default,){
final _that = this;
switch (_that) {
case _SetSlugRedirectResponse():
return $default(_that);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `map` that fallback to returning `null`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _SetSlugRedirectResponse value)?  $default,){
final _that = this;
switch (_that) {
case _SetSlugRedirectResponse() when $default != null:
return $default(_that);case _:
  return null;

}
}
/// A variant of `when` that fallback to an `orElse` callback.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function(@JsonKey(name: 'slug')  String slug, @JsonKey(name: 'redirect_to')  String redirectTo, @JsonKey(name: 'target_slug')  String? targetSlug, @JsonKey(name: 'target_title')  String? targetTitle)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _SetSlugRedirectResponse() when $default != null:
return $default(_that.slug,_that.redirectTo,_that.targetSlug,_that.targetTitle);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// As opposed to `map`, this offers destructuring.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case Subclass2(:final field2):
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function(@JsonKey(name: 'slug')  String slug, @JsonKey(name: 'redirect_to')  String redirectTo, @JsonKey(name: 'target_slug')  String? targetSlug, @JsonKey(name: 'target_title')  String? targetTitle)  $default,) {final _that = this;
switch (_that) {
case _SetSlugRedirectResponse():
return $default(_that.slug,_that.redirectTo,_that.targetSlug,_that.targetTitle);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `when` that fallback to returning `null`
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function(@JsonKey(name: 'slug')  String slug, @JsonKey(name: 'redirect_to')  String redirectTo, @JsonKey(name: 'target_slug')  String? targetSlug, @JsonKey(name: 'target_title')  String? targetTitle)?  $default,) {final _that = this;
switch (_that) {
case _SetSlugRedirectResponse() when $default != null:
return $default(_that.slug,_that.redirectTo,_that.targetSlug,_that.targetTitle);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _SetSlugRedirectResponse implements SetSlugRedirectResponse {
  const _SetSlugRedirectResponse({@JsonKey(name: 'slug') required this.slug, @JsonKey(name: 'redirect_to') required this.redirectTo, @JsonKey(name: 'target_slug') this.targetSlug, @JsonKey(name: 'target_title') this.targetTitle});
  factory _SetSlugRedirectResponse.fromJson(Map<String, dynamic> json) => _$SetSlugRedirectResponseFromJson(json);

@override@JsonKey(name: 'slug') final  String slug;
@override@JsonKey(name: 'redirect_to') final  String redirectTo;
@override@JsonKey(name: 'target_slug') final  String? targetSlug;
@override@JsonKey(name: 'target_title') final  String? targetTitle;

/// Create a copy of SetSlugRedirectResponse
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$SetSlugRedirectResponseCopyWith<_SetSlugRedirectResponse> get copyWith => __$SetSlugRedirectResponseCopyWithImpl<_SetSlugRedirectResponse>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$SetSlugRedirectResponseToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _SetSlugRedirectResponse&&(identical(other.slug, slug) || other.slug == slug)&&(identical(other.redirectTo, redirectTo) || other.redirectTo == redirectTo)&&(identical(other.targetSlug, targetSlug) || other.targetSlug == targetSlug)&&(identical(other.targetTitle, targetTitle) || other.targetTitle == targetTitle));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,slug,redirectTo,targetSlug,targetTitle);

@override
String toString() {
  return 'SetSlugRedirectResponse(slug: $slug, redirectTo: $redirectTo, targetSlug: $targetSlug, targetTitle: $targetTitle)';
}


}

/// @nodoc
abstract mixin class _$SetSlugRedirectResponseCopyWith<$Res> implements $SetSlugRedirectResponseCopyWith<$Res> {
  factory _$SetSlugRedirectResponseCopyWith(_SetSlugRedirectResponse value, $Res Function(_SetSlugRedirectResponse) _then) = __$SetSlugRedirectResponseCopyWithImpl;
@override @useResult
$Res call({
@JsonKey(name: 'slug') String slug,@JsonKey(name: 'redirect_to') String redirectTo,@JsonKey(name: 'target_slug') String? targetSlug,@JsonKey(name: 'target_title') String? targetTitle
});




}
/// @nodoc
class __$SetSlugRedirectResponseCopyWithImpl<$Res>
    implements _$SetSlugRedirectResponseCopyWith<$Res> {
  __$SetSlugRedirectResponseCopyWithImpl(this._self, this._then);

  final _SetSlugRedirectResponse _self;
  final $Res Function(_SetSlugRedirectResponse) _then;

/// Create a copy of SetSlugRedirectResponse
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? slug = null,Object? redirectTo = null,Object? targetSlug = freezed,Object? targetTitle = freezed,}) {
  return _then(_SetSlugRedirectResponse(
slug: null == slug ? _self.slug : slug // ignore: cast_nullable_to_non_nullable
as String,redirectTo: null == redirectTo ? _self.redirectTo : redirectTo // ignore: cast_nullable_to_non_nullable
as String,targetSlug: freezed == targetSlug ? _self.targetSlug : targetSlug // ignore: cast_nullable_to_non_nullable
as String?,targetTitle: freezed == targetTitle ? _self.targetTitle : targetTitle // ignore: cast_nullable_to_non_nullable
as String?,
  ));
}


}


/// @nodoc
mixin _$WriteResponse {

@JsonKey(name: 'public_id') String get publicId;@JsonKey(name: 'url') String get url;@JsonKey(name: 'version') int get version;@JsonKey(name: 'size_bytes') int get sizeBytes;@JsonKey(name: 'sanitizer_v') String get sanitizerV;@JsonKey(name: 'modified') bool get modified;@JsonKey(name: 'stripped') List<String> get stripped;@JsonKey(name: 'will_not_render') List<String> get willNotRender;@JsonKey(name: 'tags') List<String> get tags;@JsonKey(name: 'source_sha256') String? get sourceSha256;@JsonKey(name: 'title') String? get title;@JsonKey(name: 'description') String? get description;@JsonKey(name: 'slug') String? get slug;
/// Create a copy of WriteResponse
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$WriteResponseCopyWith<WriteResponse> get copyWith => _$WriteResponseCopyWithImpl<WriteResponse>(this as WriteResponse, _$identity);

  /// Serializes this WriteResponse to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is WriteResponse&&(identical(other.publicId, publicId) || other.publicId == publicId)&&(identical(other.url, url) || other.url == url)&&(identical(other.version, version) || other.version == version)&&(identical(other.sizeBytes, sizeBytes) || other.sizeBytes == sizeBytes)&&(identical(other.sanitizerV, sanitizerV) || other.sanitizerV == sanitizerV)&&(identical(other.modified, modified) || other.modified == modified)&&const DeepCollectionEquality().equals(other.stripped, stripped)&&const DeepCollectionEquality().equals(other.willNotRender, willNotRender)&&const DeepCollectionEquality().equals(other.tags, tags)&&(identical(other.sourceSha256, sourceSha256) || other.sourceSha256 == sourceSha256)&&(identical(other.title, title) || other.title == title)&&(identical(other.description, description) || other.description == description)&&(identical(other.slug, slug) || other.slug == slug));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,publicId,url,version,sizeBytes,sanitizerV,modified,const DeepCollectionEquality().hash(stripped),const DeepCollectionEquality().hash(willNotRender),const DeepCollectionEquality().hash(tags),sourceSha256,title,description,slug);

@override
String toString() {
  return 'WriteResponse(publicId: $publicId, url: $url, version: $version, sizeBytes: $sizeBytes, sanitizerV: $sanitizerV, modified: $modified, stripped: $stripped, willNotRender: $willNotRender, tags: $tags, sourceSha256: $sourceSha256, title: $title, description: $description, slug: $slug)';
}


}

/// @nodoc
abstract mixin class $WriteResponseCopyWith<$Res>  {
  factory $WriteResponseCopyWith(WriteResponse value, $Res Function(WriteResponse) _then) = _$WriteResponseCopyWithImpl;
@useResult
$Res call({
@JsonKey(name: 'public_id') String publicId,@JsonKey(name: 'url') String url,@JsonKey(name: 'version') int version,@JsonKey(name: 'size_bytes') int sizeBytes,@JsonKey(name: 'sanitizer_v') String sanitizerV,@JsonKey(name: 'modified') bool modified,@JsonKey(name: 'stripped') List<String> stripped,@JsonKey(name: 'will_not_render') List<String> willNotRender,@JsonKey(name: 'tags') List<String> tags,@JsonKey(name: 'source_sha256') String? sourceSha256,@JsonKey(name: 'title') String? title,@JsonKey(name: 'description') String? description,@JsonKey(name: 'slug') String? slug
});




}
/// @nodoc
class _$WriteResponseCopyWithImpl<$Res>
    implements $WriteResponseCopyWith<$Res> {
  _$WriteResponseCopyWithImpl(this._self, this._then);

  final WriteResponse _self;
  final $Res Function(WriteResponse) _then;

/// Create a copy of WriteResponse
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? publicId = null,Object? url = null,Object? version = null,Object? sizeBytes = null,Object? sanitizerV = null,Object? modified = null,Object? stripped = null,Object? willNotRender = null,Object? tags = null,Object? sourceSha256 = freezed,Object? title = freezed,Object? description = freezed,Object? slug = freezed,}) {
  return _then(_self.copyWith(
publicId: null == publicId ? _self.publicId : publicId // ignore: cast_nullable_to_non_nullable
as String,url: null == url ? _self.url : url // ignore: cast_nullable_to_non_nullable
as String,version: null == version ? _self.version : version // ignore: cast_nullable_to_non_nullable
as int,sizeBytes: null == sizeBytes ? _self.sizeBytes : sizeBytes // ignore: cast_nullable_to_non_nullable
as int,sanitizerV: null == sanitizerV ? _self.sanitizerV : sanitizerV // ignore: cast_nullable_to_non_nullable
as String,modified: null == modified ? _self.modified : modified // ignore: cast_nullable_to_non_nullable
as bool,stripped: null == stripped ? _self.stripped : stripped // ignore: cast_nullable_to_non_nullable
as List<String>,willNotRender: null == willNotRender ? _self.willNotRender : willNotRender // ignore: cast_nullable_to_non_nullable
as List<String>,tags: null == tags ? _self.tags : tags // ignore: cast_nullable_to_non_nullable
as List<String>,sourceSha256: freezed == sourceSha256 ? _self.sourceSha256 : sourceSha256 // ignore: cast_nullable_to_non_nullable
as String?,title: freezed == title ? _self.title : title // ignore: cast_nullable_to_non_nullable
as String?,description: freezed == description ? _self.description : description // ignore: cast_nullable_to_non_nullable
as String?,slug: freezed == slug ? _self.slug : slug // ignore: cast_nullable_to_non_nullable
as String?,
  ));
}

}


/// Adds pattern-matching-related methods to [WriteResponse].
extension WriteResponsePatterns on WriteResponse {
/// A variant of `map` that fallback to returning `orElse`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _WriteResponse value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _WriteResponse() when $default != null:
return $default(_that);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// Callbacks receives the raw object, upcasted.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case final Subclass2 value:
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _WriteResponse value)  $default,){
final _that = this;
switch (_that) {
case _WriteResponse():
return $default(_that);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `map` that fallback to returning `null`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _WriteResponse value)?  $default,){
final _that = this;
switch (_that) {
case _WriteResponse() when $default != null:
return $default(_that);case _:
  return null;

}
}
/// A variant of `when` that fallback to an `orElse` callback.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function(@JsonKey(name: 'public_id')  String publicId, @JsonKey(name: 'url')  String url, @JsonKey(name: 'version')  int version, @JsonKey(name: 'size_bytes')  int sizeBytes, @JsonKey(name: 'sanitizer_v')  String sanitizerV, @JsonKey(name: 'modified')  bool modified, @JsonKey(name: 'stripped')  List<String> stripped, @JsonKey(name: 'will_not_render')  List<String> willNotRender, @JsonKey(name: 'tags')  List<String> tags, @JsonKey(name: 'source_sha256')  String? sourceSha256, @JsonKey(name: 'title')  String? title, @JsonKey(name: 'description')  String? description, @JsonKey(name: 'slug')  String? slug)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _WriteResponse() when $default != null:
return $default(_that.publicId,_that.url,_that.version,_that.sizeBytes,_that.sanitizerV,_that.modified,_that.stripped,_that.willNotRender,_that.tags,_that.sourceSha256,_that.title,_that.description,_that.slug);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// As opposed to `map`, this offers destructuring.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case Subclass2(:final field2):
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function(@JsonKey(name: 'public_id')  String publicId, @JsonKey(name: 'url')  String url, @JsonKey(name: 'version')  int version, @JsonKey(name: 'size_bytes')  int sizeBytes, @JsonKey(name: 'sanitizer_v')  String sanitizerV, @JsonKey(name: 'modified')  bool modified, @JsonKey(name: 'stripped')  List<String> stripped, @JsonKey(name: 'will_not_render')  List<String> willNotRender, @JsonKey(name: 'tags')  List<String> tags, @JsonKey(name: 'source_sha256')  String? sourceSha256, @JsonKey(name: 'title')  String? title, @JsonKey(name: 'description')  String? description, @JsonKey(name: 'slug')  String? slug)  $default,) {final _that = this;
switch (_that) {
case _WriteResponse():
return $default(_that.publicId,_that.url,_that.version,_that.sizeBytes,_that.sanitizerV,_that.modified,_that.stripped,_that.willNotRender,_that.tags,_that.sourceSha256,_that.title,_that.description,_that.slug);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `when` that fallback to returning `null`
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function(@JsonKey(name: 'public_id')  String publicId, @JsonKey(name: 'url')  String url, @JsonKey(name: 'version')  int version, @JsonKey(name: 'size_bytes')  int sizeBytes, @JsonKey(name: 'sanitizer_v')  String sanitizerV, @JsonKey(name: 'modified')  bool modified, @JsonKey(name: 'stripped')  List<String> stripped, @JsonKey(name: 'will_not_render')  List<String> willNotRender, @JsonKey(name: 'tags')  List<String> tags, @JsonKey(name: 'source_sha256')  String? sourceSha256, @JsonKey(name: 'title')  String? title, @JsonKey(name: 'description')  String? description, @JsonKey(name: 'slug')  String? slug)?  $default,) {final _that = this;
switch (_that) {
case _WriteResponse() when $default != null:
return $default(_that.publicId,_that.url,_that.version,_that.sizeBytes,_that.sanitizerV,_that.modified,_that.stripped,_that.willNotRender,_that.tags,_that.sourceSha256,_that.title,_that.description,_that.slug);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _WriteResponse implements WriteResponse {
  const _WriteResponse({@JsonKey(name: 'public_id') required this.publicId, @JsonKey(name: 'url') required this.url, @JsonKey(name: 'version') required this.version, @JsonKey(name: 'size_bytes') required this.sizeBytes, @JsonKey(name: 'sanitizer_v') required this.sanitizerV, @JsonKey(name: 'modified') required this.modified, @JsonKey(name: 'stripped') required final  List<String> stripped, @JsonKey(name: 'will_not_render') required final  List<String> willNotRender, @JsonKey(name: 'tags') required final  List<String> tags, @JsonKey(name: 'source_sha256') this.sourceSha256, @JsonKey(name: 'title') this.title, @JsonKey(name: 'description') this.description, @JsonKey(name: 'slug') this.slug}): _stripped = stripped,_willNotRender = willNotRender,_tags = tags;
  factory _WriteResponse.fromJson(Map<String, dynamic> json) => _$WriteResponseFromJson(json);

@override@JsonKey(name: 'public_id') final  String publicId;
@override@JsonKey(name: 'url') final  String url;
@override@JsonKey(name: 'version') final  int version;
@override@JsonKey(name: 'size_bytes') final  int sizeBytes;
@override@JsonKey(name: 'sanitizer_v') final  String sanitizerV;
@override@JsonKey(name: 'modified') final  bool modified;
 final  List<String> _stripped;
@override@JsonKey(name: 'stripped') List<String> get stripped {
  if (_stripped is EqualUnmodifiableListView) return _stripped;
  // ignore: implicit_dynamic_type
  return EqualUnmodifiableListView(_stripped);
}

 final  List<String> _willNotRender;
@override@JsonKey(name: 'will_not_render') List<String> get willNotRender {
  if (_willNotRender is EqualUnmodifiableListView) return _willNotRender;
  // ignore: implicit_dynamic_type
  return EqualUnmodifiableListView(_willNotRender);
}

 final  List<String> _tags;
@override@JsonKey(name: 'tags') List<String> get tags {
  if (_tags is EqualUnmodifiableListView) return _tags;
  // ignore: implicit_dynamic_type
  return EqualUnmodifiableListView(_tags);
}

@override@JsonKey(name: 'source_sha256') final  String? sourceSha256;
@override@JsonKey(name: 'title') final  String? title;
@override@JsonKey(name: 'description') final  String? description;
@override@JsonKey(name: 'slug') final  String? slug;

/// Create a copy of WriteResponse
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$WriteResponseCopyWith<_WriteResponse> get copyWith => __$WriteResponseCopyWithImpl<_WriteResponse>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$WriteResponseToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _WriteResponse&&(identical(other.publicId, publicId) || other.publicId == publicId)&&(identical(other.url, url) || other.url == url)&&(identical(other.version, version) || other.version == version)&&(identical(other.sizeBytes, sizeBytes) || other.sizeBytes == sizeBytes)&&(identical(other.sanitizerV, sanitizerV) || other.sanitizerV == sanitizerV)&&(identical(other.modified, modified) || other.modified == modified)&&const DeepCollectionEquality().equals(other._stripped, _stripped)&&const DeepCollectionEquality().equals(other._willNotRender, _willNotRender)&&const DeepCollectionEquality().equals(other._tags, _tags)&&(identical(other.sourceSha256, sourceSha256) || other.sourceSha256 == sourceSha256)&&(identical(other.title, title) || other.title == title)&&(identical(other.description, description) || other.description == description)&&(identical(other.slug, slug) || other.slug == slug));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,publicId,url,version,sizeBytes,sanitizerV,modified,const DeepCollectionEquality().hash(_stripped),const DeepCollectionEquality().hash(_willNotRender),const DeepCollectionEquality().hash(_tags),sourceSha256,title,description,slug);

@override
String toString() {
  return 'WriteResponse(publicId: $publicId, url: $url, version: $version, sizeBytes: $sizeBytes, sanitizerV: $sanitizerV, modified: $modified, stripped: $stripped, willNotRender: $willNotRender, tags: $tags, sourceSha256: $sourceSha256, title: $title, description: $description, slug: $slug)';
}


}

/// @nodoc
abstract mixin class _$WriteResponseCopyWith<$Res> implements $WriteResponseCopyWith<$Res> {
  factory _$WriteResponseCopyWith(_WriteResponse value, $Res Function(_WriteResponse) _then) = __$WriteResponseCopyWithImpl;
@override @useResult
$Res call({
@JsonKey(name: 'public_id') String publicId,@JsonKey(name: 'url') String url,@JsonKey(name: 'version') int version,@JsonKey(name: 'size_bytes') int sizeBytes,@JsonKey(name: 'sanitizer_v') String sanitizerV,@JsonKey(name: 'modified') bool modified,@JsonKey(name: 'stripped') List<String> stripped,@JsonKey(name: 'will_not_render') List<String> willNotRender,@JsonKey(name: 'tags') List<String> tags,@JsonKey(name: 'source_sha256') String? sourceSha256,@JsonKey(name: 'title') String? title,@JsonKey(name: 'description') String? description,@JsonKey(name: 'slug') String? slug
});




}
/// @nodoc
class __$WriteResponseCopyWithImpl<$Res>
    implements _$WriteResponseCopyWith<$Res> {
  __$WriteResponseCopyWithImpl(this._self, this._then);

  final _WriteResponse _self;
  final $Res Function(_WriteResponse) _then;

/// Create a copy of WriteResponse
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? publicId = null,Object? url = null,Object? version = null,Object? sizeBytes = null,Object? sanitizerV = null,Object? modified = null,Object? stripped = null,Object? willNotRender = null,Object? tags = null,Object? sourceSha256 = freezed,Object? title = freezed,Object? description = freezed,Object? slug = freezed,}) {
  return _then(_WriteResponse(
publicId: null == publicId ? _self.publicId : publicId // ignore: cast_nullable_to_non_nullable
as String,url: null == url ? _self.url : url // ignore: cast_nullable_to_non_nullable
as String,version: null == version ? _self.version : version // ignore: cast_nullable_to_non_nullable
as int,sizeBytes: null == sizeBytes ? _self.sizeBytes : sizeBytes // ignore: cast_nullable_to_non_nullable
as int,sanitizerV: null == sanitizerV ? _self.sanitizerV : sanitizerV // ignore: cast_nullable_to_non_nullable
as String,modified: null == modified ? _self.modified : modified // ignore: cast_nullable_to_non_nullable
as bool,stripped: null == stripped ? _self._stripped : stripped // ignore: cast_nullable_to_non_nullable
as List<String>,willNotRender: null == willNotRender ? _self._willNotRender : willNotRender // ignore: cast_nullable_to_non_nullable
as List<String>,tags: null == tags ? _self._tags : tags // ignore: cast_nullable_to_non_nullable
as List<String>,sourceSha256: freezed == sourceSha256 ? _self.sourceSha256 : sourceSha256 // ignore: cast_nullable_to_non_nullable
as String?,title: freezed == title ? _self.title : title // ignore: cast_nullable_to_non_nullable
as String?,description: freezed == description ? _self.description : description // ignore: cast_nullable_to_non_nullable
as String?,slug: freezed == slug ? _self.slug : slug // ignore: cast_nullable_to_non_nullable
as String?,
  ));
}


}

// dart format on

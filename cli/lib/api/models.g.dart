// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'models.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

_BackfillResponse _$BackfillResponseFromJson(Map<String, dynamic> json) =>
    _BackfillResponse(
      mode: json['mode'] as String,
      scanned: (json['scanned'] as num).toInt(),
      embedded: (json['embedded'] as num).toInt(),
      vectors: (json['vectors'] as num).toInt(),
      skipped: (json['skipped'] as num).toInt(),
      nextCursor: json['next_cursor'] as String?,
    );

Map<String, dynamic> _$BackfillResponseToJson(_BackfillResponse instance) =>
    <String, dynamic>{
      'mode': instance.mode,
      'scanned': instance.scanned,
      'embedded': instance.embedded,
      'vectors': instance.vectors,
      'skipped': instance.skipped,
      'next_cursor': instance.nextCursor,
    };

_ClearSlugRedirectResponse _$ClearSlugRedirectResponseFromJson(
  Map<String, dynamic> json,
) => _ClearSlugRedirectResponse(
  slug: json['slug'] as String,
  redirectTo: json['redirect_to'],
);

Map<String, dynamic> _$ClearSlugRedirectResponseToJson(
  _ClearSlugRedirectResponse instance,
) => <String, dynamic>{
  'slug': instance.slug,
  'redirect_to': instance.redirectTo,
};

_CreateOAuthClientResponse _$CreateOAuthClientResponseFromJson(
  Map<String, dynamic> json,
) => _CreateOAuthClientResponse(
  clientId: json['client_id'] as String,
  clientSecret: json['client_secret'] as String,
  mcpUrl: json['mcp_url'] as String,
  agentId: json['agent_id'] as String,
  agentName: json['agent_name'] as String,
  note: json['note'] as String,
);

Map<String, dynamic> _$CreateOAuthClientResponseToJson(
  _CreateOAuthClientResponse instance,
) => <String, dynamic>{
  'client_id': instance.clientId,
  'client_secret': instance.clientSecret,
  'mcp_url': instance.mcpUrl,
  'agent_id': instance.agentId,
  'agent_name': instance.agentName,
  'note': instance.note,
};

_CreateUnboundOAuthClientResponse _$CreateUnboundOAuthClientResponseFromJson(
  Map<String, dynamic> json,
) => _CreateUnboundOAuthClientResponse(
  clientId: json['client_id'] as String,
  clientSecret: json['client_secret'] as String,
  mcpUrl: json['mcp_url'] as String,
  note: json['note'] as String,
);

Map<String, dynamic> _$CreateUnboundOAuthClientResponseToJson(
  _CreateUnboundOAuthClientResponse instance,
) => <String, dynamic>{
  'client_id': instance.clientId,
  'client_secret': instance.clientSecret,
  'mcp_url': instance.mcpUrl,
  'note': instance.note,
};

_DocumentLinksResponse _$DocumentLinksResponseFromJson(
  Map<String, dynamic> json,
) => _DocumentLinksResponse(
  publicId: json['public_id'] as String,
  backlinks: (json['backlinks'] as List<dynamic>)
      .map((e) => DocumentListing.fromJson(e as Map<String, dynamic>))
      .toList(),
  outbound: (json['outbound'] as List<dynamic>)
      .map((e) => OutboundLink.fromJson(e as Map<String, dynamic>))
      .toList(),
);

Map<String, dynamic> _$DocumentLinksResponseToJson(
  _DocumentLinksResponse instance,
) => <String, dynamic>{
  'public_id': instance.publicId,
  'backlinks': instance.backlinks,
  'outbound': instance.outbound,
};

_DocumentListing _$DocumentListingFromJson(Map<String, dynamic> json) =>
    _DocumentListing(
      publicId: json['public_id'] as String,
      createdAt: DateTime.parse(json['created_at'] as String),
      createdByKind: json['created_by_kind'] as String,
      tags: (json['tags'] as List<dynamic>).map((e) => e as String).toList(),
      status: json['status'] as String,
      visibility: json['visibility'] as String,
      currentVer: (json['current_ver'] as num?)?.toInt(),
      createdById: json['created_by_id'] as String?,
      createdByName: json['created_by_name'] as String?,
      currentSize: (json['current_size'] as num?)?.toInt(),
      currentSourceSha256: json['current_source_sha256'] as String?,
      revokedAt: json['revoked_at'] == null
          ? null
          : DateTime.parse(json['revoked_at'] as String),
      title: json['title'] as String?,
      description: json['description'] as String?,
      slug: json['slug'] as String?,
      supersededBy: json['superseded_by'] as String?,
    );

Map<String, dynamic> _$DocumentListingToJson(_DocumentListing instance) =>
    <String, dynamic>{
      'public_id': instance.publicId,
      'created_at': instance.createdAt.toIso8601String(),
      'created_by_kind': instance.createdByKind,
      'tags': instance.tags,
      'status': instance.status,
      'visibility': instance.visibility,
      'current_ver': instance.currentVer,
      'created_by_id': instance.createdById,
      'created_by_name': instance.createdByName,
      'current_size': instance.currentSize,
      'current_source_sha256': instance.currentSourceSha256,
      'revoked_at': instance.revokedAt?.toIso8601String(),
      'title': instance.title,
      'description': instance.description,
      'slug': instance.slug,
      'superseded_by': instance.supersededBy,
    };

_OutboundLink _$OutboundLinkFromJson(Map<String, dynamic> json) =>
    _OutboundLink(
      kind: json['kind'] as String,
      value: json['value'] as String,
      state: json['state'] as String,
      targetPublicId: json['target_public_id'] as String?,
      title: json['title'] as String?,
    );

Map<String, dynamic> _$OutboundLinkToJson(_OutboundLink instance) =>
    <String, dynamic>{
      'kind': instance.kind,
      'value': instance.value,
      'state': instance.state,
      'target_public_id': instance.targetPublicId,
      'title': instance.title,
    };

_HealthzResponse _$HealthzResponseFromJson(Map<String, dynamic> json) =>
    _HealthzResponse(
      ok: json['ok'] as bool,
      service: json['service'] as String,
      sanitizerVersion: json['sanitizer_version'] as String,
      storageCapBytes: (json['storage_cap_bytes'] as num).toInt(),
      d1: HealthzResponseD1.fromJson(json['d1'] as Map<String, dynamic>),
      r2: HealthzResponseR2.fromJson(json['r2'] as Map<String, dynamic>),
    );

Map<String, dynamic> _$HealthzResponseToJson(_HealthzResponse instance) =>
    <String, dynamic>{
      'ok': instance.ok,
      'service': instance.service,
      'sanitizer_version': instance.sanitizerVersion,
      'storage_cap_bytes': instance.storageCapBytes,
      'd1': instance.d1,
      'r2': instance.r2,
    };

_HealthzResponseD1 _$HealthzResponseD1FromJson(Map<String, dynamic> json) =>
    _HealthzResponseD1(
      documents: (json['documents'] as num?)?.toInt(),
      agents: (json['agents'] as num?)?.toInt(),
    );

Map<String, dynamic> _$HealthzResponseD1ToJson(_HealthzResponseD1 instance) =>
    <String, dynamic>{
      'documents': instance.documents,
      'agents': instance.agents,
    };

_HealthzResponseR2 _$HealthzResponseR2FromJson(Map<String, dynamic> json) =>
    _HealthzResponseR2(
      bucketReachable: json['bucket_reachable'] as bool,
      sampleObjectCount: (json['sample_object_count'] as num).toInt(),
    );

Map<String, dynamic> _$HealthzResponseR2ToJson(_HealthzResponseR2 instance) =>
    <String, dynamic>{
      'bucket_reachable': instance.bucketReachable,
      'sample_object_count': instance.sampleObjectCount,
    };

_LinksBackfillResponse _$LinksBackfillResponseFromJson(
  Map<String, dynamic> json,
) => _LinksBackfillResponse(
  scanned: (json['scanned'] as num).toInt(),
  updated: (json['updated'] as num).toInt(),
  links: (json['links'] as num).toInt(),
  nextCursor: json['next_cursor'] as String?,
);

Map<String, dynamic> _$LinksBackfillResponseToJson(
  _LinksBackfillResponse instance,
) => <String, dynamic>{
  'scanned': instance.scanned,
  'updated': instance.updated,
  'links': instance.links,
  'next_cursor': instance.nextCursor,
};

_ListAgentKeysResponse _$ListAgentKeysResponseFromJson(
  Map<String, dynamic> json,
) => _ListAgentKeysResponse(
  agentId: json['agent_id'] as String,
  name: json['name'] as String,
  keys: (json['keys'] as List<dynamic>)
      .map((e) => AgentKey.fromJson(e as Map<String, dynamic>))
      .toList(),
  nextCursor: json['next_cursor'] as String?,
);

Map<String, dynamic> _$ListAgentKeysResponseToJson(
  _ListAgentKeysResponse instance,
) => <String, dynamic>{
  'agent_id': instance.agentId,
  'name': instance.name,
  'keys': instance.keys,
  'next_cursor': instance.nextCursor,
};

_AgentKey _$AgentKeyFromJson(Map<String, dynamic> json) => _AgentKey(
  id: json['id'] as String,
  keyPrefix: json['key_prefix'] as String,
  createdAt: DateTime.parse(json['created_at'] as String),
  expired: json['expired'] as bool,
  revokedAt: json['revoked_at'] == null
      ? null
      : DateTime.parse(json['revoked_at'] as String),
  expiresAt: json['expires_at'] == null
      ? null
      : DateTime.parse(json['expires_at'] as String),
);

Map<String, dynamic> _$AgentKeyToJson(_AgentKey instance) => <String, dynamic>{
  'id': instance.id,
  'key_prefix': instance.keyPrefix,
  'created_at': instance.createdAt.toIso8601String(),
  'expired': instance.expired,
  'revoked_at': instance.revokedAt?.toIso8601String(),
  'expires_at': instance.expiresAt?.toIso8601String(),
};

_ListAgentsResponse _$ListAgentsResponseFromJson(Map<String, dynamic> json) =>
    _ListAgentsResponse(
      agents: (json['agents'] as List<dynamic>)
          .map((e) => AgentListing.fromJson(e as Map<String, dynamic>))
          .toList(),
      nextCursor: json['next_cursor'] as String?,
    );

Map<String, dynamic> _$ListAgentsResponseToJson(_ListAgentsResponse instance) =>
    <String, dynamic>{
      'agents': instance.agents,
      'next_cursor': instance.nextCursor,
    };

_AgentListing _$AgentListingFromJson(Map<String, dynamic> json) =>
    _AgentListing(
      id: json['id'] as String,
      name: json['name'] as String,
      createdAt: DateTime.parse(json['created_at'] as String),
      activeKeys: (json['active_keys'] as num).toInt(),
      totalKeys: (json['total_keys'] as num).toInt(),
      liveDocs: (json['live_docs'] as num).toInt(),
    );

Map<String, dynamic> _$AgentListingToJson(_AgentListing instance) =>
    <String, dynamic>{
      'id': instance.id,
      'name': instance.name,
      'created_at': instance.createdAt.toIso8601String(),
      'active_keys': instance.activeKeys,
      'total_keys': instance.totalKeys,
      'live_docs': instance.liveDocs,
    };

_ListDocumentsResponse _$ListDocumentsResponseFromJson(
  Map<String, dynamic> json,
) => _ListDocumentsResponse(
  documents: (json['documents'] as List<dynamic>)
      .map((e) => DocumentListing.fromJson(e as Map<String, dynamic>))
      .toList(),
  nextCursor: json['next_cursor'] as String?,
);

Map<String, dynamic> _$ListDocumentsResponseToJson(
  _ListDocumentsResponse instance,
) => <String, dynamic>{
  'documents': instance.documents,
  'next_cursor': instance.nextCursor,
};

_MintAgentKeyResponse _$MintAgentKeyResponseFromJson(
  Map<String, dynamic> json,
) => _MintAgentKeyResponse(
  agentId: json['agent_id'] as String,
  keyId: json['key_id'] as String,
  key: json['key'] as String,
  note: json['note'] as String,
);

Map<String, dynamic> _$MintAgentKeyResponseToJson(
  _MintAgentKeyResponse instance,
) => <String, dynamic>{
  'agent_id': instance.agentId,
  'key_id': instance.keyId,
  'key': instance.key,
  'note': instance.note,
};

_OrphanDocumentsResponse _$OrphanDocumentsResponseFromJson(
  Map<String, dynamic> json,
) => _OrphanDocumentsResponse(
  documents: (json['documents'] as List<dynamic>)
      .map((e) => DocumentListing.fromJson(e as Map<String, dynamic>))
      .toList(),
);

Map<String, dynamic> _$OrphanDocumentsResponseToJson(
  _OrphanDocumentsResponse instance,
) => <String, dynamic>{'documents': instance.documents};

_PackDocument _$PackDocumentFromJson(Map<String, dynamic> json) =>
    _PackDocument(
      publicId: json['public_id'] as String,
      createdAt: DateTime.parse(json['created_at'] as String),
      createdByKind: json['created_by_kind'] as String,
      tags: (json['tags'] as List<dynamic>).map((e) => e as String).toList(),
      status: json['status'] as String,
      visibility: json['visibility'] as String,
      content: json['content'] as String,
      format: json['format'] as String,
      converterV: json['converter_v'] as String,
      version: (json['version'] as num).toInt(),
      currentVer: (json['current_ver'] as num?)?.toInt(),
      createdById: json['created_by_id'] as String?,
      createdByName: json['created_by_name'] as String?,
      currentSize: (json['current_size'] as num?)?.toInt(),
      currentSourceSha256: json['current_source_sha256'] as String?,
      revokedAt: json['revoked_at'] == null
          ? null
          : DateTime.parse(json['revoked_at'] as String),
      title: json['title'] as String?,
      description: json['description'] as String?,
      slug: json['slug'] as String?,
      supersededBy: json['superseded_by'] as String?,
      score: (json['score'] as num?)?.toDouble(),
      matchedField: json['matched_field'] as String?,
      snippet: json['snippet'] as String?,
      tier: json['tier'] as String?,
      hint: json['hint'] as String?,
    );

Map<String, dynamic> _$PackDocumentToJson(_PackDocument instance) =>
    <String, dynamic>{
      'public_id': instance.publicId,
      'created_at': instance.createdAt.toIso8601String(),
      'created_by_kind': instance.createdByKind,
      'tags': instance.tags,
      'status': instance.status,
      'visibility': instance.visibility,
      'content': instance.content,
      'format': instance.format,
      'converter_v': instance.converterV,
      'version': instance.version,
      'current_ver': instance.currentVer,
      'created_by_id': instance.createdById,
      'created_by_name': instance.createdByName,
      'current_size': instance.currentSize,
      'current_source_sha256': instance.currentSourceSha256,
      'revoked_at': instance.revokedAt?.toIso8601String(),
      'title': instance.title,
      'description': instance.description,
      'slug': instance.slug,
      'superseded_by': instance.supersededBy,
      'score': instance.score,
      'matched_field': instance.matchedField,
      'snippet': instance.snippet,
      'tier': instance.tier,
      'hint': instance.hint,
    };

_PackInfo _$PackInfoFromJson(Map<String, dynamic> json) => _PackInfo(
  source: json['source'] as String,
  budgetBytes: (json['budget_bytes'] as num).toInt(),
  maxDocuments: (json['max_documents'] as num).toInt(),
  usedBytes: (json['used_bytes'] as num).toInt(),
  query: json['query'] as String?,
  root: json['root'] == null
      ? null
      : PackRoot.fromJson(json['root'] as Map<String, dynamic>),
);

Map<String, dynamic> _$PackInfoToJson(_PackInfo instance) => <String, dynamic>{
  'source': instance.source,
  'budget_bytes': instance.budgetBytes,
  'max_documents': instance.maxDocuments,
  'used_bytes': instance.usedBytes,
  'query': instance.query,
  'root': instance.root,
};

_PackRoot _$PackRootFromJson(Map<String, dynamic> json) => _PackRoot(
  publicId: json['public_id'] as String,
  content: json['content'] as String,
  format: json['format'] as String,
  slug: json['slug'] as String?,
  title: json['title'] as String?,
);

Map<String, dynamic> _$PackRootToJson(_PackRoot instance) => <String, dynamic>{
  'public_id': instance.publicId,
  'content': instance.content,
  'format': instance.format,
  'slug': instance.slug,
  'title': instance.title,
};

_PackOmitted _$PackOmittedFromJson(Map<String, dynamic> json) => _PackOmitted(
  ref: json['ref'] as String,
  reason: json['reason'] as String,
  publicId: json['public_id'] as String?,
  title: json['title'] as String?,
  sizeBytes: (json['size_bytes'] as num?)?.toInt(),
  supersededBy: json['superseded_by'] as String?,
  hint: json['hint'] as String?,
);

Map<String, dynamic> _$PackOmittedToJson(_PackOmitted instance) =>
    <String, dynamic>{
      'ref': instance.ref,
      'reason': instance.reason,
      'public_id': instance.publicId,
      'title': instance.title,
      'size_bytes': instance.sizeBytes,
      'superseded_by': instance.supersededBy,
      'hint': instance.hint,
    };

_PackResponse _$PackResponseFromJson(Map<String, dynamic> json) =>
    _PackResponse(
      pack: PackInfo.fromJson(json['pack'] as Map<String, dynamic>),
      documents: (json['documents'] as List<dynamic>)
          .map((e) => PackDocument.fromJson(e as Map<String, dynamic>))
          .toList(),
      omitted: (json['omitted'] as List<dynamic>)
          .map((e) => PackOmitted.fromJson(e as Map<String, dynamic>))
          .toList(),
    );

Map<String, dynamic> _$PackResponseToJson(_PackResponse instance) =>
    <String, dynamic>{
      'pack': instance.pack,
      'documents': instance.documents,
      'omitted': instance.omitted,
    };

_ReadSourceResponse _$ReadSourceResponseFromJson(Map<String, dynamic> json) =>
    _ReadSourceResponse(
      source: json['source'] as String,
      sourceFormat: json['source_format'] as String,
      versionNo: (json['version_no'] as num).toInt(),
      sanitizerV: json['sanitizer_v'] as String,
      stripped: (json['stripped'] as List<dynamic>)
          .map((e) => e as String)
          .toList(),
      willNotRender: (json['will_not_render'] as List<dynamic>)
          .map((e) => e as String)
          .toList(),
      tags: (json['tags'] as List<dynamic>).map((e) => e as String).toList(),
      status: json['status'] as String,
      unsanitized: json['unsanitized'] as bool,
      sourceSha256: json['source_sha256'] as String?,
      title: json['title'] as String?,
      description: json['description'] as String?,
      slug: json['slug'] as String?,
      supersededBy: json['superseded_by'] as String?,
    );

Map<String, dynamic> _$ReadSourceResponseToJson(_ReadSourceResponse instance) =>
    <String, dynamic>{
      'source': instance.source,
      'source_format': instance.sourceFormat,
      'version_no': instance.versionNo,
      'sanitizer_v': instance.sanitizerV,
      'stripped': instance.stripped,
      'will_not_render': instance.willNotRender,
      'tags': instance.tags,
      'status': instance.status,
      'unsanitized': instance.unsanitized,
      'source_sha256': instance.sourceSha256,
      'title': instance.title,
      'description': instance.description,
      'slug': instance.slug,
      'superseded_by': instance.supersededBy,
    };

_RedirectTarget _$RedirectTargetFromJson(Map<String, dynamic> json) =>
    _RedirectTarget(
      publicId: json['public_id'] as String,
      slug: json['slug'] as String?,
      title: json['title'] as String?,
    );

Map<String, dynamic> _$RedirectTargetToJson(_RedirectTarget instance) =>
    <String, dynamic>{
      'public_id': instance.publicId,
      'slug': instance.slug,
      'title': instance.title,
    };

_ReleaseSlugTombstoneResponse _$ReleaseSlugTombstoneResponseFromJson(
  Map<String, dynamic> json,
) => _ReleaseSlugTombstoneResponse(
  released: json['released'] as bool,
  slug: json['slug'] as String,
);

Map<String, dynamic> _$ReleaseSlugTombstoneResponseToJson(
  _ReleaseSlugTombstoneResponse instance,
) => <String, dynamic>{'released': instance.released, 'slug': instance.slug};

_RevokeAgentResponse _$RevokeAgentResponseFromJson(Map<String, dynamic> json) =>
    _RevokeAgentResponse(
      revoked: json['revoked'] as bool,
      agentId: json['agent_id'] as String,
      keysRevoked: (json['keys_revoked'] as num).toInt(),
      oauthClientsDeleted: (json['oauth_clients_deleted'] as num).toInt(),
    );

Map<String, dynamic> _$RevokeAgentResponseToJson(
  _RevokeAgentResponse instance,
) => <String, dynamic>{
  'revoked': instance.revoked,
  'agent_id': instance.agentId,
  'keys_revoked': instance.keysRevoked,
  'oauth_clients_deleted': instance.oauthClientsDeleted,
};

_RevokeKeyResponse _$RevokeKeyResponseFromJson(Map<String, dynamic> json) =>
    _RevokeKeyResponse(
      revoked: json['revoked'] as bool,
      keyId: json['key_id'] as String,
      agentId: json['agent_id'] as String,
      keyPrefix: json['key_prefix'] as String,
    );

Map<String, dynamic> _$RevokeKeyResponseToJson(_RevokeKeyResponse instance) =>
    <String, dynamic>{
      'revoked': instance.revoked,
      'key_id': instance.keyId,
      'agent_id': instance.agentId,
      'key_prefix': instance.keyPrefix,
    };

_RevokeResponse _$RevokeResponseFromJson(Map<String, dynamic> json) =>
    _RevokeResponse(
      revoked: json['revoked'] as bool,
      publicId: json['public_id'] as String,
      r2ObjectsPurged: (json['r2_objects_purged'] as num).toInt(),
    );

Map<String, dynamic> _$RevokeResponseToJson(_RevokeResponse instance) =>
    <String, dynamic>{
      'revoked': instance.revoked,
      'public_id': instance.publicId,
      'r2_objects_purged': instance.r2ObjectsPurged,
    };

_SearchDocumentsResponse _$SearchDocumentsResponseFromJson(
  Map<String, dynamic> json,
) => _SearchDocumentsResponse(
  documents: (json['documents'] as List<dynamic>)
      .map((e) => SearchHit.fromJson(e as Map<String, dynamic>))
      .toList(),
);

Map<String, dynamic> _$SearchDocumentsResponseToJson(
  _SearchDocumentsResponse instance,
) => <String, dynamic>{'documents': instance.documents};

_SearchHit _$SearchHitFromJson(Map<String, dynamic> json) => _SearchHit(
  publicId: json['public_id'] as String,
  createdAt: DateTime.parse(json['created_at'] as String),
  createdByKind: json['created_by_kind'] as String,
  tags: (json['tags'] as List<dynamic>).map((e) => e as String).toList(),
  status: json['status'] as String,
  visibility: json['visibility'] as String,
  score: (json['score'] as num).toDouble(),
  matchedField: json['matched_field'] as String,
  snippet: json['snippet'] as String,
  currentVer: (json['current_ver'] as num?)?.toInt(),
  createdById: json['created_by_id'] as String?,
  createdByName: json['created_by_name'] as String?,
  currentSize: (json['current_size'] as num?)?.toInt(),
  currentSourceSha256: json['current_source_sha256'] as String?,
  revokedAt: json['revoked_at'] == null
      ? null
      : DateTime.parse(json['revoked_at'] as String),
  title: json['title'] as String?,
  description: json['description'] as String?,
  slug: json['slug'] as String?,
  supersededBy: json['superseded_by'] as String?,
);

Map<String, dynamic> _$SearchHitToJson(_SearchHit instance) =>
    <String, dynamic>{
      'public_id': instance.publicId,
      'created_at': instance.createdAt.toIso8601String(),
      'created_by_kind': instance.createdByKind,
      'tags': instance.tags,
      'status': instance.status,
      'visibility': instance.visibility,
      'score': instance.score,
      'matched_field': instance.matchedField,
      'snippet': instance.snippet,
      'current_ver': instance.currentVer,
      'created_by_id': instance.createdById,
      'created_by_name': instance.createdByName,
      'current_size': instance.currentSize,
      'current_source_sha256': instance.currentSourceSha256,
      'revoked_at': instance.revokedAt?.toIso8601String(),
      'title': instance.title,
      'description': instance.description,
      'slug': instance.slug,
      'superseded_by': instance.supersededBy,
    };

_SetDocumentSlugResponse _$SetDocumentSlugResponseFromJson(
  Map<String, dynamic> json,
) => _SetDocumentSlugResponse(
  publicId: json['public_id'] as String,
  redirected: json['redirected'] as bool,
  slug: json['slug'] as String?,
  retired: json['retired'] as String?,
);

Map<String, dynamic> _$SetDocumentSlugResponseToJson(
  _SetDocumentSlugResponse instance,
) => <String, dynamic>{
  'public_id': instance.publicId,
  'redirected': instance.redirected,
  'slug': instance.slug,
  'retired': instance.retired,
};

_SetDocumentStatusResponse _$SetDocumentStatusResponseFromJson(
  Map<String, dynamic> json,
) => _SetDocumentStatusResponse(
  publicId: json['public_id'] as String,
  status: json['status'] as String,
  supersededBy: json['superseded_by'] as String?,
);

Map<String, dynamic> _$SetDocumentStatusResponseToJson(
  _SetDocumentStatusResponse instance,
) => <String, dynamic>{
  'public_id': instance.publicId,
  'status': instance.status,
  'superseded_by': instance.supersededBy,
};

_SetDocumentTagsResponse _$SetDocumentTagsResponseFromJson(
  Map<String, dynamic> json,
) => _SetDocumentTagsResponse(
  publicId: json['public_id'] as String,
  tags: (json['tags'] as List<dynamic>).map((e) => e as String).toList(),
);

Map<String, dynamic> _$SetDocumentTagsResponseToJson(
  _SetDocumentTagsResponse instance,
) => <String, dynamic>{'public_id': instance.publicId, 'tags': instance.tags};

_SetDocumentVisibilityResponse _$SetDocumentVisibilityResponseFromJson(
  Map<String, dynamic> json,
) => _SetDocumentVisibilityResponse(
  publicId: json['public_id'] as String,
  visibility: json['visibility'] as String,
);

Map<String, dynamic> _$SetDocumentVisibilityResponseToJson(
  _SetDocumentVisibilityResponse instance,
) => <String, dynamic>{
  'public_id': instance.publicId,
  'visibility': instance.visibility,
};

_SetSlugRedirectResponse _$SetSlugRedirectResponseFromJson(
  Map<String, dynamic> json,
) => _SetSlugRedirectResponse(
  slug: json['slug'] as String,
  redirectTo: json['redirect_to'] as String,
  targetSlug: json['target_slug'] as String?,
  targetTitle: json['target_title'] as String?,
);

Map<String, dynamic> _$SetSlugRedirectResponseToJson(
  _SetSlugRedirectResponse instance,
) => <String, dynamic>{
  'slug': instance.slug,
  'redirect_to': instance.redirectTo,
  'target_slug': instance.targetSlug,
  'target_title': instance.targetTitle,
};

_WriteResponse _$WriteResponseFromJson(Map<String, dynamic> json) =>
    _WriteResponse(
      publicId: json['public_id'] as String,
      url: json['url'] as String,
      version: (json['version'] as num).toInt(),
      sizeBytes: (json['size_bytes'] as num).toInt(),
      sanitizerV: json['sanitizer_v'] as String,
      modified: json['modified'] as bool,
      stripped: (json['stripped'] as List<dynamic>)
          .map((e) => e as String)
          .toList(),
      willNotRender: (json['will_not_render'] as List<dynamic>)
          .map((e) => e as String)
          .toList(),
      tags: (json['tags'] as List<dynamic>).map((e) => e as String).toList(),
      sourceSha256: json['source_sha256'] as String?,
      title: json['title'] as String?,
      description: json['description'] as String?,
      slug: json['slug'] as String?,
    );

Map<String, dynamic> _$WriteResponseToJson(_WriteResponse instance) =>
    <String, dynamic>{
      'public_id': instance.publicId,
      'url': instance.url,
      'version': instance.version,
      'size_bytes': instance.sizeBytes,
      'sanitizer_v': instance.sanitizerV,
      'modified': instance.modified,
      'stripped': instance.stripped,
      'will_not_render': instance.willNotRender,
      'tags': instance.tags,
      'source_sha256': instance.sourceSha256,
      'title': instance.title,
      'description': instance.description,
      'slug': instance.slug,
    };

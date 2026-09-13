-- Preparation only. One fixed SELECT; never executes an application routine.
-- Run with search_path=pg_catalog, read-only transaction, statement_timeout=10s,
-- lock_timeout=1s. Raw node hashes require the same PG17 patch; differences stop.
-- No server deparsers: they can invoke custom type output routines. Raw node
-- hashes can differ for semantically identical OID-bearing expressions; never
-- normalize such differences away. Only the built-in-only prefix is acceptable.
-- OIDs are never output identities. No body/expression text or rows are returned.
WITH RECURSIVE
ns AS MATERIALIZED (
  SELECT oid, nspname, nspowner, nspacl FROM pg_catalog.pg_namespace
  WHERE nspname = 'desmoslock_v2'
),
rels AS MATERIALIZED (
  SELECT c.* FROM pg_catalog.pg_class c JOIN ns n ON n.oid = c.relnamespace
),
type_names AS MATERIALIZED (
  SELECT t.oid, pg_catalog.quote_ident(n.nspname) || '.' || pg_catalog.quote_ident(t.typname) AS name
  FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
),
types AS MATERIALIZED (
  SELECT t.* FROM pg_catalog.pg_type t JOIN ns n ON n.oid = t.typnamespace
),
routines AS MATERIALIZED (
  SELECT p.*, COALESCE((SELECT pg_catalog.string_agg(t.name, ',' ORDER BY a.ord)
    FROM pg_catalog.unnest(p.proargtypes::oid[]) WITH ORDINALITY a(oid, ord)
    JOIN type_names t ON t.oid = a.oid), '') AS signature
  FROM pg_catalog.pg_proc p JOIN ns n ON n.oid = p.pronamespace
),
columns AS MATERIALIZED (
  SELECT a.*, c.relname, c.relowner FROM pg_catalog.pg_attribute a
  JOIN rels c ON c.oid = a.attrelid WHERE a.attnum > 0 AND NOT a.attisdropped
),
acl_objects(kind, id, object_oid, subid, owner_oid, acl_type, acl) AS MATERIALIZED (
  SELECT 'schema', ARRAY[nspname::text], oid, 0, nspowner, 'n'::"char", nspacl FROM ns
  UNION ALL SELECT 'relation', ARRAY['desmoslock_v2', relname::text], oid, 0, relowner,
    CASE WHEN relkind = 'S' THEN 's' ELSE 'r' END::"char", relacl FROM rels
  WHERE relkind IN ('r','p','v','m','f','S')
  UNION ALL SELECT 'column', ARRAY['desmoslock_v2',relname::text,attname::text],
    attrelid, attnum, relowner, 'c'::"char", attacl FROM columns
  WHERE attrelid IN (SELECT oid FROM rels WHERE relkind IN ('r','p','v','m','f'))
  UNION ALL SELECT 'routine', ARRAY['desmoslock_v2',proname::text,signature], oid, 0,
    proowner, 'f'::"char", proacl FROM routines
  UNION ALL SELECT 'type', ARRAY['desmoslock_v2',typname::text], oid, 0,
    typowner, 'T'::"char", typacl FROM types
),
creation_roles AS MATERIALIZED (
  SELECT owner_oid AS oid FROM acl_objects UNION
  SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user
  UNION SELECT r.oid FROM pg_catalog.pg_roles r CROSS JOIN ns n
    WHERE pg_catalog.has_schema_privilege(r.oid,n.oid,'CREATE')
),
default_acls AS MATERIALIZED (
  SELECT d.*, CASE WHEN d.defaclnamespace = 0 THEN '<global>' ELSE n.nspname::text END AS scope
  FROM pg_catalog.pg_default_acl d LEFT JOIN ns n ON n.oid = d.defaclnamespace
  WHERE d.defaclrole IN (SELECT oid FROM creation_roles)
    AND (d.defaclnamespace = 0 OR n.oid IS NOT NULL)
),
principals AS MATERIALIZED (
  SELECT owner_oid AS oid FROM acl_objects
  UNION SELECT oid FROM creation_roles
  UNION SELECT o FROM pg_catalog.pg_policy p JOIN rels r ON r.oid = p.polrelid
    CROSS JOIN LATERAL pg_catalog.unnest(p.polroles) o
  UNION SELECT a.grantee FROM acl_objects o CROSS JOIN LATERAL pg_catalog.aclexplode(o.acl) a
  UNION SELECT a.grantor FROM acl_objects o CROSS JOIN LATERAL pg_catalog.aclexplode(o.acl) a
  UNION SELECT a.grantee FROM default_acls d CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) a
  UNION SELECT a.grantor FROM default_acls d CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) a
  UNION SELECT oid FROM pg_catalog.pg_roles
    WHERE rolname IN ('anon','authenticated','service_role',current_user)
),
membership_scope(oid) AS (
  SELECT oid FROM principals WHERE oid <> 0
  UNION
  SELECT CASE WHEN m.roleid = s.oid THEN m.member ELSE m.roleid END
  FROM membership_scope s JOIN pg_catalog.pg_auth_members m ON m.roleid = s.oid OR m.member = s.oid
),
roles AS MATERIALIZED (
  SELECT oid, rolname::text AS name, rolsuper, rolinherit, rolbypassrls
  FROM pg_catalog.pg_roles WHERE oid IN (SELECT oid FROM membership_scope)
),
probe_roles AS MATERIALIZED (
  SELECT name FROM roles WHERE oid IN (SELECT oid FROM principals) UNION SELECT 'public'
),
privileges AS MATERIALIZED (
  SELECT o.*, r.name AS role, p.privilege,
    CASE o.acl_type
      WHEN 'n' THEN pg_catalog.has_schema_privilege(r.name::name,o.object_oid,p.privilege)
      WHEN 's' THEN pg_catalog.has_sequence_privilege(r.name::name,o.object_oid,p.privilege)
      WHEN 'r' THEN pg_catalog.has_table_privilege(r.name::name,o.object_oid,p.privilege)
      WHEN 'c' THEN pg_catalog.has_column_privilege(r.name::name,o.object_oid,o.subid::smallint,p.privilege)
      WHEN 'f' THEN pg_catalog.has_function_privilege(r.name::name,o.object_oid,p.privilege)
      WHEN 'T' THEN pg_catalog.has_type_privilege(r.name::name,o.object_oid,p.privilege)
    END AS allowed,
    CASE o.acl_type
      WHEN 'n' THEN pg_catalog.has_schema_privilege(r.name::name,o.object_oid,p.privilege || ' WITH GRANT OPTION')
      WHEN 's' THEN pg_catalog.has_sequence_privilege(r.name::name,o.object_oid,p.privilege || ' WITH GRANT OPTION')
      WHEN 'r' THEN pg_catalog.has_table_privilege(r.name::name,o.object_oid,p.privilege || ' WITH GRANT OPTION')
      WHEN 'c' THEN pg_catalog.has_column_privilege(r.name::name,o.object_oid,o.subid::smallint,p.privilege || ' WITH GRANT OPTION')
      WHEN 'f' THEN pg_catalog.has_function_privilege(r.name::name,o.object_oid,p.privilege || ' WITH GRANT OPTION')
      WHEN 'T' THEN pg_catalog.has_type_privilege(r.name::name,o.object_oid,p.privilege || ' WITH GRANT OPTION')
    END AS grantable
  FROM acl_objects o CROSS JOIN probe_roles r
  CROSS JOIN LATERAL pg_catalog.unnest(CASE o.acl_type
    WHEN 'n' THEN ARRAY['CREATE','USAGE']
    WHEN 's' THEN ARRAY['SELECT','UPDATE','USAGE']
    WHEN 'r' THEN ARRAY['DELETE','INSERT','MAINTAIN','REFERENCES','SELECT','TRIGGER','TRUNCATE','UPDATE']
    WHEN 'c' THEN ARRAY['INSERT','REFERENCES','SELECT','UPDATE']
    WHEN 'f' THEN ARRAY['EXECUTE'] WHEN 'T' THEN ARRAY['USAGE'] END) p(privilege)
),
unsupported_objects(kind,name) AS (
  SELECT 'operator',o.oprname::text || '(' || COALESCE(l.name,'<none>') || ',' || COALESCE(r.name,'<none>') || ')'
  FROM pg_catalog.pg_operator o JOIN ns n ON n.oid = o.oprnamespace
  LEFT JOIN type_names l ON l.oid = o.oprleft LEFT JOIN type_names r ON r.oid = o.oprright
  UNION ALL SELECT 'operator_class',a.amname::text || '.' || o.opcname::text FROM pg_catalog.pg_opclass o JOIN ns n ON n.oid=o.opcnamespace JOIN pg_catalog.pg_am a ON a.oid=o.opcmethod
  UNION ALL SELECT 'operator_family',a.amname::text || '.' || o.opfname::text FROM pg_catalog.pg_opfamily o JOIN ns n ON n.oid=o.opfnamespace JOIN pg_catalog.pg_am a ON a.oid=o.opfmethod
  UNION ALL SELECT 'collation',c.collname::text || ':' || c.collencoding::text FROM pg_catalog.pg_collation c JOIN ns n ON n.oid=c.collnamespace
  UNION ALL SELECT 'conversion',c.conname::text FROM pg_catalog.pg_conversion c JOIN ns n ON n.oid=c.connamespace
  UNION ALL SELECT 'text_search_config',c.cfgname::text FROM pg_catalog.pg_ts_config c JOIN ns n ON n.oid=c.cfgnamespace
  UNION ALL SELECT 'text_search_dictionary',c.dictname::text FROM pg_catalog.pg_ts_dict c JOIN ns n ON n.oid=c.dictnamespace
  UNION ALL SELECT 'text_search_parser',c.prsname::text FROM pg_catalog.pg_ts_parser c JOIN ns n ON n.oid=c.prsnamespace
  UNION ALL SELECT 'text_search_template',c.tmplname::text FROM pg_catalog.pg_ts_template c JOIN ns n ON n.oid=c.tmplnamespace
),
records(kind, id, data) AS (
  SELECT 'context', ARRAY['desmoslock_v2'], pg_catalog.jsonb_build_object(
    'server_version_num', pg_catalog.current_setting('server_version_num')::integer,
    'database', pg_catalog.current_database(), 'query_role', current_user, 'session_role', session_user,
    'search_path', pg_catalog.current_setting('search_path'),
    'read_only', pg_catalog.current_setting('transaction_read_only') = 'on',
    'required_roles_present', (SELECT pg_catalog.count(*) = 3 FROM roles
      WHERE name IN ('anon','authenticated','service_role')),
    'default_acl_roles', ARRAY(SELECT pg_catalog.pg_get_userbyid(oid)::text FROM creation_roles ORDER BY 1))
  UNION ALL
  SELECT 'unsupported_object', ARRAY['desmoslock_v2',kind,name], '{}'::jsonb FROM unsupported_objects
  UNION ALL
  SELECT 'schema', ARRAY[nspname::text], pg_catalog.jsonb_build_object(
    'owner', pg_catalog.pg_get_userbyid(nspowner)) FROM ns
  UNION ALL
  SELECT 'relation', ARRAY['desmoslock_v2',c.relname::text], pg_catalog.jsonb_build_object(
    'kind', c.relkind, 'owner', pg_catalog.pg_get_userbyid(c.relowner),
    'persistence', c.relpersistence, 'is_partition', c.relispartition,
    'rls', c.relrowsecurity, 'force_rls', c.relforcerowsecurity,
    'replica_identity', c.relreplident,
    'has_rules', c.relhasrules, 'has_triggers', c.relhastriggers,
    'parents', ARRAY(SELECT pg_catalog.quote_ident(n.nspname) || '.' || pg_catalog.quote_ident(p.relname)
      FROM pg_catalog.pg_inherits i JOIN pg_catalog.pg_class p ON p.oid = i.inhparent
      JOIN pg_catalog.pg_namespace n ON n.oid = p.relnamespace
      WHERE i.inhrelid = c.oid ORDER BY i.inhseqno),
    'partition_hash', CASE WHEN c.relpartbound IS NOT NULL THEN
      pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(c.relpartbound::text,'UTF8')),'hex') END,
    'options_hash', pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(COALESCE(c.reloptions::text,'<null>'),'UTF8')),'hex'))
  FROM rels c
  UNION ALL
  SELECT 'column', ARRAY['desmoslock_v2',a.relname::text,a.attname::text], pg_catalog.jsonb_build_object(
    'position', a.attnum, 'type', t.name, 'typmod', a.atttypmod,
    'not_null', a.attnotnull, 'identity', a.attidentity, 'generated', a.attgenerated,
    'collation', CASE WHEN co.oid IS NOT NULL THEN pg_catalog.quote_ident(cn.nspname) || '.' || pg_catalog.quote_ident(co.collname) END,
    'has_default', d.oid IS NOT NULL,
    'default_hash', CASE WHEN d.oid IS NOT NULL THEN
      pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(d.adbin::text,'UTF8')),'hex') END)
  FROM columns a JOIN type_names t ON t.oid = a.atttypid
  LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  LEFT JOIN pg_catalog.pg_collation co ON co.oid = a.attcollation
  LEFT JOIN pg_catalog.pg_namespace cn ON cn.oid = co.collnamespace
  UNION ALL
  SELECT 'constraint', ARRAY[CASE WHEN c.conrelid = 0 THEN 'type' ELSE 'relation' END,
    'desmoslock_v2',COALESCE(r.relname,t.typname)::text,c.conname::text], pg_catalog.jsonb_build_object(
    'kind', c.contype, 'validated', c.convalidated, 'deferrable', c.condeferrable,
    'deferred', c.condeferred, 'no_inherit', c.connoinherit, 'is_local', c.conislocal,
    'supporting_index', (SELECT pg_catalog.quote_ident(n.nspname) || '.' || pg_catalog.quote_ident(i.relname)
      FROM pg_catalog.pg_class i JOIN pg_catalog.pg_namespace n ON n.oid = i.relnamespace WHERE i.oid = c.conindid),
    'columns', ARRAY(SELECT a.attname::text FROM pg_catalog.unnest(c.conkey) WITH ORDINALITY k(num,ord)
      JOIN pg_catalog.pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num ORDER BY k.ord),
    'referenced_table', CASE WHEN fr.oid IS NOT NULL THEN pg_catalog.quote_ident(fn.nspname) || '.' || pg_catalog.quote_ident(fr.relname) END,
    'referenced_columns', ARRAY(SELECT a.attname::text FROM pg_catalog.unnest(c.confkey) WITH ORDINALITY k(num,ord)
      JOIN pg_catalog.pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.num ORDER BY k.ord),
    'definition_hash', pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object('expression_node',c.conbin::text,'fk_match',c.confmatchtype,'fk_update',c.confupdtype,'fk_delete',c.confdeltype)::text,'UTF8')),'hex'))
  FROM pg_catalog.pg_constraint c LEFT JOIN rels r ON r.oid = c.conrelid
  LEFT JOIN types t ON t.oid = c.contypid
  LEFT JOIN pg_catalog.pg_class fr ON fr.oid = c.confrelid
  LEFT JOIN pg_catalog.pg_namespace fn ON fn.oid = fr.relnamespace
  WHERE r.oid IS NOT NULL OR t.oid IS NOT NULL
  UNION ALL
  SELECT 'index', ARRAY['desmoslock_v2',r.relname::text], pg_catalog.jsonb_build_object(
    'table', pg_catalog.quote_ident(tn.nspname) || '.' || pg_catalog.quote_ident(t.relname),
    'unique', i.indisunique, 'primary', i.indisprimary, 'exclusion', i.indisexclusion,
    'valid', i.indisvalid, 'ready', i.indisready, 'live', i.indislive,
    'nulls_not_distinct', i.indnullsnotdistinct, 'replica_identity', i.indisreplident,
    'key_count', i.indnkeyatts, 'column_count', i.indnatts,
    'columns', ARRAY(SELECT COALESCE(a.attname::text,'<expression>')
      FROM pg_catalog.unnest(i.indkey::smallint[]) WITH ORDINALITY k(num,ord)
      LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.num ORDER BY k.ord),
    'definition_hash', pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object('access_method',(SELECT amname FROM pg_catalog.pg_am WHERE oid = r.relam),'opclasses',ARRAY(SELECT pg_catalog.quote_ident(n.nspname) || '.' || pg_catalog.quote_ident(o.opcname) FROM pg_catalog.unnest(i.indclass::oid[]) WITH ORDINALITY a(oid,ord) JOIN pg_catalog.pg_opclass o ON o.oid = a.oid JOIN pg_catalog.pg_namespace n ON n.oid = o.opcnamespace ORDER BY a.ord),'collations',ARRAY(SELECT COALESCE(pg_catalog.quote_ident(n.nspname) || '.' || pg_catalog.quote_ident(c.collname),'<none>') FROM pg_catalog.unnest(i.indcollation::oid[]) WITH ORDINALITY a(oid,ord) LEFT JOIN pg_catalog.pg_collation c ON c.oid = a.oid LEFT JOIN pg_catalog.pg_namespace n ON n.oid = c.collnamespace ORDER BY a.ord),'keys',i.indkey::text,'options',i.indoption::text,'expressions_node',i.indexprs::text,'predicate_node',i.indpred::text)::text,'UTF8')),'hex'))
  FROM pg_catalog.pg_index i JOIN rels r ON r.oid = i.indexrelid
  JOIN pg_catalog.pg_class t ON t.oid = i.indrelid JOIN pg_catalog.pg_namespace tn ON tn.oid = t.relnamespace
  UNION ALL
  SELECT 'routine', ARRAY['desmoslock_v2',p.proname::text,p.signature], pg_catalog.jsonb_build_object(
    'kind', p.prokind, 'owner', pg_catalog.pg_get_userbyid(p.proowner), 'language', l.lanname,
    'return_type', rt.name, 'returns_set', p.proretset,
    'all_argument_types', ARRAY(SELECT t.name FROM pg_catalog.unnest(COALESCE(p.proallargtypes,p.proargtypes::oid[]))
      WITH ORDINALITY a(oid,ord) JOIN type_names t ON t.oid = a.oid ORDER BY a.ord),
    'argument_names', COALESCE(p.proargnames,ARRAY[]::text[]),
    'argument_modes', COALESCE(p.proargmodes::text[],ARRAY[]::text[]),
    'default_count', p.pronargdefaults, 'security_definer', p.prosecdef,
    'volatility', p.provolatile, 'strict', p.proisstrict, 'leakproof', p.proleakproof, 'parallel', p.proparallel,
    'body_hash', pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.prosrc,'UTF8')),'hex'),
    'binary_hash', CASE WHEN p.probin IS NOT NULL THEN pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.probin,'UTF8')),'hex') END,
    'has_sql_body', p.prosqlbody IS NOT NULL,
    'definition_hash', CASE WHEN p.prokind <> 'a' THEN
      pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object('source',p.prosrc,'binary',p.probin,'defaults_node',p.proargdefaults::text,'sql_body_node',p.prosqlbody::text,'cost',p.procost,'rows',p.prorows,'has_support',p.prosupport <> 0,'transform_count',COALESCE(pg_catalog.cardinality(p.protrftypes),0),'variadic',(SELECT name FROM type_names WHERE oid = p.provariadic))::text,'UTF8')),'hex') END,
    'config_names', ARRAY(SELECT pg_catalog.split_part(v,'=',1) FROM pg_catalog.unnest(p.proconfig) v ORDER BY v COLLATE "C"),
    'config_hash', pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(COALESCE(p.proconfig::text,'<null>'),'UTF8')),'hex'),
    'sole_empty_search_path', COALESCE(p.proconfig = ARRAY['search_path=""']::text[],false))
  FROM routines p JOIN pg_catalog.pg_language l ON l.oid = p.prolang JOIN type_names rt ON rt.oid = p.prorettype
  UNION ALL
  SELECT 'type', ARRAY['desmoslock_v2',t.typname::text], pg_catalog.jsonb_build_object(
    'kind', t.typtype, 'owner', pg_catalog.pg_get_userbyid(t.typowner),
    'companion', CASE WHEN EXISTS(SELECT 1 FROM pg_catalog.pg_type b WHERE b.typarray = t.oid) THEN 'array'
      WHEN t.typrelid <> 0 AND EXISTS(SELECT 1 FROM rels r WHERE r.oid = t.typrelid AND r.relkind <> 'c') THEN 'relation' ELSE 'user' END,
    'base_type', bt.name, 'element_type', et.name, 'not_null', t.typnotnull, 'typmod', t.typtypmod,
    'relation', (SELECT r.relname FROM rels r WHERE r.oid = t.typrelid),
    'default_hash', CASE WHEN t.typdefault IS NOT NULL THEN pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(t.typdefault,'UTF8')),'hex') END,
    'enum_hash', CASE WHEN t.typtype = 'e' THEN pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
      (SELECT pg_catalog.jsonb_agg(e.enumlabel ORDER BY e.enumsortorder)::text FROM pg_catalog.pg_enum e WHERE e.enumtypid = t.oid),'UTF8')),'hex') END)
  FROM types t LEFT JOIN type_names bt ON bt.oid = t.typbasetype LEFT JOIN type_names et ON et.oid = t.typelem
  UNION ALL
  SELECT 'policy', ARRAY['desmoslock_v2',r.relname::text,p.polname::text], pg_catalog.jsonb_build_object(
    'command', p.polcmd, 'permissive', p.polpermissive,
    'roles', ARRAY(SELECT CASE WHEN o = 0 THEN 'public' ELSE pg_catalog.pg_get_userbyid(o)::text END AS role_name
      FROM pg_catalog.unnest(p.polroles) o ORDER BY role_name),
    'using_hash', CASE WHEN p.polqual IS NOT NULL THEN pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.polqual::text,'UTF8')),'hex') END,
    'check_hash', CASE WHEN p.polwithcheck IS NOT NULL THEN pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.polwithcheck::text,'UTF8')),'hex') END)
  FROM pg_catalog.pg_policy p JOIN rels r ON r.oid = p.polrelid
  UNION ALL
  SELECT 'trigger', ARRAY['desmoslock_v2',r.relname::text,
    CASE WHEN t.tgisinternal AND c.oid IS NOT NULL THEN 'constraint' ELSE 'named' END,
    CASE WHEN t.tgisinternal AND c.oid IS NOT NULL THEN c.conname::text ELSE t.tgname::text END,
    t.tgtype::text], pg_catalog.jsonb_build_object(
    'internal', t.tgisinternal, 'enabled', t.tgenabled,
    'deferrable', t.tgdeferrable, 'initially_deferred', t.tginitdeferred,
    'routine', pg_catalog.quote_ident(n.nspname) || '.' || pg_catalog.quote_ident(p.proname),
    'constraint_table', CASE WHEN cr.oid IS NOT NULL THEN pg_catalog.quote_ident(cn.nspname) || '.' || pg_catalog.quote_ident(cr.relname) END,
    'arguments_hash', pg_catalog.encode(pg_catalog.sha256(t.tgargs),'hex'),
    'when_hash', CASE WHEN t.tgqual IS NOT NULL THEN pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(t.tgqual::text,'UTF8')),'hex') END,
    'definition_hash', CASE WHEN NOT t.tgisinternal THEN pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object('type',t.tgtype,'args',pg_catalog.encode(t.tgargs,'hex'),'columns',t.tgattr::text,'when_node',t.tgqual::text,'old_transition_name',t.tgoldtable,'new_transition_name',t.tgnewtable)::text,'UTF8')),'hex') END)
  FROM pg_catalog.pg_trigger t JOIN rels r ON r.oid = t.tgrelid
  JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  LEFT JOIN pg_catalog.pg_constraint c ON c.oid = t.tgconstraint
  LEFT JOIN pg_catalog.pg_class cr ON cr.oid = c.conrelid LEFT JOIN pg_catalog.pg_namespace cn ON cn.oid = cr.relnamespace
  UNION ALL
  SELECT 'rule', ARRAY['desmoslock_v2',r.relname::text,w.rulename::text], pg_catalog.jsonb_build_object(
    'enabled', w.ev_enabled, 'event', w.ev_type, 'instead', w.is_instead,
    'definition_hash', pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object('qual_node',w.ev_qual::text,'action_node',w.ev_action::text)::text,'UTF8')),'hex'))
  FROM pg_catalog.pg_rewrite w JOIN rels r ON r.oid = w.ev_class
  UNION ALL
  SELECT 'acl', ARRAY[o.kind] || o.id, pg_catalog.jsonb_build_object(
    'is_null', o.acl IS NULL,
    'entries', COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'grantor', pg_catalog.pg_get_userbyid(a.grantor),
      'grantee', CASE WHEN a.grantee = 0 THEN 'public' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END,
      'privilege', a.privilege_type, 'grantable', a.is_grantable)
      ORDER BY pg_catalog.pg_get_userbyid(a.grantor) COLLATE "C", CASE WHEN a.grantee = 0 THEN 'public' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END COLLATE "C", a.privilege_type COLLATE "C", a.is_grantable)
      FROM pg_catalog.aclexplode(COALESCE(o.acl,pg_catalog.acldefault(o.acl_type,o.owner_oid))) a),'[]'::jsonb))
  FROM acl_objects o
  UNION ALL
  SELECT 'effective_acl', ARRAY[kind] || id || ARRAY[role], pg_catalog.jsonb_build_object(
    'privileges', COALESCE(pg_catalog.jsonb_agg(privilege ORDER BY privilege COLLATE "C") FILTER (WHERE allowed),'[]'::jsonb),
    'grant_options', COALESCE(pg_catalog.jsonb_agg(privilege ORDER BY privilege COLLATE "C") FILTER (WHERE grantable),'[]'::jsonb))
  FROM privileges GROUP BY kind,id,role
  UNION ALL
  SELECT 'role', ARRAY[name], pg_catalog.jsonb_build_object(
    'effective_probe', r.oid IN (SELECT oid FROM principals), 'superuser', rolsuper, 'inherit', rolinherit, 'bypass_rls', rolbypassrls,
    'inherits_roles', ARRAY(SELECT p.rolname::text FROM pg_catalog.pg_roles p
      WHERE p.oid <> r.oid AND pg_catalog.pg_has_role(r.oid,p.oid,'USAGE') ORDER BY p.rolname COLLATE "C"),
    'can_set_roles', ARRAY(SELECT p.rolname::text FROM pg_catalog.pg_roles p
      WHERE p.oid <> r.oid AND pg_catalog.pg_has_role(r.oid,p.oid,'SET') ORDER BY p.rolname COLLATE "C"))
  FROM roles r
  UNION ALL
  SELECT 'membership', ARRAY[pg_catalog.pg_get_userbyid(m.roleid)::text,pg_catalog.pg_get_userbyid(m.member)::text,pg_catalog.pg_get_userbyid(m.grantor)::text],
    pg_catalog.jsonb_build_object('admin_option',m.admin_option,'inherit_option',m.inherit_option,'set_option',m.set_option)
  FROM pg_catalog.pg_auth_members m WHERE m.roleid IN (SELECT oid FROM membership_scope) OR m.member IN (SELECT oid FROM membership_scope)
  UNION ALL
  SELECT 'default_acl', ARRAY[pg_catalog.pg_get_userbyid(d.defaclrole)::text,d.scope,d.defaclobjtype::text],
    pg_catalog.jsonb_build_object('entries', COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'grantor', pg_catalog.pg_get_userbyid(a.grantor),
      'grantee', CASE WHEN a.grantee = 0 THEN 'public' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END,
      'privilege', a.privilege_type, 'grantable', a.is_grantable)
      ORDER BY pg_catalog.pg_get_userbyid(a.grantor) COLLATE "C", CASE WHEN a.grantee = 0 THEN 'public' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END COLLATE "C", a.privilege_type COLLATE "C", a.is_grantable)
      FROM pg_catalog.aclexplode(d.defaclacl) a),'[]'::jsonb))
  FROM default_acls d
),
bounded AS MATERIALIZED (
  SELECT kind,id,data,pg_catalog.jsonb_build_object('kind',kind,'id',id,'data',data) AS record
  FROM records LIMIT 2049
),
measure AS (
  SELECT pg_catalog.count(*) AS count, COALESCE(pg_catalog.sum(pg_catalog.octet_length(record::text)),0) AS bytes,
    COALESCE(pg_catalog.max(pg_catalog.octet_length(record::text)),0) AS largest FROM bounded
)
SELECT pg_catalog.jsonb_build_object(
  'format_version', 1, 'schema', 'desmoslock_v2',
  'overflow', m.count > 2048 OR m.bytes > 1048576 OR m.largest > 16384,
  'records', CASE WHEN m.count > 2048 OR m.bytes > 1048576 OR m.largest > 16384 THEN '[]'::jsonb
    ELSE COALESCE((SELECT pg_catalog.jsonb_agg(record ORDER BY kind COLLATE "C",id::text COLLATE "C") FROM bounded),'[]'::jsonb) END
) AS catalog_projection
FROM measure m;

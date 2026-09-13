#!/usr/bin/env python3
"""Pure, fail-closed validator/comparator. No database or network capability."""
import argparse
import hashlib
import json
import re
from pathlib import Path

MAX_BYTES = 1_100_000
MAX_RECORDS = 2048
MAX_RECORD_BYTES = 16384
MAX_DATA_BYTES = 1048576
MAX_DIFFS = 500
MAX_DIFF_BYTES = 131072
HASH = re.compile(r"[0-9a-f]{64}\Z")
PRIVILEGES = {"CREATE", "USAGE", "SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE",
              "REFERENCES", "TRIGGER", "MAINTAIN", "EXECUTE"}
# Every object is closed: a new field or catalog category requires explicit review.
FIELDS = {
    "context": {"server_version_num": "int", "database": "str", "query_role": "str",
                "session_role": "str", "search_path": "str", "read_only": "bool",
                "required_roles_present": "bool", "default_acl_roles": "strings"},
    "schema": {"owner": "str"},
    "relation": {"kind": "str", "owner": "str", "persistence": "str", "is_partition": "bool",
                 "rls": "bool", "force_rls": "bool", "replica_identity": "str",
                 "has_rules": "bool", "has_triggers": "bool", "parents": "strings",
                 "partition_hash": "hash?", "options_hash": "hash"},
    "column": {"position": "int", "type": "str", "typmod": "int", "not_null": "bool",
               "identity": "str", "generated": "str", "collation": "str?", "has_default": "bool",
               "default_hash": "hash?"},
    "constraint": {"kind": "str", "validated": "bool", "deferrable": "bool", "deferred": "bool",
                   "no_inherit": "bool", "is_local": "bool", "supporting_index": "str?", "columns": "strings",
                   "referenced_table": "str?", "referenced_columns": "strings", "definition_hash": "hash"},
    "index": {"table": "str", "unique": "bool", "primary": "bool", "exclusion": "bool",
              "valid": "bool", "ready": "bool", "live": "bool", "nulls_not_distinct": "bool",
              "replica_identity": "bool", "key_count": "int", "column_count": "int", "columns": "strings", "definition_hash": "hash"},
    "routine": {"kind": "str", "owner": "str", "language": "str", "return_type": "str",
                "returns_set": "bool", "all_argument_types": "strings", "argument_names": "strings",
                "argument_modes": "strings", "default_count": "int", "security_definer": "bool",
                "volatility": "str", "strict": "bool", "leakproof": "bool", "parallel": "str",
                "body_hash": "hash", "binary_hash": "hash?", "has_sql_body": "bool",
                "definition_hash": "hash?", "config_names": "strings", "config_hash": "hash",
                "sole_empty_search_path": "bool"},
    "type": {"kind": "str", "owner": "str", "companion": "str", "base_type": "str?",
             "element_type": "str?", "not_null": "bool", "typmod": "int", "relation": "str?",
             "default_hash": "hash?", "enum_hash": "hash?"},
    "policy": {"command": "str", "permissive": "bool", "roles": "strings", "using_hash": "hash?", "check_hash": "hash?"},
    "trigger": {"internal": "bool", "enabled": "str", "deferrable": "bool", "initially_deferred": "bool",
                "routine": "str", "constraint_table": "str?", "arguments_hash": "hash",
                "when_hash": "hash?", "definition_hash": "hash?"},
    "rule": {"enabled": "str", "event": "str", "instead": "bool", "definition_hash": "hash"},
    "acl": {"is_null": "bool", "entries": "acl_entries"},
    "effective_acl": {"privileges": "privileges", "grant_options": "privileges"},
    "role": {"effective_probe": "bool", "superuser": "bool", "inherit": "bool", "bypass_rls": "bool",
             "inherits_roles": "strings", "can_set_roles": "strings"},
    "membership": {"admin_option": "bool", "inherit_option": "bool", "set_option": "bool"},
    "unsupported_object": {},
    "default_acl": {"entries": "acl_entries"},
}
ID_LENGTH = {"context": 1, "schema": 1, "relation": 2, "column": 3, "constraint": 4,
             "index": 2, "routine": 3, "type": 2, "policy": 3, "trigger": 5,
             "rule": 3, "role": 1, "default_acl": 3, "membership": 3, "unsupported_object": 3}
OBJECT_ID_LENGTH = {"schema": 1, "relation": 2, "column": 3, "routine": 3, "type": 2}
ENUMS = {
    ("relation", "kind"): set("ripvmtfcIS"), ("relation", "persistence"): set("put"),
    ("relation", "replica_identity"): set("dnfi"),
    ("column", "identity"): {"", "a", "d"}, ("column", "generated"): {"", "s"},
    ("constraint", "kind"): set("cfpux t".replace(" ", "")),
    ("routine", "kind"): set("fpaw"), ("routine", "volatility"): set("isv"),
    ("routine", "parallel"): set("sru"), ("type", "kind"): set("bcdepmr"),
    ("type", "companion"): {"array", "relation", "user"},
    ("policy", "command"): set("*rawd"), ("trigger", "enabled"): set("ODRA"),
    ("rule", "enabled"): set("ODRA"), ("rule", "event"): set("1234"),
}


class Invalid(ValueError):
    pass


def require(ok, message):
    if not ok:
        raise Invalid(message)


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "duplicate JSON field")
        result[key] = value
    return result


def decode(raw):
    require(isinstance(raw, bytes) and len(raw) <= MAX_BYTES, "input byte cap")
    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=unique_object,
                           parse_constant=lambda _: (_ for _ in ()).throw(Invalid("nonfinite number")))
    except (UnicodeError, ValueError, RecursionError) as error:
        raise Invalid("malformed JSON") from error
    try:
        return validate(value)
    except (UnicodeError, RecursionError) as error:
        raise Invalid("malformed JSON string or nesting") from error


def read(path):
    with Path(path).open("rb") as stream:
        return decode(stream.read(MAX_BYTES + 1))


def scalar(value, descriptor):
    if descriptor.endswith("?"):
        return value is None or scalar(value, descriptor[:-1])
    if descriptor == "str":
        return isinstance(value, str) and len(value.encode("utf-8")) <= 2048 and not any(ord(c) < 32 for c in value)
    if descriptor == "int":
        return type(value) is int and -(2**31) <= value < 2**31
    if descriptor == "bool":
        return type(value) is bool
    if descriptor == "hash":
        return isinstance(value, str) and bool(HASH.fullmatch(value))
    if descriptor in ("strings", "privileges"):
        if not isinstance(value, list) or len(value) > 128 or not all(scalar(v, "str") for v in value):
            return False
        return descriptor == "strings" or (value == sorted(set(value)) and set(value) <= PRIVILEGES)
    if descriptor == "acl_entries":
        if not isinstance(value, list) or len(value) > 256:
            return False
        for entry in value:
            if not isinstance(entry, dict) or set(entry) != {"grantor", "grantee", "privilege", "grantable"}:
                return False
            if not all(scalar(entry[k], "str") and entry[k] for k in ("grantor", "grantee", "privilege")):
                return False
            if type(entry["grantable"]) is not bool or entry["privilege"] not in PRIVILEGES:
                return False
        keys = [(e["grantor"], e["grantee"], e["privilege"], e["grantable"]) for e in value]
        return keys == sorted(set(keys))
    raise AssertionError(descriptor)


def key(record):
    return record["kind"], tuple(record["id"])


def validate(value):
    require(isinstance(value, dict) and set(value) == {"format_version", "schema", "overflow", "records"}, "closed envelope")
    require(type(value["format_version"]) is int and value["format_version"] == 1, "format version")
    require(value["schema"] == "desmoslock_v2" and value["overflow"] is False, "scope or server overflow")
    rows = value["records"]
    require(isinstance(rows, list) and 1 <= len(rows) <= MAX_RECORDS, "record cap")
    require(sum(len(canonical(r).encode()) for r in rows) <= MAX_DATA_BYTES, "record byte cap")
    seen = set()
    for r in rows:
        require(isinstance(r, dict) and set(r) == {"kind", "id", "data"}, "closed record")
        require(isinstance(r["kind"], str) and r["kind"] in FIELDS, "unknown record kind")
        kind, identity, data = r["kind"], r["id"], r["data"]
        require(len(canonical(r).encode()) <= MAX_RECORD_BYTES, "single record byte cap")
        require(isinstance(identity, list) and all(scalar(v, "str") for v in identity), "identity shape")
        if kind in ("acl", "effective_acl"):
            require(bool(identity) and identity[0] in OBJECT_ID_LENGTH, "ACL object kind")
            expected = 1 + OBJECT_ID_LENGTH[identity[0]] + (kind == "effective_acl")
            require(len(identity) == expected and identity[1] == "desmoslock_v2", "ACL identity")
        else:
            require(len(identity) == ID_LENGTH[kind], "identity length")
            if kind not in ("role", "membership", "default_acl"):
                require(identity[1 if kind == "constraint" else 0] == "desmoslock_v2", "object schema")
        require(all(v != "" for i, v in enumerate(identity) if not (
            (kind == "routine" and i == 2) or
            (kind in ("acl", "effective_acl") and identity[0] == "routine" and i == 3))), "empty identity")
        if kind == "constraint":
            require(identity[0] in ("relation", "type"), "constraint object kind")
        if kind == "default_acl":
            require(identity[1] in ("<global>", "desmoslock_v2") and identity[2] in set("rSfTn"), "default ACL scope")
        require(key(r) not in seen, "duplicate object identity")
        seen.add(key(r))
        require(isinstance(data, dict) and set(data) == set(FIELDS[kind]), "closed data fields")
        for field, descriptor in FIELDS[kind].items():
            require(scalar(data[field], descriptor), f"invalid {kind}.{field}")
            if (kind, field) in ENUMS:
                require(data[field] in ENUMS[kind, field], f"invalid enum {kind}.{field}")
        if kind == "column":
            require(1 <= data["position"] <= 1600 and data["has_default"] == (data["default_hash"] is not None), "column invariant")
        if kind == "routine":
            require(0 <= data["default_count"] <= len(data["all_argument_types"]), "routine default count")
            require(all(v in set("iobvt") for v in data["argument_modes"]), "argument modes")
            require((data["kind"] == "a") == (data["definition_hash"] is None), "routine definition invariant")
        if kind == "effective_acl":
            require(set(data["grant_options"]) <= set(data["privileges"]), "grant option without privilege")
    contexts = [r for r in rows if r["kind"] == "context"]
    require(len(contexts) == 1, "one context required")
    context = contexts[0]["data"]
    require(170000 <= context["server_version_num"] < 180000, "PG17 required")
    require(context["search_path"] == "pg_catalog" and context["read_only"] is True, "unsafe query session")
    require(context["required_roles_present"], "required roles absent")
    require(len(context["default_acl_roles"]) == len(set(context["default_acl_roles"])), "duplicate default ACL role")
    require(len([r for r in rows if r["kind"] == "schema"]) == 1, "one schema required")
    # Cross-record checks catch missing linked ACLs; full completeness additionally
    # requires a trusted SAME QUERY reference and exact source-prefix checks.
    for r in rows:
        kind, identity = r["kind"], tuple(r["id"])
        if kind in ("acl", "effective_acl"):
            base_id = identity[1:-1] if kind == "effective_acl" else identity[1:]
            require((identity[0], base_id) in seen, "orphan ACL")
        if kind in ("column", "policy", "trigger", "rule"):
            require(("relation", identity[:2]) in seen, "orphan relation child")
    role_names = {r["id"][0] for r in rows if r["kind"] == "role"}
    probe_names = {r["id"][0] for r in rows if r["kind"] == "role" and r["data"]["effective_probe"]}
    require({"anon", "authenticated", "service_role", context["query_role"]} <= role_names, "role inventory incomplete")
    require(set(context["default_acl_roles"]) <= probe_names, "default ACL role inventory incomplete")
    for r in rows:
        kind, identity, data = r["kind"], tuple(r["id"]), r["data"]
        if kind in ("schema", "routine", "type") or (kind == "relation" and data["kind"] in set("rpvmfS")) or (
            kind == "column" and next(x for x in rows if key(x) == ("relation", identity[:2]))["data"]["kind"] in set("rpvmf")):
            require(("acl", (kind,) + identity) in seen, "explicit ACL inventory incomplete")
            for role in probe_names | {"public"}:
                require(("effective_acl", (kind,) + identity + (role,)) in seen, "effective ACL inventory incomplete")
        if "owner" in data:
            require(data["owner"] in role_names, "owner role inventory incomplete")
    return value


def check_prefix(value, expectations):
    """Source checks are necessary only; they never assert catalog equivalence."""
    validate(value)
    rows = value["records"]
    tables = {r["id"][1] for r in rows if r["kind"] == "relation" and r["data"]["kind"] == "r"}
    require(tables == {t["name"] for t in expectations["tables"]}, "prefix table inventory mismatch")
    require(all(r["data"]["kind"] in ("r", "i") for r in rows if r["kind"] == "relation"), "unexpected relation kind")
    require(all(r["data"]["rls"] for r in rows if r["kind"] == "relation" and r["data"]["kind"] == "r"), "prefix RLS mismatch")
    routines = [r for r in rows if r["kind"] == "routine"]
    expected = {(f["name"], "pg_catalog._text" if f["name"] == "internal_frame_text" else ""): f for f in expectations["functions"]}
    require({(r["id"][1], r["id"][2]) for r in routines} == set(expected), "prefix routine inventory mismatch")
    for r in routines:
        d, e = r["data"], expected[r["id"][1], r["id"][2]]
        require(d["kind"] == "f" and d["language"] == "sql" and not d["has_sql_body"] and d["binary_hash"] is None, "prefix routine kind mismatch")
        require(d["body_hash"] == e["sourceDollarQuotedBodySha256"], "source body hash mismatch")
    require(not any(r["kind"] in ("policy", "rule") for r in rows), "unexpected policy or rule")
    require(not any(r["kind"] == "trigger" and not r["data"]["internal"] for r in rows), "unexpected user trigger")
    require(not any(r["kind"] == "type" and r["data"]["companion"] == "user" for r in rows), "unexpected user type")
    require(not any(r["kind"] == "unsupported_object" for r in rows), "unexpected unsupported namespace object")
    return {"source_prefix_checks": "pass", "catalog_equivalence": "not_established"}


def compare(reference, target):
    validate(reference)
    validate(target)
    left = {key(r): r["data"] for r in reference["records"]}
    right = {key(r): r["data"] for r in target["records"]}
    context_key = ("context", ("desmoslock_v2",))
    lc, rc = left[context_key], right[context_key]
    compatible = lc["server_version_num"] == rc["server_version_num"] and lc["search_path"] == rc["search_path"]
    differences = []
    for k in sorted(left.keys() | right.keys()):
        if k[0] == "context":
            if lc["default_acl_roles"] != rc["default_acl_roles"]:
                differences.append({"kind": "context", "id": ["desmoslock_v2"], "change": "changed",
                    "fields": {"default_acl_roles": {"reference": lc["default_acl_roles"], "target": rc["default_acl_roles"]}}})
            continue  # Database/query/session identities remain visible informational context.
        if k not in left or k not in right:
            differences.append({"kind": k[0], "id": list(k[1]), "change": "added" if k not in left else "missing"})
        elif left[k] != right[k]:
            changes = {f: {"reference": left[k][f], "target": right[k][f]}
                       for f in sorted(left[k]) if left[k][f] != right[k][f]}
            differences.append({"kind": k[0], "id": list(k[1]), "change": "changed", "fields": changes})
    shown = []
    shown_bytes = 0
    for difference in differences:
        size = len(canonical(difference).encode())
        if len(shown) == MAX_DIFFS or shown_bytes + size > MAX_DIFF_BYTES:
            break
        shown.append(difference)
        shown_bytes += size
    return {"format_version": 1, "reference_hash": sha(reference), "target_hash": sha(target),
            "status": "match" if compatible and not differences else "review_required",
            "node_hash_version_compatible": compatible,
            "context": {"reference": lc, "target": rc},
            "difference_count": len(differences), "differences_truncated": len(shown) < len(differences),
            "differences": shown,
            "limit": "Namespace projection only; no fixture-row, Auth/API, platform-global, or rollout-readiness claim."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("validate", "compare"))
    parser.add_argument("reference")
    parser.add_argument("target", nargs="?")
    parser.add_argument("--expectations")
    args = parser.parse_args()
    try:
        ref = read(args.reference)
        if args.expectations:
            expected = json.loads(Path(args.expectations).read_text())
            check_prefix(ref, expected)
        if args.mode == "compare":
            require(args.target is not None, "target required")
            require(args.expectations is not None, "comparison requires source expectations")
            target = read(args.target)
            result = compare(ref, target)
            try:
                check_prefix(target, expected)
                result["target_source_prefix"] = "pass"
            except Invalid as error:
                result["target_source_prefix"] = str(error)
                result["status"] = "review_required"
            code = 0 if result["status"] == "match" else 2
        else:
            require(args.target is None, "unexpected target argument")
            result = {"status": "valid", "records": len(ref["records"]), "sha256": sha(ref),
                      "catalog_equivalence": "not_established"}
            code = 0
        print(json.dumps(result, sort_keys=True, indent=2))
        return code
    except (Invalid, OSError, ValueError) as error:
        print(json.dumps({"status": "rejected", "reason": str(error)}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

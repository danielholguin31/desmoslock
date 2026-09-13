import copy
import json
import re
import unittest
from pathlib import Path

import validate as v


def record(kind, identity, data):
    return {"kind": kind, "id": identity, "data": data}


def fixture():
    roles = ["anon", "authenticated", "service_role", "supabase_admin"]
    rows = [record("context", ["desmoslock_v2"], {
        "server_version_num": 170006, "database": "postgres", "query_role": "supabase_admin",
        "session_role": "supabase_admin", "search_path": "pg_catalog", "read_only": True,
        "required_roles_present": True, "default_acl_roles": ["supabase_admin"]}),
        record("schema", ["desmoslock_v2"], {"owner": "supabase_admin"}),
        record("acl", ["schema", "desmoslock_v2"], {"is_null": False, "entries": []})]
    for role in roles:
        rows.append(record("role", [role], {"effective_probe": True, "superuser": role == "supabase_admin",
            "inherit": True, "bypass_rls": role == "service_role", "inherits_roles": [], "can_set_roles": []}))
    for role in roles + ["public"]:
        rows.append(record("effective_acl", ["schema", "desmoslock_v2", role], {"privileges": [], "grant_options": []}))
    return {"format_version": 1, "schema": "desmoslock_v2", "overflow": False, "records": rows}


class ValidationTests(unittest.TestCase):
    def assert_rejected(self, mutate):
        value = fixture()
        mutate(value)
        with self.assertRaises(v.Invalid):
            v.decode(json.dumps(value).encode())

    def test_positive_synthetic_shape_and_identity_compare(self):
        value = fixture()
        self.assertEqual(v.decode(json.dumps(value).encode()), value)
        self.assertEqual(v.compare(value, copy.deepcopy(value))["status"], "match")

    def test_closed_envelope_record_and_nested_fields(self):
        for mutate in (
            lambda x: x.update(secret="not permitted"),
            lambda x: x["records"][0].update(oid=123),
            lambda x: x["records"][1]["data"].update(body="not permitted"),
            lambda x: x["records"][2]["data"]["entries"].append({"grantor": "a", "grantee": "b", "privilege": "USAGE", "grantable": False, "extra": 1}),
        ):
            with self.subTest(mutate=mutate):
                self.assert_rejected(mutate)

    def test_malformed_duplicate_nonfinite_and_trailing_json(self):
        for raw in (b"{", b"{}{}", b'\xff', b'{"a":1,"a":2}', b'{"n":NaN}'):
            with self.subTest(raw=raw), self.assertRaises(v.Invalid):
                v.decode(raw)
        malformed = json.dumps(fixture()).replace('"supabase_admin"', '"\\ud800"').encode()
        with self.assertRaises(v.Invalid):
            v.decode(malformed)

    def test_missing_hash_invalid_enum_and_changed_body_are_visible(self):
        def routine():
            data = {}
            for field, descriptor in v.FIELDS["routine"].items():
                data[field] = {"str": "x", "str?": None, "strings": [], "int": 0,
                               "bool": False, "hash": "0" * 64, "hash?": None}[descriptor]
            data.update(kind="f", owner="supabase_admin", language="sql", return_type="pg_catalog.text",
                        volatility="s", parallel="s", definition_hash="1" * 64)
            return record("routine", ["desmoslock_v2", "example", ""], data)
        ref = fixture()
        ref["records"].append(routine())
        ref["records"].append(record("acl", ["routine", "desmoslock_v2", "example", ""], {"is_null": False, "entries": []}))
        for role in ["anon", "authenticated", "service_role", "supabase_admin", "public"]:
            ref["records"].append(record("effective_acl", ["routine", "desmoslock_v2", "example", "", role], {"privileges": [], "grant_options": []}))
        target = copy.deepcopy(ref)
        next(r for r in target["records"] if r["kind"] == "routine")["data"]["body_hash"] = "2" * 64
        result = v.compare(ref, target)
        self.assertEqual(set(result["differences"][0]["fields"]), {"body_hash"})
        for field, invalid in [("body_hash", "bad"), ("definition_hash", None), ("volatility", "unknown")]:
            bad = copy.deepcopy(ref)
            next(r for r in bad["records"] if r["kind"] == "routine")["data"][field] = invalid
            with self.subTest(field=field), self.assertRaises(v.Invalid):
                v.validate(bad)

    def test_source_prefix_checks_are_necessary_but_not_equivalence(self):
        expected = json.loads(Path(__file__).with_name("catalog-source-expectations.json").read_text())
        value = fixture()
        def add_object(category, identity, **overrides):
            defaults = {"str": "", "str?": None, "strings": [], "int": 0, "bool": False,
                        "hash": "0" * 64, "hash?": None}
            data = {f: copy.deepcopy(defaults[d]) for f, d in v.FIELDS[category].items()}
            data.update(overrides)
            value["records"].append(record(category, identity, data))
            value["records"].append(record("acl", [category] + identity, {"is_null": False, "entries": []}))
            for role in ["anon", "authenticated", "service_role", "supabase_admin", "public"]:
                value["records"].append(record("effective_acl", [category] + identity + [role], {"privileges": [], "grant_options": []}))
        for table in expected["tables"]:
            add_object("relation", ["desmoslock_v2", table["name"]], kind="r", owner="supabase_admin",
                       persistence="p", rls=True, replica_identity="d")
        for function in expected["functions"]:
            signature = "pg_catalog._text" if function["name"] == "internal_frame_text" else ""
            add_object("routine", ["desmoslock_v2", function["name"], signature], kind="f",
                       owner="supabase_admin", language="sql", return_type="pg_catalog.text",
                       volatility="s", parallel="u", definition_hash="1" * 64,
                       body_hash=function["sourceDollarQuotedBodySha256"])
        self.assertEqual(v.check_prefix(value, expected)["catalog_equivalence"], "not_established")
        changed = copy.deepcopy(value)
        next(r for r in changed["records"] if r["kind"] == "routine")["data"]["body_hash"] = "2" * 64
        with self.assertRaisesRegex(v.Invalid, "source body hash"):
            v.check_prefix(changed, expected)
        changed = copy.deepcopy(value)
        changed["records"].append(record("unsupported_object", ["desmoslock_v2", "operator", "unexpected"], {}))
        with self.assertRaisesRegex(v.Invalid, "unexpected unsupported"):
            v.check_prefix(changed, expected)

    def test_invalid_types_and_missing_context(self):
        for mutate in (
            lambda x: x.update(format_version=True),
            lambda x: x.update(overflow="false"),
            lambda x: x["records"][0]["data"].update(server_version_num=True),
            lambda x: x["records"][0]["data"].update(read_only=False),
            lambda x: x["records"][0]["data"].update(search_path="public"),
            lambda x: x["records"].pop(0),
            lambda x: x["records"][1].update(kind="unknown"),
            lambda x: x["records"][1].update(id=["elsewhere"]),
            lambda x: x["records"][1]["data"].update(owner="x\nsecret"),
            lambda x: x["records"][1]["data"].update(owner="x" * 2049),
        ):
            with self.subTest(mutate=mutate):
                self.assert_rejected(mutate)

    def test_overflow_and_all_size_caps(self):
        with self.assertRaises(v.Invalid):
            v.decode(b" " * (v.MAX_BYTES + 1))
        self.assert_rejected(lambda x: x.update(overflow=True))
        self.assert_rejected(lambda x: x.update(records=x["records"] * v.MAX_RECORDS))
        self.assert_rejected(lambda x: x["records"][3]["data"].update(inherits_roles=["x" * 2048] * 128))
        self.assert_rejected(lambda x: x["records"][3]["data"].update(inherits_roles=["x"] * 129))

    def test_duplicates_truncation_and_orphan_acl(self):
        self.assert_rejected(lambda x: x["records"].append(copy.deepcopy(x["records"][1])))
        self.assert_rejected(lambda x: x["records"].pop())
        self.assert_rejected(lambda x: x["records"][2].update(id=["relation", "desmoslock_v2", "unknown"]))
        self.assert_rejected(lambda x: x["records"][1]["data"].update(owner="missing_role"))

    def test_null_versus_empty_acl_and_grant_options(self):
        ref, target = fixture(), fixture()
        target["records"][2]["data"]["is_null"] = True
        result = v.compare(ref, target)
        self.assertEqual(result["status"], "review_required")
        self.assertEqual(result["differences"][0]["fields"]["is_null"], {"reference": False, "target": True})
        self.assert_rejected(lambda x: x["records"][-1]["data"].update(grant_options=["USAGE"]))
        self.assert_rejected(lambda x: x["records"][-1]["data"].update(privileges=["USAGE", "USAGE"]))
        self.assert_rejected(lambda x: x["records"][-1]["data"].update(privileges=["PASSWORD"]))

    def test_owner_and_membership_drift_are_visible(self):
        ref, target = fixture(), fixture()
        target["records"][1]["data"]["owner"] = "authenticated"
        target["records"].append(record("membership", ["authenticated", "anon", "supabase_admin"],
            {"admin_option": True, "inherit_option": True, "set_option": True}))
        changes = v.compare(ref, target)["differences"]
        self.assertEqual({x["kind"] for x in changes}, {"schema", "membership"})

    def test_same_major_different_patch_requires_review(self):
        target = fixture()
        target["records"][0]["data"]["server_version_num"] += 1
        result = v.compare(fixture(), target)
        self.assertEqual(result["status"], "review_required")
        self.assertFalse(result["node_hash_version_compatible"])

    def test_default_acl_scope_difference_is_not_a_match(self):
        target = fixture()
        target["records"][0]["data"]["default_acl_roles"] = ["authenticated", "supabase_admin"]
        result = v.compare(fixture(), target)
        self.assertEqual(result["status"], "review_required")
        self.assertEqual(set(result["differences"][0]["fields"]), {"default_acl_roles"})
        self.assert_rejected(lambda x: x["records"][0]["data"].update(default_acl_roles=["supabase_admin", "supabase_admin"]))
        self.assert_rejected(lambda x: x["records"][0]["data"].update(default_acl_roles=["absent_role"]))

    def test_unexpected_objects_retained_in_diff(self):
        target = fixture()
        target["records"].append(record("unsupported_object", ["desmoslock_v2", "conversion", "unexpected"], {}))
        result = v.compare(fixture(), target)
        self.assertEqual(result["differences"][0]["id"], ["desmoslock_v2", "conversion", "unexpected"])

    def test_difference_report_is_bounded(self):
        target = fixture()
        for i in range(v.MAX_DIFFS + 1):
            target["records"].append(record("unsupported_object", ["desmoslock_v2", "conversion", f"extra_{i}"], {}))
        result = v.compare(fixture(), target)
        self.assertEqual(result["status"], "review_required")
        self.assertEqual(len(result["differences"]), v.MAX_DIFFS)
        self.assertTrue(result["differences_truncated"])

    def test_query_has_no_deparsers_or_mutations(self):
        sql = Path(__file__).with_name("catalog.sql").read_text()
        code = "\n".join(line for line in sql.splitlines() if not line.lstrip().startswith("--"))
        self.assertEqual(code.count(";"), 1)
        self.assertTrue(code.startswith("WITH RECURSIVE"))
        for forbidden in ("pg_get_expr", "pg_get_functiondef", "pg_get_constraintdef", "pg_get_indexdef",
                          "pg_get_triggerdef", "pg_get_ruledef", "pg_authid", "rolpassword", "set_config",
                          "desmoslock_v2.", "information_schema", "pg_read_file", "pg_stat_"):
            self.assertNotIn(forbidden, code)
        self.assertIn("LIMIT 2049", code)
        self.assertIn("m.bytes > 1048576", code)
        ctes = re.findall(r"^([a-z_]+)(?:\([^\n]*\))? AS(?: MATERIALIZED)? \($", code, re.M)
        self.assertEqual(len(ctes), len(set(ctes)))
        self.assertEqual(set(ctes), {"ns", "rels", "type_names", "types", "routines", "columns",
            "acl_objects", "creation_roles", "default_acls", "principals", "membership_scope",
            "roles", "probe_roles", "privileges", "unsupported_objects", "records", "bounded", "measure"})


if __name__ == "__main__":
    unittest.main()

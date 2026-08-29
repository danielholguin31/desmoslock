import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

export function fail(message) {
  throw new Error(message);
}

export function readJson(repositoryRoot, relativePath) {
  return JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8"),
  );
}

export function readText(repositoryRoot, relativePath) {
  return fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8");
}

export function requireEqual(actual, expected, label) {
  if (!isDeepStrictEqual(actual, expected)) {
    fail(
      `${label} differs:\nexpected ${JSON.stringify(expected)}\nreceived ${JSON.stringify(actual)}`,
    );
  }
}

export function requireObjectKeys(object, expectedKeys, label) {
  if (object === null || typeof object !== "object" || Array.isArray(object)) {
    fail(`${label} must be an object`);
  }
  requireEqual(
    Object.keys(object).sort(),
    [...expectedKeys].sort(),
    `${label} keys`,
  );
}

export function requireSha(value, label, length = 40) {
  if (!new RegExp(`^[0-9a-f]{${length}}$`, "u").test(String(value))) {
    fail(
      `${label} must be a lowercase ${length}-character hexadecimal identity`,
    );
  }
}

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHook } from "node:async_hooks";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const filename = fileURLToPath(import.meta.url);
const addonPath = fileURLToPath(
  new URL(
    "../../apps/desktop/dist/native/durable-record.node",
    import.meta.url,
  ),
);
const require = createRequire(import.meta.url);
const execute = promisify(execFile);
const recordName = "student-session.record";
const lockName = "student-session.lock";
const native = process.platform === "darwin" ? require(addonPath) : null;

async function childMain() {
  let store;
  let loaded = false;
  let egress = false;
  const directory = process.argv[3];
  const mode = process.argv[4];
  try {
    store = await native.openStore(directory);
    const current = await store.loadEncryptedRecord();
    loaded = true;
    let counter = current === null ? 0 : JSON.parse(current.toString()).counter;
    if (mode === "owner" || mode === "successor") {
      const originalCounter = counter;
      counter = mode === "owner" ? 10 : counter + 1;
      await store.replaceEncryptedRecord(
        Buffer.from(JSON.stringify({ synthetic: true, counter })),
      );
      egress = true;
      childResponse({
        status: "acquired",
        originalCounter,
        counter,
        loaded,
        egress,
      });
    } else if (mode !== "gc" && mode !== "teardown")
      childResponse({ status: "acquired", counter, loaded, egress });
    if (mode === "teardown") {
      await store.replaceEncryptedRecord(Buffer.from("synthetic teardown"));
      childResponse({ status: "teardown-written" });
      return;
    }
    if (mode === "gc") {
      store = null;
      global.gc();
      global.gc();
      childResponse({ status: "unreferenced" });
    }
    const commands = createInterface({ input: process.stdin });
    commands.on("line", async (line) => {
      const { operation, counter: nextCounter } = JSON.parse(line);
      try {
        if (operation === "replace") {
          await store.replaceEncryptedRecord(
            Buffer.from(
              JSON.stringify({ synthetic: true, counter: nextCounter }),
            ),
          );
        } else if (operation === "quarantine")
          await store.quarantineEncryptedRecord();
        else if (operation === "close") {
          await store.close();
          childResponse({ status: "closed" }, () => {
            commands.close();
            process.stdin.destroy();
          });
          return;
        }
        childResponse({ status: "completed", operation });
      } catch (error) {
        childResponse({
          status: "failed",
          code: error.code,
          stage: error.stage,
        });
      }
    });
  } catch (error) {
    childResponse({
      status: "failed",
      code: error.code,
      stage: error.stage,
      errno: error.errno,
      loaded,
      egress,
    });
  }
}

function childResponse(message, callback) {
  process.stdout.write(`${JSON.stringify(message)}\n`, callback);
}

function nextMessage(child) {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(
      () => finish(new Error("Native child response timed out")),
      10_000,
    );
    const onMessage = (message) => finish(null, message);
    const onExit = (code, signal) =>
      finish(
        new Error(`Native child exited before response: ${code}/${signal}`),
      );
    function finish(error, message) {
      clearTimeout(deadline);
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("error", finish);
      if (error) reject(error);
      else resolve(message);
    }
    child.once("message", onMessage);
    child.once("exit", onExit);
    child.once("error", finish);
  });
}

function exited(child) {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve();
  return new Promise((resolve) => child.once("exit", resolve));
}

async function fixture(t) {
  const root = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "desmoslock-native-record-"),
  );
  const handles = [];
  const children = [];
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      await exited(child);
    }
    for (const handle of handles) {
      try {
        await handle.close();
      } catch (error) {
        if (error.code !== "STORE_CLOSED") throw error;
      }
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    root,
    async open(directory = root) {
      const handle = await native.openStore(directory);
      handles.push(handle);
      return handle;
    },
    launch(mode, directory = root) {
      const child = spawn(
        process.execPath,
        ["--expose-gc", filename, "--native-child", directory, mode],
        {
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            PATH: process.env.PATH ?? "",
            TMPDIR: root,
            LC_ALL: "C",
            NODE_DISABLE_COMPILE_CACHE: "1",
          },
        },
      );
      const responses = createInterface({ input: child.stdout });
      responses.on("line", (line) => child.emit("message", JSON.parse(line)));
      child.send = (message) =>
        child.stdin.write(`${JSON.stringify(message)}\n`);
      children.push(child);
      return child;
    },
  };
}

async function compileFixture(root, name, source, executable = false) {
  const compiler = process.env.DESMOSLOCK_NATIVE_CLANG;
  const sdk = process.env.DESMOSLOCK_NATIVE_SDK;
  const headers = process.env.DESMOSLOCK_NATIVE_NODE_HEADERS;
  assert.ok(
    compiler && sdk && headers,
    "Native syscall acceptance requires the selected compiler, SDK and headers",
  );
  const sourcePath = path.join(root, `${name}.c`);
  const output = path.join(root, `${name}${executable ? "" : ".node"}`);
  await fs.writeFile(sourcePath, source, { mode: 0o600 });
  await execute(
    compiler,
    [
      "-std=c11",
      "-arch",
      process.arch === "x64" ? "x86_64" : "arm64",
      "-mmacosx-version-min=13.0",
      "-fno-modules",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-isysroot",
      sdk,
      "-I",
      headers,
      "-B",
      path.dirname(compiler),
      ...(executable
        ? []
        : [
            "-DNAPI_VERSION=8",
            "-DNODE_GYP_MODULE_NAME=durable_record_fixture",
            "-bundle",
            "-undefined",
            "dynamic_lookup",
          ]),
      sourcePath,
      "-o",
      output,
    ],
    {
      env: {
        PATH: `${path.dirname(compiler)}:/usr/bin:/bin`,
        LC_ALL: "C",
        TMPDIR: root,
        CLANG_MODULE_CACHE_PATH: root,
      },
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    },
  );
  return output;
}

function syscallFixture(mode, helper = "") {
  const production = fileURLToPath(
    new URL("../../apps/desktop/native/durable-record.c", import.meta.url),
  );
  return `
#include <node_api.h>
#include <fcntl.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdarg.h>
#include <string.h>
static int fixture_fcntl(int fd, int command, ...);
static int fixture_renameat(int a, const char *b, int c, const char *d);
static int fixture_flock(int fd, int operation);
#define fcntl fixture_fcntl
#define renameat fixture_renameat
#define flock fixture_flock
#include ${JSON.stringify(production)}
#undef fcntl
#undef renameat
#undef flock
static int injected = 0;
static int published_fixture = 0;
static int fixture_fcntl(int fd, int command, ...) {
  struct stat status;
  if (command != F_FULLFSYNC) { errno = EINVAL; return -1; }
  if (!injected && fstat(fd, &status) == 0 &&
      ((${mode} == 1 && S_ISREG(status.st_mode) && status.st_size > 0) ||
       (${mode} == 3 && published_fixture && S_ISDIR(status.st_mode)))) {
    injected = 1; errno = EIO; return -1;
  }
  return fcntl(fd, command);
}
static int fixture_renameat(int a, const char *b, int c, const char *d) {
  if (${mode} == 2 && !injected) { injected = 1; errno = EIO; return -1; }
  int result = renameat(a, b, c, d);
  if (result == 0) published_fixture = 1;
  return result;
}
static int fixture_flock(int fd, int operation) {
  if (${mode} == 4) { errno = ENOTSUP; return -1; }
  int result = flock(fd, operation);
  if (result != 0 || ${mode} != 5) return result;
  if ((fcntl(fd, F_GETFD) & FD_CLOEXEC) == 0) { errno = EIO; return -1; }
  char number[32];
  snprintf(number, sizeof(number), "%d", fd);
  char *args[] = {${JSON.stringify(helper)}, number, NULL};
  pid_t child = fork();
  if (child == 0) { execv(args[0], args); _exit(99); }
  int status = 0;
  if (child < 0) return -1;
  pid_t waited;
  do { waited = waitpid(child, &status, 0); } while (waited < 0 && errno == EINTR);
  if (waited != child || !WIFEXITED(status) || WEXITSTATUS(status) != 0) { errno = EIO; return -1; }
  return 0;
}
`;
}

if (process.argv[2] === "--native-child") {
  await childMain();
} else {
  test(
    "native durability is explicitly unsupported outside macOS",
    { skip: process.platform === "darwin" },
    () => {
      assert.equal(native, null);
    },
  );

  test(
    "native store loads missing state, snapshots input, bounds bytes, and closes",
    { skip: native === null },
    async (t) => {
      const f = await fixture(t);
      const store = await f.open();
      assert.equal(native.maximumRecordBytes, 65536);
      assert.equal(await store.loadEncryptedRecord(), null);
      const bytes = Buffer.from("synthetic successor");
      const operation = store.replaceEncryptedRecord(bytes);
      bytes.fill(0);
      await assert.rejects(store.close(), { code: "STORE_BUSY" });
      await assert.rejects(store.loadEncryptedRecord(), { code: "STORE_BUSY" });
      await operation;
      assert.equal(
        (await store.loadEncryptedRecord()).toString(),
        "synthetic successor",
      );
      await assert.rejects(store.replaceEncryptedRecord(Buffer.alloc(0)), {
        code: "STORE_INVALID",
      });
      await assert.rejects(store.replaceEncryptedRecord(Buffer.alloc(65537)), {
        code: "STORE_INVALID",
      });
      await assert.rejects(
        store.replaceEncryptedRecord(Buffer.from(new SharedArrayBuffer(10))),
        { code: "STORE_INVALID" },
      );
      await assert.rejects(native.openStore(path.join(f.root, "different")), {
        code: "STORE_IN_USE",
      });
      const borrowed = store.loadEncryptedRecord;
      await assert.rejects(borrowed(), { code: "STORE_INVALID" });
      await store.close();
      await assert.rejects(store.loadEncryptedRecord(), {
        code: "STORE_CLOSED",
      });
    },
  );

  test(
    "async hooks cannot schedule overlapping work or revive closing ownership",
    { skip: native === null },
    async (t) => {
      const f = await fixture(t);
      const store = await f.open();
      for (const resourceType of ["PROMISE", "desmoslock-durable-record"]) {
        let armed = true;
        let observed;
        const hook = createHook({
          init(_id, type) {
            if (armed && type === resourceType) {
              armed = false;
              observed = store.close().then(
                () => "unexpected-close",
                (error) => error.code,
              );
            }
          },
        });
        hook.enable();
        try {
          await store.replaceEncryptedRecord(
            Buffer.from(`synthetic ${resourceType}`),
          );
          assert.equal(await observed, "STORE_BUSY");
        } finally {
          hook.disable();
        }
      }
      let closeId;
      let armed = true;
      let reentry;
      const hook = createHook({
        init(id, type) {
          if (armed && closeId === undefined && type === "PROMISE")
            closeId = id;
        },
        promiseResolve(id) {
          if (armed && id === closeId) {
            armed = false;
            reentry = store
              .replaceEncryptedRecord(Buffer.from("must not write"))
              .then(
                () => "unexpected-write",
                (error) => error.code,
              );
          }
        },
      });
      hook.enable();
      try {
        await store.close();
        assert.equal(await reentry, "STORE_CLOSED");
      } finally {
        hook.disable();
      }
      const reopened = await f.open();
      assert.equal(
        (await reopened.loadEncryptedRecord()).toString(),
        "synthetic desmoslock-durable-record",
      );
    },
  );

  test(
    "garbage collection retains ownership until exit and clean environment teardown releases it",
    { skip: native === null },
    async (t) => {
      const f = await fixture(t);
      const owner = f.launch("gc");
      assert.equal((await nextMessage(owner)).status, "unreferenced");
      const before = await fs.stat(path.join(f.root, lockName));
      const contender = f.launch("contender");
      assert.equal((await nextMessage(contender)).code, "STORE_IN_USE");
      await exited(contender);
      owner.kill("SIGKILL");
      await exited(owner);
      const teardown = f.launch("teardown");
      assert.equal((await nextMessage(teardown)).status, "teardown-written");
      await exited(teardown);
      assert.equal(teardown.exitCode, 0);
      const reopened = await f.open();
      assert.equal(
        (await reopened.loadEncryptedRecord()).toString(),
        "synthetic teardown",
      );
      assert.equal(
        (await fs.stat(path.join(f.root, lockName))).ino,
        before.ino,
      );
    },
  );

  test(
    "directory chains and record replacement preserve the separate lock inode",
    { skip: native === null },
    async (t) => {
      const f = await fixture(t);
      const directory = path.join(f.root, "nested", "owned");
      const store = await f.open(directory);
      const before = await fs.stat(path.join(directory, lockName));
      await store.replaceEncryptedRecord(Buffer.from("synthetic first"));
      await store.replaceEncryptedRecord(Buffer.from("synthetic next"));
      await store.quarantineEncryptedRecord();
      await assert.rejects(store.loadEncryptedRecord(), {
        code: "STORE_RECOVERY_REQUIRED",
        stage: "preserved-recovery",
      });
      assert.equal(
        await fs.readFile(
          path.join(directory, "student-session.quarantine.0"),
          "utf8",
        ),
        "synthetic next",
      );
      await store.replaceEncryptedRecord(Buffer.from("synthetic targeted"));
      await store.close();
      const next = await f.open(directory);
      assert.equal(
        (await next.loadEncryptedRecord()).toString(),
        "synthetic targeted",
      );
      const after = await fs.stat(path.join(directory, lockName));
      assert.equal(after.ino, before.ino);
      assert.equal(after.dev, before.dev);
      assert.equal(after.size, before.size);
      assert.equal(after.mode & 0o777, 0o600);
    },
  );

  test(
    "two processes reject competing access, preserve inode, and recover a greater counter after crash",
    { skip: native === null },
    async (t) => {
      const f = await fixture(t);
      const owner = f.launch("owner");
      assert.equal((await nextMessage(owner)).counter, 10);
      const lockBefore = await fs.stat(path.join(f.root, lockName));
      const original = await fs.readFile(path.join(f.root, recordName));
      const contender = f.launch("contender");
      assert.deepEqual(await nextMessage(contender), {
        status: "failed",
        code: "STORE_IN_USE",
        stage: "acquire-lock",
        errno: 35,
        loaded: false,
        egress: false,
      });
      await exited(contender);
      assert.deepEqual(
        await fs.readFile(path.join(f.root, recordName)),
        original,
      );
      for (const command of [
        { operation: "replace", counter: 11 },
        { operation: "quarantine" },
        { operation: "replace", counter: 12 },
      ]) {
        const response = nextMessage(owner);
        owner.send(command);
        assert.equal((await response).status, "completed");
        assert.equal(
          (await fs.stat(path.join(f.root, lockName))).ino,
          lockBefore.ino,
        );
      }
      owner.kill("SIGKILL");
      await exited(owner);
      const successor = f.launch("successor");
      assert.deepEqual(await nextMessage(successor), {
        status: "acquired",
        originalCounter: 12,
        counter: 13,
        loaded: true,
        egress: true,
      });
      assert.equal(
        (await fs.stat(path.join(f.root, lockName))).ino,
        lockBefore.ino,
      );
      const closed = nextMessage(successor);
      successor.send({ operation: "close" });
      assert.deepEqual(await closed, { status: "closed" });
      await exited(successor);
      const final = await f.open();
      assert.equal(
        JSON.parse((await final.loadEncryptedRecord()).toString()).counter,
        13,
      );
    },
  );

  test(
    "a crash after quarantine cannot make retained recovery look like empty initial admission",
    { skip: native === null },
    async (t) => {
      const f = await fixture(t);
      const owner = f.launch("owner");
      assert.equal((await nextMessage(owner)).counter, 10);
      const originalLock = await fs.stat(path.join(f.root, lockName));
      const quarantined = nextMessage(owner);
      owner.send({ operation: "quarantine" });
      assert.equal((await quarantined).status, "completed");
      owner.kill("SIGKILL");
      await exited(owner);
      const store = await f.open();
      await assert.rejects(store.loadEncryptedRecord(), {
        code: "STORE_RECOVERY_REQUIRED",
        stage: "preserved-recovery",
      });
      assert.equal(
        (await fs.stat(path.join(f.root, lockName))).ino,
        originalLock.ino,
      );
      assert.equal(
        JSON.parse(
          await fs.readFile(
            path.join(f.root, "student-session.quarantine.0"),
            "utf8",
          ),
        ).counter,
        10,
      );
      await store.replaceEncryptedRecord(
        Buffer.from("synthetic targeted-only pending"),
      );
      assert.equal(
        (await store.loadEncryptedRecord()).toString(),
        "synthetic targeted-only pending",
      );
    },
  );

  test(
    "simultaneous process initialization yields one owner and one unavailable contender",
    { skip: native === null },
    async (t) => {
      const f = await fixture(t);
      const children = [f.launch("race"), f.launch("race")];
      const results = await Promise.all(children.map(nextMessage));
      assert.equal(
        results.filter((result) => result.status === "acquired").length,
        1,
        JSON.stringify(results),
      );
      assert.equal(
        results.filter(
          (result) =>
            result.code === "STORE_IN_USE" && !result.loaded && !result.egress,
        ).length,
        1,
        JSON.stringify(results),
      );
    },
  );

  test(
    "invalid and symbolic lock slots fail without touching their targets",
    { skip: native === null },
    async (t) => {
      const f = await fixture(t);
      const target = path.join(f.root, "synthetic-target");
      await fs.writeFile(target, "preserve", { mode: 0o600 });
      await fs.symlink(target, path.join(f.root, lockName));
      await assert.rejects(native.openStore(f.root), { code: "STORE_INVALID" });
      assert.equal(await fs.readFile(target, "utf8"), "preserve");
      await fs.unlink(path.join(f.root, lockName));
      await fs.mkdir(path.join(f.root, lockName));
      await assert.rejects(native.openStore(f.root), { code: "STORE_INVALID" });
    },
  );

  test(
    "changed lock identity poisons operations and never recreates a slot",
    { skip: native === null },
    async (t) => {
      const f = await fixture(t);
      const store = await f.open();
      await store.replaceEncryptedRecord(Buffer.from("preserve record"));
      await fs.rename(
        path.join(f.root, lockName),
        path.join(f.root, "moved-lock.synthetic"),
      );
      await fs.writeFile(path.join(f.root, lockName), "replacement", {
        mode: 0o600,
      });
      await assert.rejects(store.loadEncryptedRecord(), {
        code: "STORE_INVALID",
        stage: "lock-identity",
      });
      await assert.rejects(
        store.replaceEncryptedRecord(Buffer.from("must not write")),
        { code: "STORE_INVALID", stage: "storage-recovery-required" },
      );
      assert.equal(
        await fs.readFile(path.join(f.root, recordName), "utf8"),
        "preserve record",
      );
    },
  );

  test(
    "oversized and unreadable owned records can be preserved without reading or overwriting",
    { skip: native === null },
    async (t) => {
      const f = await fixture(t);
      const store = await f.open();
      const bytes = Buffer.alloc(65537, 0x53);
      await fs.writeFile(path.join(f.root, recordName), bytes, { mode: 0o600 });
      await assert.rejects(store.loadEncryptedRecord(), {
        code: "STORE_RECORD_TOO_LARGE",
      });
      await fs.chmod(path.join(f.root, recordName), 0o000);
      await store.quarantineEncryptedRecord();
      const preserved = path.join(f.root, "student-session.quarantine.0");
      assert.equal((await fs.stat(preserved)).mode & 0o777, 0);
      await fs.chmod(preserved, 0o600);
      assert.deepEqual(await fs.readFile(preserved), bytes);
      await store.replaceEncryptedRecord(Buffer.from("fresh synthetic intent"));
    },
  );

  test(
    "injected syscall failures preserve publication classification and fail closed before synthetic egress",
    { skip: native === null },
    async (t) => {
      const f = await fixture(t);
      for (const [mode, stage] of [
        [1, "temporary-file-barrier"],
        [2, "replace-record"],
        [3, "record-directory-barrier"],
        [4, "acquire-lock"],
      ]) {
        const directory = path.join(f.root, `case-${mode}`);
        await fs.mkdir(directory, { mode: 0o700 });
        const old = Buffer.from("synthetic counter 10");
        const next = Buffer.from("synthetic counter 11");
        await fs.writeFile(path.join(directory, recordName), old, {
          mode: 0o600,
        });
        const adapter = require(
          await compileFixture(f.root, `fault-${mode}`, syscallFixture(mode)),
        );
        let egress = false;
        if (mode === 4) {
          await assert.rejects(adapter.openStore(directory), {
            code: "STORE_IO",
            stage,
            publication: "not-published",
            errno: 45,
          });
          assert.deepEqual(
            await fs.readFile(path.join(directory, recordName)),
            old,
          );
          assert.equal(egress, false);
          continue;
        }
        const store = await adapter.openStore(directory);
        try {
          await assert.rejects(store.replaceEncryptedRecord(next), {
            code: "STORE_IO",
            stage,
            publication: mode === 3 ? "possibly-published" : "not-published",
            errno: 5,
          });
          assert.deepEqual(
            await fs.readFile(path.join(directory, recordName)),
            mode === 3 ? next : old,
          );
          assert.equal(egress, false);
          assert.equal(
            (await fs.readdir(directory)).some((entry) =>
              entry.startsWith("student-session.pending."),
            ),
            false,
          );
          if (mode === 3) {
            await assert.rejects(store.loadEncryptedRecord(), {
              stage: "storage-recovery-required",
            });
            await assert.rejects(store.replaceEncryptedRecord(old), {
              stage: "storage-recovery-required",
            });
          }
        } finally {
          await store.close();
        }
        const reopened = await adapter.openStore(directory);
        try {
          await reopened.loadEncryptedRecord();
          assert.equal(
            egress,
            false,
            "Readback alone never authorizes synthetic continuation",
          );
          await reopened.replaceEncryptedRecord(
            Buffer.from("synthetic counter 12"),
          );
          egress = true;
          assert.equal(egress, true);
        } finally {
          await reopened.close();
        }
      }
    },
  );

  test(
    "native builder rejects a redirected output ancestor before creating external output",
    { skip: native === null },
    async (t) => {
      const f = await fixture(t);
      const checkout = path.join(f.root, "synthetic-checkout");
      const external = path.join(f.root, "synthetic-external");
      await fs.mkdir(path.join(checkout, "scripts"), { recursive: true });
      await fs.mkdir(path.join(checkout, "apps/desktop"), { recursive: true });
      await fs.mkdir(external);
      await fs.symlink(external, path.join(checkout, "apps/desktop/dist"));
      const copiedScript = path.join(
        checkout,
        "scripts/build-desktop-durable-record.mjs",
      );
      await fs.copyFile(
        fileURLToPath(
          new URL(
            "../../scripts/build-desktop-durable-record.mjs",
            import.meta.url,
          ),
        ),
        copiedScript,
      );
      const builder = await import(pathToFileURL(copiedScript).href);
      await assert.rejects(
        builder.buildDesktopDurableRecord(),
        /output ancestors must be owned directories/,
      );
      assert.deepEqual(await fs.readdir(external), []);
    },
  );

  test(
    "the actual lock descriptor has CLOEXEC and is absent after direct native fork/exec",
    { skip: native === null },
    async (t) => {
      const f = await fixture(t);
      const helper = await compileFixture(
        f.root,
        "verify-closed-fd",
        `
#include <sys/stat.h>
#include <stdlib.h>
#include <errno.h>
int main(int argc, char **argv) {
  if (argc != 2) return 2;
  struct stat status;
  int result = fstat(atoi(argv[1]), &status);
  return result == -1 && errno == EBADF ? 0 : 3;
}
`,
        true,
      );
      const adapter = require(
        await compileFixture(f.root, "inheritance", syscallFixture(5, helper)),
      );
      const store = await adapter.openStore(f.root);
      try {
        await store.replaceEncryptedRecord(
          Buffer.from("synthetic descriptor boundary"),
        );
        assert.equal(
          (await store.loadEncryptedRecord()).toString(),
          "synthetic descriptor boundary",
        );
      } finally {
        await store.close();
      }
      const reopened = await f.open();
      assert.equal(
        (await reopened.loadEncryptedRecord()).toString(),
        "synthetic descriptor boundary",
      );
    },
  );

  test(
    "quarantine capacity is bounded and existing preservation slots never change",
    { skip: native === null },
    async (t) => {
      const f = await fixture(t);
      const store = await f.open();
      for (let slot = 0; slot < 16; slot += 1) {
        await store.replaceEncryptedRecord(Buffer.from(`synthetic ${slot}`));
        await store.quarantineEncryptedRecord();
      }
      await store.replaceEncryptedRecord(Buffer.from("retain current"));
      await assert.rejects(store.quarantineEncryptedRecord(), {
        code: "STORE_QUARANTINE_FULL",
        publication: "not-published",
      });
      assert.equal(
        (await store.loadEncryptedRecord()).toString(),
        "retain current",
      );
      for (let slot = 0; slot < 16; slot += 1) {
        assert.equal(
          await fs.readFile(
            path.join(f.root, `student-session.quarantine.${slot}`),
            "utf8",
          ),
          `synthetic ${slot}`,
        );
      }
    },
  );
}

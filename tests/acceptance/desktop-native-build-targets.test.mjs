import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(
  new URL("../../", import.meta.url),
).replace(/\/$/u, "");
const runId = "10000000-0000-4000-8000-000000000001";
const toolchain = Object.freeze({
  compiler: "/native-target-test/bin/clang",
  sdk: "/native-target-test/sdk",
  nodeHeaders: "/native-target-test/include/node",
});
const builders = [
  {
    filename: "build-desktop-aac-protection.mjs",
    exported: "buildDesktopAACProtection",
    addon: "aac-protection.node",
    module: "aac_protection",
    source: "aac-protection.mm",
    standard: "-std=c++17",
    reason: "macOS native assessment unavailable",
  },
  {
    filename: "build-desktop-durable-record.mjs",
    exported: "buildDesktopDurableRecord",
    addon: "durable-record.node",
    module: "durable_record",
    source: "durable-record.c",
    standard: "-std=c11",
    reason: "macOS native storage unavailable",
  },
];
let fixtureSequence = 0;
function missing(code = "ENOENT") {
  return Object.assign(new Error("Synthetic filesystem refusal"), { code });
}

async function fixture(t, selected, host = "arm64", platform = "darwin") {
  const id = ++fixtureSequence;
  const key = `__desmoslockNativeTargetFixture${id}`;
  const moduleUrl = new URL(
    `../../scripts/${selected.filename}?target-test=${id}`,
    import.meta.url,
  ).href;
  const nodes = new Map();
  const calls = [];
  let nextInode = 1;
  let temporaryCount = 0;
  function directory(filename, mode = 0o755) {
    if (filename !== "/" && !nodes.has(path.dirname(filename)))
      directory(path.dirname(filename));
    if (!nodes.has(filename))
      nodes.set(filename, {
        kind: "directory",
        uid: 501,
        mode,
        dev: 1,
        ino: nextInode++,
        nlink: 1,
        size: 0,
      });
    else nodes.get(filename).mode = mode;
  }
  function file(filename, size = 64) {
    if (!nodes.has(path.dirname(filename))) directory(path.dirname(filename));
    const value = {
      kind: "file",
      uid: 501,
      mode: 0o755,
      dev: 1,
      ino: nextInode++,
      nlink: 1,
      size,
    };
    nodes.set(filename, value);
    return value;
  }
  function realpath(filename) {
    assert.equal(path.isAbsolute(filename), true);
    let prefix = "/";
    const parts = filename.slice(1).split("/");
    for (let index = 0; index < parts.length; index += 1) {
      prefix = path.join(prefix, parts[index]);
      const node = nodes.get(prefix);
      if (node === undefined) throw missing();
      if (node.kind === "link")
        return realpath(path.join(node.target, ...parts.slice(index + 1)));
    }
    return filename;
  }
  function status(filename) {
    const node = nodes.get(filename);
    if (node === undefined) throw missing();
    return {
      ...node,
      isDirectory: () => node.kind === "directory",
      isFile: () => node.kind === "file",
      isSymbolicLink: () => node.kind === "link",
    };
  }
  const defaultOutput = path.join(repositoryRoot, "apps/desktop/dist/native");
  const runRoot = path.join(
    repositoryRoot,
    "artifacts/universal-artifact-runs",
    runId,
  );
  function prepareTarget(architecture) {
    const outputDirectory = path.join(
      runRoot,
      "slices",
      architecture,
      "native",
    );
    directory(path.join(repositoryRoot, "artifacts"));
    let current = path.join(
      repositoryRoot,
      "artifacts/universal-artifact-runs",
    );
    directory(current, 0o700);
    for (const part of [runId, "slices", architecture, "native"]) {
      current = path.join(current, part);
      directory(current, 0o700);
    }
    return { architecture, outputDirectory, toolchain: { ...toolchain } };
  }
  directory(path.join(repositoryRoot, "apps/desktop"));
  file(toolchain.compiler);
  file(path.join(toolchain.sdk, "usr/include/sys/fcntl.h"));
  file(path.join(toolchain.nodeHeaders, "node_api.h"));
  const state = {
    compilerFailure: false,
    afterCompile: null,
    afterRemove: null,
    beforeCompile: null,
    process: {
      platform,
      arch: host,
      versions: { node: "24.20.0" },
      execPath: "/native-target-test/bin/node",
      argv: ["node", "synthetic-test"],
      env: {
        DESMOSLOCK_NATIVE_CLANG: toolchain.compiler,
        DESMOSLOCK_NATIVE_SDK: toolchain.sdk,
        DESMOSLOCK_NATIVE_NODE_HEADERS: toolchain.nodeHeaders,
      },
      geteuid: () => 501,
    },
  };
  function writePath(filename) {
    assert.equal(
      filename === path.join(repositoryRoot, "apps/desktop/dist") ||
        filename === defaultOutput ||
        filename.startsWith(`${defaultOutput}/`) ||
        filename.startsWith(`${runRoot}/slices/`),
      true,
      `Unexpected synthetic output: ${filename}`,
    );
  }
  const filesystem = {
    async lstat(filename) {
      calls.push({ method: "lstat", filename });
      return status(filename);
    },
    async stat(filename) {
      calls.push({ method: "stat", filename });
      return status(realpath(filename));
    },
    async realpath(filename) {
      calls.push({ method: "realpath", filename });
      return realpath(filename);
    },
    async mkdir(filename) {
      writePath(filename);
      calls.push({ method: "mkdir", filename });
      if (nodes.has(filename)) throw missing("EEXIST");
      assert.equal(nodes.get(path.dirname(filename))?.kind, "directory");
      directory(filename);
    },
    async mkdtemp(prefix) {
      writePath(prefix);
      assert.equal(path.basename(prefix), ".build-");
      assert.equal(nodes.get(path.dirname(prefix))?.kind, "directory");
      const filename = `${prefix}${++temporaryCount}`;
      calls.push({ method: "mkdtemp", filename });
      directory(filename, 0o700);
      return filename;
    },
    async rename(source, destination) {
      writePath(source);
      writePath(destination);
      calls.push({ method: "rename", source, destination });
      const value = nodes.get(source);
      assert.equal(value?.kind, "file");
      nodes.set(destination, value);
      nodes.delete(source);
    },
    async link(source, destination) {
      writePath(source);
      writePath(destination);
      calls.push({ method: "link", source, destination });
      if (nodes.has(destination)) throw missing("EEXIST");
      const value = nodes.get(source);
      assert.equal(value?.kind, "file");
      value.nlink += 1;
      nodes.set(destination, value);
    },
    async rm(filename, options) {
      writePath(filename);
      assert.match(path.basename(filename), /^\.build-[1-9][0-9]*$/u);
      assert.deepEqual(options, { recursive: true, force: true });
      calls.push({ method: "rm", filename });
      for (const [entry, value] of nodes)
        if (entry === filename || entry.startsWith(`${filename}/`)) {
          value.nlink -= 1;
          nodes.delete(entry);
        }
      await state.afterRemove?.();
    },
  };
  async function execute(command, args, options) {
    calls.push({ method: "execute", command, args: [...args], options });
    if (command === "/usr/bin/xcrun") {
      if (args.join(" ") === "--find clang")
        return { stdout: `${toolchain.compiler}\n`, stderr: "" };
      assert.deepEqual(args, ["--sdk", "macosx", "--show-sdk-path"]);
      return { stdout: `${toolchain.sdk}\n`, stderr: "" };
    }
    assert.equal(
      command,
      toolchain.compiler,
      "No real or unselected command may execute",
    );
    await state.beforeCompile?.();
    const output = args[args.indexOf("-o") + 1];
    writePath(output);
    file(output);
    if (state.compilerFailure) throw new Error("Synthetic compiler timeout");
    await state.afterCompile?.(output);
    return { stdout: "", stderr: "" };
  }
  globalThis[key] = { process: state.process, filesystem, execute };
  const fsUrl = `native-target-mock:${id}/fs`;
  const childUrl = `native-target-mock:${id}/child`;
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (context.parentURL === moduleUrl) {
        if (specifier === "node:fs/promises")
          return { url: fsUrl, shortCircuit: true };
        if (specifier === "node:child_process")
          return { url: childUrl, shortCircuit: true };
        assert.equal(
          ["node:path", "node:url", "node:util"].includes(specifier),
          true,
          `Unexpected builder import ${specifier}`,
        );
      }
      return next(specifier, context);
    },
    load(url, context, next) {
      if (url === fsUrl)
        return {
          format: "module",
          shortCircuit: true,
          source: `export default globalThis[${JSON.stringify(key)}].filesystem;`,
        };
      if (url === childUrl)
        return {
          format: "module",
          shortCircuit: true,
          source: `import { promisify } from 'node:util'; export function execFile() { throw new Error('Unmocked child invocation'); } execFile[promisify.custom] = globalThis[${JSON.stringify(key)}].execute;`,
        };
      const loaded = next(url, context);
      if (url !== moduleUrl) return loaded;
      return {
        ...loaded,
        source: `const process = globalThis[${JSON.stringify(key)}].process;\n${loaded.source}`,
      };
    },
  });
  t.after(() => {
    hooks.deregister();
    delete globalThis[key];
  });
  const build = (await import(moduleUrl))[selected.exported];
  return {
    build,
    prepareTarget,
    calls,
    state,
    nodes,
    file,
    directory,
    defaultOutput,
    runRoot,
    commands: () => calls.filter((call) => call.method === "execute"),
    mutations: () =>
      calls.filter((call) =>
        ["mkdir", "mkdtemp", "rename", "link", "rm"].includes(call.method),
      ),
  };
}

for (const selected of builders) {
  for (const architecture of ["arm64", "x64"])
    test(`${selected.addon}: explicit ${architecture} target preserves exact compiler policy and host-independent result`, async (t) => {
      const f = await fixture(
        t,
        selected,
        architecture === "arm64" ? "x64" : "arm64",
      );
      const options = f.prepareTarget(architecture);
      f.state.process.env = new Proxy(
        {},
        {
          get() {
            assert.fail(
              "Explicit target must not consult environment tool defaults",
            );
          },
        },
      );
      const result = await f.build(options);
      const outputFile = path.join(options.outputDirectory, selected.addon);
      assert.deepEqual(result, {
        supported: true,
        architecture,
        napi: 8,
        outputFile,
      });
      assert.equal(f.commands().length, 1);
      const command = f.commands()[0];
      const output = command.args.at(-1);
      const expected = [
        selected.standard,
        ...(selected.module === "aac_protection"
          ? ["-fobjc-arc", "-fvisibility=hidden"]
          : []),
        "-arch",
        architecture === "x64" ? "x86_64" : "arm64",
        "-mmacosx-version-min=13.0",
        "-fno-modules",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-DNAPI_VERSION=8",
        `-DNODE_GYP_MODULE_NAME=${selected.module}`,
        "-isysroot",
        toolchain.sdk,
        "-I",
        toolchain.nodeHeaders,
        "-B",
        path.dirname(toolchain.compiler),
        "-bundle",
        "-undefined",
        "dynamic_lookup",
        ...(selected.module === "aac_protection"
          ? [
              "-framework",
              "Foundation",
              "-framework",
              "AppKit",
              "-framework",
              "AutomaticAssessmentConfiguration",
              "-lc++",
            ]
          : []),
        path.join(repositoryRoot, "apps/desktop/native", selected.source),
        "-o",
        output,
      ];
      assert.deepEqual(command.args, expected);
      assert.equal(path.dirname(path.dirname(output)), options.outputDirectory);
      assert.deepEqual(command.options, {
        cwd: repositoryRoot,
        env: {
          PATH: `${path.dirname(toolchain.compiler)}:/usr/bin:/bin`,
          LC_ALL: "C",
          TMPDIR: path.dirname(output),
          TMP: path.dirname(output),
          TEMP: path.dirname(output),
          CLANG_MODULE_CACHE_PATH: path.dirname(output),
        },
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      });
      assert.equal(f.nodes.get(outputFile).nlink, 1);
      assert.equal(
        f
          .mutations()
          .some((call) => call.method === "rename" || call.method === "mkdir"),
        false,
      );
      assert.equal(
        f
          .mutations()
          .some((call) =>
            (call.filename ?? call.destination).startsWith(f.defaultOutput),
          ),
        false,
      );
    });

  test(`${selected.addon}: no-argument default retains host output, replacement and tool discovery`, async (t) => {
    const f = await fixture(t, selected, "x64");
    f.state.process.env = {};
    const result = await f.build();
    assert.deepEqual(result, {
      supported: true,
      architecture: "x64",
      napi: 8,
      outputFile: path.join(f.defaultOutput, selected.addon),
    });
    assert.equal(
      f.commands().filter((call) => call.command === "/usr/bin/xcrun").length,
      2,
    );
    assert.equal(
      f.commands().at(-1).args[f.commands().at(-1).args.indexOf("-arch") + 1],
      "x86_64",
    );
    assert.equal(
      f.mutations().filter((call) => call.method === "rename").length,
      1,
    );
    assert.equal(
      f.mutations().filter((call) => call.method === "link").length,
      0,
    );
    await f.build();
    assert.equal(
      f.mutations().filter((call) => call.method === "rename").length,
      2,
    );
  });

  test(`${selected.addon}: unsupported default remains unavailable and refuses stale artifacts`, async (t) => {
    const f = await fixture(t, selected, "x64", "linux");
    assert.deepEqual(await f.build(), {
      supported: false,
      reason: selected.reason,
    });
    f.file(path.join(f.defaultOutput, selected.addon));
    await assert.rejects(f.build(), /unsupported-platform/u);
    await assert.rejects(f.build(f.prepareTarget("x64")), /require macOS/u);
    assert.equal(f.commands().length, 0);
    assert.equal(f.mutations().length, 0);
  });

  test(`${selected.addon}: strict options reject malformed or redirected targets before effects`, async (t) => {
    const f = await fixture(t, selected);
    const valid = f.prepareTarget("arm64");
    let reads = 0;
    const invalid = [
      null,
      {},
      { architecture: "arm64" },
      { ...valid, architecture: "universal" },
      { ...valid, outputDirectory: f.defaultOutput },
      { ...valid, outputDirectory: `${valid.outputDirectory}/` },
      {
        ...valid,
        outputDirectory: valid.outputDirectory.replace(
          "slices/arm64",
          "slices/x64",
        ),
      },
      {
        ...valid,
        outputDirectory: valid.outputDirectory.replace("10000000", "A0000000"),
      },
      { ...valid, extra: true },
      { ...valid, toolchain: { ...toolchain, extra: true } },
      { ...valid, toolchain: { ...toolchain, compiler: "clang" } },
      {
        ...valid,
        get architecture() {
          reads += 1;
          return "arm64";
        },
      },
      {
        ...valid,
        toolchain: {
          ...toolchain,
          get compiler() {
            reads += 1;
            return toolchain.compiler;
          },
        },
      },
      new Proxy(
        {},
        {
          ownKeys() {
            throw new Error("Unexpected caller error");
          },
        },
      ),
    ];
    for (const options of invalid)
      await assert.rejects(f.build(options), /exact owned slice options/u);
    assert.equal(reads, 0);
    assert.equal(f.calls.length, 0);
  });

  test(`${selected.addon}: explicit targets snapshot all inputs before awaiting`, async (t) => {
    const f = await fixture(t, selected);
    const options = f.prepareTarget("x64");
    const outputDirectory = options.outputDirectory;
    const operation = f.build(options);
    options.architecture = "arm64";
    options.outputDirectory = "/must-not-write";
    options.toolchain.compiler = "/must-not-execute";
    assert.deepEqual(await operation, {
      supported: true,
      architecture: "x64",
      napi: 8,
      outputFile: path.join(outputDirectory, selected.addon),
    });
    assert.equal(f.commands()[0].command, toolchain.compiler);
  });

  test(`${selected.addon}: explicit cross-compilation still requires the selected Node and supported Mac host`, async (t) => {
    const f = await fixture(t, selected);
    const options = f.prepareTarget("x64");
    f.state.process.versions.node = "22.23.2";
    await assert.rejects(f.build(options), /selected Node 24\.20\.0/u);
    f.state.process.versions.node = "24.20.0";
    f.state.process.arch = "riscv64";
    await assert.rejects(f.build(options), /selected Node 24\.20\.0/u);
    assert.equal(f.calls.length, 0);
  });

  for (const fault of ["symlink", "hardlink", "empty"])
    test(`${selected.addon}: ${fault} compiler output is never published`, async (t) => {
      const f = await fixture(t, selected);
      const options = f.prepareTarget("arm64");
      f.state.afterCompile = (output) => {
        const value = f.nodes.get(output);
        if (fault === "symlink") {
          value.kind = "link";
          value.target = "/unselected-binary";
        } else if (fault === "hardlink") value.nlink = 2;
        else value.size = 0;
      };
      await assert.rejects(f.build(options), /compiler output is invalid/u);
      assert.equal(
        f.nodes.has(path.join(options.outputDirectory, selected.addon)),
        false,
      );
      assert.equal(
        f.mutations().some((call) => ["link", "rename"].includes(call.method)),
        false,
      );
    });

  for (const fault of [
    "missing",
    "symlink",
    "unowned",
    "writable",
    "nonprivate",
  ])
    test(`${selected.addon}: ${fault} target ancestor refuses before compiler or directory writes`, async (t) => {
      const f = await fixture(t, selected);
      const options = f.prepareTarget("arm64");
      const ancestor = path.dirname(options.outputDirectory);
      if (fault === "missing") f.nodes.delete(ancestor);
      else if (fault === "symlink")
        f.nodes.set(ancestor, {
          ...f.nodes.get(ancestor),
          kind: "link",
          target: "/unselected-output",
        });
      else if (fault === "unowned") f.nodes.get(ancestor).uid = 999;
      else f.nodes.get(ancestor).mode = fault === "writable" ? 0o777 : 0o755;
      await assert.rejects(f.build(options));
      assert.equal(f.commands().length, 0);
      assert.equal(f.mutations().length, 0);
    });

  test(`${selected.addon}: existing or racing targets cannot be overwritten`, async (t) => {
    const f = await fixture(t, selected);
    const options = f.prepareTarget("x64");
    const outputFile = path.join(options.outputDirectory, selected.addon);
    const existing = f.file(outputFile, 123);
    await assert.rejects(f.build(options), /already exists/u);
    assert.equal(f.commands().length, 0);
    assert.equal(f.mutations().length, 0);
    f.nodes.delete(outputFile);
    f.state.afterCompile = () => {
      f.nodes.set(outputFile, existing);
    };
    await assert.rejects(f.build(options), { code: "EEXIST" });
    assert.equal(f.nodes.get(outputFile), existing);
    assert.equal(existing.size, 123);
    assert.equal(
      f.mutations().some((call) => call.method === "rename"),
      false,
    );
  });

  test(`${selected.addon}: directory replacement during compilation cannot publish or clean through a new path`, async (t) => {
    const f = await fixture(t, selected);
    const options = f.prepareTarget("arm64");
    f.state.afterCompile = () => {
      f.nodes.get(options.outputDirectory).ino += 1000;
    };
    await assert.rejects(f.build(options), /directory changed/u);
    assert.equal(
      f.nodes.has(path.join(options.outputDirectory, selected.addon)),
      false,
    );
    assert.equal(
      f
        .mutations()
        .some((call) => ["link", "rename", "rm"].includes(call.method)),
      false,
    );
  });

  test(`${selected.addon}: post-publication replacement cannot return a successful target`, async (t) => {
    const f = await fixture(t, selected);
    const options = f.prepareTarget("arm64");
    const outputFile = path.join(options.outputDirectory, selected.addon);
    f.state.afterRemove = () => {
      f.file(outputFile);
    };
    await assert.rejects(
      f.build(options),
      /output changed during publication/u,
    );
  });

  test(`${selected.addon}: failed explicit compiler retains temporary evidence while default cleanup remains unchanged`, async (t) => {
    const f = await fixture(t, selected);
    f.state.compilerFailure = true;
    const options = f.prepareTarget("arm64");
    await assert.rejects(f.build(options), /Synthetic compiler timeout/u);
    assert.equal(
      f.nodes.has(path.join(options.outputDirectory, selected.addon)),
      false,
    );
    assert.equal(
      f.mutations().some((call) => call.method === "rm"),
      false,
    );
    await assert.rejects(f.build(), /Synthetic compiler timeout/u);
    assert.equal(
      f.mutations().filter((call) => call.method === "rm").length,
      1,
    );
  });

  test(`${selected.addon}: reversed parallel slice completion stays in disjoint target roots`, async (t) => {
    const f = await fixture(t, selected);
    let release;
    const waiting = new Promise((resolve) => {
      release = resolve;
    });
    f.state.afterCompile = async (output) => {
      if (output.includes("/slices/arm64/")) await waiting;
      else release();
    };
    const [arm64, x64] = await Promise.all([
      f.build(f.prepareTarget("arm64")),
      f.build(f.prepareTarget("x64")),
    ]);
    assert.equal(arm64.architecture, "arm64");
    assert.equal(x64.architecture, "x64");
    assert.notEqual(
      path.dirname(arm64.outputFile),
      path.dirname(x64.outputFile),
    );
    assert.equal(f.nodes.get(arm64.outputFile).nlink, 1);
    assert.equal(f.nodes.get(x64.outputFile).nlink, 1);
    assert.equal(f.commands().length, 2);
  });
}

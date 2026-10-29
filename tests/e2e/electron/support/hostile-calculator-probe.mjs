/**
 * This function is serialized into an isolated calculator renderer. Keep its
 * body self-contained: the importing harness must not become a capability.
 */
export async function runHostileCalculatorProbe(input) {
  const result = {
    bridge: typeof globalThis.desmoslockDesktop,
    externalProtocol: "pending",
    fetch: "pending",
    nodeProcess: typeof globalThis.process,
    nodeRequire: typeof globalThis.require,
    permission: "unavailable",
    popup: "pending",
    rtcPeerConnection: "unavailable",
    webTransport: "unavailable",
  };

  const controller = new globalThis.AbortController();
  globalThis.setTimeout(() => controller.abort(), 300);
  try {
    await globalThis.fetch(`${input.httpOrigin}/fetch`, {
      mode: "no-cors",
      signal: controller.signal,
    });
    result.fetch = "allowed";
  } catch {
    result.fetch = "blocked";
  }

  try {
    const popup = globalThis.open(`${input.httpOrigin}/popup`, "_blank");
    result.popup = popup === null ? "blocked" : "allowed";
  } catch {
    result.popup = "blocked";
  }
  try {
    const external = globalThis.open(
      "desmoslock-unregistered://attacker.invalid",
      "_blank",
    );
    result.externalProtocol = external === null ? "denied" : "allowed";
  } catch {
    result.externalProtocol = "denied";
  }

  if (globalThis.navigator.permissions !== undefined) {
    try {
      result.permission = (
        await globalThis.navigator.permissions.query({ name: "geolocation" })
      ).state;
    } catch {
      result.permission = "denied";
    }
  }

  const image = globalThis.document.createElement("img");
  image.src = `${input.httpOrigin}/image`;
  globalThis.document.body.append(image);
  try {
    const socket = new globalThis.WebSocket(
      input.httpOrigin.replace("http", "ws") + "/socket",
    );
    socket.addEventListener("open", () => socket.close(), { once: true });
  } catch {
    // Constructor rejection is an expected blocked outcome.
  }

  if (typeof globalThis.RTCPeerConnection !== "undefined") {
    try {
      const peer = new globalThis.RTCPeerConnection({
        iceServers: [
          { urls: `stun:127.0.0.1:${input.udpPort}` },
          {
            credential: "hostile",
            urls: `turn:127.0.0.1:${input.tcpPort}?transport=tcp`,
            username: "hostile",
          },
        ],
        iceTransportPolicy: "relay",
      });
      let emittedCandidate = false;
      peer.addEventListener("icecandidate", (event) => {
        if (event.candidate !== null) emittedCandidate = true;
      });
      peer.createDataChannel("hostile");
      await peer.setLocalDescription(await peer.createOffer());
      await new Promise((resolve) => globalThis.setTimeout(resolve, 700));
      // Chromium 152 (Electron 44) enforces Connection-Allowlist webrtc=block
      // by stripping every ICE server and marking all candidates
      // administratively prohibited, which forces ICE to "failed", instead of
      // throwing NotAllowedError from the constructor.
      result.rtcPeerConnection = emittedCandidate
        ? "candidate"
        : peer.getConfiguration().iceServers.length === 0 &&
            peer.iceConnectionState === "failed"
          ? "administratively-prohibited"
          : "no-candidate";
      peer.close();
    } catch (caught) {
      result.rtcPeerConnection =
        caught !== null && typeof caught === "object" && "name" in caught
          ? String(caught.name)
          : `unexpected:${String(caught)}`;
    }
  }

  if (typeof globalThis.WebTransport !== "undefined") {
    try {
      const transport = new globalThis.WebTransport(
        `https://127.0.0.1:${input.udpPort}/hostile`,
      );
      result.webTransport = await Promise.race([
        transport.ready.then(
          () => "allowed",
          () => "rejected",
        ),
        new Promise((resolve) =>
          globalThis.setTimeout(() => resolve("timeout"), 700),
        ),
      ]);
      transport.close();
    } catch {
      result.webTransport = "rejected";
    }
  }

  const iframe = globalThis.document.createElement("iframe");
  iframe.src = `${input.httpOrigin}/frame`;
  globalThis.document.body.append(iframe);
  const download = globalThis.document.createElement("a");
  download.href = "data:text/plain,blocked";
  download.download = "desmoslock-hostile-probe-must-not-exist.txt";
  download.click();
  globalThis.location.assign(`${input.httpOrigin}/navigation`);
  return result;
}

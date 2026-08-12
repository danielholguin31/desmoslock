# Optional managed-Mac signing experiment

This is an internal, separate workstream. It is **not** part of the public ad-hoc
v1.0.1 release, is not a customer promise, and must not appear in website or release
copy until it passes on an enrolled, managed Mac.

The experiment uses a stable self-signed code-signing identity held only in the Mac
Mini keychain. Do not export its private key, upload it to GitHub, place it in a
workflow, or use it for the public ad-hoc artifacts. A build signed with this identity
is a distinct managed-deployment candidate with its own hashes and receipt.

Before extracting a rule, verify the candidate DMG's SHA-256 against the managed-build
receipt, mount that exact candidate, and point `MANAGED_CANDIDATE_APP` at its staged
app—not at a generic or previously installed `/Applications` copy. Require
`codesign --verify --deep --strict "$MANAGED_CANDIDATE_APP"`, inspect the signing
identity against the receipt, then capture the exact designated requirement with
`codesign -dr - "$MANAGED_CANDIDATE_APP"`. Have the MDM administrator paste that
captured requirement—not a guessed bundle-ID-only rule—into a device-channel
`com.apple.systempolicy.rule` payload. An administrative template is:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>Comment</key>
      <string>Allow the separately tested DesmosLock managed build.</string>
      <key>OperationType</key>
      <string>operation:execute</string>
      <key>Priority</key>
      <real>101</real>
      <key>Requirement</key>
      <string>REPLACE_WITH_EXACT_DESIGNATED_REQUIREMENT</string>
      <key>PayloadIdentifier</key>
      <string>app.desmoslock.system-policy-rule</string>
      <key>PayloadType</key>
      <string>com.apple.systempolicy.rule</string>
      <key>PayloadUUID</key>
      <string>REPLACE-WITH-UNIQUE-PAYLOAD-UUID</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
    </dict>
  </array>
  <key>PayloadDisplayName</key>
  <string>DesmosLock managed build policy</string>
  <key>PayloadIdentifier</key>
  <string>app.desmoslock.system-policy-profile</string>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadUUID</key>
  <string>REPLACE-WITH-UNIQUE-PROFILE-UUID</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
</dict>
</plist>
```

Generate distinct UUIDs and validate the final profile with the MDM vendor. Do not
use a SystemPolicyControl payload that disables assessment, and do not broaden the
requirement to all applications from the self-signed certificate.

Acceptance requires an enrolled managed Mac, a fresh quarantined download of the
exact managed candidate, successful noninteractive launch under the installed rule,
all functional lock/recovery tests, rule removal and rollback testing, and proof that
an altered or differently signed build is rejected. Until then, record MDM as
unproven.

Reference: [Apple SystemPolicyRule payload](https://developer.apple.com/documentation/devicemanagement/systempolicyrule).

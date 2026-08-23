# Pilot promise versus existing testing alternatives

**Research question:** [Issue #13 — Compare the pilot promise with existing testing alternatives](https://github.com/danielholguin31/desmoslock/issues/13).[2]  
**Planning context:** [Issue #9 — One controlled paid school pilot](https://github.com/danielholguin31/desmoslock/issues/9).[1]  
**Research cutoff:** 2026-08-23  
**Product snapshot:** `ea1d034aabf3798e52a6fdf99a666477e5dc7644`  
**Evidence policy:** public, first-party product/platform sources plus the pinned DesmosLock repository. Vendor descriptions establish documented capability or intent, not independently proven effectiveness. The marker `[unverified]` identifies an inference, proposed claim boundary, or pilot threshold rather than a sourced fact.

## Decision

Do **not** sell the pilot as “secure Desmos,” a superior lockdown browser, or cheating prevention.[unverified]

Official Desmos Test Mode, Apple assessment controls, and Windows Take a Test already cover substantial parts of those categories.[6][9][12]

Exam.net, Respondus LockDown Browser, and Safe Exam Browser cover many of the same needs.[15][19][22]

Exam.net is the closest direct substitute: its official materials describe an exam key with no student accounts, built-in Desmos, multiple security levels, cross-device support, and real-time teacher monitoring.[15][16][17]

The smallest potentially differentiated wedge is instead a **paper-first classroom workflow**: a teacher already has the assessment and wants only a synchronized, calculator-only class session, without creating a digital exam, routing students through an LMS, or asking IT to deploy a per-assessment kiosk configuration.[unverified] This is an inference to test, not an established market fact.[unverified]

> **Smallest pilot promise**  
> For one supervised, lower-stakes, paper-first math course using one pre-approved homogeneous cohort of school-owned Macs **or** Windows PCs, DesmosLock gives the teacher one class code to start and end a class-wide Desmos calculator session, requires no student account or digital-exam build, and surfaces selected device-interruption flags to the teacher.[unverified] It is a workflow-and-observability aid: it does not make the assessment cheat-proof, replace room supervision, or qualify the setup for high-stakes testing.[unverified]

That promise is deliberately narrower than the current README’s broad “locked to the screen” language. The repository documents a code-and-name join flow, class-wide lock control, and a live activity feed ([pinned lines 3–8](https://github.com/danielholguin31/desmoslock/blob/ea1d034aabf3798e52a6fdf99a666477e5dc7644/README.md#L3-L8)).[3] It also explicitly documents macOS force-quit and focus-switching limits and states that a phone or second computer is outside the software boundary ([pinned lines 99–109](https://github.com/danielholguin31/desmoslock/blob/ea1d034aabf3798e52a6fdf99a666477e5dc7644/README.md#L99-L109)).[3]

## What the current artifact actually supports

### Verified implementation facts

- The teacher can create a test, receive a class code, see joined students, lock/unlock the class, and end the session; a student joins with a name and code rather than a student account ([renderer lines 383–417](https://github.com/danielholguin31/desmoslock/blob/ea1d034aabf3798e52a6fdf99a666477e5dc7644/desktop/renderer/app.js#L383-L417)).[5]
- The Electron main process applies full-display coverage, registers shortcut handlers, starts a 300 ms watchdog, rebuilds coverage when displays change, scans periodically for other open apps, and reports focus loss ([main-process lines 340–425](https://github.com/danielholguin31/desmoslock/blob/ea1d034aabf3798e52a6fdf99a666477e5dc7644/desktop/main.js#L340-L425)).[4]
- The renderer queues selected interruption events, offers an override-code path, and offers a recorded force exit after 90 seconds without server contact ([renderer lines 625–685](https://github.com/danielholguin31/desmoslock/blob/ea1d034aabf3798e52a6fdf99a666477e5dc7644/desktop/renderer/app.js#L625-L685)).[5]
- A locally persisted locked session is designed to restore after a force quit or backend outage ([renderer lines 705–743](https://github.com/danielholguin31/desmoslock/blob/ea1d034aabf3798e52a6fdf99a666477e5dc7644/desktop/renderer/app.js#L705-L743)).[5]
- The app currently embeds the Desmos API with a public demo key; the README says classroom use should obtain a separate key ([pinned lines 227–229](https://github.com/danielholguin31/desmoslock/blob/ea1d034aabf3798e52a6fdf99a666477e5dc7644/README.md#L227-L229)), while Desmos’s API documentation directs integrators to obtain their own API key.[3][8]

### Not verified

The repository and official competitor pages reviewed here provide implementation evidence and vendor-authored capability claims.[unverified] They do **not** provide a controlled DesmosLock classroom trial, a head-to-head escape test, measured false-positive rates, teacher time savings, willingness-to-pay evidence, or proof that DesmosLock is more secure than an alternative.[unverified] Any claim of effectiveness, superiority, reliability at classroom scale, or reduced cheating remains unverified until the proposed pilot measurements are run.[unverified]

### Commercial-use gate

Desmos’s current API terms define production use by end users or internal use for a business purpose as commercial use. Outside the free trial-tier limits, the terms require an appropriate paid plan or a written Commercial Addendum before commercial use.[7] Therefore a paid school pilot must not start—and the promise must not be sold—until DesmosLock has documented commercial API authorization for the named application and an approved production key.[7][8] This research does not establish Desmos endorsement or permission to use Desmos trademarks in the product name.[unverified]

## Verified alternative landscape

The “verified” column below means “documented by the official source.” It does not mean independently penetration-tested or outcome-validated.

| Alternative | Verified official capability | What it already solves | Remaining gap or decision implication |
|---|---|---|---|
| **Official Desmos Test Mode** | Desmos documents school-managed Chromebook kiosk deployment, secure-browser options for Windows/Mac, MDM locking on iPad, Apple self-lock in the iOS app, Android app pinning, offline use in several apps, and visible Test Mode color/badge plus an end-of-session continuity summary.[6] | Calculator configurations matched to assessments and device-level restriction without DesmosLock. | The reviewed Desmos guidance does not describe a cross-platform teacher roster, synchronized class lock/release, or live interruption feed. **Inference:** DesmosLock may reduce device-by-device verification for a paper test, but only if that reduction is measured. |
| **Apple Automatic Assessment Configuration / managed single-app modes** | Apple’s assessment framework can enter single-app mode, hide the Dock/menu bar/Mission Control/other Spaces, block other apps and screen capture, and restrict network access to the assessment app; use requires Apple’s assessment entitlement.[9] For managed Macs, the Autonomous Single App Mode payload requires device enrollment, app-developer information, and user approval, and Apple says it grants the app low-level system access.[10] Apple’s App Lock payload for iPhone/iPad forces one selected app and can reopen it after restart on devices enrolled through Automated Device Enrollment.[11] | Stronger OS-mediated restriction primitives than an ordinary Electron window and shortcut watchdog. | These are platform primitives and management controls, not a ready-made teacher session, roster, or paper-test workflow. **Inference:** DesmosLock’s only defensible edge is orchestration; if the school’s MDM already gives teachers just-in-time app locking and adequate status, the edge may disappear. |
| **Windows Take a Test** | Microsoft documents a lower-stakes secure-assessment link that can present any hosted web content and blocks other apps, clipboard access, system settings, and—by default—printing and capture.[12] Its higher-stakes kiosk mode uses a dedicated test account and can be configured with Intune, CSP, a provisioning package, PowerShell, or local Settings.[14] The technical reference says lockdown runs above the Windows lock screen, applies local MDM policies atomically, clears the clipboard, blacks out extended displays, and disables capture.[13] | A built-in Windows secure browser for a Desmos URL or another web assessment, with no new commercial secure-browser product. | The reviewed Microsoft flow is per-link or per-device/profile; it does not document a cross-platform class code, teacher roster, synchronized release, or live teacher event feed. For a Windows-only class that needs only a secure URL, Take a Test is a strong substitute and may eliminate the buyer pain. |
| **Exam.net** | Exam.net documents PDF upload, several security levels, real-time monitoring/chat, no student accounts, an exam key, recovery after connectivity/device failure, and support across Chromebooks, Macs, iPads/iPhones, and Windows.[15] Its official tool list includes Desmos.[16] Its security page says high-security mode uses native apps or secure browsers on those platforms and reports suspected events during or after an exam.[17] | It overlaps almost the entire initial proposition and adds digital exam delivery, accommodations, response collection, grading, and LMS integrations. | This is the closest substitute. **Inference:** the only plausible wedge is being materially faster and thinner for an existing paper assessment. Exam.net publicly offers school-based annual licensing but not an exact price on the page reviewed, so price superiority cannot be claimed.[18] |
| **Respondus LockDown Browser** | Respondus documents that students normally install the institutional build, enter through a supported LMS, and become unable to print, copy, visit other addresses, or use other applications after the exam starts; early exits require a reason visible to instructors.[20] It officially supports major LMSs including Blackboard, Brightspace, Canvas, Moodle, Sakai, and Schoology.[21] Respondus also documents adding a Desmos link to a quiz and allowlisting `*.desmos.com` so Desmos opens in another locked tab.[19] | A mature incumbent for schools already delivering quizzes through an LMS, including a documented Desmos path. | Its documented workflow is LMS/quiz-centered rather than a one-code calculator session for an existing paper test. **Inference:** DesmosLock may remove quiz/link/domain setup, but a school that already licenses and supports Respondus may not value that reduction enough to add another client. |
| **Safe Exam Browser (SEB)** | SEB describes a free/open-source kiosk browser for Windows, macOS, and iOS with encrypted per-exam configuration, URL filtering, process restrictions, optional allowed apps, and broad web-assessment/LMS compatibility. It has no required central cloud; an optional self-hosted SEB Server can distribute/configure sessions and add monitoring or remote controls.[22] | A configurable, no-license-fee secure-browser substrate that can point to approved web resources and work on managed or unmanaged devices. | SEB usually needs configuration plus an assessment system or optional server. **Inference:** DesmosLock may be simpler out of the box for one calculator-only classroom, but a school with SEB expertise or SEB Server can reproduce much of the claimed control and may prefer the established tool. |
| **Ordinary supervision + free Desmos** | In Desmos’s student-device path, the teacher can visually confirm the Test Mode banner/badge and inspect the continuous-session duration shown when the student finishes.[6] | No new procurement or desktop client; a present teacher can also observe phones, notes, conversation, and second devices that desktop software cannot see. DesmosLock itself identifies a phone/second computer as outside its boundary.[3] | Repeated visual checks do not provide a synchronized start/end or central timeline. **Inference:** the pilot must prove that the dashboard saves attention rather than merely creating noisy flags. |

## Where buyer pain may remain

The comparison leaves only a narrow pain hypothesis:

1. **The assessment is already authored elsewhere or on paper.** Exam.net and Respondus are optimized around a digital exam or LMS quiz; the buyer does not want to rebuild or wrap the test merely to permit Desmos.[15][19][20]
2. **The teacher needs class orchestration, not an IT security project.** Apple managed modes and Windows kiosk accounts involve entitlements, profiles, accounts, or device configuration.[10][14] SEB adds encrypted configuration and assessment-system integration.[22]
3. **Students should remain accountless.** DesmosLock’s current join flow and Exam.net both satisfy this, so accountlessness is necessary but not differentiated by itself.[5][15]
4. **The teacher wants a single live exception list.** DesmosLock implements selected event reporting, but the value of those signals over walking the room is unproven.[4][5]
5. **The environment is already supervised and lower stakes.** That bounded setting can tolerate a deterrence-and-observability aid; it cannot justify “airtight,” “cheat-proof,” remote-proctoring, or high-stakes claims. A second device remains a supervision problem, not a DesmosLock claim.[3]

The pain hypothesis is **not** “students can access other apps while using Desmos.”[unverified] Many alternatives already address that.[6][12][15] It is: **“For a paper-first math test, the available controls either remain per-device/manual or require a broader exam/MDM workflow than the teacher wants.”**[unverified]

## Claim boundary for the paid pilot

### Credible if acceptance evidence passes

- “One teacher can start and end a calculator-only session for the supported class from one console.”[unverified]
- “Students join with a class code and name; they do not create DesmosLock student accounts.”[unverified]
- “The supported client reports the specifically tested focus, quit, display, application, and connectivity events.”[unverified]
- “The workflow does not require the teacher to create the assessment in DesmosLock or launch it from an LMS.”[unverified]
- “On the exact supported OS/device build, the tested controls add friction to casual switching while the teacher remains in the room.”[unverified]

### Not credible for this pilot

- “Official Desmos,” “Desmos-approved,” or any implication of endorsement absent written permission.[unverified]
- “Cheat-proof,” “airtight,” “tamper-proof,” “prevents cheating,” or “detects cheating.”[unverified]
- “Secure browser equivalent” or “more secure than MDM/Exam.net/Respondus/SEB.”[unverified]
- “High-stakes,” “remote proctoring,” “BYOD,” “district-wide,” or platform-parity claims.[unverified]
- “Prevents app switching” on macOS: the pinned README says key focus can move even though coverage is intended to remain and focus is reclaimed.[3]
- Any unqualified claim that every shortcut, process, display path, accessibility path, virtual machine, remote-control tool, or second device is blocked.[unverified]

## Smallest falsifiable paid-pilot design

Use one school, one homogeneous school-owned device/OS cohort, one paper-first math course, 1–3 trained teachers, and at least five supervised lower-stakes sessions.[unverified] Choose **Mac or Windows, not both**, before acceptance testing.[unverified] Provision the client once; do not introduce student accounts, digital exam authoring, grading, webcam capture, remote proctoring, or Chromebook/iPad/BYOD support.[unverified]

Run a counterfactual comparison before purchase: the same teacher and existing paper assessment should rehearse (a) the school’s best available incumbent—official Desmos Test Mode plus supervision, Windows Take a Test/MDM, Exam.net, Respondus, or SEB as applicable—and (b) DesmosLock.[unverified] Record aggregate timings and event counts only; do not put student/customer PII in the research or acceptance record.[unverified]

### Proposed success measures

These thresholds are product hypotheses, not facts from the sources:

1. **Prep:** after initial installation, median teacher preparation from “existing paper test ready” to “session code ready” is at most 5 minutes.[unverified]
2. **Class start:** at least 95% of present supported devices reach the calculator session within 3 minutes of the teacher displaying the code in at least 4 of 5 sessions.[unverified]
3. **Counterfactual advantage:** combined teacher prep plus class-start time is at least 30% lower than the best incumbent workflow available to that school, without increasing live IT assistance.[unverified]
4. **Event fidelity:** in a scripted rehearsal, at least 95% of supported focus-loss, quit, display-change, and connection-loss events appear at the teacher console within 5 seconds; newly launched-app events appear within 15 seconds; there is no unflagged repeatable route to use a disallowed local app/site for more than 5 seconds while the client presents itself as locked.[unverified]
5. **Noise:** no more than one false severe flag per 30 student-hours, and teachers can identify the relevant student/event without leaving the console.[unverified]
6. **Recovery:** every device releases within 10 seconds of the teacher’s normal unlock/end command; every simulated server outage has a tested, documented release path within 2 minutes; no student device remains stranded.[unverified]
7. **Demand:** after the comparison, the school owner approves continued paid use and either at least two of three participating teachers—or every participating teacher if fewer than three—chooses DesmosLock over the available incumbent for the next eligible paper-first assessment.[unverified]

## Falsifiers and stop conditions

Any one of the following defeats or materially narrows the pilot promise:

1. **Commercial authorization missing:** no paid Desmos API plan or written Commercial Addendum and production key covering this application before launch.[7][8]
2. **No workflow edge:** the school’s existing Desmos/MDM/Take a Test/Exam.net/Respondus/SEB path meets the same paper-first need with comparable or lower prep, start time, supervision burden, and total incremental cost.[unverified]
3. **Exam.net parity in practice:** a teacher can create a minimal Exam.net session with Desmos, no student accounts, and monitoring as quickly as DesmosLock, with acceptable procurement terms.[15][16][18]
4. **Unreliable containment:** a scripted supported-device escape exposes and permits use of another app/site for more than 5 seconds without a timely flag, or the same bypass recurs after remediation.[unverified]
5. **Alert burden:** false or duplicate flags make the teacher watch the dashboard more than the room, or a material seeded event is missed.[unverified]
6. **Unsafe recovery:** unlock/end, crash recovery, outage handling, or the emergency path strands a device, loses student calculator work, or requires improvised administrator intervention during class.[unverified]
7. **Scope mismatch:** the buyer requires Chromebook/iPad/BYOD, remote proctoring, digital exam delivery/grading, mixed fleets, state/high-stakes use, or control of phones/second computers.[unverified]
8. **No paid demand:** after using the product and seeing the incumbent comparison, the school will not pay for continued use.[unverified] Interest in “security” without a signed, bounded workflow need is not validation.[unverified]
9. **Claim cannot stay narrow:** procurement or sales requires Desmos endorsement, cheating-prevention, high-stakes, or platform-wide assurances that the build and acceptance evidence do not prove.[unverified]

## Bottom line

The market is not missing a lockdown mechanism.[unverified]

Desmos documents its own test modes, while Apple and Microsoft expose OS-level assessment controls.[6][9][12]

Exam.net combines Desmos, no student accounts, security modes, and monitoring.[15][16][17]

Respondus supports Desmos inside LMS quizzes, and SEB supplies a configurable open-source secure-browser substrate.[19][22]

The only pilot-sized proposition left is **less workflow for a supervised paper-first calculator session, plus a useful exception feed**.[unverified] That proposition is credible only as a measured convenience and observability claim on one exact managed fleet.[unverified] If a direct rehearsal shows that Exam.net, Windows Take a Test, existing MDM, Respondus, SEB, or ordinary Desmos Test Mode already meets the need with equal or lower burden, DesmosLock has no differentiated paid-pilot promise for that school.[unverified]

## Source-access limitations and uncertainty

- No independent penetration test, classroom trial, buyer interview set, or outcome study was used. Official vendor claims were treated as authorial evidence, not proof of superiority.
- Exam.net’s Salesforce help-center article bodies were JavaScript-rendered and not extractable in this research environment; the accessible official Exam.net product, tools, and security pages were used instead.[15][16][17]
- Respondus’s marketing landing page returned an access block to non-browser retrieval; accessible first-party Respondus support articles supplied the cited workflow, LMS, and Desmos evidence.[19][20][21]
- Desmos’s testing landing page was JavaScript-rendered; its current official in-class assessment help article supplied the detailed platform guidance.[6]
- The official pages successfully accessed did not expose exact current Exam.net or Respondus school pricing, deployment labor, support quality, or contract terms, so this artifact makes no price-superiority claim.[18][20]
- Apple capabilities vary by OS version, enrollment, entitlement, and management service.[9][10][11]
- Windows capabilities vary by OS version, account mode, and policy.[12][14]
- The pilot must validate one exact hardware/OS/configuration matrix; this research does not infer fleet-wide parity.[unverified]
- Absence of a teacher roster or synchronized controls from a reviewed platform document is not proof that no MDM vendor, add-on, LMS integration, or newer product feature provides it.[unverified] That is why the school-specific incumbent rehearsal is a hard pilot gate.[unverified]

## Final pilot promise and decisive falsifiers

> For one supervised, lower-stakes, paper-first math course using one pre-approved homogeneous cohort of school-owned Macs **or** Windows PCs, DesmosLock gives the teacher one class code to start and end a class-wide Desmos calculator session, requires no student account or digital-exam build, and surfaces selected device-interruption flags to the teacher. It is a workflow-and-observability aid—not a cheating-prevention, high-stakes, or Desmos-endorsed product claim.[unverified]

Reject or narrow that promise if commercial Desmos API authorization is absent; the school’s best incumbent matches the workflow at equal or lower burden; the start, event-fidelity, noise, or recovery thresholds fail; a repeatable supported-device escape remains usable without a timely flag; teachers prefer ordinary supervision or the incumbent after comparison; or the buyer requires devices, stakes, or threats outside the bounded pilot.[7][unverified]

## Sources

[1] https://github.com/danielholguin31/desmoslock/issues/9 — Pilot readiness map: One controlled paid school pilot
[2] https://github.com/danielholguin31/desmoslock/issues/13 — Compare the pilot promise with existing testing alternatives
[3] https://github.com/danielholguin31/desmoslock/blob/ea1d034aabf3798e52a6fdf99a666477e5dc7644/README.md — DesmosLock README at ea1d034
[4] https://github.com/danielholguin31/desmoslock/blob/ea1d034aabf3798e52a6fdf99a666477e5dc7644/desktop/main.js — DesmosLock desktop main process at ea1d034
[5] https://github.com/danielholguin31/desmoslock/blob/ea1d034aabf3798e52a6fdf99a666477e5dc7644/desktop/renderer/app.js — DesmosLock renderer at ea1d034
[6] https://help.desmos.com/hc/en-us/articles/4405003743757-Using-Desmos-on-In-Class-Assessments — Using Desmos on In-Class Assessments
[7] https://www.desmos.com/api-terms?lang=en — Desmos API Terms of Service
[8] https://www.desmos.com/api/v1.12/docs/index.html — Desmos API v1.12 documentation
[9] https://developer.apple.com/documentation/automaticassessmentconfiguration — Automatic Assessment Configuration
[10] https://support.apple.com/guide/deployment/autonomous-single-app-mode-payload-settings-dep8a42c4c4a/web — Autonomous Single App Mode payload settings for Mac
[11] https://support.apple.com/guide/deployment/app-lock-payload-settings-dep80a981/web — App Lock payload settings for Apple devices
[12] https://learn.microsoft.com/en-us/education/windows/take-tests-in-windows — Take tests and assessments in Windows
[13] https://learn.microsoft.com/en-us/education/windows/take-a-test-app-technical — Take a Test app technical reference
[14] https://learn.microsoft.com/en-us/education/windows/edu-take-a-test-kiosk-mode — Configure Take a Test in kiosk mode
[15] https://exam.net/how-it-works — Exam.net product overview
[16] https://exam.net/tools — Exam.net tools
[17] https://exam.net/cheat — Exam.net cheating and security modes
[18] https://exam.net/pricing — Exam.net pricing
[19] https://support.respondus.com/hc/en-us/articles/41692549223451-Using-the-Desmos-Calculator-with-LockDown-Browser-instructions-for-faculty — Using the Desmos Calculator with LockDown Browser
[20] https://support.respondus.com/hc/en-us/articles/4409607360539-LockDown-Browser-The-Student-Experience — LockDown Browser: The Student Experience
[21] https://support.respondus.com/hc/en-us/articles/4409595377179-Which-learning-management-systems-does-LockDown-Browser-integrate-with — LockDown Browser LMS integrations
[22] https://safeexambrowser.org/about_overview_en.html — Safe Exam Browser overview

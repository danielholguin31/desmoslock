# Federal and common school-pilot compliance floor

- **Research question:** [#14 — Establish the federal and common school-pilot compliance floor](https://github.com/danielholguin31/desmoslock/issues/14)
- **Parent map:** [#9 — Pilot readiness map: One controlled paid school pilot](https://github.com/danielholguin31/desmoslock/issues/9)
- **Current through:** 2026-08-23
- **Scope:** one controlled paid U.S. K–12 pilot, using the map's default assumptions of supervised, in-person, lower-stakes use on school-owned managed devices.
- **Disclaimer:** This is research, not legal advice. The Pilot School and its counsel must approve the actual agreement, notices, consent path, accessibility plan, and state/local compliance.

## Executive answer

There is no small-pilot exemption and no single federal “edtech compliant” certificate.
COPPA attaches based on the operator, audience/knowledge, age, and online collection.[1]
FERPA attaches when a covered school discloses or has a provider maintain personally identifiable information (PII) from education records.[5]
ADA Title II/Section 504 obligations attach on the school side based on public-entity and federal-funding status.[8][10]

For DesmosLock, “accountless” does **not** mean anonymous or outside the rules.[1][5]
The [current product description](../../README.md#using-it) says a student enters a name and that the product stores or reports assessment-session state and activity; COPPA also defines IP addresses, device serial numbers, and unique device identifiers as personal information.[1]
The Pilot Release therefore needs a field-by-field data-flow and age/grade determination before real students use it.[1][5][6]

The practical pre-pilot floor is:

1. a school-authorized, signed pilot agreement plus data-protection addendum (DPA) binding the exact Pilot Release and every data recipient;[3][5][6]
2. a documented COPPA determination and, if COPPA applies, a valid parent- or school-authorization path completed **before** collection;[1][3]
3. FERPA school-official/direct-control terms whenever FERPA-protected PII is involved;[5][6]
4. a truthful privacy notice, data inventory, purpose limits, access/export path, retention/deletion schedule, and controlled subprocessor list;[1][5][7]
5. a written, exercised security program and incident-response process;[1][7]
6. functional accessibility evidence for all student and teacher critical paths, without waiting for district-scale certification;[8][9][10] and
7. a second legal/procurement pass after the Pilot School is named, because federal guidance directs schools to account for applicable state and local law and the ADA date depends on the public entity.[6][8][9]

A DPA, export workflow, deletion receipt, incident clock, subprocessor change procedure, and accessibility conformance report are not each independently commanded by one federal sentence.[5][6][7]
They are the common contractual mechanisms by which the school and operator make the actual federal duties provable and operable.[6][7][8]
This distinction matters: call them pilot go/no-go controls, not universal statutory wording.[6][7]

## How this paper labels obligations

- **Federal requirement** — text imposed by a current statute or regulation when its trigger is met.
- **Agency enforcement guidance** — the agency's stated application of a rule. In particular, the FTC says it will continue enforcing COPPA in edtech consistently with its existing school guidance.[2]
- **School-side operational requirement** — a capability the vendor must provide so the school can meet its own federal duty, usually made binding in the DPA.
- **Common procurement / best practice** — not a universal federal mandate by itself, but a normal and reasonable precondition for entrusting student data or providing instructional software.
- **School/state-specific** — unresolved until the Pilot School, state, legal entity, student ages, and local policies are known.

## 1. Current COPPA floor

### 1.1 Trigger and current rule

COPPA applies to a commercial operator of a child-directed website or online service, and to a general-audience operator with actual knowledge that it collects or maintains personal information from a child under 13.[1] “Collection” includes passive tracking, and personal information includes a child's name, persistent identifiers such as IP addresses or unique device identifiers, photos/voice, geolocation, and biometric identifiers.[1] An accountless session can therefore still be covered.[1]

The FTC's 2025 amendments became effective June 23, 2025, with the general compliance deadline on April 22, 2026; that deadline has passed.[2] The current rule, not the older 2013 rule summary sometimes repeated in guidance, is the compliance baseline.[1][2]

Before enabling real students, make one of these determinations and retain the evidence:

- **COPPA applies:** the Pilot Release will be directed to children under 13 or DesmosLock will have actual knowledge of under-13 users and will collect personal information. Implement the controls below.[1]
- **No under-13 collection:** the named school limits the pilot to students 13 or older and the operator does not otherwise have actual knowledge of an under-13 user. The contract, roster process, support process, and product behavior must preserve that boundary.[1]
- **No covered personal-information collection:** technically prevent collection, including passive persistent identifiers. Merely omitting student accounts is not enough.[1]

For a mixed-age K–12 deployment, the conservative pilot decision is to build the covered path rather than rely on informal age assumptions.[1][3]

### 1.2 School authorization is narrow and remains guidance

The 2025 final rule did **not** codify the proposed edtech/school amendments; the FTC expressly said it would continue enforcing COPPA in the edtech context under its existing guidance.[2] The school-consent route should therefore be treated as an FTC enforcement position that must be followed carefully, not as a broad exemption written into § 312.5.[2][3]

Under the FTC's existing guidance, a school may act as the parent's agent only in the educational context: the operator collects information for the use and benefit of the school and for no other commercial purpose.[3] The operator must contract with the school, give the school the same type of direct notice it would give a parent, verify that authorization actually comes from the school, and let the school review and delete a child's information and prevent further use or collection.[3]

The school cannot authorize advertising, marketing, unrelated profiling, sale, or another independent commercial use.[3][4]
If the operator wants an additional commercial use or disclosure, it must obtain parental consent rather than stretch the school authorization.[3]
The operator—not the school—remains responsible for COPPA compliance, and the agreement must not shift that responsibility away.[3][4]

**Pilot consequence:** use school authorization only through the contracting school/district official designated to approve the service.[3] An individual teacher click-through is not enough unless the Pilot School has expressly delegated that authority; the FTC recommends school- or district-level review as the best practice.[3]

### 1.3 What the operator must have before collection

| Topic | Current federal requirement when COPPA applies | Pilot implementation consequence |
|---|---|---|
| Online and direct notice | Post a prominent, clear online notice describing operators, information collected, uses, disclosures/third-party identities or categories and purposes, parent rights, and the written retention policy; provide direct notice before collection and for material changes.[1] | Publish a child-specific privacy notice and a matching direct notice. If relying on school authorization, deliver the direct notice to the authorized school official and preserve the dated version and authorization receipt.[3] |
| Consent and disclosure choice | Obtain verifiable parental consent before collection, use, or disclosure, subject only to enumerated exceptions. Give a separate choice for third-party disclosure unless the disclosure is integral to the service.[1] | Map every external recipient. Document why each disclosure is an internal-operations provider or integral to the school-requested service; otherwise obtain the required separate consent. Do not infer consent from product use. |
| Data minimization | Do not condition participation on providing more personal information than reasonably necessary for the activity.[1][4] | Justify every field and telemetry event. Disable advertising identifiers, unrelated analytics, unnecessary app/process details, precise location, contacts, microphone/camera capture, and other nonessential collection. |
| Review, stop, and delete | Give the parent a reasonable means to review data, refuse further use/future collection, and direct deletion.[1] Under school authorization, provide those capabilities to the school on request.[3] | Provide school-mediated per-student lookup, review, stop-processing, and deletion workflows. Test them with synthetic data before launch. |
| Written security program | Maintain a written information-security program appropriate to sensitivity and business size/scope, with a coordinator, at least annual risk assessment, risk-based safeguards, regular testing/monitoring, and at least annual evaluation/modification.[1] | A startup-sized program may be concise, but it must be real, owned, dated, and exercised. A policy template with no evidence is insufficient. |
| Service providers / subprocessors | Before another operator, service provider, or third party collects or maintains children's personal information, take reasonable steps to assess its capability and obtain written assurances of reasonable confidentiality, security, and integrity measures.[1] | Inventory every recipient, obtain written flow-down assurances, and prevent unapproved SDKs or infrastructure changes. |
| Retention and deletion | Retain children's personal information only as long as reasonably necessary for the stated purpose; do not retain indefinitely; delete with reasonable protection; maintain a written policy stating purpose, business need, and deletion timeframe; disclose that policy in the online notice.[1] | Set per-category periods, event-based deletion triggers, backup expiry, and a verifiable deletion process. “For as long as useful” is not sufficient. |

### 1.4 DesmosLock-specific COPPA posture

The Pilot Release should contractually prohibit use of identifiable or pseudonymous student data for ads, marketing, sale, unrelated profiling, cross-context tracking, or general-purpose model training.[3][4][5]
Product improvement using student-level data should occur only when it is within the school-authorized service and stated purpose; the lower-risk pilot default is synthetic data or school-approved, properly de-identified data.[3][4][6]
State law may be stricter, so even de-identified reuse remains subject to the named-school review.[3][6][7]

The direct notice and data inventory should expressly cover, if present: student-entered names; school, teacher, assessment, class, and device/session identifiers; IP/network metadata; graph/work state; join/exit timestamps; focus, process, shortcut, display, lock, and connectivity events; support records; crash logs; and data stored locally, in backups, or in cloud services.[1][3][6] This is an inventory requirement, not a conclusion that every listed field is currently collected.

## 2. FERPA school-official/direct-control floor

### 2.1 Trigger

FERPA protects PII from education records at covered educational agencies and institutions.[5] An education record is a record directly related to a student and maintained by the school or by a party acting for it; PII includes direct identifiers and other information that, alone or in combination, would let a reasonable person in the school community identify the student with reasonable certainty.[5]

FERPA can therefore attach in either direction:

- the school discloses roster, name, identifier, class, accommodation, or other education-record PII to DesmosLock;[5] or
- DesmosLock creates or maintains student-linked assessment/session records for the school.[5][6]

A random-looking ID is not automatically de-identified if the school or provider can link it back to the student.[5] Conversely, a genuinely non-identifiable calculator session with no school disclosure and no maintained student-linked record may fall outside FERPA; that conclusion needs the actual data-flow map.[5][6]

### 2.2 School-official exception conditions

When the school relies on the school-official exception instead of parent consent, the provider must:

1. perform an institutional service or function for which the school would otherwise use employees;
2. qualify under the school's annual-notice criteria as a school official with a legitimate educational interest;
3. be under the school's direct control with respect to use and maintenance of education records; and
4. comply with § 99.33's purpose and redisclosure limits.[5]

The school must use reasonable methods so school officials access only records in which they have legitimate educational interests, and its annual FERPA notice must state its criteria for school officials and legitimate educational interests.[5] The DPA should therefore implement least-privilege school roles, scoped teacher access, school-owner control, and support/admin access that is authorized, logged, and limited to need.[5][6]

Section 99.33 conditions disclosure on no further disclosure without the required consent, and allows the receiving party's officers, employees, and agents to use the information only for the purpose for which it was disclosed.[5] A subprocessor is not a loophole: its role must fit the authorized purpose, be controlled by the school/provider agreement, and receive the same use, confidentiality, security, access, and deletion restrictions.[5][7]

### 2.3 A written DPA is the practical floor, with an important legal nuance

The school-official regulation does not categorically require a written contract.[5][6] Department of Education guidance says, however, that schools outsourcing services will usually establish the required direct control through a contract signed by the school/district and provider.[6]

For this paid pilot, **no executed agreement/DPA means no-go**.[3][5][6]
That is a procurement and risk-control decision grounded in FERPA direct control, COPPA notice/authorization, and the need to bind subprocessors—not a claim that FERPA always names a “DPA.”[3][5][7]
The agreement must prevail over conflicting website terms, click-wrap terms, or later unilateral privacy-policy changes.[6][7]

### 2.4 Access, export, correction, and deletion

A covered school must provide a parent or eligible student access to education records within a reasonable time and no more than 45 days after a request, and must not destroy a record while an access request is outstanding.[5] DOE guidance tells schools to ensure provider agreements allow direct or indirect parental access, normally with the school acting as intermediary.[6]

The cited FERPA provisions set an access obligation, not a vendor file format.[5][6]
The DPA should create the operational capability: secure school-admin search and export of all records linked to a student, in a documented human-readable and usable machine-readable format, with a vendor response time short enough for the school to meet its own deadline.[5][6]
It should also support correction/amendment workflows where the school determines a record must be changed.[5]

For the school-official exception, FERPA does not set one universal vendor-retention period or destruction method.[5][7]
Direct control and purpose limits still apply, and DOE model terms recommend return or destruction when data are no longer needed or the relationship ends.[7]
The DPA should set the stricter of: the purpose ending, school request, student leaving the pilot, or contract termination—subject to an outstanding FERPA request, a documented legal hold, or a school records schedule.[5][7]
The provider should delete active copies promptly, expire backups on a stated schedule, flow deletion to subprocessors, and provide a deletion certificate or equivalent audit record.[7]

## 3. Accessibility floor for public-school-provided software

### 3.1 Duties that exist now

Public schools are covered by ADA Title II, and state/local governments remain responsible when services are provided through contractors.[9] Title II prohibits a public entity from providing, directly or through contractual or licensing arrangements, an unequal or less effective service and requires communications with people with disabilities to be as effective as communications with others.[8]

Section 504 separately prohibits a recipient of federal financial assistance from denying or providing a less effective aid, benefit, or service on the basis of disability, including through contractual or licensing arrangements.[10] These are present equal-access obligations; a future technical-standard deadline is not permission to deploy software that excludes a student now.[8][10]

For an assessment product, the Pilot School must also preserve the accommodations and equal access required for each participating student.[8][10]
The Pilot Release cannot disable or obstruct a necessary screen reader, magnifier, switch/keyboard path, captioning, or other assistive technology without a lawful and equally effective plan approved by the school.[8][10]
The product's lockdown behavior makes this a pre-pilot functional test, not a paper-only review.[8][10]

### 3.2 Current web/mobile technical standard and dates

Current 28 CFR § 35.200 requires public-entity web content and mobile apps made available directly or through contractual, licensing, or other arrangements to conform to WCAG 2.1 Level A and Level AA by the applicable date.[8] After the Department of Justice's 2026 extension, the dates are:

- **April 26, 2027** for a public entity other than a special district government with a total population of 50,000 or more;[8][9] and
- **April 26, 2028** for a public entity with a population under 50,000 or a special district government.[8][9]

The exact public entity, its population measure, and therefore its date are **school-specific and unresolved**.[8][9] The third-party-content exception does not cover content supplied under the school's contractual or licensing arrangement.[8]

DesmosLock contains browser/admin surfaces and an Electron renderer built from web technologies.
For pilot planning, test those surfaces against WCAG 2.1 AA rather than relying on an argument about packaging; counsel can confirm whether every native desktop surface falls within Subpart H's “web content” definition.[8][10]
Native desktop behavior outside the specific web/mobile rule still must satisfy Title II/Section 504 equal-access and effective-communication duties.[8][10]

### 3.3 Minimum accessibility evidence before the pilot

At minimum, test the exact installed Pilot Release and supported OS/device configuration for:

- complete keyboard-only operation with visible focus and no keyboard trap;[8]
- VoiceOver or the school-standard screen reader, including names, roles, states, errors, live status, and Desmos calculator interaction;[8]
- zoom/reflow, text scaling, contrast, color-independent meaning, and flashing safeguards;[8]
- accessible authentication, class-code entry, consent/notice, join, calculator, lock/unlock, warning, override, force-exit, and support flows;[8]
- compatibility with the student's IEP/504 accommodations and assistive technologies while lockdown is active;[8][10] and
- an accessible help/contact path and a documented defect/remediation owner.[8][9]

A current Accessibility Conformance Report (ACR/VPAT) is a common procurement artifact, not a federal certification or substitute for functional testing.[8][9]
For a bounded pilot, a scoped WCAG 2.1 AA audit plus an honest exception/remediation log can precede a full product-wide ACR only if the school accepts it and no participating student's access is impaired.[8][10]

## 4. Minimum pilot contract and evidence package

The following is the common pre-pilot floor. The “basis” column deliberately separates law from implementation or procurement practice.

| Control | Minimum clause, artifact, or verified behavior | Basis |
|---|---|---|
| Authority and scope | Name both legal entities, authorized signers, one Pilot School, term, seats, supported devices, environments, exact Pilot Release/version, support hours, and approved users. Ban teacher-side click-wrap from changing the DPA. | Common procurement; necessary to make school authorization and direct control provable.[3][6] |
| Data inventory and flow map | Enumerate each collected/generated field, source, age group, purpose, location, recipient, retention period, and whether it is COPPA PI, FERPA PII/education record, school confidential data, or operational data. Include local mode, cloud mode, logs, backups, support, analytics, and crash reporting. | Required to determine COPPA/FERPA scope; common privacy engineering.[1][5][6] |
| Purpose and prohibited uses | Limit use to delivering/supporting the school-requested pilot. Prohibit sale, ads, marketing to students/parents, unrelated profiling, cross-context tracking, re-identification, and unrelated AI/model training. Require school approval for materially new uses. | COPPA school-authorization and FERPA purpose limits when triggered; otherwise common procurement.[3][4][5] |
| Privacy notice and change control | Publish a notice matching actual behavior; include COPPA-required content when applicable. Give advance notice and require school consent before a material data-use change; preserve version history. | COPPA legal requirement when triggered; transparency/change control otherwise procurement.[1][3][7] |
| DPA / direct control | State school-official status where applicable; school ownership/control; legitimate educational interest; limited license; confidentiality; authorized support access; no conflicting terms; and survival of privacy/security/deletion obligations. | FERPA direct-control mechanism and common paid-school contracting.[5][6] |
| Access and export | School can retrieve all school and per-student data securely, including event logs and records maintained by subprocessors, within a contract period that preserves the school's 45-day FERPA maximum. Document formats and authentication. | School-side FERPA access capability; format/SLA is procurement.[5][6] |
| Retention and deletion | Per-category purpose and maximum period; deletion on purpose end, school request, or termination; backup expiry; legal-hold/outstanding-request handling; subprocessor flow-down; deletion confirmation. | COPPA legal requirement when triggered; FERPA direct control and DOE best practice otherwise.[1][7] |
| Subprocessors | List legal name, service, data, purpose, hosting region, and link to terms; prior notice for additions; school objection/termination path; same-use/security/deletion obligations; no undisclosed SDKs; written COPPA security assurances when applicable. | COPPA § 312.8(c) and FERPA use/redisclosure constraints; list/change mechanics are procurement.[1][5][7] |
| Security program | Named coordinator; current risk assessment; least privilege; MFA for privileged/remote administration; strong authentication; encryption in transit and at rest; secrets handling; secure configuration; dependency/patch/vulnerability management; logging/monitoring; backups and restore tests; secure development/release; staff confidentiality/training; annual review. | COPPA written-program requirements when triggered; DOE-recommended security and procurement evidence otherwise.[1][6][7] |
| Incident response | Written and exercised plan; 24/7 or reliably monitored reporting contact; containment, forensics/evidence preservation, credential/session revocation, recovery, status updates, root-cause/remediation report, and cooperation with school notices. Notify the school without unreasonable delay and no later than the school/state-specific contractual clock. | Written plan and prompt school notice are DOE model terms; the exact notification clock is not a universal COPPA/FERPA number and must be set by state law/DPA.[7] |
| Accessibility | WCAG 2.1 AA test report for applicable web content, critical-path assistive-technology tests for the installed desktop app, known-defect list, remediation dates, accessible support, and no blocking of required accommodations. | ADA Title II/Section 504 legal access duties; report/ACR format is procurement.[8][9][10] |
| Audit and evidence | Permit the school to receive reasonable evidence: policies, risk summary, test summaries, incident/deletion records, subprocessor assurances, and remediation status. Scope audit rights to protect other customers and security. | Common procurement; supports COPPA reasonable security and FERPA direct control.[1][6][7] |
| Termination and transition | School export first, access cutoff, credential revocation, return/deletion, backup expiry, subprocessor deletion, and continuing confidentiality. Provide a workable exit if the provider fails or service ends. | Common procurement; supports access, purpose, retention, and direct control.[1][5][6] |

### Security evidence proportional to a pilot

A pilot does not require SOC 2 or ISO 27001 by the cited federal rules.[1][5][8]
It does require actual controls appropriate to the data and, when COPPA applies, the current written-program elements in § 312.8.[1]
Acceptable pilot evidence can be a signed security summary, current risk register, focused independent or qualified internal assessment, vulnerability/dependency scan results, backup/restore evidence, access-control review, and remediation record.[1][6][7]
A badge without those controls is not enough.[1]

Do not transmit student PII in plaintext merely because devices share a classroom LAN.[1][6][7]
Encryption in transit, authenticated endpoints, least privilege, and secure logs are common minimum safeguards; any deviation needs a documented risk decision accepted by the school.[1][6][7]

### Incident notification nuance

Neither the cited COPPA Rule nor the cited FERPA school-official provisions establish one universal vendor-to-school breach-notification number of hours.[1][5]
COPPA does require a reasonable written security program, and DOE model terms recommend a written incident-response plan with prompt school notification.[1][7]
State breach laws, state student-privacy laws, and district DPAs commonly supply the binding clock; insert that clock only after the Pilot School and state are known.[6][7]

The contract should make the vendor notify the school on a confirmed or reasonably suspected compromise of school/student data or material loss of confidentiality, integrity, or availability—not only after the vendor has completed its investigation.[7] It should allocate who determines legally required parent, regulator, insurer, or law-enforcement notices; the vendor should not make a school-attributed notice without authorization unless law requires it.[7]

## 5. Go/no-go acceptance matrix

No real student/customer PII should enter the Pilot Release until every **must-pass** item below has evidence.[1][5][6]

| Must-pass item | Acceptance evidence |
|---|---|
| Named customer and applicable-law review | Pilot School legal name, state, public/private and funding status, contracting authority, district/public-entity identity and population category, student age/grade range, counsel/procurement owner, and approved state/local addendum. |
| Product/data boundary | Approved Pilot Release hash/version, architecture and data-flow diagram, field inventory, environments, supported devices, roles, and full recipient/subprocessor list. |
| COPPA path | Written applicability determination; current online/direct notice; parent consent workflow or dated school authorization from an authorized official; verified review/stop/delete workflow; retention and security programs. |
| FERPA path | School-official determination if used, annual-notice compatibility confirmed by school, executed direct-control/use/redisclosure terms, least-privilege roles, and parent/school access support. |
| Contract package | Signed order/pilot agreement, DPA, security exhibit, subprocessor exhibit, retention/deletion schedule, incident clause, accessibility exhibit, and precedence over click-wrap/online terms. |
| Security readiness | Named coordinator, current risk assessment, remediated critical/high findings or school-accepted exceptions, privileged-access review, encryption check, restore test, logging/alert check, dependency scan, and incident tabletop. |
| Access/export/deletion | Synthetic per-student and tenant-wide export receipt, correction/stop-processing test, active-store deletion test, documented backup expiry, subprocessor propagation, and deletion audit record. |
| Accessibility | WCAG/assistive-technology critical-path report on the exact devices; no blocker for participating students' accommodations; accepted remediation plan for noncritical defects. |
| Operational ownership | Named vendor and school contacts for privacy, security incidents, accessibility, support, release approval, and emergency unlock/exit; training and a one-page incident/escalation card. |
| Claims control | Website, proposal, and training claims match tested behavior; do not claim “FERPA certified,” “COPPA certified,” guaranteed cheating prevention, or an accessibility certification the evidence does not support. |

## 6. District-scale maturity that can wait

The following are **not universal federal preconditions** in the cited rules and guidance to one controlled pilot, unless the named school makes them contractual requirements:[1][5][6]

- SOC 2 Type II, ISO 27001 certification, a full-time CISO/privacy officer, or a 24/7 security operations center;[1][6][7]
- a formal uptime SLA, service credits, multi-region failover, automated disaster-recovery orchestration, or district-scale capacity evidence;
- SSO, SCIM, SIS/LMS integration, automated rostering, self-service billing, or a fully automated data-subject-request portal;
- an automated subprocessor portal or deletion pipeline, if a controlled manual process is documented, timely, tested, and auditable;
- a nationwide state-law matrix before the Pilot School is selected;
- district-wide accessibility certification, if the exact pilot critical paths are already accessible and the school accepts a bounded remediation plan for nonpilot surfaces; and
- district-wide cyber-insurance limits, indemnity positions, and procurement forms before the school states its requirements.

What cannot wait is the underlying control: a manual but verified export is acceptable; no export is not.[5][6]
A manual but verified deletion process is acceptable; indefinite retention is not.[1][7]
A scoped security assessment is acceptable; an unassessed release is not.[1][6][7]
A bounded accessibility audit is acceptable; excluding a participating student or blocking required assistive technology is not.[8][10]

## 7. Explicitly unresolved until the Pilot School is named

Do **not** mark these complete from this federal baseline:

1. **State student-privacy law and required DPA language.** Restrictions on sale, targeted advertising, profiling, product improvement, de-identified data, successor entities, operator duties, and contract terms vary by state.[3][6][7]
2. **State general breach law and notice clock.** The triggering data, risk-of-harm standard, regulator/parent notice, content, and timing depend on the affected people and state.[6][7]
3. **School/district contract and procurement.** Required form agreement, board approval, purchase authority, insurance, indemnity, governing law, records law, public-records treatment, background checks, security questionnaire, hosting/data-residency rules, and audit rights are local.[6][7]
4. **FERPA posture.** Confirm the school receives Department of Education funds, its annual-notice school-official criteria, legitimate-interest definition, records schedule, parent-access workflow, and authorized contracting/consent official.[5][6]
5. **COPPA population and authorization.** Confirm participant ages, whether the operator is child-directed or has actual knowledge, who can authorize for the school, and whether any use/disclosure lies outside the requested educational service.[1][3]
6. **ADA Title II date and exact surface classification.** Identify the public entity and population category, determine which Electron/native surfaces are “web content,” and reconcile the Pilot Release with participating students' IEP/504 accommodations.[8][9][10]
7. **Actual Pilot Release data and subprocessors.** Decide cloud versus local architecture and verify which parties—including infrastructure, authentication, calculator, hosting, analytics, logging, crash-reporting, email, and support providers—receive which data. A company name in the repository is not by itself a final subprocessor determination.
8. **Sensitive or regulated collection.** Resolve any voice, image, biometric, precise location, disability/accommodation, app/process-monitoring, or device-surveillance data under the named state's laws and the school's policies.[1][5][6]
9. **Exact incident, deletion, and export service levels.** Insert the stricter of law, school policy, and negotiated DPA; do not invent a universal 24-, 48-, or 72-hour federal rule.[1][5][7]
10. **Private-school alternative.** If the customer is not a public school, re-evaluate ADA title, Section 504 recipient status, FERPA coverage, governance, and procurement rather than reusing the public-school analysis unchanged.[5][8][10]

## Bottom line

A controlled paid pilot may defer enterprise certifications and automation, but it may not defer purpose limitation, valid authorization, direct control, truthful notice, least-privilege access, tested export/deletion, subprocessor accountability, reasonable security, incident readiness, or equal access.[1][5][8]
The fastest compliant pilot is not a waiver of those controls; it is a narrow release, narrow dataset, narrow customer, short retention schedule, small approved recipient list, and concrete evidence that each control works.[1][6][7]

## Sources

[1] https://www.ecfr.gov/current/title-16/chapter-I/subchapter-C/part-312 — 16 CFR Part 312 — Children's Online Privacy Protection Rule
    > "A persistent identifier that can be used to recognize a user over time and across different websites or online services. Such persistent identifier includes, but is not limited to, a customer number held in a cookie, an Internet Protocol (IP) address, a processor or device serial number, or unique device identifier;"
    > "At a minimum, the operator must establish, implement, and maintain a written information security program that contains safeguards that are appropriate to the sensitivity of the personal information collected from children and the operator's size, complexity, and nature and scope of activities."
    > "Before allowing other operators, service providers, or third parties to collect or maintain personal information from children on the operator's behalf, or before releasing children's personal information to such entities, the operator must take reasonable steps to determine that such entities are capable of maintaining the confidentiality, security, and integrity of the information and must obtain written assurances that such entities will employ reasonable measures to maintain the confidentiality, security, and integrity of the information."
    > "At a minimum, the operator must establish, implement, and maintain a written data retention policy that sets forth the purposes for which children's personal information is collected, the business need for retaining such information, and a timeframe for deletion of such information."
[2] https://www.federalregister.gov/documents/2025/04/22/2025-05904/childrens-online-privacy-protection-rule — FTC Final Rule Amendments — Children's Online Privacy Protection Rule (2025)
    > "The amended Rule is effective June 23, 2025."
    > "Except with respect to § 312.11(d)(1), (d)(4), and (g), regulated entities have until April 22, 2026 to comply."
    > "The Commission will continue to enforce COPPA in the ed tech context consistent with its existing guidance."
[3] https://www.ftc.gov/business-guidance/resources/complying-coppa-frequently-asked-questions — FTC — Complying with COPPA: Frequently Asked Questions
    > "However, the school’s ability to consent for the parent is limited to the educational context – where an operator collects personal information from students for the use and benefit of the school, and for no other commercial purpose."
    > "Importantly, operators should not state in Terms of Service or anywhere else that the school is responsible for complying with COPPA, as it is the responsibility of the operator to comply with the Rule."
    > "In order for the operator to rely on consent obtained from the school under COPPA instead of the parent, the operator must provide the school with the same type of direct notice regarding its practices as to the collection, use, or disclosure of personal information from children as it would otherwise provide to the parent."
    > "In addition, the operator, upon request from the school, must provide the school a description of the types of personal information collected; an opportunity to review the child’s personal information and the right to have the information deleted; and the opportunity to prevent further use or online collection of a child’s personal information."
[4] https://www.ftc.gov/legal-library/browse/policy-statement-federal-trade-commission-education-technology-childrens-online-privacy-protection — FTC Policy Statement on Education Technology and COPPA
    > "In this context, ed tech companies are prohibited from using such information for any commercial purpose, including marketing, advertising, or other commercial purposes unrelated to the provision of the school-requested online service."
    > "The responsibility for COPPA compliance is on businesses, not schools or parents—and agreements must reflect that."
[5] https://www.ecfr.gov/current/title-34/subtitle-A/part-99 — 34 CFR Part 99 — FERPA Regulations
    > "(1) Performs an institutional service or function for which the agency or institution would otherwise use employees; (2) Is under the direct control of the agency or institution with respect to the use and maintenance of education records; and (3) Is subject to the requirements of § 99.33(a) governing the use and redisclosure of personally identifiable information from education records."
    > "The educational agency or institution, or SEA or its component, shall comply with a request for access to records within a reasonable period of time, but not more than 45 days after it has received the request."
    > "The officers, employees, and agents of a party that receives information under paragraph (a)(1) of this section may use the information, but only for the purposes for which the disclosure was made."
[6] https://studentprivacy.ed.gov/resources/protecting-student-privacy-while-using-online-educational-services-requirements-and-best — U.S. Department of Education PTAC — Online Educational Services: Requirements and Best Practices
    > "While FERPA regulations do not require a written agreement for use in disclosures under the school official exception, in practice, schools and districts wishing to outsource services will usually be able to establish direct control through a contract signed by both the school or district and the provider."
    > "Schools and districts should ensure that their agreements with providers include provisions to allow for direct or indirect parental access."
[7] https://studentprivacy.ed.gov/resources/protecting-student-privacy-while-using-online-educational-services-model-terms-service — U.S. Department of Education PTAC — Model Terms of Service
    > "schools/districts should be made aware of these arrangements and subcontractors should be bound by the limitations in the TOS."
    > "Provider will also have a written incident response plan, to include prompt notification of the [School/District] in the event of a security or privacy incident, as well as best practices for responding to a breach of PII."
[8] https://www.ecfr.gov/current/title-28/chapter-I/part-35 — 28 CFR Part 35 — ADA Title II Regulations
    > "A public entity shall ensure that the following are readily accessible to and usable by individuals with disabilities: (1) Web content that a public entity provides or makes available, directly or through contractual, licensing, or other arrangements; and (2) Mobile apps that a public entity provides or makes available, directly or through contractual, licensing, or other arrangements."
    > "Beginning April 26, 2027, a public entity, other than a special district government, with a total population of 50,000 or more shall ensure that the web content and mobile apps that the public entity provides or makes available, directly or through contractual, licensing, or other arrangements, comply with Level A and Level AA success criteria and conformance requirements specified in WCAG 2.1, unless the public entity can demonstrate that compliance with this section would result in a fundamental alteration in the nature of a service, program, or activity or in undue financial and administrative burdens."
    > "Beginning April 26, 2028, a public entity with a total population of less than 50,000 or any public entity that is a special district government shall ensure that the web content and mobile apps that the public entity provides or makes available, directly or through contractual, licensing, or other arrangements, comply with Level A and Level AA success criteria and conformance requirements specified in WCAG 2.1, unless the public entity can demonstrate that compliance with this section would result in a fundamental alteration in the nature of a service, program, or activity or in undue financial and administrative burdens."
    > "Content posted by a third party, unless the third party is posting due to contractual, licensing, or other arrangements with the public entity."
[9] https://www.ada.gov/resources/2024-03-08-web-rule — DOJ ADA.gov — Web and Mobile Accessibility Rule Fact Sheet
    > "Public schools, community colleges, and public universities"
    > "State and local governments that contract with other entities to provide public services for them (like non-profit organizations that run drug treatment programs on behalf of a state agency) also have to make sure that their contractors follow Title II."
    > "On April 20, 2026, the Federal Register published the Department’s Interim Final Rule (IFR) extending the compliance date for State and local government entities with a total population of 50,000 or more to April 26, 2027. The compliance date for public entities with a total population of less than 50,000, or any special district government, is extended to April 26, 2028."
[10] https://www.ecfr.gov/current/title-34/subtitle-B/chapter-I/part-104 — 34 CFR Part 104 — Section 504 Regulations
    > "A recipient, in providing any aid, benefit, or service, may not, directly or through contractual, licensing, or other arrangements, on the basis of handicap:"
    > "Provide a qualified handicapped person with an aid, benefit, or service that is not as effective as that provided to others;"

# MobyDB SCADA Sidecar — Integration Specification

```
Document:   mobydb_scada_sidecar_spec.md
Version:    1.0
Status:     Draft for utility integration engineering review
Owner:      ULISSY s.r.l. · camilo@ulissy.app
Audience:   SCADA integrators, OT security, control-room engineering
```

---

## 1. Purpose

This document specifies the **MobyDB SCADA Sidecar** — a read‑only subscriber
that sits beside an existing SCADA / historian / EMS deployment and produces
a **signed, jurisdictionally‑scoped, Merkle‑verifiable** mirror of telemetry
into MobyDB.

The sidecar exists because two audiences want the same data in two
incompatible shapes:

- **Control room operators** want low latency, high availability, and
  absolutely no new failure modes in the control path.
- **Auditors and regulators** (NIS2 CSIRT, EU AI Act supervisory authority,
  ENTSO‑E, internal compliance) want cryptographic evidence of what
  happened, who wrote it, and where — retrievable years later.

The sidecar delivers the second without touching the first.

---

## 2. Non‑goals

Explicit, so no one is surprised later.

1. **The sidecar is not a SCADA replacement.** It does not supervise, does
   not issue control commands, does not hold alarms.
2. **The sidecar is not in the control path.** Failure of the sidecar must
   not degrade SCADA availability or latency by any measurable amount.
3. **The sidecar does not back‑write to SCADA.** Writes flow one way:
   SCADA → sidecar → MobyDB.
4. **The sidecar does not decode proprietary vendor extensions** unless
   explicitly modelled. It reads standard protocols (OPC UA, DNP3,
   IEC 61850 MMS). Vendor‑specific payloads pass through as opaque bytes.
5. **The sidecar does not store beyond a short buffer.** Durability is
   MobyDB's job; the sidecar is a stream.

---

## 3. Architecture

### 3.1 Where the sidecar sits

```
             ┌─────────────────────────────────────────┐
             │  OT network · ISA‑95 Level 2            │
             │  (PLC · RTU · IED · field bus)          │
             └──────────────┬──────────────────────────┘
                            │
              ┌─────────────▼─────────────┐
              │  SCADA / EMS / historian  │  ← unchanged
              │  (vendor of record)       │
              └────┬─────────────────┬────┘
                   │ read-only       │
                   │ subscription    │ (OPC UA / DNP3 / 61850)
                   ▼                 │
         ┌───────────────────┐       │
         │  MobyDB Sidecar   │       │
         │  (this spec)      │◄──────┘
         │                   │
         │  sign · scope ·   │
         │  buffer · ship    │
         └─────────┬─────────┘
                   │ HTTPS + mTLS
                   ▼
         ┌───────────────────┐
         │  MobyDB cluster   │  ← jurisdictionally scoped
         │  (L3 / DMZ-audit) │
         └─────────┬─────────┘
                   │
                   ▼
         ┌───────────────────┐
         │  Auditors · AI    │  ← regulators, compliance,
         │  agents · Hive    │     GNS‑AIP agents
         └───────────────────┘
```

The sidecar lives in a **dedicated audit zone** (IEC 62443 Level 2.5 /
DMZ) between the SCADA zone and the corporate network. It is a
subscriber, never a publisher back into the OT zone.

### 3.2 Data flow

One direction. Strictly.

```
[PLC]──▶[SCADA]──▶[sidecar subscribe]──▶[sign]──▶[buffer]──▶[MobyDB]
                                   │
                                   └──▶ drop on full buffer + alarm
```

Back‑pressure policy: if MobyDB is unreachable, the sidecar fills its
in‑memory + on‑disk buffer (default 4 GiB, operator‑tunable). Once the
buffer is 90 % full the sidecar **drops oldest records and raises a
log‑level ALARM**. It does not block the subscription, ever.

### 3.3 Control path guarantees

These are the properties the sidecar must preserve. They are the reason
the sidecar exists at all.

- **Zero writes toward OT.** The subscription is a one‑way OPC UA / DNP3
  / IEC 61850 connection with write permissions disabled at the SCADA
  ACL, not only at the sidecar.
- **Bounded CPU and memory footprint.** `cgroup` enforced: 2 vCPU,
  2 GiB RAM default. Exceeding triggers an orderly shutdown, not a
  kill‑9.
- **Bounded network egress.** `tc` rate‑limits outbound to 50 Mbit/s
  default. Prevents a misconfigured sidecar from saturating the
  corporate uplink.
- **No privileged OS access.** Runs as an unprivileged user in a
  read‑only rootfs container. No `CAP_NET_ADMIN`, no `CAP_SYS_PTRACE`.
- **No dynamic code loading.** Single statically‑linked binary. No
  Lua/JS/Python interpreter embedded. Reduces supply‑chain surface.

---

## 4. Configuration

### 4.1 scada‑adapter.toml schema

Complete example. Every field has a default; the minimal usable config
is roughly 15 lines.

```toml
# ── identity ─────────────────────────────────────────────────
[identity]
# GNS handle of the signer. The sidecar will refuse to start
# if the key material cannot be loaded.
handle        = "sidecar@astalli.terna"
signer_source = "hsm"           # "hsm" | "file" | "pkcs11"
hsm_uri       = "pkcs11:slot=0;object=sidecar-astalli"

# Delegation certificate proving this sidecar is authorised
# by a human principal to sign records in the named territory.
delegation    = "/etc/mobydb/delegation.cert.json"

# ── source ───────────────────────────────────────────────────
[source.opcua]
endpoint           = "opc.tcp://scada.astalli.terna.local:4840"
security_policy    = "Basic256Sha256"
security_mode      = "SignAndEncrypt"
user_cert          = "/etc/mobydb/client.crt"
user_key           = "/etc/mobydb/client.key"

# Subscription set — operator-defined. Each line maps an OPC UA
# node to a MobyDB payload facet.
subscriptions = [
  { node = "ns=2;s=Astalli/Bus1/V",     facet = "grid.voltage.kv" },
  { node = "ns=2;s=Astalli/Bus1/I",     facet = "grid.current.a"  },
  { node = "ns=2;s=Astalli/Feeder/MW",  facet = "grid.load.mw"    },
]
publishing_interval_ms = 1000
queue_size             = 10

# ── spatial scoping ──────────────────────────────────────────
[geography]
# Sidecar discovers its position from a static mapping file.
# Each OPC UA node path is bound to an H3 cell at a chosen
# resolution. Writes outside this territory are rejected by
# MobyDB as unauthorised, even if signed correctly.
placement_file  = "/etc/mobydb/placement.astalli.json"
h3_resolution   = 9             # ~174 m edge — substation granularity
strict_scoping  = true          # reject write if node absent from placement

# ── sink ─────────────────────────────────────────────────────
[sink.mobydb]
url              = "https://mobydb.corp.terna.it/v1/write"
mtls_cert        = "/etc/mobydb/sink.crt"
mtls_key         = "/etc/mobydb/sink.key"
mtls_ca          = "/etc/mobydb/sink.ca"
batch_size       = 128          # records per request
flush_ms         = 1000
compression      = "zstd"
max_inflight     = 4

# ── buffer ───────────────────────────────────────────────────
[buffer]
memory_mib     = 512
disk_path      = "/var/lib/mobydb-sidecar/spool"
disk_max_gib   = 4
high_water_pct = 90             # triggers ALARM
drop_policy    = "oldest"       # "oldest" | "newest"

# ── observability ────────────────────────────────────────────
[telemetry]
prometheus_bind  = "127.0.0.1:9464"
log_level        = "info"
log_format       = "json"
syslog           = "/run/syslog"
```

### 4.2 HSM and key management

The sidecar's Ed25519 key is the most sensitive artefact it touches.
Policy:

- Key is generated on the HSM and **never leaves** it. The sidecar holds
  a PKCS#11 session; `sign()` is delegated to the HSM. No software‑key
  mode in production.
- Key rotation is operator‑driven. Rotate by: (a) generate new key on
  HSM, (b) obtain new delegation certificate for the new public key,
  (c) update `signer_source`, (d) SIGHUP the sidecar. Old records
  remain verifiable against the old key; the old key is retained in
  the HSM audit log but removed from the active signing slot.
- Compromise response: revoke the delegation certificate at the GNS
  Foundation registry. MobyDB will reject subsequent writes from the
  revoked key within one epoch.

Fall‑back `signer_source = "file"` is allowed **only** in lab /
pre‑production environments, and the binary logs a WARN on every start
in that mode.

### 4.3 Territory scoping

Scoping is enforced in two places — belt and suspenders.

1. **Sidecar‑local** — `placement.astalli.json` maps every subscribed
   OPC UA node to an H3 cell. A subscription update for an unmapped
   node is dropped and logged.
2. **MobyDB‑server** — the delegation certificate carries the H3 cell
   prefixes this sidecar is allowed to write. The server re‑checks
   every record. A misconfigured sidecar cannot forge territory.

Example placement file (abridged):

```json
{
  "ns=2;s=Astalli/Bus1/V":     { "h3": "891e8052affffff" },
  "ns=2;s=Astalli/Bus1/I":     { "h3": "891e8052affffff" },
  "ns=2;s=Astalli/Feeder/MW":  { "h3": "891e8052a7ffffff" }
}
```

---

## 5. Deployment modes

### 5.1 Same‑host Linux container

Simplest. The sidecar runs as a rootless Podman / Docker container on
the SCADA application server, inside the same VLAN. Latency to SCADA is
sub‑millisecond; latency to MobyDB depends on the audit‑DMZ path.

Suitable when: the SCADA host has spare capacity and the organisation is
comfortable running the sidecar on a Level 2 / 2.5 host.

### 5.2 Side‑rack dedicated appliance

Recommended for Terna‑scale deployments. A 1U appliance in the substation
rack, connected to SCADA over a dedicated VLAN, to the audit DMZ over a
separate VLAN, and to the HSM over a PCIe or SmartCard reader.

Suitable when: operations wants physical and logical separation from the
SCADA application server. Preferred under IEC 62443 Level 3 postures.

### 5.3 Virtualised (KVM / VMware)

Same binary, packaged as a VM. Less common but supported for
organisations with strict "no new hardware" policies. The HSM is
attached via `virtio‑scsi` passthrough of a USB HSM or a network HSM
(Thales Luna, Utimaco).

**Not supported**: running the sidecar on the SCADA host's own
hypervisor without network segmentation. This collapses the audit zone
into the control zone.

---

## 6. Protocols

The sidecar implements three OT protocols natively. Each has its own
subscription semantics; the internal record shape is unified.

### 6.1 OPC UA subscription

Modern, structured, well‑supported. Uses OPC UA security (`Basic256Sha256`
+ `SignAndEncrypt`). Subscriptions are monitored items with a
publishing interval, matching how historians already read SCADA.

- Pros: typed values, timestamps with quality codes, built‑in security.
- Cons: vendor implementations vary in completeness; some expose
  nonstandard `StatusCode` bits that the sidecar records as opaque.

### 6.2 DNP3 outstation polling

Legacy but ubiquitous in distribution grids. The sidecar acts as a DNP3
master polling the SCADA DNP3 gateway, not the outstations themselves —
to preserve the control path.

- Pros: well understood; Secure Authentication v5 supported.
- Cons: integer‑only analogue inputs in many deployments; the sidecar
  maps engineering‑unit conversions from a sidecar‑local table, which
  must match the SCADA's.

### 6.3 IEC 61850 MMS (substation)

For substation automation. The sidecar subscribes to MMS reports from
IEDs via the station bus. GOOSE and Sampled Values are intentionally
out of scope — they are too tightly coupled to the control path and
too high‑rate to be useful as audit evidence.

- Pros: native to modern substations; rich data model.
- Cons: requires ICD file parsing; report‑control block subscriptions
  must be negotiated at config time.

Other protocols (Modbus, IEC 60870‑5‑104) are handled by an OPC UA
gateway upstream. The sidecar does not read them directly.

---

## 7. Write path

End‑to‑end, what happens when a PLC updates `Astalli/Bus1/V` to 132.4 kV:

```
1. PLC updates tag in SCADA RTDB.
2. SCADA OPC UA server publishes to its subscribers, including the
   sidecar's monitored item (publishing interval 1s).
3. Sidecar receives NotificationMessage:
     { node: "ns=2;s=Astalli/Bus1/V",
       value: 132.4, quality: 0xC0, ts: 2026-04-22T10:03:14.128Z }
4. Sidecar looks up node → H3 cell via placement.json
     → 891e8052affffff
5. Sidecar constructs MobyDB record (canonical JSON):
     {
       h3_cell: "891e8052affffff",
       epoch:   <current server epoch>,
       pubkey:  "ed25519:3c8f…",
       facet:   "grid.voltage.kv",
       payload: { value: 132.4, quality: 0xC0, ts: "…" },
       parent:  <previous record hash>
     }
6. Sidecar calls HSM: sign(blake3(canonical_json)) → signature.
7. Record + signature batched; ZSTD‑compressed; POSTed over mTLS to
   MobyDB /v1/write.
8. MobyDB:
     a. verifies signature against delegation chain,
     b. verifies H3 cell is in the signer's allowed territory,
     c. stores (h3, epoch, pubkey) → record,
     d. adds leaf to the current epoch's Merkle tree,
     e. returns 201 with record_hash.
9. Sidecar ACKs the batch; buffer drains.
```

Typical wall‑clock from SCADA publish to MobyDB 201: **40–120 ms** on
the same LAN; **150–400 ms** over a WAN to a regional MobyDB cluster.
Not time‑critical — this is audit evidence, not control.

---

## 8. Failure modes

Every failure mode the sidecar can experience, what it does, and what
the operator sees.

```
FAILURE                       SIDECAR BEHAVIOUR            OPERATOR SEES
──────────────────────────────────────────────────────────────────────────
MobyDB unreachable            buffer to disk               WA  buffer_bytes
                                                          > high_water
                                                          alarm

HSM unreachable               stop accepting new records;  VI  signer_down
                              do not drop existing         alarm; sidecar
                              buffered data                marked unhealthy

SCADA subscription drops      exponential back-off         WA  source_down
                              reconnect; no data loss      alarm; gap in
                              (SCADA-side buffering)       audit trail during
                                                           outage

Clock skew > 5 s              refuse to sign; log ERROR    VI  clock_skew
                                                           alarm

Placement file missing node   drop record; log INFO        WA  unmapped_node
                                                           counter increments

Delegation cert expired       refuse to sign; log ERROR    VI  cert_expired
                              buffer continues to fill     alarm; operator
                                                           must rotate before
                                                           buffer full

Disk buffer full              drop per drop_policy;         VI  buffer_full
                              continue accepting subs       alarm; audit gap
                                                           logged

Binary OOM (approached        orderly shutdown;            VI  sidecar_down;
cgroup limit)                 systemd restart              auto-recovery
```

Notably **absent**: no failure mode kills SCADA, blocks SCADA, or
degrades SCADA latency. That is by design.

---

## 9. Security posture

### 9.1 NIS2 alignment

The sidecar is one component of the operator's NIS2 risk‑management
obligations. It contributes directly to:

- **Art. 21(2)(a)** — risk analysis: the sidecar emits Prometheus
  metrics and JSON logs consumable by the operator's SIEM.
- **Art. 21(2)(e)** — security of network and information systems in
  the context of incident handling: the signed record stream is the
  forensic artefact for post‑incident reconstruction.
- **Art. 23** — incident notification: the sidecar's audit trail
  answers the "what exactly changed in the 72 h window" question CSIRT
  will ask.

### 9.2 IEC 62443 zones and conduits

The sidecar lives in a dedicated zone:

```
Zone: MobyDB-Audit
Level: SL-T 3
Conduits:
  Conduit-A (SCADA → sidecar): OPC UA Sign+Encrypt, no back-channel
  Conduit-B (sidecar → MobyDB): mTLS 1.3, outbound only
  Conduit-C (sidecar ↔ HSM):   PKCS#11 over TLS or PCIe
```

All three conduits have independent firewall policies, independent
keys, independent auditing. A compromise of any one conduit does not
cascade.

### 9.3 EU AI Act Art. 12 evidence

The sidecar's output is the substrate for Art. 12 record‑keeping for
any high‑risk AI system that consumes grid telemetry. Specifically:

- Every record carries its writer's public key → Art. 12(2)(b).
- Every record is in a sealed epoch chain → Art. 12(2)(a).
- Per‑cell territory scoping → Art. 25 territorial applicability.
- Offline‑verifiable attestation bundles → Art. 72 post‑market
  monitoring and Art. 26§6 retention.

The integration page at <demo.mobydb.com/integration.html> details the
five‑step compliance pipeline end‑to‑end.

---

## 10. Day‑1 integration checklist

What Terna's (or Areti's) integration engineer needs to do to bring a
single substation online. Not a project plan — a checklist.

```
PRE-WORK (off the shelf)
  [ ] One 1U appliance or VM matching §5.1–§5.3 reserved
  [ ] HSM slot allocated (Thales Luna 7 / Utimaco SecurityServer)
  [ ] Audit-DMZ VLAN provisioned with egress to MobyDB cluster
  [ ] MobyDB service endpoint registered in DNS
  [ ] GNS handle requested: sidecar@<site>.<operator>
  [ ] Delegation certificate issued by operator principal

PHASE 1 — Bring-up (≤ 2 hours)
  [ ] Install binary; verify cgroup limits enforced
  [ ] Load Ed25519 keypair onto HSM; confirm PKCS#11 session
  [ ] Install delegation.cert.json; mobydb-sidecar --validate passes
  [ ] Place scada-adapter.toml with dry-run true
  [ ] Connect to SCADA OPC UA in sign+encrypt mode
  [ ] Confirm monitored items receive first NotificationMessage

PHASE 2 — Territory wiring (≤ 4 hours)
  [ ] Map every subscribed node → H3 cell in placement.json
  [ ] Disable dry-run; confirm first POST to MobyDB returns 201
  [ ] Confirm Merkle root visible in MobyDB /stats

PHASE 3 — Observability (≤ 2 hours)
  [ ] Prometheus scrape target added
  [ ] JSON logs forwarded to SIEM
  [ ] Alert rules: source_down, signer_down, buffer_full, clock_skew
  [ ] Grafana dashboard imported from mobydb-sidecar-dashboard.json

PHASE 4 — First audit (day 2)
  [ ] Run  mobydb attest --cell <hex> --epoch <n>  from a workstation
  [ ] Verify offline:  mobydb verify attestation.json  → OK
  [ ] Hand the artefact to compliance for review
  [ ] Mark substation as AUDIT-READY in operator CMDB
```

Typical substation bring‑up once pre‑work is complete: **one working
day** with one engineer on each side.

---

## 11. Known limitations — honestly drawn

Per project engineering practice: disclose before deployment.

1. **No GOOSE / Sampled Values.** Out of scope by design. The sidecar
   records MMS reports; sub‑cycle substation data is not audit material.

2. **Clock drift.** The sidecar refuses to sign if its NTP‑synced clock
   skew exceeds 5 s. Substations without a reliable time source must
   install PTP or local GPS before deployment.

3. **Engineering unit tables.** For DNP3 only, the sidecar must hold
   its own EU conversion table. A mismatch with the SCADA's table
   produces silently‑wrong payloads. Validation is a day‑1 checklist
   item (§10 Phase 2).

4. **No schema enforcement on payloads.** The sidecar accepts whatever
   the subscription emits. Consumers downstream (AI agents, analysts)
   must agree on the facet shape. A future version will carry a
   sidecar‑side schema registry.

5. **Single‑site scope per process.** One sidecar instance serves one
   SCADA endpoint. Multi‑site deployments run one instance per site,
   with independent HSM slots and delegation certificates.

6. **No replay.** The sidecar is not a historian. It does not re‑send
   records that were already acknowledged by MobyDB. Audit‑trail gaps
   during extended outages are real and must be addressed by SCADA‑side
   store‑and‑forward or by dual‑sidecar deployment.

7. **No on‑premise MobyDB packaging yet.** Terna pilots today write to
   a MobyDB instance in a Railway‑hosted EU region. A Hetzner /
   on‑premise MobyDB build is on the Week‑9 plan, not available as of
   the current draft.

---

## 12. Appendix A — Record shape, canonical form

Exactly the bytes signed:

```
{
  "h3_cell":  "891e8052affffff",
  "epoch":    42,
  "pubkey":   "ed25519:3c8f8b1a…",
  "facet":    "grid.voltage.kv",
  "payload": {
    "value":   132.4,
    "quality": 192,
    "ts":      "2026-04-22T10:03:14.128Z"
  },
  "parent":   "blake3:6f2c4a…"
}
```

Canonicalisation: keys sorted ASCII; null fields excluded; numbers
normalised (no trailing zeros, no +/‑0); UTF‑8. This matches the
canonical JSON rules used everywhere else in the GNS stack.

Signature: `ed25519_sign(sk, blake3(canonical_json))`.

## 13. Appendix B — Referenced standards

```
OPC UA                IEC 62541
DNP3 Secure Auth v5   IEEE 1815‑2012
IEC 61850 MMS         IEC 61850‑8‑1
NIS2                  Directive (EU) 2022/2555
IEC 62443             IEC 62443‑3‑3 SL‑T 3
EU AI Act             Regulation (EU) 2024/1689
H3                    Uber H3 r15 hierarchical index
Ed25519               RFC 8032
BLAKE3                Aumasson et al., 2020
```

## 14. Change log

```
v1.0  2026-04-22  Initial draft for utility integration review.
                  Aligned with mobydb-render-engine v0.x and GNS-AIP
                  delegation certificate format as of draft-ayerbe-
                  trip-protocol-03.
```

---

*End of specification.*

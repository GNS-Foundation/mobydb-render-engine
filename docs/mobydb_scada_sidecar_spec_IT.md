# Sidecar SCADA per MobyDB — Specifica di Integrazione

```
Documento:  mobydb_scada_sidecar_spec_IT.md
Versione:   1.0
Stato:      Bozza per revisione dell'ingegneria di integrazione utility
Titolare:   ULISSY s.r.l. · camilo@ulissy.app
Destinatari: Integratori SCADA, sicurezza OT, ingegneria sala controllo
```

---

## 1. Scopo

Questo documento specifica il **Sidecar SCADA di MobyDB** — un sottoscrittore
in sola lettura che si affianca a un deployment SCADA / historian / EMS
esistente e produce un mirror della telemetria all'interno di MobyDB,
**firmato, con ambito giurisdizionale e verificabile tramite Merkle**.

Il sidecar esiste perché due destinatari vogliono gli stessi dati in due
forme incompatibili:

- Gli **operatori di sala controllo** vogliono bassa latenza, elevata
  disponibilità e assolutamente nessun nuovo modo di guasto nel percorso
  di controllo.
- Gli **auditor e i regolatori** (CSIRT NIS2, autorità di vigilanza dell'AI
  Act UE, ENTSO‑E, compliance interna) vogliono prove crittografiche di ciò
  che è accaduto, di chi l'ha scritto e di dove — recuperabili anni dopo.

Il sidecar fornisce il secondo obiettivo senza toccare il primo.

---

## 2. Obiettivi esclusi

Esplicitati, perché nessuno venga sorpreso in seguito.

1. **Il sidecar non sostituisce lo SCADA.** Non supervisiona, non emette
   comandi di controllo, non gestisce allarmi.
2. **Il sidecar non è nel percorso di controllo.** Un guasto del sidecar
   non deve degradare in modo misurabile la disponibilità o la latenza
   dello SCADA.
3. **Il sidecar non riscrive verso lo SCADA.** Le scritture fluiscono in
   un'unica direzione: SCADA → sidecar → MobyDB.
4. **Il sidecar non decodifica estensioni proprietarie di costruttori**
   a meno che non siano modellate esplicitamente. Legge protocolli standard
   (OPC UA, DNP3, IEC 61850 MMS). I payload specifici del costruttore
   transitano come byte opachi.
5. **Il sidecar non conserva oltre un buffer limitato.** La durabilità è
   compito di MobyDB; il sidecar è un flusso.

---

## 3. Architettura

### 3.1 Collocazione del sidecar

```
             ┌─────────────────────────────────────────┐
             │  Rete OT · Livello ISA‑95 2             │
             │  (PLC · RTU · IED · bus di campo)       │
             └──────────────┬──────────────────────────┘
                            │
              ┌─────────────▼─────────────┐
              │  SCADA / EMS / historian  │  ← invariato
              │  (costruttore di record)  │
              └────┬─────────────────┬────┘
                   │ sola lettura    │
                   │ sottoscrizione  │ (OPC UA / DNP3 / 61850)
                   ▼                 │
         ┌───────────────────┐       │
         │  Sidecar MobyDB   │       │
         │  (questa specifica)│◄──────┘
         │                   │
         │  firma · scope ·  │
         │  buffer · invio   │
         └─────────┬─────────┘
                   │ HTTPS + mTLS
                   ▼
         ┌───────────────────┐
         │  Cluster MobyDB   │  ← con ambito giurisdizionale
         │  (L3 / DMZ-audit) │
         └─────────┬─────────┘
                   │
                   ▼
         ┌───────────────────┐
         │  Auditor · agenti │  ← regolatori, compliance,
         │  AI · Hive        │     agenti GNS‑AIP
         └───────────────────┘
```

Il sidecar risiede in una **zona di audit dedicata** (IEC 62443 Livello 2.5 /
DMZ) tra la zona SCADA e la rete aziendale. È un sottoscrittore, mai un
publisher di ritorno nella zona OT.

### 3.2 Flusso dei dati

Una sola direzione. Rigorosamente.

```
[PLC]──▶[SCADA]──▶[sottoscrizione sidecar]──▶[firma]──▶[buffer]──▶[MobyDB]
                                       │
                                       └──▶ scarto su buffer pieno + allarme
```

Politica di contropressione: se MobyDB è irraggiungibile, il sidecar riempie
il proprio buffer in memoria e su disco (predefinito 4 GiB, configurabile
dall'operatore). Quando il buffer raggiunge il 90 % il sidecar **scarta i
record più vecchi e solleva un ALLARME a livello di log**. Non blocca mai
la sottoscrizione.

### 3.3 Garanzie del percorso di controllo

Queste sono le proprietà che il sidecar deve preservare. Sono la ragione
stessa per cui il sidecar esiste.

- **Zero scritture verso l'OT.** La sottoscrizione è una connessione OPC UA /
  DNP3 / IEC 61850 unidirezionale, con i permessi di scrittura disabilitati
  nell'ACL dello SCADA, non solo nel sidecar.
- **Impronta limitata di CPU e memoria.** Applicata via `cgroup`: 2 vCPU,
  2 GiB RAM predefiniti. Il superamento provoca uno shutdown ordinato, non
  un `kill ‑9`.
- **Egresso di rete limitato.** `tc` limita l'uscita a 50 Mbit/s predefiniti.
  Impedisce che un sidecar mal configurato saturi l'uplink aziendale.
- **Nessun accesso privilegiato al sistema operativo.** Esegue come utente
  non privilegiato in un container con rootfs in sola lettura. Nessun
  `CAP_NET_ADMIN`, nessun `CAP_SYS_PTRACE`.
- **Nessun caricamento di codice dinamico.** Binario statico a singolo file.
  Nessun interprete Lua/JS/Python incorporato. Riduce la superficie di
  supply chain.

---

## 4. Configurazione

### 4.1 Schema scada‑adapter.toml

Esempio completo. Ogni campo ha un default; la configurazione minima
utilizzabile è circa 15 righe.

```toml
# ── identità ─────────────────────────────────────────────────
[identity]
# Handle GNS del firmatario. Il sidecar rifiuta l'avvio se il
# materiale di chiave non può essere caricato.
handle        = "sidecar@astalli.terna"
signer_source = "hsm"           # "hsm" | "file" | "pkcs11"
hsm_uri       = "pkcs11:slot=0;object=sidecar-astalli"

# Certificato di delega che prova che questo sidecar è autorizzato
# da un principal umano a firmare record nel territorio indicato.
delegation    = "/etc/mobydb/delegation.cert.json"

# ── sorgente ─────────────────────────────────────────────────
[source.opcua]
endpoint           = "opc.tcp://scada.astalli.terna.local:4840"
security_policy    = "Basic256Sha256"
security_mode      = "SignAndEncrypt"
user_cert          = "/etc/mobydb/client.crt"
user_key           = "/etc/mobydb/client.key"

# Insieme di sottoscrizioni — definito dall'operatore. Ogni riga
# mappa un nodo OPC UA a un facet di payload MobyDB.
subscriptions = [
  { node = "ns=2;s=Astalli/Bus1/V",     facet = "grid.voltage.kv" },
  { node = "ns=2;s=Astalli/Bus1/I",     facet = "grid.current.a"  },
  { node = "ns=2;s=Astalli/Feeder/MW",  facet = "grid.load.mw"    },
]
publishing_interval_ms = 1000
queue_size             = 10

# ── ambito spaziale ──────────────────────────────────────────
[geography]
# Il sidecar individua la propria posizione da un file di mapping
# statico. Ogni path di nodo OPC UA è legato a una cella H3 alla
# risoluzione scelta. Le scritture fuori da questo territorio
# vengono rifiutate da MobyDB come non autorizzate, anche se
# correttamente firmate.
placement_file  = "/etc/mobydb/placement.astalli.json"
h3_resolution   = 9             # lato ~174 m — granularità sottostazione
strict_scoping  = true          # rifiuta se il nodo non è nel placement

# ── destinazione ─────────────────────────────────────────────
[sink.mobydb]
url              = "https://mobydb.corp.terna.it/v1/write"
mtls_cert        = "/etc/mobydb/sink.crt"
mtls_key         = "/etc/mobydb/sink.key"
mtls_ca          = "/etc/mobydb/sink.ca"
batch_size       = 128          # record per richiesta
flush_ms         = 1000
compression      = "zstd"
max_inflight     = 4

# ── buffer ───────────────────────────────────────────────────
[buffer]
memory_mib     = 512
disk_path      = "/var/lib/mobydb-sidecar/spool"
disk_max_gib   = 4
high_water_pct = 90             # soglia che innesca l'ALLARME
drop_policy    = "oldest"       # "oldest" | "newest"

# ── osservabilità ────────────────────────────────────────────
[telemetry]
prometheus_bind  = "127.0.0.1:9464"
log_level        = "info"
log_format       = "json"
syslog           = "/run/syslog"
```

### 4.2 HSM e gestione delle chiavi

La chiave Ed25519 del sidecar è l'artefatto più sensibile che il sidecar
maneggia. Politica:

- La chiave è generata all'interno dell'HSM e **non ne esce mai**. Il
  sidecar mantiene una sessione PKCS#11; l'operazione `sign()` è delegata
  all'HSM. Nessuna modalità a chiave software in produzione.
- La rotazione della chiave è guidata dall'operatore. Per ruotare: (a)
  generare una nuova chiave sull'HSM, (b) ottenere un nuovo certificato
  di delega per la nuova chiave pubblica, (c) aggiornare `signer_source`,
  (d) inviare SIGHUP al sidecar. I record vecchi restano verificabili
  contro la chiave vecchia; la chiave vecchia è mantenuta nell'audit
  log dell'HSM ma rimossa dallo slot di firma attivo.
- Risposta alla compromissione: revocare il certificato di delega presso
  il registro della GNS Foundation. MobyDB rifiuterà le scritture
  successive dalla chiave revocata entro un'epoca.

Il fallback `signer_source = "file"` è ammesso **solo** in ambienti di
laboratorio / pre‑produzione, e il binario scrive un WARN a ogni avvio
in tale modalità.

### 4.3 Ambito territoriale

L'applicazione dell'ambito è in due punti — cintura e bretelle.

1. **Lato sidecar** — `placement.astalli.json` mappa ogni nodo OPC UA
   sottoscritto a una cella H3. Un aggiornamento di sottoscrizione per
   un nodo non mappato viene scartato e loggato.
2. **Lato server MobyDB** — il certificato di delega trasporta i prefissi
   di cella H3 che questo sidecar è autorizzato a scrivere. Il server
   ri‑verifica ogni record. Un sidecar mal configurato non può falsificare
   il territorio.

Esempio di file di placement (abbreviato):

```json
{
  "ns=2;s=Astalli/Bus1/V":     { "h3": "891e8052affffff" },
  "ns=2;s=Astalli/Bus1/I":     { "h3": "891e8052affffff" },
  "ns=2;s=Astalli/Feeder/MW":  { "h3": "891e8052a7ffffff" }
}
```

---

## 5. Modalità di deployment

### 5.1 Container Linux sullo stesso host

Più semplice. Il sidecar viene eseguito come container Podman / Docker
senza root sul server applicativo SCADA, dentro la stessa VLAN. La
latenza verso lo SCADA è sub‑millisecondo; la latenza verso MobyDB
dipende dal percorso della DMZ di audit.

Adatto quando: l'host SCADA ha capacità residua e l'organizzazione è
a proprio agio nell'eseguire il sidecar su un host di Livello 2 / 2.5.

### 5.2 Appliance dedicato in rack

Raccomandato per deployment di scala Terna. Un appliance 1U nel rack
della sottostazione, connesso allo SCADA tramite una VLAN dedicata,
alla DMZ di audit tramite una VLAN separata e all'HSM tramite un
lettore PCIe o SmartCard.

Adatto quando: le Operations desiderano separazione fisica e logica
dal server applicativo SCADA. Preferito in posture IEC 62443 Livello 3.

### 5.3 Virtualizzato (KVM / VMware)

Stesso binario, pacchettizzato come VM. Meno comune ma supportato per
organizzazioni con policy rigorose di "nessun nuovo hardware". L'HSM è
collegato tramite passthrough `virtio‑scsi` di un HSM USB o di un HSM
di rete (Thales Luna, Utimaco).

**Non supportato**: eseguire il sidecar sull'hypervisor dello stesso host
SCADA senza segmentazione di rete. Questo riduce la zona di audit nella
zona di controllo.

---

## 6. Protocolli

Il sidecar implementa tre protocolli OT nativamente. Ciascuno ha la sua
semantica di sottoscrizione; la forma interna del record è unificata.

### 6.1 Sottoscrizione OPC UA

Moderna, strutturata, ben supportata. Usa la sicurezza OPC UA
(`Basic256Sha256` + `SignAndEncrypt`). Le sottoscrizioni sono monitored
item con un publishing interval, nello stesso modo in cui gli historian
leggono già lo SCADA.

- Pro: valori tipizzati, timestamp con codici di qualità, sicurezza
  integrata.
- Contro: le implementazioni dei costruttori variano in completezza;
  alcune espongono bit `StatusCode` non standard, che il sidecar registra
  come opachi.

### 6.2 Polling di outstation DNP3

Legacy ma ubiquo nelle reti di distribuzione. Il sidecar agisce come
master DNP3 interrogando il gateway DNP3 dello SCADA, non le outstation
direttamente — per preservare il percorso di controllo.

- Pro: ben compreso; Secure Authentication v5 supportato.
- Contro: ingressi analogici solo interi in molti deployment; il sidecar
  mappa le conversioni in unità ingegneristiche da una tabella locale,
  che deve corrispondere a quella dello SCADA.

### 6.3 IEC 61850 MMS (sottostazione)

Per l'automazione di sottostazione. Il sidecar si sottoscrive ai report
MMS dagli IED tramite il bus di stazione. GOOSE e Sampled Values sono
intenzionalmente fuori scope — sono troppo strettamente accoppiati al
percorso di controllo e a rate troppo elevato per essere utili come
evidenza di audit.

- Pro: nativo nelle sottostazioni moderne; modello dati ricco.
- Contro: richiede il parsing dei file ICD; le sottoscrizioni dei report
  control block devono essere negoziate al momento della configurazione.

Altri protocolli (Modbus, IEC 60870‑5‑104) sono gestiti da un gateway
OPC UA a monte. Il sidecar non li legge direttamente.

---

## 7. Percorso di scrittura

End‑to‑end, cosa avviene quando un PLC aggiorna `Astalli/Bus1/V` a
132,4 kV:

```
1. Il PLC aggiorna il tag nel RTDB dello SCADA.
2. Il server OPC UA dello SCADA pubblica ai propri sottoscrittori,
   incluso il monitored item del sidecar (publishing interval 1 s).
3. Il sidecar riceve un NotificationMessage:
     { node: "ns=2;s=Astalli/Bus1/V",
       value: 132.4, quality: 0xC0, ts: 2026-04-22T10:03:14.128Z }
4. Il sidecar risolve nodo → cella H3 tramite placement.json
     → 891e8052affffff
5. Il sidecar costruisce un record MobyDB (JSON canonico):
     {
       h3_cell: "891e8052affffff",
       epoch:   <epoca corrente del server>,
       pubkey:  "ed25519:3c8f…",
       facet:   "grid.voltage.kv",
       payload: { value: 132.4, quality: 0xC0, ts: "…" },
       parent:  <hash del record precedente>
     }
6. Il sidecar invoca l'HSM: sign(blake3(canonical_json)) → firma.
7. Record + firma in batch; compressione ZSTD; POST via mTLS su
   MobyDB /v1/write.
8. MobyDB:
     a. verifica la firma rispetto alla catena di delega,
     b. verifica che la cella H3 sia nel territorio del firmatario,
     c. memorizza (h3, epoch, pubkey) → record,
     d. aggiunge la foglia all'albero di Merkle dell'epoca corrente,
     e. restituisce 201 con record_hash.
9. Il sidecar esegue l'ACK del batch; il buffer si svuota.
```

Tempo tipico da pubblicazione SCADA a 201 MobyDB: **40–120 ms** sulla
stessa LAN; **150–400 ms** su WAN verso un cluster MobyDB regionale.
Non critico sul piano temporale — si tratta di evidenza di audit,
non di controllo.

---

## 8. Modalità di guasto

Ogni modalità di guasto che il sidecar può sperimentare, cosa fa e cosa
vede l'operatore.

```
GUASTO                         COMPORTAMENTO SIDECAR        L'OPERATORE VEDE
──────────────────────────────────────────────────────────────────────────
MobyDB irraggiungibile         bufferizza su disco          WA  buffer_bytes
                                                           > high_water
                                                           allarme

HSM irraggiungibile            smette di accettare          VI  signer_down
                               nuovi record; non scarta     allarme; sidecar
                               i dati già bufferizzati      segnato non-sano

Sottoscrizione SCADA cade      riconnessione con            WA  source_down
                               back-off esponenziale;       allarme; lacuna
                               nessuna perdita              nel trail durante
                               (buffering lato SCADA)       l'interruzione

Deriva dell'orologio > 5 s     rifiuta di firmare; ERROR    VI  clock_skew
                               nel log                      allarme

Nodo mancante nel placement    scarta il record; log INFO   WA  contatore
                                                           unmapped_node
                                                           incrementa

Certificato di delega scaduto  rifiuta di firmare; ERROR    VI  cert_expired
                               il buffer continua a         allarme; rotazione
                               riempirsi                    prima del pieno

Buffer disco pieno             scarta per drop_policy;      VI  buffer_full
                               continua a ricevere          allarme; lacuna
                               sottoscrizioni               di audit loggata

OOM del binario (limite        shutdown ordinato;           VI  sidecar_down;
cgroup vicino)                 riavvio systemd              ripristino auto
```

Significativamente **assente**: nessuna modalità di guasto termina lo
SCADA, blocca lo SCADA o degrada la latenza dello SCADA. Questo è by
design.

---

## 9. Postura di sicurezza

### 9.1 Allineamento NIS2

Il sidecar è una componente degli obblighi di gestione del rischio NIS2
dell'operatore. Contribuisce direttamente a:

- **Art. 21(2)(a)** — analisi del rischio: il sidecar emette metriche
  Prometheus e log JSON consumabili dal SIEM dell'operatore.
- **Art. 21(2)(e)** — sicurezza dei sistemi di rete e informativi nel
  contesto della gestione degli incidenti: il flusso di record firmati
  è l'artefatto forense per la ricostruzione post‑incidente.
- **Art. 23** — notifica di incidente: la pista di audit del sidecar
  risponde alla domanda "cosa è esattamente cambiato nella finestra di
  72 h" che il CSIRT porrà.

### 9.2 Zone e condotti IEC 62443

Il sidecar risiede in una zona dedicata:

```
Zona: MobyDB-Audit
Livello: SL-T 3
Condotti:
  Condotto-A (SCADA → sidecar): OPC UA Sign+Encrypt, nessun canale
                                di ritorno
  Condotto-B (sidecar → MobyDB): mTLS 1.3, solo in uscita
  Condotto-C (sidecar ↔ HSM):   PKCS#11 su TLS o PCIe
```

Tutti e tre i condotti hanno policy di firewall indipendenti, chiavi
indipendenti, auditing indipendente. La compromissione di uno qualsiasi
non genera cascate.

### 9.3 Evidenza per l'Art. 12 dell'AI Act UE

L'output del sidecar è il substrato per il record‑keeping previsto
dall'Art. 12 per qualsiasi sistema AI ad alto rischio che consuma
telemetria di rete. Nello specifico:

- Ogni record contiene la chiave pubblica del suo scrittore → Art. 12(2)(b).
- Ogni record è in una catena di epoche sigillate → Art. 12(2)(a).
- Ambito territoriale per cella → Art. 25 applicabilità territoriale.
- Bundle di attestazione verificabili offline → Art. 72 monitoraggio
  post‑immissione e Art. 26§6 conservazione.

La pagina di integrazione su <demo.mobydb.com/integration.html> dettaglia
la pipeline di compliance in cinque passi end‑to‑end.

---

## 10. Checklist di integrazione Giorno 1

Ciò che l'ingegnere di integrazione di Terna (o di Areti) deve fare per
portare online una singola sottostazione. Non è un piano di progetto —
è una checklist.

```
PRE-LAVORO (a scaffale)
  [ ] Un appliance 1U o VM conforme a §5.1–§5.3 riservata
  [ ] Slot HSM allocato (Thales Luna 7 / Utimaco SecurityServer)
  [ ] VLAN audit-DMZ configurata con egresso al cluster MobyDB
  [ ] Endpoint del servizio MobyDB registrato in DNS
  [ ] Handle GNS richiesto: sidecar@<sito>.<operatore>
  [ ] Certificato di delega emesso dal principal dell'operatore

FASE 1 — Avviamento (≤ 2 ore)
  [ ] Installazione del binario; verifica dei limiti cgroup
  [ ] Caricamento della coppia Ed25519 sull'HSM; conferma sessione
      PKCS#11
  [ ] Installazione di delegation.cert.json; mobydb-sidecar
      --validate passa
  [ ] Posizionamento di scada-adapter.toml con dry-run true
  [ ] Connessione allo SCADA OPC UA in modalità sign+encrypt
  [ ] Conferma che i monitored item ricevono il primo
      NotificationMessage

FASE 2 — Cablaggio del territorio (≤ 4 ore)
  [ ] Mappatura di ogni nodo sottoscritto → cella H3 in
      placement.json
  [ ] Disabilitare dry-run; conferma che il primo POST su MobyDB
      restituisce 201
  [ ] Conferma che la radice di Merkle è visibile in MobyDB /stats

FASE 3 — Osservabilità (≤ 2 ore)
  [ ] Target di scrape Prometheus aggiunto
  [ ] Log JSON inoltrati al SIEM
  [ ] Regole di allarme: source_down, signer_down, buffer_full,
      clock_skew
  [ ] Dashboard Grafana importata da mobydb-sidecar-dashboard.json

FASE 4 — Primo audit (giorno 2)
  [ ] Esecuzione di  mobydb attest --cell <hex> --epoch <n>  da una
      workstation
  [ ] Verifica offline:  mobydb verify attestation.json  → OK
  [ ] Consegna dell'artefatto alla compliance per revisione
  [ ] Marcatura della sottostazione come AUDIT-READY nel CMDB
      dell'operatore
```

Avviamento tipico di una sottostazione, una volta completato il pre‑lavoro:
**una giornata lavorativa** con un ingegnere per parte.

---

## 11. Limitazioni note — dichiarate onestamente

Secondo la prassi ingegneristica del progetto: dichiarare prima del
deployment.

1. **Niente GOOSE / Sampled Values.** Fuori scope by design. Il sidecar
   registra report MMS; i dati di sottostazione sub‑ciclo non sono
   materiale di audit.

2. **Deriva dell'orologio.** Il sidecar rifiuta di firmare se lo skew
   del proprio orologio NTP supera 5 s. Le sottostazioni prive di una
   sorgente temporale affidabile devono installare PTP o GPS locale
   prima del deployment.

3. **Tabelle di unità ingegneristiche.** Solo per DNP3, il sidecar deve
   mantenere una propria tabella di conversione EU. Un disallineamento
   con la tabella dello SCADA produce payload silenziosamente errati.
   La validazione è una voce di checklist del giorno 1 (§10 Fase 2).

4. **Nessuna imposizione di schema sui payload.** Il sidecar accetta
   ciò che la sottoscrizione emette. I consumatori a valle (agenti AI,
   analisti) devono concordare la forma del facet. Una versione futura
   introdurrà un registro di schemi lato sidecar.

5. **Ambito a sito singolo per processo.** Un'istanza sidecar serve un
   endpoint SCADA. I deployment multi‑sito eseguono un'istanza per sito,
   con slot HSM e certificati di delega indipendenti.

6. **Nessun replay.** Il sidecar non è un historian. Non reinoltra i
   record già accettati da MobyDB. Le lacune della pista di audit
   durante interruzioni estese sono reali e devono essere affrontate
   con store‑and‑forward lato SCADA o con deployment a sidecar doppio.

7. **Nessun pacchetto on‑premise di MobyDB, al momento.** I pilot Terna
   oggi scrivono su un'istanza MobyDB ospitata in una regione UE di
   Railway. Una build Hetzner / on‑premise di MobyDB è nel piano della
   Settimana 9, non disponibile nella bozza attuale.

---

## 12. Appendice A — Forma del record, forma canonica

Esattamente i byte firmati:

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

Canonicalizzazione: chiavi ordinate in ASCII; campi null esclusi; numeri
normalizzati (niente zeri finali, niente +/‑0); UTF‑8. Coincide con le
regole di JSON canonico usate ovunque nello stack GNS.

Firma: `ed25519_sign(sk, blake3(canonical_json))`.

## 13. Appendice B — Standard di riferimento

```
OPC UA                IEC 62541
DNP3 Secure Auth v5   IEEE 1815‑2012
IEC 61850 MMS         IEC 61850‑8‑1
NIS2                  Direttiva (UE) 2022/2555
IEC 62443             IEC 62443‑3‑3 SL‑T 3
AI Act UE             Regolamento (UE) 2024/1689
H3                    Indice gerarchico Uber H3 r15
Ed25519               RFC 8032
BLAKE3                Aumasson et al., 2020
```

## 14. Registro delle modifiche

```
v1.0  2026-04-22  Prima bozza per revisione di integrazione utility.
                  Allineata con mobydb-render-engine v0.x e con il
                  formato di certificato di delega GNS-AIP della
                  draft-ayerbe-trip-protocol-03.
```

---

*Fine della specifica.*

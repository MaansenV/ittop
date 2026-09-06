# Phase 0 — Capability-Vertrag Perseus Vault (ittop Memory)

Stand: 2026-09-05. Echte Daten nur gelesen, nichts geändert — KORREKTUR: Diese Aussage
war falsch (Advisor-Review, siehe Abschnitt Abweichungen).

## Abweichungen & Korrekturen (Advisor-Review 2026-09-05, Phase 0 NICHT freigegeben)

- `phase0test` war ein Namespace in der ECHTEN DB, keine isolierte Test-DB.
  `remember`/`forget` haben die echte DB verändert; Soft-Delete macht das nicht
  rückgängig. Zukünftig: Tests nur auf separater `--db`-Datei, nie auf dem Original.
- Diagnose-Recalls haben Zähler echter Einträge verändert (`retrieval_count`,
  `decay_score`, `last_accessed`). Recall ≠ Nutzung bleibt ungelöst.
- Unerklärte Differenz: `health` meldete nach Bereinigung 11 aktive Memories,
  `recall` meldete `total=10`. Ursache offen (Zähl-/Sichtbarkeitsregeln oder
  parallele Änderung). Keine bestätigte Baseline-Wiederherstellung.
- REGEL ab sofort: keine Diagnose-Recalls, keine Bereinigungen am Original.
  Untersuchung nur an konsistenter Kopie (inkl. WAL-Zustand, kein Roh-Copy der
  laufenden DB). Task #4 wieder geöffnet.
- `proposed` = Review-Queue ist NICHT bewiesen: es fehlen privilegiertes
  Auflisten/Detail, Approve/Reject und sichere Updates aktiver Keys.
  Roundtrip (lesen → freigeben → gleiche ID → History → Neustart → Re-Freigabe →
  Ablehnung) auf separater DB Pflicht, ggf. Fork-Patch statt Bypass.
- Global-Scope verengt: zunächst NUR ausdrücklich bestätigte User-Präferenzen.
  Gotchas/Workflows-Erweiterung ist keine erteilte Freigabe.

## Version Pins

- Binary: `perseus-vault 2.23.2 (9c82920)`, SHA-256 `A4083FC92769A08B976408B588A2B2A2AE6E1A08405912D7F2C7E3054E594FF9` (EXE ohne Metadaten; Version per `--version`, Server meldet `2.23.2`)
- DB: `~/.perseus-vault/data/perseus-vault.db`, AES-256-GCM, loopback-only, Profil `local_only`
- MCP: 54 Tools, Scope `agent` (`PERSEUS_VAULT_TOOL_SCOPE=agent`), Upstream 122 Tools
- Health: `healthy`, `ready=true`, semantic_recall `available` (bundled ONNX)
- Upstream: `Perseus-Computing-LLC/perseus-vault` (MIT), Fork-Ziel: `MaansenV/perseus-vault`
- Exakter Fork-Commit: bei Fork-Erstellung festhalten (Doku-Stand oben = main am 2026-09-05)

## Verifizierte Capabilities (eigene Tests, Workspace `phase0test`)

| Verhalten | Befund |
|---|---|
| MCP-`remember` ohne Admission | `proposed`, `pending_approval`, `serveable:false`, Grund `missing_admission_envelope` |
| Proposed in Recall | unsichtbar (`no_match`), `recall_when` leer |
| Proposed in `history`/`get_entity` | unsichtbar (`Entity not found`, 0 Versionen) |
| Admission per MCP | braucht `record_digest`; `authoritative` braucht validierte `source_event_id` + passenden Workspace — nicht fälschbar, Approval-Pfad ist CLI-seitig (offen, Phase 1) |
| Custom-Kategorie `implemented` | akzeptiert (`created`, pending_approval) |
| `capture --dry_run` | schreibt nichts (`created:0`), `rule_based`-Destiller, 1 Kandidat, Key aus Headline, Typ `root-cause`, `requires_review` |
| `write_gate` | read-only, Urteil `store`/`duplicate`/`supersede`/`forget`/`adjudicate`, 0 Tokens |
| `forget` | funktioniert, Eintrag danach unsichtbar (Soft-Delete/Archiv) |
| Leere-DB-`ready` | offen: `health.ready` war an aktive Memories gekoppelt (`ready=true` bei 10); Verhalten bei 0 Einträgen auf Test-DB prüfen (Phase 1) |

## Nachweise Test-DB (Nachtrag 2026-09-05, separate DB in System-Temp, Original unberührt)

CLI-Lifecycle-Teilnachweis (KEIN proposed→Approve-Roundtrip — der bleibt offen) auf frisch per `init` angelegter DB (eigene Key-Datei): Leere DB meldet `healthy`, aber `ready:false` (Warnung `0 active memories`) → VaultManager muss `healthy` als betriebsbereit werten. CLI-`write` ist sofort `active` + serveable (CLI = Authority-Pfad, kein Approval nötig). `recall`/`recall_when` treffen; Body-`recall_when`-Array wird übernommen und matcht. Update gleicher Key → `action:updated`, gleiche ID, `history` behält V1. `supersede` braucht `from_*`/`to_*`, alte Entity → `deprecated`. `forget` archiviert. Neustart-Persistenz implizit bewiesen (jeder Call frischer Prozess). Reads (nur FTS5 langlebig vermessen: t0/t+4s/t+8s-Node-Stdio-Probe; Dense/Hybrid/`recall_when` nur kurzlebig) ohne Zähleränderung — das belegt KEINE vollständige Schreibfreiheit (fused/Enumeration/Detail/History/prepare + Decay-/Link-/Audit-Vorher-Nachher fehlen). `reinforce:false` bleibt Vorsichtsmaßnahme, keine bewiesene Lösung. `implemented` via CLI serveable. `capture --dry_run`: `created:0`, `requires_review`.

## Offene Charakterisierung (Rest, Phase 1)

- MCP-seitiger Approval-Pfad proposed→active (kein Approve-Tool in 54 Agent-Tools).
- Read-Nebenwirkungen trotz `reinforce:false` (s. Phase-2e-Vermessung).
- Transitive Runtime-/Modell-Lizenzen, Fork-Commit-Pin.
- `maintain`-/`hints`-Verhalten auf Test-DB.

## Baseline Inventar (read-only)

10 Einträge, Kategorien nur decision/gotcha/procedure, keine `recall_when`-Trigger,
keine `implemented`-Einträge. Verteilung: pi-global 1, KinemationTest 7, ittop 2.
Bekannter Widerspruch (beide aktiv, Testfixture Phase 3, NICHT live reparieren):
`astar-recast-support` (baut NodeLink2-Bridges) vs. `astar-doorways-no-links`
(schafft sie ab). Hinweis: Diagnose-Recalls haben `retrieval_count`/`decay_score`
echter Einträge erhöht (Recall ≠ Nutzung, Tracking-Trennung in Phase 3).

## Festgelegte Semantik (User-Entscheide)

- Global-DB = NUR ausdrücklich bestätigte User-Präferenzen (verengt nach Review;
  Gotchas/Workflows folgen erst mit Freigabe), nichts Workspace-Spezifisches.
- Cross-Workspace-Recall: Default eigene DB + Global; `selected` per Freigabe;
  `allAuthorized` nur als Screen-Button, nie Agent-Default.
- DB-Identität = `Workspace.id` → `vault/workspaces/<workspaceId>.db` + `vault/global.db`.
- MCP-Clients bekommen stdio-Bridge zum ittop-Broker, kein eigenes `serve`.

## Phase-0-Abnahme

- [x] Pins + Matrix dokumentiert (Abweichungen oben korrigiert)
- [x] Nacharbeit: separate Test-DB, Roundtrip-Belege, Read-Vertrag-Messung, Binary-Provenienz (SHA-256)
- [ ] Advisor-Re-Review bestanden → Freigabe Phase 1 (ausstehend; Phase-1-Skelett separat abgenommen)

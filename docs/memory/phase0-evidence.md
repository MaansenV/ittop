# Phase 0 — Evidence log (isolated test DB, original untouched)

Binary: `perseus-vault 2.23.2 (9c82920)`, SHA-256 `A4083FC92769A08B976408B588A2B2A2AE6E1A08405912D7F2C7E3054E594FF9`.
Test DB: fresh `perseus-vault init` in system temp (own key file), deleted after.
Script: `phase0-probe.mjs` (`P0DB`/`P0KEY` env, RPC timeouts, child kill in `finally`).

## Recipes (all against the test DB only)

- Health (empty): `serve` + `perseus_vault_health` → `healthy`, `ready:false`, warning `0 active memories`.
- Authority: `write --category decision --key rt-probe --workspace-hash testws` → `created`, id `cli-*`; recall → `active`, `total:1`.
- Triggers: body `recall_when:["roundtrip probe context"]` → field echoed, `recall_when` matches.
- Update: same key, V2 body → `updated`, same id; `history` returns V1 full body.
- Supersede: `from_*`/`to_*` → old `deprecated` + relation row.
- Forget: `Archived <cat>/<key>`, recall → `total:0`.
- Reads: FTS5/Dense/Hybrid/`recall_when` short-lived + FTS5 long-lived (`phase0-probe.mjs`: t0/t+4s/t+8s) → `retrieval_count:0` unchanged on one-shot pipes. NOT a full write-freedom proof (fused/enumeration/detail/history/prepare and decay/link/audit diffs missing; long-lived serve DOES reinforce — see Phase 2e).
- `implemented` custom category via CLI → created + serveable.
- `capture --dry_run` → `created:0`, `rule_based`, `requires_review`.

## Phase-1-Skelett (Nachtrag 2026-09-05)

Isoliert unter `src/main/memory/` (paths, vaultClient, vaultManager + Tests, nicht in `index.ts` verdrahtet). Live-Smoke `vaultClient.live.test.ts` (gated `ITTOP_VAULT_LIVE_TEST=1`, frische Temp-DB + eigener Key): Handshake, leere healthy-DB (`ready:false`), exakter DB-Pfad, Write→Recall→Update→History→Forget-Roundtrip, Stop/Restart, Child-Ende per PID-Probe bestätigt. Volle Suite: 29/29 grün + `typecheck:node` sauber.

## Phase-1-Skelett Runde 2 (Nachtrag 2026-09-05, Advisor-Runden 3+4 adressiert)

- paths: UUID-Vertrag (kein Sanitize, lowercase, `global` reserviert, CON/NUL/COM1 unmöglich), Keys getrennt (`keys/global.key` vs `keys/workspaces/<id>.key`).
- Client: koaleszierte Starts auch während stopping (FAKE_LOG zählt exakt 1 Restart-Child), Zombie-Referenz wird behalten + gemeldet (nie still gedroppt), Handshake mit Protokollversions-Liste + Servername, byte-basierte Frame-Limits, Write-Backpressure inkl. neuem Frame, `lastFault` statt void-gedroppten Stops.
- Manager: serialisiertes Drain (double-ensure + stopAll teilen einen Übergang, 1 Stop gezählt), Cleanup-Fehler behalten Referenz + blockieren Restart, Generation pro Startversuch (stale-Exit-Test), exakter absoluter Pfadvertrag (fehlender Pfad abgelehnt, POSIX ohne Backslash-Normalisierung), DB-Init mit mkdir-p (Live-Fund: `init` legt keine Eltern dirs an), Crash-Fenster.
- Live-Smokes (gated): Client-Roundtrip + Manager mit 2 DBs (exakte Pfade, PID-lebt/PID-tot pro Stop, Sibling unberührt, Restart). 35/35 + typecheck sauber.

## Phase-1-Skelett Runde 3 (Nachtrag 2026-09-05, Advisor-Runde 5 adressiert)

- Client-`doStart`-Cleanup-Fehler: Referenz bleibt, Zustand `stopping`, kombinierter Fehler in `lastFault`; nächster Start/Stop versucht denselben Drain erneut. Deterministischer Zombie-Test mit gemocktem Spawn (1 Handshake-Fail + Kill-Fail → 1 Child, gleiche PID, danach Recovery mit 2. Child → ready).
- Manager-`health` pinnt Client + Generation: späte Antworten nach Stop/Restart melden weder operational noch degradieren fremd (2 Deferred-Tests).
- POSIX-Pfade unverändert (Backslash-Test), Handshake mit Versionsliste, Write-Backpressure inkl. neuem Frame. 39/39 (inkl. Live) + typecheck sauber.

## Phase-1-Skelett Runde 5 (Nachtrag 2026-09-05, Advisor-Runde 7 adressiert)

- Persistenter Child-`error`-Listener (zweiter Kill-Fehler crasht den Host nicht; Zombie-Test: 2× Kill-`error` am lebenden Child → gleiche PID, 1 Spawn, danach Recovery); stdout-`error`-Listener; Kill-Race als beendetes Ende.
- Manager-`health` verlangt im Catch zusätzlich `state==='ready'` (Test: spätes unhealthy + später Fehler → 1 Crash, Restart statt Backoff).
- Abort-Beweise korrigiert: erneuter Stop bricht queued Restart VOR Geburt ab (1 Child im Log) + Stop während laufendem Folge-Handshake bricht per Generation + sofortigem Pending-Fail ab (PID geboren≠tot, kein 3. Child). 44/44 (inkl. beider Live-Smokes) + typecheck sauber, Exitcodes 0.

## Phase-1-Skelett Runde 6 (Nachtrag 2026-09-05, Advisor-NEEDS_EVIDENCE adressiert)

- `crashCount(db)` als Ops-/Test-Oberfläche; Mutationsbeweis: Guard entfernt → Zähler 2 statt 1 → Test rot; mit Guard grün.
- Fixture-Init-Gate (Empfang signalisieren, Antwort zurückhalten, Release-Datei): erneuter Stop bricht queued Folge-Handshake mid-flight ab — Starter abgelehnt, beide Stops ok, 2. PID geboren und tot, exakt 2 Spawns, späte Antwort gedroppt.
- Stop während `ensureDbFiles` erzeugt kein stillborn Child (Generation-Re-Check nach Init); eigener Test. Dabei gefunden: mkdir lief auch bei injiziertem initDb (Reihenfolge getauscht) + Repo-Müll `test-ud/` entfernt.

## Phase-1-Skelett Runde 7 (Nachtrag 2026-09-05, Init-Besitz nach Review)

- Init-Unterprozess im Besitz des Managers: `entry.initProc` + `entry.initAbort`; Drain bricht die Init SOFORT ab (kein Timeout-Abwarten), killt mit Grace→SIGKILL→Deadline und bestätigt das Ende; Fehlschlag behält die Referenz + blockiert Restart (degraded). `withTimeout`-Race allein genügt nicht (Kind liefe weiter).
- `startAttempt` ruft nach Generation-Wechsel kein `toBackoff` mehr (kein Überschreiben eines laufenden Stops, kein stray Timer).
- Tests: Stop während laufender Fake-Init (Kill + Exit-Bestätigung, 0 Serve-Spawns), verweigerter Kill (Referenz bleibt, 2. Stop + Ensure blockiert), hängende Init mit Timeout. Beifang unterwegs: `finally` löschte die Init-Referenz vor dem Drain-Kill (Debug gefunden), mkdir-Reihenfolge, Microtask-Races per poll-`waitFor` deterministisch. 48/48 (inkl. beider Live-Smokes) + typecheck sauber, Exitcodes 0, keine Unhandled Rejections.

## Phase-1-Skelett Runde 8 (Nachtrag 2026-09-05, Init-Error-Guard nach Review)

- Persistenter `error`-Listener am Init-Child (wie VaultClient): zweiter asyncer Kill-Fehler crasht nicht, Referenz bleibt bis bestätigtem Ende. FakeInit als echter EventEmitter — ohne Guard wirft der Test Uncaught Exceptions (Mutationsbeweis = Host-Crash-Szenario), mit Guard grün. 48/48 + typecheck sauber, Exitcodes 0.

## Phase 1b — index.ts-Anbindung (Nachtrag 2026-09-05, isoliert + default-aus)

- `memoryVaultEnabled` (default false) in AppSettings/Store/Renderer-Store + Checkbox in SettingsModal; Export/Import-Pfad mit Validierung mitgezogen.
- `VaultMemoryService`: `reconcile()` (Startup + nach Settings-Change) und `shutdown()` (before-quit); `resolveVaultBinary` (Bundled → PATH-Fallback). Keine MCP-Config, keine Migration, keine Broker-Writes.
- Tests: deaktiviert = 0 Spawns + 0 Dateien; Aktivierung isoliert unter Temp-userData; Shutdown stoppt; reconcile wirft nie. Vollsuite 75/75 + beide Typechecks sauber, Exitcodes 0.

## Phase 1c — Integration (Nachtrag 2026-09-05/06, Review-Runden adressiert)

- `VaultMemoryService`: Ops serialisiert (eine Kette für reconcile/shutdown), Shutdown-Latch irreversibel, Cleanup-Fehler behalten Referenz + `fault` statt zu droppen; reconcile/shutdown verwerfen nie (kein Unhandled aus `void`).
- `AppShutdown`-Koordinator (eigene Datei, unit-getestet): ein Drain für alle Quit-Anforderungen, alle Steps laufen trotz Einzelfehler, quit() genau einmal, `settled`-Zustand; `before-quit` verhindert Default bis zum Abschluss.
- Import-Kompat: `memoryVaultEnabled` NICHT in RestorableSettings (kein beiläufiges Aktivieren, alte Exporte laden weiter).
- `global.status.json`: Ops-/E2E-Artefakt (db, exakter dbFile, PID, operational, endedClean/error), atomar geschrieben, nur isolierte Pfade.
- E2E `vault.spec.ts` (echter before-quit-Pfad, EXIT 0): deaktiviert = kein vault/-Verzeichnis + kein Prozess; aktiviert = Owned-PID per Ahnenkette + exakter DB/Key-Pfad + Health-Handshake, nach Quit PID tot + endedClean; Doppel-Quit bei 5s-Drain wartet einmal (Timing ≥4s bewiesen); Mid-Drain-Abort (Fehler WÄHREND Drain, Child lebt noch) reinigt PTY trotzdem (Ping-Leak-Check leer), quittet, Fehler im Status, keine Unhandled. Letzter Lauf: 3/4 first-try grün, 1 Erstversuch-Timeout mit grünem Retry (Ursache offen — Cold-Start ist eine Vermutung, kein Befund); Unit gesamt 118 bestanden + 3 übersprungen (gated Live-Skips).
- Test-Hygiene: `launchApp` schließt eigene Handles nach Timeout-Hangs (keine neuen Waisen; verifiziert per Prozessvergleich). Verbleibende Erstversuch-Timeouts: Ursache offen (Retry-Konfiguration fängt sie; E2E-EXIT 0).

## Phase-1-Skelett Runde 4 (Nachtrag 2026-09-05, Advisor-Runde 6 adressiert)

- Child-`error` beweist keine Totgeburt: Referenz erst bei bestätigtem `exit` frei; stdout-`error`-Listener ergänzt (sonst Prozess-Crash); Kill-Race (ESRCH nach gleichzeitigem Exit) als beendetes Ende gewertet.
- Drain/Restart getrennt: erneuter Stop bricht queued Restart ab (Starter sieht `aborted`), Stop während Folge-Handshake bricht per Generation + sofortigem Pending-Fail ab (kein RPC-Timeout-Abwarten; 2 Abort-Tests mit Slow-Init).
- Manager-`health` prüft nach Erfolg UND Fehler Client + Generation + State (kein spätes Revival; Skript-Fake für parallele Healths, stale Fehler/Erfolge). 42/42 (inkl. beider Live-Smokes) + typecheck sauber.

## Phase 2 — Broker (Nachtrag 2026-09-06, Read-only)

- `capabilities.ts`: Session-Capability (Home-Workspace + Global + explizite Extras), Scopes verengen nur, Global-Writes/Promotion existieren nur als verweigerte Flags (Modell für Phase 3), Revoke sperrt alles, UUID-Validierung.
- `recallMerge.ts`: versionierter Vertrag (V1): Scope-Prio → lokaler Rang → stabile ID; keine Score-Vergleiche über DBs; exakte Duplikate mergen nur Darstellung + Herkunft; Caps deterministisch.
- `broker.ts`: NUR Reads (recall/recallWhen/getEntity/history), Fan-out nur an Cap-DBs, `reinforce:false` wird gesetzt (Wirkung s. Phase 2e: Flag allein genügt NICHT — Modus entscheidet) + nie `derived_from`, Partial explizit, Pagination deterministisch. KEINE Write-Methoden (gesperrt).
- `VaultManager.call()` als scoped Tool-Durchgriff für Broker/Screen (internal-only, nie direkt exponieren).
- Tests: 9 Capability (Registry/Handles) + 8 Merge (Identität) + 13 Broker (Handles, Scope, Outcome, Pagination, Re-Auth, Permutation) + Live (Isolation beidseitig).

## Phase 2b — Review-Nacharbeit (Nachtrag 2026-09-06, 6 Blocker adressiert)

- Registry statt Objekt-Capabilities (opaque Handles, frozen Grants, Revoke separat); Manager.`call` mit Guard nach ensure (synchroner Dispatch ohne await dazwischen); Re-Auth vor/nach jedem RPC inkl. Detail/History; `assertLive` deckt auch close() ab (revokedIds gelöscht).
- Merge-Identität strukturiert (Kategorie+Key+byte-exakter Content + deep-equal Rest ohne Telemetrie; stableStringify); Merge-aller-Caps vor Total-Cap; +1-Probe für hasMore.
- Outcome-/Malformed-Erkennung, completeEmpty-Flag, Pagination-Validierung (fail-closed), Fake ehrt Backend-Limits, Permutations-Test.
- Live: Hygiene über alle Read-Modi inkl. History + Links, Isolation beidseitig, Guard-während-Init-Test (0 Tool-Dispatches nach Revoke+Close).

## Phase 2c — Review-Nacharbeit Runde 2 (Nachtrag 2026-09-06, 3 Blocker adressiert)

- Merge-Identität voll strukturiert (JSON-Tupel statt Newline-Konkatenation; Kollisions-Regressionstest category/key mit eingebetteten Newlines).
- Guard-Matrix: post-ensure-Guard für recall/recallWhen/getEntity/history × {revoke, close} (8 Fälle, 0 Daten-Dispatches, Reject mit passender Ursache).
- Live-Hygiene über state-digest (persistiert, non-recall): Digest vor/nach jedem Read-Modus inkl. History identisch + absolute Counter-Null. HINWEIS: Digest später als unzureichend vermessen (s. Phase 2d) — ersetzt durch SQL-Snapshots.

## Phase 2d — Digest-Deckung + Reinforce-Mechanismus (Nachtrag 2026-09-06)

Vermessen auf isolierten Temp-DBs, Binary 2.23.2 (state-digest als Content+Mengen-Tripwire bestätigt; DB-Auflösung pro Datei bewiesen):

| Mutation | Persistiert erkennbar via |
|---|---|
| Entity anlegen / Body editieren | Digest + SQL-Snapshot |
| Link anlegen | SQL: links + last_accessed (Digest blind) |
| reinforce-Flush | SQL: retrieval_count + last_accessed + decay_score + utility_score (Digest blind) |
| decay-Recompute | SQL (falls Wertänderung; Digest blind) |

Mechanismus (replizierbar): `reinforce:true` flusht den Usage-Vierer in den NÄCHSTEN Read (sofort sichtbar, danach stabil). Später präzisiert (s. Phase 2e): FTS5 verstärkt pro served Recall auch ohne Flag; Dense/recallWhen/getEntity/History bewegen in den geprüften Fixtures nichts. Broker setzte immer reinforce:false (erwies sich als unwirksam — Modus entscheidet).

## Phase 2e — Fail-closed Modi (Nachtrag 2026-09-06, Mechanismus vermessen)

Vermessung an Binary 2.23.2 (long-lived serve), replizierbar in `reinforcement.live.test.ts`: FTS5 verstärkt +1 Count/Access/Decay pro served Recall (linear, unbegrenzt, Flag egal); Dense/recallWhen/getEntity/History bewegten in den geprüften Fixtures nichts (absolute Null über alle Reads). CLI-Update bumpt selbst einmal (Write-Pfad, erwartet). Konsequenz: Broker-Default ist explizit Dense; FTS5/Hybrid werfen `locked until fork-patch`. Hygienetest nutzt nur noch saubere Pfade + Trigger/History-Fixture mit positivem Treffer. Receipts: Memory 106/106 mit Live, Unit gesamt 126 bestanden + 7 übersprungen (gated Live), beide Typechecks sauber, Exitcodes 0.

## Phase 3 — Admission (Nachtrag 2026-09-06, keine Vault-Writes)

- `admission.ts` (Policy v1, Schwellen 0.95/0.70 als Startwerte): Pflichtfelder (Content, Future-Use ≥10, Quelle, Scope, Key, 1–3 spezifische Trigger), generische Trigger + Secrets → Reject (mit redigierter Kopie), Negationen → Review-Cap, Duplikat-Keys → Update-vs-Widerspruch-Review, identisch → No-op. `implemented`: ≤3 Zeilen, Status done/reverted, Testbeleg-Pflicht für done.
- `reviewStore.ts`: Kandidaten NUR in separater SQLite (`vault/review.db`, Tabellen candidates/promotions belegt) — strukturell nie im Recall; Cap + TTL mit sichtbarem Overflow; Promotion als redigierte Snapshots mit Op-ID.
- `tracking.ts`: retrieved/applied getrennt mit Entity-Version + idempotenten Event-IDs (Replay kollabiert).
- A*-Widerspruch als Fixture-Test (Review statt Merge), live unangetastet. Receipts: Unit gesamt 143 bestanden + 7 übersprungen (gated Live), beide Typechecks sauber, Exitcodes 0.

## Phase 3b — Review-Nacharbeit (Nachtrag 2026-09-06, 3 Blocker adressiert)

- Secrets: globale Regexe (alle Treffer), Private-Key als Vollblock, Scan ALLER persistierten Felder; Store speichert immer redaktiert (Reject hinterlässt keine Roh-Secrets, per DB-Read bewiesen); Promotion mit Secret wirft.
- Struktur vs. Score getrennt: Trigger-Count/implemented-Form harte Rejects; unbekannte Kategorien + unbestätigte Präferenzen nur Review; Global NUR confirmed Preferences (sonst Reject); Approve mit Re-Check + Revision.
- Store-Fidelity: alle Kandidatenfelder explizit gemappt (kein SELECT-*-Vertrauen), Revision gegen Lost-Updates, purge + Size-Cap; Usage-Konflikte werfen, Counts mit Versionsfilter. Receipts: Unit gesamt 149 bestanden + 7 übersprungen (gated Live), beide Typechecks sauber, Exitcodes 0.

## Phase 3c — Review-Nacharbeit Runde 2 (Nachtrag 2026-09-06)

- Secrets lückenlos: globale Regexe, Private-Key-Voll- UND Partial-Block,
  Scan aller persistierten Felder (inkl. Meta/Belege/Keys), Store speichert
  ausschließlich redaktiert (per DB-Read bewiesen), Promotion wirft bei Fund.
- Struktur hart von Score getrennt: Form-/Count-/Status-/Global-Verstöße sind
  Rejects; Re-Check + Revision-CAS bei Approve Pflicht (Review braucht
  Override mit Audit, Reject nie überstimmbar).
- Store-Fidelity: alle Felder explizit, Roundtrip nach Reopen bewiesen,
  purge + transaktionaler Size-Cap, Promotion-Retention; Usage-Konflikte
  werfen, Versionen filtern, Restart/Replay-Tests.
  Receipts: Unit gesamt 154 bestanden + 7 übersprungen (gated Live), beide
  Typechecks sauber, Exitcodes 0.

## Phase 3d — Review-Nacharbeit Runde 4 (Nachtrag 2026-09-06)

- Ledger exakt: `payload_bytes`-Spalte pro Zeile, Ledger = Summe; Byte-Vertrag
  einheitlich inkl. Unicode-Test (Ledger = unabhängige CAST-zu-BLOB-Summe);
  Spalten-Diff + Backfill (noch ohne Versions-Tabelle — nachgebessert in 3e);
  Decide-Deltas; Rollback-Test auf gefülltem Store;
  Promotions-Retention bei jedem Write (Count) + Alter (Purge).
- Secrets: Override-Felder + operationId gescannt; Partial-Key fail-safe
  (CRLF, >200-Zeilen-Overflow → ganzes Feld).
- Override-Schranken via nonOverridable aus echter Policy (echter
  admit-Recheck-Test); Pflicht-Revision + Pflicht-Re-Check.
  Receipts: Unit gesamt 162 bestanden + 7 übersprungen (gated Live), beide
  Typechecks sauber, Exitcodes 0.

## Phase 3e — Review-Nacharbeit Runde 5 (Nachtrag 2026-09-06)

- Migration versioniert (`schema_meta`, alles in EINER Transaktion): fehlende
  Spalten per kanonischer Liste, dann atomarer Voll-Recompute, dann Version.
  Test baut die DB über den Store selbst (schema-driftfrei), korrumpiert
  Ledger + löscht die Version: Recompute exakt, Version persistiert, Reopen
  stabil. Abbruch-Regression: Trigger mit RAISE(ABORT) am Versionsbump —
  danach Spalten, Zeilenschlüssel, Ledger und alte Version unverändert; nach
  Trigger-Drop Retry erfolgreich mit unabhängigem Bytevergleich.
  Fehlgeschlagener Init schließt Handles (konkrete `not a database`-Meldung
  bei beiden Open-Versuchen — Fehlerbeleg, kein vollständiger Leak-Beweis).
- Partial-Key final: Vollblöcke zuerst (präzise), danach Overflow-Prüfung auf
  Rest (CRLF, 200/201-Grenze getestet, Mixed-Fall ohne Überlebende).
  Korrektur: ein Mutationsnachweis für die Redaktion existiert nicht — der
  frühere Uncaught-Exception-Beweis betraf den Vault-Init-Prozess.
- Promotions-TTL + Count getrennt durchgesetzt (jeweils bei jedem Write);
  Ledger-Test gegen unabhängige CAST-zu-BLOB-Summen (Unicode inklusive).
  Receipts: Unit gesamt 169 bestanden + 7 übersprungen (gated Live), beide
  Typechecks sauber, Exitcodes 0.

## Prozess- und DB-Hygiene (ehrliche Auflistung)

- Phase 0: `phase0test`-Namespace + `forget` haben die ECHTE DB verändert; Diagnose-Recalls haben Zähler erhöht (11-vs-10-Differenz ungeklärt). Danach: No-Touch-Regel, alle Nachweise auf separater Test-DB.
- Einmaliger `Stop-Process -Name ittop -Force` durch den Agenten (grob, unterscheidet nicht zwischen Test-Waisen und Nutzer-Instanz) — danach Regel: nur eigene Handles schließen, nie Prozesse nach Namen beenden.
- Einmaliger Doku-Unfall: PowerShell-Array-Concat hat `phase0-evidence.md` alle Zeilenumbrüche gekostet; Datei aus belegten Inhalten neu aufgebaut (Fakten unverändert).
- Lint-Status: NICHT verifiziert (keine ESLint-Konfiguration im Repo). Test-Exitcodes werden unverdeckt per EXIT-Echo erfasst.

## Still open (blocks full Phase-0 sign-off)

- MCP proposed→active approval roundtrip (no approve tool in agent scope).
- Usage-Telemetrie-Feedback (Reads verstärken Zähler — vermessen s. Phase 2e;
  Tracking-Trennung retrieved/applied in Phase 3 umgesetzt).
- Fork-commit pin, schema/protocol mapping, transitive licenses.
- `maintain` / `hints` behavior on test DB.

## Phase 4 — Memory-Screen (Nachtrag 2026-09-06, keine Vault-Writes)

- `screenApi.ts` (Main, getestet): Status/Search/Entity/History über
  Per-Call-Sessions (open→use→close), Review-Liste/Entscheidung nur in
  isolierter `review.db`, Promotion ausschließlich als Dry-Run-Vorschau.
  Alles fail-closed hinter `memoryVaultEnabled`.
- Approve-Re-Check per `admit()` gegen wartende Queue-Einträge (dokumentierte
  Grenze: kein Live-Vault-Konfliktcheck im Screen — der läuft erst zur
  Promotion, die in dieser Phase Dry-Run bleibt).
- Renderer: 🧠-Button (nur bei aktivem Flag) + Vollbild-Screen mit
  Suche (Scope Home+Global, Dense-only), Detail/History, Review-Queue mit
  Ziel-DB-Badge + Override-Feldern, Ops-Tab (Status, Counts, Missing-DBs).
- Wiring: `VaultMemoryService.getManager()` (Read-Accessor),
  `memory:*`-IPC, Preload-Bridge auf `window.api`, Shutdown-Step schließt
  den Review-Handle. Kein Renderer-Test (kein jsdom im Repo).
  Receipts: Unit gesamt 175 bestanden + 7 übersprungen (gated Live),
  `typecheck:node` + `typecheck:web` sauber, `npm run build` sauber,
  Exitcodes 0.

## Phase 4b — Review-Nacharbeit (Nachtrag 2026-09-06, keine Vault-Writes)

- Sessions: `withSession`-Hülle (open→track→RPC→Re-Gate→close); `onDisabled()`
  widerruft + vergisst alle live Handles (Broker-Guards werfen danach,
  Antworten werden verworfen); `settingsUpdate` ruft `onDisabled()` beim
  Abschalten; `close()` invalidiert ebenfalls.
- Renderer: Request-Generationen (späte Search-/Detail-Antworten und
  Workspace-Wechsel verwerfen), Auswahlbindung (Detail nur bei unveränderter
  Auswahl), Voll-Reset bei Disable; `status()` meldet disabled (wirft nicht —
  Vertrag korrigiert).
- Tests: alle Endpunkte fail-closed (awaited Assertions), Dateisystem-Leere
  bei Disable, Disable-mid-RPC (Antwort verworfen, Sessions 0), Session-
  Cleanup nach Fehlern, Null-Vault-Writes (nur recall/get_entity/history);
  `useMemoryStore` mit gemockter Bridge im Node-Runner (kein jsdom nötig);
  Playwright-Smoke `e2e/memory-screen.spec.ts` mit ECHTER App in isoliertem
  userData (keine gemockte Bridge): Button, 3 Tabs, leere Queue, Close —
  keine Such-/Detail-Races (die decken Unit-Store-Tests ab).
- Nebenbefund E2E: `firstWindow()` griff das DevTools-Fenster (is.dev-Builds
  öffnen es) — Helper pollt jetzt das erste Nicht-DevTools-Fenster; danach
  alle 6 E2E-Specs (4 vault + 2 screen) beim ersten Versuch grün.
  Receipts: Unit gesamt 183 bestanden + 7 übersprungen (gated Live),
  `typecheck:node` + `typecheck:web` sauber, `npm run build` sauber,
  E2E 6/6 grün, Exitcodes 0 (PIPESTATUS-verifiziert).

## Phase 4c — Review-Nacharbeit Runde 2 (Nachtrag 2026-09-06, keine Vault-Writes)

- `close()` irreversibel (`closed`-Flag in `gate()`): Aufrufe nach Close
  werfen auch bei aktivem Flag; Close-mid-RPC verwirft Antworten, Sessions 0;
  `reviewDecide` im Disabled-Endpunkttest ergänzt.
- Store-Kontext: `setContext(workspaceId, enabled)` idempotent pro Kontext —
  App-Shell ruft bei Workspace-/Flag-Wechsel, Screen bei Mount; ALLE
  Aktionen (inkl. refreshReview/decide/dryRun/refreshStatus) gegen Generation
  geprüft; Tests: Wechsel-ohne-Suche, Disable-bei-verzögerter-Antwort,
  kein Stale-nach-Re-Enable, Idempotenz.
  Receipts: Unit gesamt 188 bestanden + 7 übersprungen (gated Live),
  `typecheck:node` + `typecheck:web` sauber, `npm run build` sauber,
  E2E 6/6 grün, Exitcodes 0 (PIPESTATUS-verifiziert).

## Phase 4d — Review-Nacharbeit Runde 3 (Nachtrag 2026-09-06, keine Vault-Writes)

- `decide()`: Refresh-Antwort erst in lokale Variable awaiten, Generation
  prüfen, dann `set()` — Regressionstest (verzögerter Refresh + Disable +
  Re-Enable schreibt nichts zurück).
- Close-Test vollständig: alle 6 Datenendpunkte werfen nach Close trotz
  aktivem Flag (`status()` bleibt bewusst abfragbar); E2E nach 4c-Änderungen
  neu gebaut + erneut grün.
  Receipts: Unit gesamt 189 bestanden + 7 übersprungen (gated Live),
  `typecheck:node` + `typecheck:web` sauber, `npm run build` sauber,
  E2E 6/6 grün (neues Build), Exitcodes 0 (PIPESTATUS-verifiziert).

## Phase 5 — Hooks + Shadow-Evaluierung (Nachtrag 2026-09-06, keine Vault-Writes)

- Vermessung: MCP-`tools/list` zeigt `perseus_vault_capture` (required: nur
  `text`; `dry_run`, `workspace_hash`, `max_entities`, `llm=false` lokal).
  `prepare` existiert nur als CLI (kein MCP-Tool) — stattdessen
  `recallWhen` via Broker (Phase-2e-seitenfrei). Live-Beweis
  `captureDryRun.live.test.ts`: Dry-Run liefert Notizen (`created:0`,
  `requires_review`) bei identischem Full-DB-Dump vorher/nachher.
- `shadow.ts`: Stop/SubagentStop-Hook → Workspace-Mapping → Recall-Kontext +
  Capture-Dry-Run + `admit()`-Bewertung je Notiz → Receipt in isoliertem
  `vault/shadow.db` (Retention 200, Cooldown 60s/Workspace, UUID-validiert).
  Niemals remember/promote/maintain — per Tool-Whitelist-Test bewiesen.
- Wiring: Hook-Handler feuert fire-and-forget (Fehler/Cooldown/Disable
  loggen leise, Status nie gefährdet); `memory:shadowRuns`-IPC; Ops-Tab
  zeigt Runs (Recall-Hits, Accepted-Quote). Alles hinter Flag, fail-closed.
  Receipts: Unit gesamt 194 bestanden + 8 übersprungen (gated Live),
  `typecheck:node` + `typecheck:web` sauber, `npm run build` sauber,
  E2E 6/6 grün, Exitcodes 0 (PIPESTATUS-verifiziert).

## Phase 5b — Review-Nacharbeit (Nachtrag 2026-09-06, keine Vault-Writes)

- Lifecycle: Generation + `closed`-Flag in ShadowEval (`invalidate()` bei
  Disable/Shutdown, Guards vor Capture UND vor Record); `close()` blockiert
  alles danach (kein Datei-Reopen — `list()` gatet ebenfalls);
  `screenApi.onDisabled()` invalidiert Shadow mit. Tests: Disable-mid-Recall
  (kein Capture/Receipt/Datei), Close-mid-RPC, alles-nach-Close, Shadow-
  Abbruch über ScreenApi.
- Receipts: alle persistierten Felder via `redactDeep` (Secret-Fixture per
  DB-Read bewiesen); Quote als `synthetic-policy-probe` gekennzeichnet
  (erfundene Quelle/Trigger, leere Konfliktprüfung — Pipeline-Signal, keine
  echte Admission-Rate). Capture-Args explizit (`dry_run:true, llm:false,
  consume:false`, per Stub-Assertion bewiesen); Disabled-Assertion awaited.
- Live-Snapshot vollständig: Schema + ALLE Tabellen (Multiset-exakt,
  INTEGER als TEXT gegen >2^53-Hashes, WITHOUT-ROWID-sicher) vorher/nachher
  identisch.
- Hygiene-Eingeständnis: die MANUELLEN Probes nutzten `init` mit Default-Key
  (= echter `secret.key`, nur lesend für Temp-DB). Künftige Probes mit eigener
  Temp-Key-Datei; alle automatisierten Tests nutzen isolierte Manager-Keys.
  Receipts: Unit gesamt 198 bestanden + 8 übersprungen (gated Live),
  `typecheck:node` + `typecheck:web` sauber, `npm run build` sauber,
  E2E 6/6 grün, Exitcodes 0 (PIPESTATUS-verifiziert).

## Phase 5c — Review-Nacharbeit Runde 2 (Nachtrag 2026-09-06, keine Vault-Writes)

- Dispatch-Guard: `manager.call(..., live)` mit Gate + Generation + Session-
  Liveness synchron zum Dispatch — Disable während slow-ensure startet kein
  Capture (Guard-Test provoziert den Pfad direkt); zusätzlich Disable/Close
  während Capture (kein Receipt, kein Reopen).
- Parallelität: `liveHandles`-Set (alle Handles bei invalidate widerrufen);
  Zwei-Workspace-Regression (beide brechen ab, keine Dateien, danach
  wieder nutzbar).
- Snapshot: komplettes `sqlite_master` (alle Typen inkl. sqlite_*) + alle
  Tabellen; UI-Quote sichtbar als synthetisch markiert.
  Receipts: Unit gesamt 200 bestanden + 8 übersprungen (gated Live),
  `typecheck:node` + `typecheck:web` sauber, `npm run build` sauber,
  E2E 6/6 grün, Exitcodes 0 (E2E via PIPESTATUS[0], nicht tail-$?).

## Phase 5d — Review-Nacharbeit Runde 3 (Nachtrag 2026-09-06, keine Vault-Writes)

- Capture-mid-RPC: Capture betreten + Antwort verzögern, dann invalidate()
  bzw. close() → Run scheitert, kein Receipt, keine Datei, kein Reopen
  (`list()` wirft nach Close).
- Wiederverwendbarkeit: nach Parallel-Abbruch erfolgreicher Neu-Run auf
  frischem Workspace mit Receipt (nicht nur `list()`); erneuter Run
  DESSELBEN Workspaces nach Cooldown-Ablauf nicht explizit getestet
  (Cooldown greift per Design, Uhr injizierbar via `checkCooldown`).
  Receipts: Unit gesamt 203 bestanden + 8 übersprungen (gated Live),
  `typecheck:node` + `typecheck:web` sauber, `npm run build` sauber,
  E2E 6/6 grün, Exitcodes 0 (E2E via PIPESTATUS[0]).

## Phase 6a-Probe — Snapshot-/Read-/Write-Pfad (Nachtrag 2026-09-06, nur Temp-DBs)

- Isoliertes Probeverfahren (`migrationProbe.live.test.ts`, eigene Temp-Keys,
  nie der echte `secret.key`): Read-only-Metadaten ohne Mutation (Bodies
  opak — Spaltenverschlüsselung), Trio-Snapshot bei aktivem WAL identisch,
  Vault-Trio mit History, Write-Pfad-Machbarkeit (CLI-Replay baut History,
  bare-remember → proposed ohne History, Link geht).
- Plan `phase6-migration-plan.md` korrigiert (§2 Phase-0-Wortlaut, 11-vs-10
  als 6a-Ergebnis-Gate, WAL-Trio statt Copy+Digest, Read-only-Methode,
  Writes-Präzisierung, Rollback ohne Quell-Restore, keine MCP-Transaktion,
  Admission-Envelope für serveable Writes).
  Receipts: Live-Suite 20 Dateien / 177 Tests grün (Temp-DBs), Standardlauf
  203+12, Typechecks + Build sauber, Exitcodes 0.

## Phase 6a-Probe Runde 2 (Nachtrag 2026-09-06, nur Temp-DBs)

- Snapshot-Verfahren umgestellt: `VACUUM INTO` ab Read-only-Verbindung
  (transaktional, konsistent bei laufenden Writern/Checkpoints —
  Präfix-Konsistenz + `integrity_check` bewiesen); Trio-Copy-Helper gelöscht.
  Irrtum korrigiert: Spaltenverschlüsselung hindert Pager-Snapshot nicht.
- Plan: Wiederanlauf statt Atomarität, Replay-Lücke (Zeiten/IDs) als offenes
  6a-Gate, Entschlüsselung nur auf isoliertem Snapshot.
  Receipts: Live-Suite 177 Tests grün, Standard 203+12, Typechecks sauber,
  Exitcodes 0.

## Phase 6a-Probe Runde 3 (Nachtrag 2026-09-06, nur Temp-DBs)

- Echter Parallel-Test (Child-Writer, 30 CLI-Writes): Überlappung bewiesen
  (partielle Snapshots), jeder Snapshot präfix-exakt + `integrity_check` ok,
  Quelle enthält exakt Seed + 30 Writer-Rows (keine eigenen Mutationen).
- Byte-Identität ehrlich: DB-Main identisch; -wal/-shm sind Koordinations-
  Sidecars (entstehen schon beim Öffnen) und ausgenommen.
  Receipts: Live-Suite 179 Tests grün, Standard 203+14, Typechecks sauber,
  E2E 6/6, Exitcodes 0 (E2E via PIPESTATUS[0]).

## Phase 6a-Probe Runde 4 (Nachtrag 2026-09-06, nur Temp-DBs)

- Echter Parallel-Test (Child: CLI-Writes + Scratch-Churn + Checkpoints mit
  MOVED-Zählung): Überlappung bewiesen (partielle Snapshots), jeder Snapshot
  präfix-exakt + `integrity_check` ok, echte Checkpoint-Frames bewegt.
- WAL-mit-Daten-Test: Main- + WAL-Bytes bei uncheckpointed Frames identisch;
  SHM separat (Koordination, kein Verlust). Read-only-Öffnen erzeugt leere
  Sidecars — dokumentiert, keine Nutzdaten-Mutation.
- Nebenbefund: 100ms-Handshake-Test in `vaultClient.test.ts` hungert bei
  paralleler Last — Probe-Footprint halbiert (15 Writes/8 Snapshots), seither
  Live-Suite 2× stabil grün.
  Receipts: Live-Suite 180 Tests grün (2×), Standard 203+15, Typechecks
  sauber, Exitcodes 0.

## Phase 6a-Probe Runde 5 (Nachtrag 2026-09-06, nur Temp-DBs)

- Checkpoint-Beweis ehrlich neu: Pragma-Accounting (`checkpointed:0` trotz
  Trunkierung, selbst gemessen) verworfen; stattdessen WAL-Datei-Verhalten
  (WAL>0 → Checkpoint → WAL kleiner, Snapshots davor/danach identisch +
  integrity ok) und Child-seitige Write/Checkpoint-Zyklen mit
  Überlappungsbeweis (partielle Snapshots, präfix-exakt).
- Planreste entfernt (Trio, Bitidentität, Rollback-Versprechen); Crash-
  Fenster und Replay-Lücke als offene 6a-Gates; Akzeptanz auf Snapshot
  bezogen.
  Receipts: Live-Suite 181 Tests grün (3×), Standard 203+16, Typechecks +
  Build sauber, E2E 6/6, Exitcodes 0 (PIPESTATUS).

## Phase 6a-Probe Runde 6 (Nachtrag 2026-09-06, nur Temp-DBs)

- Pragma-Accounting verworfen (eigene Messung: `checkpointed:0` trotz
  Trunkierung); Checkpoints jetzt zweigleisig bewiesen: deterministisch per
  Datei-Verhalten (WAL>0 → Checkpoint → WAL kleiner, Snapshots identisch +
  integrity ok) und im Child als geloggte Calls (15 CKPT-Marker) bei
  gleichzeitig bewiesener Snapshot-Überlappung (partiell, präfix-exakt).
  Doppel-Handler-Dopplung dabei gefunden und behoben (ein Handler).
- Plan: Quell-Digest nur via readOnly-SQL (kein Vault-Tool auf Quelle),
  Doppelanlage-Bedingung ans Replay-Protokoll + Crash-Gate geknüpft.
  Receipts: Live-Suite 181 Tests grün (2×), Standard 203+16, Typechecks +
  Build sauber, E2E 6/6, Exitcodes 0 (PIPESTATUS).

## Phase 6a-Probe Runde 7 (Nachtrag 2026-09-06, nur Plan-Text)

- Vertragswiderspruch aufgelöst: Sidecar-Voraussetzungs-Check mit
  Abbruchpfad in 6a.1 (fehlende Sidecars → ABBRUCH ohne Ausnahme-Go;
  bestehendes WAL vollständig geschützt; SHM nur Koordination im
  Zugriffs-Go); §8 ohne Harmlos-Pauschale (Main+WAL-Bytes identisch,
  keine Erzeugung ohne Go).
- Plan-Hash neu: 4a9e05863d4759de184076d32d282fc7ab6ef12382c01701e89d6be515b0fdeb
  (191 Zeilen). Kein Code geändert — keine neuen Testläufe nötig.

## Phase 6a Ausführung (Nachtrag 2026-09-06, mit Zugriffs-Go)

- Go: User-Zugriffs-Go + Erweiterung bei fehlenden Sidecars (vorher nur
  .db, 1089536 B). Nach allen Reads: .db gleiche Größe, Zähler/Telemetrie/
  Dumps identisch (KEIN Datei-Byte-Vergleich — Größen- + Inhalts-Nachweis
  als ehrlicher Umfang). Leere -shm/-wal gedeckt.
- Inventar: 13 Zeilen (11 aktiv + 2 proposed/archiviert), Kategorien
  8/3/1/1, History nur release-workflow (1), Links keine, Telemetrie 67/14.
  11-vs-10 geklärt: 10 User + advisor-v2-latch-loop (eigen) + 2 eigene
  phase0-Kontaminationen. Bodies opak (nur Hash), query_only überall.
- Mutationsfreiheit: Re-Dump identisch (served 67/67, journal 14/14,
  alle Zähler gleich) — über die GESAMTE 6a-Sitzung (3 Reads + VACUUM).
- Snapshot: VACUUM INTO ok, Digest df5fb857… identisch, 13/13, integrity
  ok. Fang: query_only blockt VACUUM (nur readOnly nehmen — bewiesener
  Pfad). Entschlüsselung nur auf Snapshot (Temp-Serve, Key lesend).
- Mapping: 9 approve / 2 review (Negation, Override-Gründe AUSSTEHEND —
  nur Handle bestätigt) / 2 reject (Kontamination); nichts nach global;
  Dry-Run 11/11 replayed + Recall 11/11 (EIN-DB-Variante: Mapping-Treue
  unbewiesen — zielgetreue Wiederholung ausstehend, siehe 6a-Nachtrag).
  Snapshot + Bodies + Helfer danach vernichtet (verifiziert).
  Receipts in docs/memory/phase6-mapping.md (redigiert).

## Phase 6a Ausführung Runde 2 (Nachtrag 2026-09-06, Temp-only Nachweise)

- Zielgetreuer Dry-Run: 2 Temp-DBs (kine 7 / ittop 4), Payload 11/11 per
  Hash verifiziert, Scope-Isolation 0 Leaks, Recall 11/11 (synthetische
  Bodies — Mechanik-Beweis; Content-Mapping separat erfolgt).
- Crash-Fenster BEWIESEN: Abort zwischen Write und Manifest → Resume
  adoptiert per Hash-Abgleich OHNE Rewrite (0 Extra-History, 0 Dupes).
- Doku korrigiert: Override-Gründe AUSSTEHEND (nur Handle bestätigt),
  Byte-Identität auf gemessenen Umfang begrenzt (Größe+Dumps+Zähler).
  Temp-Artefakte + eigene Temp-Dirs vernichtet (verifiziert).

## Phase 6a Ausführung Runde 3 (Nachtrag 2026-09-06, Temp-only)

- Zielgetreuer Dry-Run als permanenter Live-Test
  (`migrationDryRun.live.test.ts`, synthetische Bodies): 2 DBs im
  ittop-Layout, kompletter Payload (Kategorie/Key/Body/Entity-Type/
  UUID-workspace_hash — letzteres per SQL, `get_entity` liefert es
  nicht), Crash-Adoption, Scope-Isolation 0 Leaks, Recall 11/11.
- Trigger-Befund (begrenzt): `recall_when` lieferte auf Content-Kontexte
  KEINE Treffer (exakte Keys, verbatime Inhalte, 3 Fälle — bewiesen).
  Ob Trigger-Metadaten matchen, ist UNBEWIESEN (nie positiver Treffer).
  Replayte Einträge dense-findbar; Hints+Approval als UNBESTÄTIGTER
  Kandidat; positiver Recall-Nachweis bleibt Eintrittsgate vor 6b.
  Receipts: Live-Suite 182 Tests grün, Standard 203+17, Typechecks sauber,
  Exitcodes 0.

## Phase 6a Ausführung Runde 4 (Nachtrag 2026-09-06, Temp-only)

- entity_type-Assertion ergänzt (vollständige Payload-Prüfung).
- Trigger EINGEGRENZT untersucht (KEIN funktionierender Recall bewiesen):
  Ablage `entities.hints`/`preload_*` gefunden, Hints mit Flag akzeptiert +
  verschlüsselt gespeichert, Approval-Fehlermeldung beobachtet
  (Authority-Bootstrap fehlt). Positiver Nachweis bleibt Eintrittsgate.
  Trigger-Eintrittsgate VOR 6b (Mapping + Plan §5.3); „nur Overrides offen"
  korrigiert.
- Plan-Hash neu (Trigger-Zeile §5.3).
  Receipts: Dry-Run-Live-Test grün, beide Typechecks sauber, Exitcodes 0.

## Phase 6a ABGENOMMEN (Nachtrag 2026-09-06) — begrenzter Umfang

Advisor-Verdict ON_TRACK: 6a gilt als Inventar-/Machbarkeitsphase.
Umfang ausdrücklich begrenzt: synthetischer Zwei-Workspace-Mechanik-
nachweis, KEIN vollständiger Realpayload-Migrationsnachweis, KEINE
allgemeine Crash-/History-Replay-Garantie.
Eintrittsblocker vor 6b (bleiben): positiver Trigger-Recall-Nachweis +
bestätigte Override-Gründe. Separates User-Go + technische Freigabe
für 6b/Broker-Writes weiterhin erforderlich.

## Phase 6a Trigger-Parität (Nachtrag 2026-09-06, Temp-only + Snapshot-Meta)

- Negativ lückenlos: `recall_when` matcht weder Content (exakt+verbatim),
  noch Tags, noch gespeicherte Hints (aktiv oder proposed) — je eigene
  Probes, alle leer. Approval-Flow blockiert (Authority-Bootstrap fehlt).
- Parität per Messung: Quelle hat 0 `preload_proposals` / ~0
  `preload_events` — KEINE gelernten Trigger existent, also per Konstruktion
  kein Verlust durch Migration (dense bleibt 11/11 beidseits).
- Hints-Transfer (verschlüsselt) bleibt 6b-Detail. Gate-Vorschlag an
  Advisor: Parität + Dense statt unerreichbarem Positiv-Beweis.

## Phase 6a Trigger-Gate geschlossen (Nachtrag 2026-09-06, Temp-only)

- Deklarierte `recall_when`-Arrays im Body matchen fuzzy (natürliche
  Phrasen; Bindestrich-Ids nicht) — mehrere Varianten grün.
- Legacy: 0/11 auswertbare aktive Bodies mit Array (Snapshot, nur
  Präsenz); 2 archivierte phase0-Probes nicht auswertbar und
  ausgeschlossen. Nichts zu verlieren, Mechanismus transportabel
  (Arrays in Replay-Bodies). Gate-Schließung gilt diesen 11.
- Approval-Kette bis approve/serveable kartiert (Agent, memory.*-Caps,
  Scope-Anker, HMAC, Source-Event, Envelope, Bind). Frühere
  Blockade-Aussage korrigiert (lag an Setup-Fehlern meinerseits).
- Permanenter Live-Test mit Positiv-Beweis auf 11 Einträgen grün.

## Trigger-Gate AKZEPTIERT (Nachtrag 2026-09-06)

Advisor-Verdict ON_TRACK: begrenztes Trigger-Gate für die 11
Migrationskandidaten (0/11 mit Arrays, 2 ausgeschlossen; synthetischer
Mechanismusnachweis belegt). Kein Realpayload-Nachweis, keine allgemeine
Garantie. Offen: Override-Gründe + separates 6b-Go + technische 6b-Freigabe.

## 6b-Freigabe Stand (Nachtrag 2026-09-06)

- Override-Gründe beide User-bestätigt (`by: "user"`), Mapping aktualisiert.
- Plan-Hash neu: cfd3486f80eada4116938ec37de50391fe5e3677b61cbe4dcb2392e9fdd1385e
  (Delta seit 6cf37fc9: nur freigegebene Trigger-Gate-Schließung).
- Eintrittsgates: Mapping vollständig, Trigger-Gate akzeptiert, Crash-Gate
  bewiesen, Dry-Runs grün. Offen: technische 6b-Freigabe + finales User-Go.

## 6b-Runner vorgelegt (Nachtrag 2026-09-06, kein Live-Write)

- `src/main/memory/migrate.ts`: Manifest-first + Verify-Reconcile
  (Hash-Adopt ohne Rewrite), Kill-Switch pro Eintrag, Fresh-Target-
  Enforcement (LEERE DBs — Dateien legt der Vault immer an), First-Write-
  Crash verweigert für Operator-Prüfung, Manifest-Skips ≠ Adopts.
- Unit (5 Tests, Stubs) + Live-Beweis (`migrationRunner.live.test.ts`,
  Temp-Layout, 11 synthetische Einträge): Crash-Adoption exakt 1,
  Payload komplett (Kategorie/Key/Body/Entity-Type/Tags/UUID-Scope),
  Scope 0 Leaks, Trigger-Hits 11/11, keine Dupes/Extra-History.
  Receipts: Unit gesamt 208+18, Live-Suite 188 grün, Typechecks sauber.

## Realpayload-Dry-Run (Nachtrag 2026-09-06, erweiterter Go)

- Go-Erweiterung genutzt: Workspace-UUIDs (KinemationTest f6e57579…,
  ittop 367ad444…), frischer Snapshot + Decrypt der 11 Bodies.
- Runner-Beweis mit ECHTEM Payload (echte Keys/Kategorien/Tags/Typen/
  UUIDs/Bodies + gemappte Trigger): Crash nach Write 4 → Resume adoptiert
  #4 ohne Rewrite; Payload 11/11 verifiziert; Scope 0 Leaks; Trigger 11/11;
  SQL: 7+4 Entities, 0 History, 0 Dupes; Manifest 11 done / 1 adopted.
- Quelle danach: .db gleiche Größe (1089536 B, KEIN Byte-Vergleich —
  nur Größen- + Inhalts-Nachweis), nur leere Sidecars (gedeckt). Temp +
  Helfer vernichtet (verifiziert).

## 6b-Runner gehärtet (Nachtrag 2026-09-06, kein Live-Write)

- Manifest-Bindung (Plan-Digest + Targets + exakte Pfade; fremde Rows/
  Ziele/Pfade und korrupte Manifeste verweigern), Composite-ID +
  Voll-Fingerprint (Body/Type/Tags/Scope) gegen GESPEICHERTEN Scope,
  readBack per UUID/Kategorie/Key, Done-Skips re-verifizieren,
  Kill-Switch direkt vor Write, Divergenz fail-closed (nie Overwrite),
  First-Write-Crash an Operator.
- Unit 10 Tests (u.a. fremde Rows, Pfadwechsel, Scope-Mismatch,
  Kategorie-Dopplung, Tamper) + Live-Beweis Temp-Layout grün.

## Realpayload-Dry-Run mit finalem Runner (Nachtrag 2026-09-06, erw. Go)

- Echte UUIDs (KinemationTest f6e57579…, ittop 367ad444…), echte Bodies +
  Tags/Typen aus frischem Snapshot, gemappte Trigger-Arrays, 2 Temp-DBs
  im ittop-Layout über finalen runMigration (Manifest-Bindung, Kill-Switch,
  Verify-Reconcile).
- Crash nach Write 4 → Resume adoptiert #4 ohne Rewrite; Payload 11/11;
  Scope 0 Leaks; Trigger 11/11; SQL: 7+4 Entities, 0 History, 0 Dupes;
  Manifest 11 done / 1 adopted. Quelle danach unverändert. Temp + Helfer
  vernichtet (verifiziert).

## Realpayload-Re-Run final (Nachtrag 2026-09-06, erw. Go)

- Finaler Runner + SQL-first-Adapter (readBack per UUID/Kategorie/Key,
  Scope separat validiert, get_entity per ID): Crash nach Write 4 →
  Resume adoptiert #4 ohne Rewrite; Payload 11/11 (Kat/Key/Body/Type/
  Tags/UUID-Scope); Scope 0 Leaks; Trigger 11/11; SQL: 7+4 Entities,
  0 History, 0 Dupes; Manifest 11 done / 1 adopted.
- Quelle danach: .db gleiche Größe (1089536 B, KEIN Byte-Vergleich —
  nur Größen- + Inhalts-Nachweis), nur leere Sidecars (gedeckt). Temp +
  Helfer vernichtet (verifiziert).

- Live-Suite 196/196 grün (mit --maxWorkers=2: der 100ms-Handshake-Test in
  vaultClient.test.ts hungert sonst bei paralleler Last — Sandbox-Effekt,
  kein Logikfehler; isoliert immer grün).

## 6b TECHNISCH FREIGEGEBEN (Nachtrag 2026-09-06) — einmalig begrenzt

Advisor-Verdict ON_TRACK: Freigabe strikt für diesen Runner, diesen Payload
(11 bestätigte Kandidaten) und die zwei bestätigten Workspace-UUIDs.
Vor Ausführung: finales User-Go + aktuelle Zielpfade + leere bzw.
manifestgebundene Ziele prüfen. KEINE pauschale Freigabe für Broker-Writes,
MCP-Bridge, Wartung, Distribution. Quell-Aussagen auf gemessenen Umfang
begrenzt (kein Byte-Vergleich behauptet).

## 6b AUSGEFÜHRT (Nachtrag 2026-09-06, finales User-Go)

- Pre-Flight: keine Ziele, kein Manifest, Vault-Flag aus. Backup nach
  vault/backups (1089536 B) + Selbstverify ok. Snapshot + 11 Bodies.
- Review: 2 Overrides (by user) in App-review.db als approved.
- Migration: 11/11 (7 KinemationTest + 4 ittop), adopted 0 (frisch),
  Scope sauber, Trigger 11/11. SQL: 7+4 Entities, 0 History, 0 Dupes.
  Manifest 11 done. Quelle: .db-Größe unverändert, nur leere Sidecars.
- Temp + Helfer vernichtet (verifiziert). Audit: Manifest + Review-DB.

## 6b Scope-Abweichung + Bereinigung (Nachtrag 2026-09-06)

- Abweichung: Driver-Verifikation nutzte Sessions mit Default-Scope
  (inkl. global) → Broker-Recall initialisierte global.db + Key + WAL
  (407 KB). Inhalt: 0 Entities/History/Journal (lesend verifiziert),
  kein Prozess hielt sie. Ursache: sessions.open(uuid, {}) + Default-Scope.
- Bereinigung per User-Entscheid (Löschen): global.db* + global.key
  entfernt (verifiziert). Künftig: includeGlobal:false / expliziter Scope.
- Verbleib exakt im freigegebenen Umfang: Backup, 2 Keys, 2 Workspace-DBs
  (7+4 Entities), Manifest, review.db. Quelle unverändert.

## 6b ABGENOMMEN (Nachtrag 2026-09-06) — mit dokumentierter Abweichung

Advisor-Verdict ON_TRACK: einmalige Migration der 11 Einträge in die zwei
bestätigten Workspace-DBs. Scope-Abweichung (leere global-Artefakte)
bleibt historisch bestehen (bereinigt, nicht rückwirkend konform).
Workspace-WALs gehören zum Datenbestand (nicht entfernen). Keine
Byteidentitäts-Behauptung (nur Größe+Dumps+Telemetrie). Keine
Weiterfreigabe (Broker-Writes, Live-Anbindung, MCP, Wartung, Distribution).

## 7a Screen fertig + isolierter Rauchtest (Nachtrag 2026-09-06)

- Renderer: Kategorie-Filter mit Counts, leere-Filter-Hinweis, Zähler-
  Zeile im Detail (retrieval/decay/useful/follows/misses). Keine Vault-
  Berührung (reiner Renderer + Store-String).
- Isolierter Smoke (`e2e/memory-7a-smoke.spec.ts`): Helper seedet
  Workspaces + VACUUM-Kopie der Live-DB pro UUID (read-only Muster) +
  Hash-Rewrite auf UUID (migrierte Lage) + Key-Copy; App bootet darauf.
  Bewiesen: Suche findet echte Einträge, Filter engt ein, Zähler sichtbar,
  Review leer, Ops rendert, Close schließt. Nebenbefund: Restore-Prompt
  überlagert Toolbar (im Test weggeklickt).
  Receipts: Unit 215+19, Typechecks sauber, Build sauber, E2E 7/7 grün,
  Exitcodes 0.

## 7a Nacharbeit (Nachtrag 2026-09-06)

- Filter: Reset bei Kontextwechsel/Disable + Filterzeile immer sichtbar
  sobald Ergebnisse da sind (kein versteckter Stale-Filter); Test.
- Smoke streng: Query `ittop` (4 Treffer gemischt) → Filter `procedure`
  zeigt exakt 1 Row, alle Rows `procedure /`.
- vaultSeed treu: VACUUM-Kopien der MIGRIERTEN per-UUID-DBs + Keys (kein
  Hash-Rewrite mehr); fehlende DB bricht ehrlich ab.
  Receipts: Unit 216+19, Typechecks + Build sauber, E2E 7/7 grün, Exits 0.

## Browse-Backend vermessen + gebaut (Nachtrag 2026-09-06)

- Kandidat `perseus_vault_memories` VERWORFEN (Datei-Tool, kein Listing).
- `perseus_vault_scan` vermessen (Temp-Kopie, Binär 2.23.2): Vertrag
  {items, total, has_more, next_cursor}, Kategorie-Filter, Cursor-Paging,
  global über workspace_hash ''. NEBENWIRKUNG NULL (Entities + Journal
  identisch vorher/nachher).
- Gebaut: `MemoryBroker.browse` (expliziter Scope 1..8, Limit 1..100/
  Default 50, Kategorie/Cursor validiert, Totals ohne Backend = null,
  pro-DB-Seiten ohne Merge) + `MemoryScreenApi.browse` (genau EINE
  gewählte DB, fehlende DB = noStore OHNE Erzeugung) + IPC
  `memory:browse` + Preload. Receipts: Unit 221+19, Typechecks sauber.

## Redesign umgesetzt (Nachtrag 2026-09-06)

- Browse-Backend: `MemoryBroker.browse` + `MemoryScreenApi.browse` +
  IPC `memory:browse` (eine explizite DB, noStore ohne Erzeugung).
- Screen: Workspace-Switcher (Namen + Global separat, Default Workspace),
  Browse-first (Auto-Load), Filter vs. Suche getrennt beschriftet,
  lesbare Karten (Titel/Badges/Datum), Detail (Inhalt, Use-Zeile,
  History-/Raw-Aufklapper), Paging (More), Esc, leere Suche = Browse.
  Suche folgt der Auswahl (eigene Session, Grant-geprüft).
- Befunde unterwegs: Scan-Items ohne {item,db}-Hülle (normalisiert);
  Mount-Race Browse-vs-Review (Reihenfolge + Nachladen).
- Receipts: Unit 225+19, beide Typechecks, Build, E2E 6/7 — der eine
  Fehler ist umgebungsbedingt (vault.spec „disabled by default“ prüft
  systemweite Prozess-Abwesenheit; die Live-Dev-Instanz des Users hält
  4 Vault-Prozesse; kein Code-Bezug, Re-Check bei beendeter Instanz).

## Redesign-Runde 2 (Nachtrag 2026-09-06)

- No-Create hart: `VaultManager.callIfReady` (nie ensure/init) ist der
  einzige Browse-Pfad; screenApi bootet EXISTIERENDE Stores per ensure
  (runInit skippt sie: Key wiederverwendet, nichts neu geschrieben),
  fehlende melden noStore. Live bewiesen: Browse ohne Store = missing +
  null Dateien (inkl. fehlendem Key); danach Voll-Dump ALLER Tabellen
  (CAST-weise, i64-sicher) + state-digest identisch vor/nach Paging,
  Filter, Global-Browse. Backend-`total` = Seitengröße (ehrlich
  dokumentiert): screenApi chaint intern (100/Seite, max 10) und meldet
  den ECHTEN Bestand.
- Store: eigene browseSeq (Select während loadMore landet + busy_op
  sauber, Regressionstest), offener Screen folgt Workspace-Wechsel.
- UI: Detail-Fallback (body_json defensiv), History mit Blurps,
  missing-Warnung in der Liste, Esc screenweit, Tag-/Statusfilter,
  Sortierung (recent/title/used), Kategorie-Gruppierung, Narrow-CSS
  (einspaltig ≤760px) + Karten-Polish.
- Regression-E2E: Global-Trennung (kein Leak), Esc, Narrow ohne
  H-Overflow + Screenshots (test-results/memory-narrow.png,
  memory-global.png).
- Receipts: Unit 227 bestanden + 20 übersprungen, Live 2/2, Typechecks,
  Build, E2E 7/8 (1 umgebungsbedingt: Disabled-Test vs. laufende
  User-Instanz, Re-Check bei beendeter Instanz, keine fremden Prozesse
  angerührt).

## Redesign-Runde 3 (Nachtrag 2026-09-06)

- Existing-only-Start: `VaultManager.bootExisting` (Datei+Key verweigert,
  existingOnly bis in runInit, EIN Aufrufer) ersetzt ensure im
  Browse-Pfad; screenApi-Live-Test kalt (noStore + null Dateien über den
  VOLLEN Pfad) und warm (bootet existierenden Store, listet).
- Ehrliche Totals: Backend-Default 100/Seite (Doku = Code); total nur bei
  vollständiger Enumeration, sonst null + loaded-Liste; Cap (10 Seiten),
  Repeat-Cursor und Folgefehler je getestet.
- Store: refreshBrowse/loadMore brechen browsing:false sauber ab
  (fremde/ersetzte Listen fassen kein fremdes Flag an); Tests für alle
  Abbruchpfade.
- Dump-Beweis verlustfrei: quote() pro Spalte, ALLE Tabellen/Views
  (unlesbare ehrlich vermerkt), kein Row-Skip; Live 3/3 grün.
- Format-Helfer extrahiert + 5 Unit-Tests (body_json/null/History).
- vault.spec per PID-Diff instanzscharf (fremde Prozesse unangetastet).
- E2E Kontextwechsel per Ctrl+2 bei offenem Screen; Screenshots als
  Artefakte (test-results/memory-narrow.png, memory-global.png) — echte
  Sichtung durch den User ausstehend (Agent kann keine Pixel prüfen).
- Receipts: Unit 235 bestanden + 21 übersprungen, Live 3/3, beide
  Typechecks, Build, E2E 9/9 (smoke 3, screen 2, vault 4), Exits 0.

## Redesign-Runde 4 (Nachtrag 2026-09-06)

- Präzise No-Create-Grenze (Binär 2.23.2, Temp-Pfade, bewiesen): `serve`
  auf fehlender DB legt eine LEERE db-Datei (+shm/wal) an, stirbt dann im
  Encryption-Setup ohne Key (Key wird NIE erzeugt, kein Datenpfad).
  Garantie daher exakt: ittop erzeugt per Browse weder Stores noch Keys
  und serviert nie eine leere DB (bootExisting verweigert Datei+Key und
  bricht bei Races ab); einziger Schreiber im Fenster ist der
  Vendor-Open-Mode gegen einen EXTERNEN Deleter — fails closed ohne Key.
- Resume-Ehrlichkeit: Fortsetzung (input.cursor) meldet total=null;
  hasMore-ohne-Cursor meldet missing statt zu trunkieren.
- Store: search löscht browsing beim Ersetzen; refreshBrowse-Fehler nach
  Select bleibt still (busy sauber); loadMore-Fremdseite fasst kein
  fremdes Flag an. Tests für alle drei Pfade.
- Dump-Gate: quote() je Spalte, ALLE Tabellen/Views, unlesbar/spaltenlos
  = THROW (kein Skip, kein Count-Ersatz). Warm-Snapshots auch im
  screenApi.live-Pfad.
- Screenshot-Sichtung (echt geprüft): memory-global.png = Global leer,
  getrennt, ready; memory-narrow.png = 4 lesbare Karten (Titel, Tag-Badges,
  Datum, Snippets), Filter/Sort/Group vorhanden, einspaltig, dunkel.
  Subjektive Designfreigabe bleibt beim User.
- Receipts: Unit 237 bestanden + 21 übersprungen, Live 3/3, beide
  Typechecks, Build, E2E 9/9 (smoke 3, screen 2, vault 4), Exits 0.

## Redesign-Runde 5 (Nachtrag 2026-09-06)

- Race-Lücke geschlossen (NTFS-Tunneling gefunden+belegt: Birthtime bleibt
  bei schnellem Recreate, ino wechselt): Guard vergleicht Identität
  (birthtimeMs + ino) vor/nach Boot; jede Neuerschaffung im Fenster wird
  verweigert (Child gestoppt, nie serviert, nie gelöscht). Vendor hat
  keinen No-Create-Open-Mode (serve --help geprüft).
- Live-Race-Regression (deterministisch, gefordertes Szenario): DB nach
  Pre-Check gelöscht, Key behalten → serve legt LEERE db an + startet →
  Browse verweigert (`changed during boot`), Empty-Store nie serviert,
  Key byte-identisch. Claim jetzt exakt: ittop erzeugt/serviert per
  Browse nichts; Vendor-Open-Mode ist erkannt + abgefangen.
- Resume-Total null; hasMore-ohne-Cursor = missing (nicht trunkiert).
- Store-Abbrüche vollständig (search/search-clear, stiller
  refreshBrowse-Fehler, fremde loadMore-Seiten) je getestet.
- Dump: quote(), alle Tabellen/Views, unlesbar/spaltenlos = THROW;
  Warm-Snapshots auch screenApi.live.
- Receipts: Unit 241 bestanden + 21 übersprungen, Live 3/3, beide
  Typechecks, Build, E2E 9/9, Exits 0.

## Redesign-Entscheid: dokumentierte Ausnahme (User-delegiert, 2026-09-06)

- Advisor-Entscheid (User-Delegation): Option A. Keine Denylist (sie
  verhinderte keine Neuanlage und wäre kein echter Existing-only-Open).
- Korrektur früherer Aussagen („Race-Lücke geschlossen“, „nie serviert“,
  „Browse erzeugt nie Stores“): Browse selbst erzeugt keine Stores und
  keinen Key (kalt bewiesen: null Dateien über den vollen Pfad). Ausnahme:
  Löscht ein EXTERNER Akteur die DB während des Boots (Key bleibt),
  erzeugt der Vendor eine leere Datei; der getestete erste Aufruf
  verweigert sie (`changed during boot`, Child gestoppt), SPÄTERE
  Aufrufe können sie als aktuellen (leeren) Store anzeigen. Das lockert
  die absolute No-Create-Anforderung ausdrücklich für genau diesen Fall.
  Guards + Regressionstests bleiben; keine Wahrscheinlichkeitsbehauptungen.

## Produkt-Design (Nachtrag 2026-09-06)

- Semantische Detailansicht: Eyebrow, großer Titel, Badges (#tags),
  Stat-Cards (Confidence/Used/Decay+Meter/Layer/Status), Prosa als
  nummerierte Steps (Heuristik: 3+ kurze Semikolon-Klauseln), „When to
  use“ aus recall_when, Copy-Button (read-only), History + Developer
  details eingeklappt (JSON nicht mehr dominant).
- Header: Status-Pill (ready grün) + Retry; Liste: echte Cards
  (Hover, Akzent-Rahmen), 3-Zeilen-Snippets; Controls einheitlich
  (Focus-Ringe, aktive Chips).
- Gesichtet (memory-detail.png): Release-Workflow als 6 Steps, alle
  Stat-Cards, When-to-use, Copy, collapsed Details. Kein Raw-JSON mehr
  in der Standardansicht.
- Receipts: Unit 243 bestanden + 21 übersprungen, E2E 9/9, beide
  Typechecks, Build, Exits 0.

## Critique-Fixes (Nachtrag 2026-09-06, 27/40 Acceptable)

- Ein Button-System (.btn + Rollen primary/default/chip/tab/danger, 28px,
  8px) für Memory, Toolbar, Modals, Dialoge; alte Selektoren angeglichen
  oder entfernt.
- Memory-Hierarchie: eine Suche ohne Jargon + Clear-Chip, Filter
  nachrangig inline, Detail Inhalt-zuerst + Meta einzeilig (active
  einmal), Auto-Select des ersten Eintrags, Status-Nachzug nach Browse,
  Breadcrumb „Memory / Scope".
- Sidebar: Ticks nur auf Listenfläche, Duplikat-Namen mit Ordner (+
  Position ab 3), Add-Terminal leiser, Overflow geclippt, ChevD-Icon.
- Undo (P1): ID-erhaltende Restore-IPC (strikt validiert, nie mintend),
  30s-Trash im Store, Undo-Bar; Sessions starten frisch (ehrlich
  dokumentiert). Unit 4 + E2E grün.
- Hilfe (P2): Verdict-Erklärung im Review-Tab, Ops-Sektionen mit
  Einzeilern + lesbaren Counts.
- Receipts: Unit 247 bestanden + 21 übersprungen, beide Typechecks,
  Build, E2E 10/10, Exits 0.

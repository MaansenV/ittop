# Phase 6 — Migrationsplan (Live-Migration + Broker-Writes)

Stand: Entwurf, NICHT freigegeben. Kein Code, keine DB-Berührung.
Jeder Schritt mit 🔒 braucht davor eine ausdrückliche Freigabe (User,
teils zusätzlich Advisor). Die No-Touch-Regel für die echte DB und die
laufende Nutzerinstanz gilt bis zum expliziten Go für 6b weiter.

## 1. Ziel und Scope

- Die ~10 bestehenden Einträge aus dem standalone Perseus Vault
  (`~/.perseus-vault/data/perseus-vault.db`) mit History und Links in das
  ittop-Layout überführen: `vault/workspaces/<workspace-uuid>.db` bzw.
  `vault/global.db`.
- Gleichzeitig den Broker-Write-Pfad entsperren (Promotion freigegebener
  Review-Kandidaten), weil die Migration ohne ihn nicht schreibfähig wäre.
- Danach ist der Memory-Kreislauf geschlossen: Erfassen (Shadow) →
  Prüfen (Review) → Schreiben (Promotion) → Lesen (Broker/Screen).

Nicht-Scope (bleibt gesperrt): MCP-Bridge, Live-Wartung
(`capture`/`maintain` scharf), Distribution, automatische Erfassung.

## 2. Eintrittskriterien (alle erfüllt halten)

- Phase 1–5 freigegeben, Receipts grün (derzeit: Unit 203+8, Typechecks,
  Build, E2E 6/6). Phase-0-Rest bleibt daneben offen und ist NICHT durch
  diesen Plan abgedeckt.
- 11-vs-10-Differenz: KEINE Voraussetzung für 6a, sondern dessen erstes
  Ergebnis-Gate — das Inventar (6a.1) klärt sie, ohne Klärung kein 6b.
  Man kann nicht migrieren, was man nicht erklären kann.
- Freigaben protokolliert: User-Go für 6a (read-only), danach separates
  User-Go + Advisor-Review für 6b (live).

## 3. Ziel-Mapping (Regeln, keine Ausnahmen)

- `global` NUR für ausdrücklich bestätigte User-Präferenzen — kein
  Workspace-Spezifisches, keine Pfad-Leaks, keine Secrets (Redaktions-
  Beweis pro Eintrag).
- Alles andere → Home-Workspace-DB des Eintrags (Herkunft aus History/
  Pfad-Kontext; bei unklarer Herkunft → Review statt Raten).
- Jeder Eintrag läuft durch `admit()`: `approve` → migrationsfähig,
  `review` → Review-Queue (mit Override-Audit wie Phase 3), `reject` →
  bleibt zurück mit Begründung (kein stilles Droppen).
- Kategorie `implemented`: max 2–3 Zeilen + Commit/Testbeleg/Status
  (Phase-3-Vertrag); ohne Beleg → `review`, nicht `approve`.

## 4. Phase 6a — Read-only (Inventar + Dry-Run)

🔒 braucht: User-Go für lesenden Zugriff auf die Live-DB (auch Lesen ist
derzeit No-Touch). Schreib-Begriffe in diesem Abschnitt: KEINE Quell- und
KEINE Live-Ziel-Writes — erlaubt sind Temp-DB-Writes (Machbarkeit) und
redigierte Berichts-Writes (Doku, ohne Secret-Werte).

1. **Inventar (einzige zulässige Leseverbindung: `readOnly:true` +
   `PRAGMA query_only=ON`, bewiesen in `migrationProbe.live.test.ts`):**
   alle Entities lesen (Kategorie, Key, Status, Content-Hash — KEINE
   Secret-Werte ins Protokoll; Bodies sind spaltenverschlüsselt und bleiben
   opak), dazu History-Tiefe, Links (Herkunft/Ziel), `recall_when`-Trigger,
   Zähler (`retrieval_count`, `decay_score`), `state-digest`.
   Entschlüsselung (für `admit()`-Content und Trigger-Mapping)
   AUSSCHLIESSLICH auf dem isolierten Snapshot (eigene Temp-Datei, danach
   vernichtet) via `get_entity` (2e-seitenfrei) — niemals auf der Live-DB.
   NIEMALS über Vault-serve/init auf der Quelle oder verstärkende Tools
   (FTS-Recall etc.) — bei notwendiger Recovery/Quellmutation: abbrechen.
   Ergebnis-Gate 1: die 11-vs-10-Differenz ist erklärt.
   Voraussetzungs-Check VOR dem ersten Öffnen (Abbruchpfad): Sidecar-
   Inventar (db/-wal/-shm samt Größen) protokollieren. Fehlen -wal/-shm,
   würde schon Öffnen sie erzeugen = Datei-Erstellung an der Live-Quelle
   → ABBRUCH, außer es liegt ein ausdrückliches User-Go für genau diese
   Ausnahme vor. Bestehendes WAL wird vollständig geschützt (nie schreiben,
   löschen oder checkpointen — unsere Werkzeuge tun das nicht, bewiesen).
   SHM-Änderungen durch Öffnen sind reine Koordination und nur im Rahmen
   des erteilten Zugriffs-Go gedeckt.
   11-vs-10-Differenz ist erklärt.
2. **Mapping-Tabelle**: pro Eintrag → Ziel-DB + `admit()`-Erwartung +
   Begründung. Review-pflichtige und zurückbleibende explizit listen.
3. **Snapshot-Methode (bewiesen in `migrationProbe.live.test.ts`, eigene
   Temp-DB + eigener Temp-Key): `VACUUM INTO <temp-ziel>` ab einer
   Read-only-Verbindung — transaktional auf der Quelle, daher konsistent
   auch bei laufenden Writern/Checkpoints (Präfix-Konsistenz +
   `integrity_check` bewiesen). Spaltenverschlüsselung steht dem NICHT im
   Weg (Pager-Ebene). KEIN Datei-Trio-Copy (keine Snapshot-Garantie bei
   gleichzeitigem Writer). Nutzerprozesse laufen weiter — es braucht KEINE
   Schreibpause, die Konsistenz kommt aus der Transaktion, nicht aus
   Stillstand. Restore-in-Temp + Re-Verify als Beweis — noch NICHT an
   der echten DB.
4. **Dry-Run-Migration + Write-Pfad-Machbarkeit (Temp-DBs im ittop-
   Layout):** Quell-Export (JSON) → Mapping → Schreiben in FRISCHE
   Temp-DBs → Vollverifikation (Counts, History-Tiefe, Links, Digests,
   Recall-Smoke, `admit()`-Nachprüfung). Machbarkeitsgate (bewiesen):
   CLI-`write`-Replay baut History auf (Authority-Pfad, sofort aktiv),
   MCP-`remember` ohne Admission landet in `proposed` (KEINE History —
   History-Transfer geht nur über Write-Replay in chronologischer
   Reihenfolge), MCP-`link` funktioniert auch auf Proposed. Es gibt KEINE
   Transaktion über mehrere MCP-Calls und KEINE Atomarität über einen
   Eintrag: Manifest + Idempotenz + Verify liefern ausschließlich
   sauberen WIEDERANLAUF nach Abbruch (siehe 6b.3).
   Offenes 6a-Ergebnis-Gate: Replay erhält Reihenfolge + Count +
   Content-Hashes, aber NICHT originale History-Zeiten/IDs — 6a
   entscheidet: Manifest-Sidecar (Originale als JSON daneben) oder
   akzeptieren.
5. **Gate**: 6a-Receipts + Mapping-Tabelle → User-Review. Erst danach 6b.

## 5. Phase 6b — Live (Backup → Schreiben → Verifikation)

🔒 braucht: 6a-Receipts + separates User-Go + Advisor-Freigabe.

1. **Backup**: `VACUUM INTO`-Snapshot der echten Quell-DB nach 6a.3-
   Methode (Vault-Prozesse der Nutzerinstanz laufen weiter — nur lesen,
   nie beenden). VORHER: Quell-Digest AUSSCHLIESSLICH via readOnly-SQL (SHA-256 über den stabilen Dump-Auszug, gleiche Methode wie 6a-Probe) - KEINE Vault-CLI, kein Serve, kein Digest-Tool auf der Live-Quelle. NACHHER:
   Snapshot-Selbstverify (`integrity_check` ok, Mindest-Counts aus dem
   Inventar enthalten) + Manifest-Record (Snapshot-Digest, Timestamp,
   Quell-Digest). KEIN Full-Dump-Vergleich Quelle-vs-Snapshot als Beweis —
   die Live-Quelle darf sich danach legal weiterentwickeln.
2. **Kill-Switch (scharf ab hier)**: separates Flag
   (`memoryMigrationEnabled`, default false, NICHT das Vault-Flag) +
   Manifest-Tabelle (pro Eintrag: Status pending/in_progress/done/failed,
   Attempts). Abbruch jederzeit möglich; abgeschlossene Einträge bleiben
   stehen (Verify-protokolliert), angefangene gelten als unvollständig und
   werden beim Resume per Verify-Reconcile geprüft und zu Ende gebracht
   (kein transaktionales Rollback — siehe 3). SONDERFALL: fehlendes oder
   verlorenes Manifest bei befülltem Target → Runner verweigert und
   verlangt Operator-Prüfung (kein stilles Adoptieren ohne Herkunfts-
   nachweis). Der normale manifest-first-Abbruch (in_progress vorhanden)
   resumed automatisch.
3. **Schreiben**: pro Eintrag EINE logische Einheit (NICHT eine DB-
   Transaktion — MCP-Calls sind einzeln): CLI-Write-Replay der Versionen
   in chronologischer Reihenfolge (History-Aufbau) + Link-Rebuild +
   Manifest-Update + Verify-nach-jedem-Schritt. Idempotent per
   `(category, key)` — Neustart nach Abbruch setzt am Manifest fort,
   kein Eintrag wird doppelt angelegt (gilt im Replay-Protokoll; Crash-Fenster siehe offenes Gate oben). Offenes 6a-Gate: Crash-Fenster
   ZWISCHEN Write und Manifest-Update (Manifest-first +
   Verify-Reconcile-Strategie im 6a-Dry-Run beweisen, nicht zusichern).
   `global` zuletzt (kleinste, sensibelste Menge). Nach jedem Eintrag
   Digest-Check der Ziel-DB. TRIGGER-GATE GESCHLOSSEN für die 11
   Migrationskandidaten: Legacy ohne `recall_when`-Arrays (0/11
   auswertbare aktive Bodies; 2 archivierte Probes nicht auswertbar und
   ausgeschlossen); Mechanismus bewiesen (deklarierte
   Arrays matchen fuzzy, Live-Test auf 11 Replay-Einträgen grün); 6b
   transportiert Arrays in Replay-Bodies mit. Bewiesen: `remember`-
   Updates auf aktive Entities flippen zu proposed — Replay nutzt CLI-Write.
4. **Verifikation**: Snapshot-Selbstkonsistenz (`integrity_check` ok,
   Recall-Smoke auf dem Snapshot via Temp-Serve) + Manifest-Record
   (Snapshot-Digest, Timestamp). KEIN Full-Dump-Vergleich gegen eine
   danach weitergeschriebene Live-Quelle — das bewiese nichts (externe
   Änderungen sind legitim und von eigenen Mutationen zu unterscheiden:
   eigene Lesezugriffe sind per 6a-Probe als mutationsfrei bewiesen).
   Counts pro DB, History-Tiefe pro migriertem Key, Link-Integrität
   (keine Dangling-Ziele) und Recall-Smoke (jeder migrierte Key per
   dense-Recall auffindbar) auf den ZIEL-DBs. Review-Queue für `review`-
   Fälle befüllt. Quelle UNVERÄNDERT lassen (kein
   `forget`/`prune` an der Live-DB — Decommission ist ein eigenes,
   späteres Thema mit eigenem Go).
5. **Rollback**: NUR nachweislich migrations-eigene NEUE Ziel-DBs
   verwerfen (+ Verify, dass sie weg sind); bestehende Ziel-DBs und die
   Quelle werden NIEMALS überschrieben oder zurückkopiert (die Quelle
   wird gar nicht erst verändert — es gibt nichts zurückzurollen).
   Rollback-Fenster und -Verantwortung vor 6b-Start festlegen. Decommission
   der Quelle ist ein eigenes, späteres Thema mit eigenem Go.

## 6. Broker-Write-Pfad (Entsperr-Design, Teil von 6b)

- Neue, enge Grants: `mayWriteWorkspace` pro Session (Home-DB only),
  `mayWriteGlobal` NUR per separatem, explizitem Grant (weiter default
  false). `SessionRegistry.canWrite` existiert bereits — nutzen, nicht
  neu erfinden.
- Jeder Write: `admit()`-Recheck gegen LIVE-State + Review-Status
  (`approved` Pflicht, Revision-CAS) + Audit in `promotions`
  (recordPromotion existiert — wiederverwenden). Bloßes `remember` ohne
  Admission-Envelope landet in `proposed` (bewiesen) — serveable Writes
  brauchen Envelope oder CLI-Authority-Pfad (bewiesen).
- Promotion bleibt im Screen Dry-Run, bis 6b freigegeben ist; danach
  schaltet exakt EIN Codepfad (`promoteDryRun` → `promote`) scharf —
  kein zweiter Schreibweg daneben.
- Anti-Flood: Cap pro Session/Tag (Größenordnung: einstellige Zahl,
  kein Bulk-Import durch die Hintertür).

## 7. Risiken und Gegenmittel

| Risiko | Gegenmittel |
|---|---|
| Quell-DB wird migriert anders interpretiert (11-vs-10) | 6a-Klärung als Gate, kein Start ohne |
| Secret/Pfad-Leak nach `global` | Mapping-Regel + Redaktions-Beweis pro Eintrag, `global` zuletzt |
| Abbruch mitten im Schreiben | Manifest + Idempotenz + Verify-Reconcile, Resume-fähig (kein Rollback) |
| Nutzerinstanz betroffen | Nur eigene Handles, fremde Prozesse nie anfassen (bewährte Regel) |
| Write-Pfad weitet sich aus (Scope-Creep) | Ein Schreibweg, Caps, Audit; Rest bleibt gesperrt |
| Backup korrupt/nutzlos | Restore-in-Temp als 6a-Beweis, Digest-Verify in 6b |

## 8. Akzeptanz („fertig" heißt)

- Alle migrierbaren Einträge in Ziel-DBs, verifiziert per 6b-Checkliste;
  `review`-Fälle in der Queue, `reject`-Fälle begründet dokumentiert.
- Quelle logisch und dateiseitig unverändert: keine eigenen Writes
  (bewiesen mutationsfreie Zugriffe); Main- und WAL-Bytes identisch
  (bei WAL mit Nutzdaten bewiesen); -shm nur Koordination im Rahmen des
  Zugriffs-Go; fehlende Sidecars werden ohne Ausnahme-Go NICHT erzeugt
  (Abbruchpfad 6a.1). Snapshot per Selbstverify belegt, Backup verifiziert.
- Broker-Write-Pfad mit Audit belegt (Promotions lesbar, Caps getestet).
- Doku: 6a/6b-Receipts in `phase0-evidence.md`, dieser Plan als
  umgesetzt markiert, Kill-Switch-Laufzeit dokumentiert.
- Alle alten Locks (MCP-Bridge, Live-Wartung, Distribution) bleiben
  explizit gesperrt und stehen hier NICHT zur Debatte.

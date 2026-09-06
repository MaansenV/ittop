# Phase 7 — Restarbeiten (eine Phase, intern gegatet)

Stand: Entwurf, NICHT freigegeben. Jedes Unterkapitel (7a–7f) folgt dem
einheitlichen Gate: Planreview → isolierte Implementierung → konkrete
Positiv-/Negativ-Receipts → Advisor-Abnahme → gezieltes Live-User-Go.
Kein Schritt schreibt oder aktiviert live, bevor sein Gate grün ist.
No-Touch- und Write-Locks gelten weiter, bis das jeweilige Gate sie
gezielt öffnet.

## Offene-Posten-Inventar (alles zugeordnet oder zurückgestellt)

| Posten | Wo |
|---|---|
| Screen: Filter, Zähler, Rauchtest | 7a |
| Broker-Writes/Promotion | 7b |
| MCP-Bridge | 7c |
| Live-Wartung (capture/maintain) | 7d |
| Memory-Pakete teilen | 7e |
| Quellen-Decommission | 7f |
| Phase-0-Rest (MCP proposed→active Roundtrip) | 7c (Bridge braucht ihn) |
| Fork-/Binary-Pin, Protokoll-/Schema-Vertrag | 7c (Kompatibilitäts-Gate) |
| Transitive Lizenzen | 7c (vor Bridge-Bündelung) |
| OS-Keystore (statt Key-Dateien) | zurückgestellt (eigene Phase 8) |
| Parent-Hard-Kill / POSIX-Abnahme | zurückgestellt (eigene Phase 8) |
| App-Binary-Bündelung/Distribution | NICHT Memory-Scope (separates Thema) |

## 7a — Screen fertig + Rauchtest (isoliert zuerst)

- 7a ist NICHT schreibfrei: Flag-Aktivierung initialisiert DBs/Keys,
  Review-Lesen mutiert TTL-Markierungen, Stop-Hooks erzeugen
  Shadow-Receipts. Erlaubte Live-Nebenwirkungen werden pro Schritt
  benannt und separat gegatet — nichts implizit.
- Zuerst: Filter-Steuerung + Zähler im Screen (reiner Renderer, keine
  Vault-Berührung) + Rauchtest auf ISOLIERTER KOPIE (Temp-UserData mit
  kopierten DBs: Button, Suche, Review, Ops, Shadow).
- Erst danach: Live-Aktivierung mit benannten Nebenwirkungen (DB/Key-Init,
  TTL-Markierungen, Shadow-Receipts) als eigenes Go durch den User.

## 7b — Broker-Writes allgemein (Promotion-Pfad)

- **Gemeinsamer Session-/Grant-Vertrag (Voraussetzung für 7b & 7c):**
  - Typed Grants mit Zweckbindung (`purpose: 'screen_promote' | 'terminal_mcp'`),
    strikt unveränderlich (frozen), mit Ablaufzeit (`expiresAt`), Generation und
    Budgetzählern (Rate/Session/Day).
  - Terminal-Grants sind zunächst rein READ-ONLY (`mayWriteWorkspace: false`,
    `mayWriteGlobal: false`, `mayPromote: false`).
  - Widerruf (Revocation): automatisch bei Terminal-Exit/Restart, Workspace-Löschung,
    Screen-Schließen und App-Shutdown. Prüfung vor Dispatch und vor Rückgabe.
  - Globaler Not-Aus (Kill-Switch-Flag) im `VaultMemoryService`.
- **Promotion-Workflow (strikt dreistufig):**
  - Stufe 1: `Approve` (übernimmt Kandidat in Queue-Zustand `approved`, optional mit
    auditiertem Override).
  - Stufe 2: `Preview` (reine Dry-Run-Vorschau ohne Schreibzugriff).
  - Stufe 3: `Promote` (expliziter Schreibakt mit `expectedRevision`).
- **Idempotenz & Audit (`promotions`-Tabelle in `review.db`):**
  - Eindeutiger Idempotenzschlüssel `candidateId:revision:targetDb`.
  - Zustände: `intent` → `dispatched` → `verified` | `failed` | `indeterminate`.
  - Bei unbekanntem Ausgang (`indeterminate`) kein blinder Retry.
- **Exklusive Write-Lease in VaultManager (Single-Process-Garantie):**
  - Niemals CLI neben laufendem `serve`-Prozess (SQLite Lock-Kollision!).
  - Ablauf unter Lease: In-Flight-Calls drainen → `serve`-Child stoppen und Exit bestätigen
    → gepinntes CLI `perseus-vault write` mit Argv-Array (keine Shell!) ausführen → CLI-Exit
    bestätigen → `serve`-Child neu starten und mit Health-Check verifizieren.
- **Admission-Recheck:**
  - Unter der Lease wird der vollständige Live-State (`admit()` gegen Live-Scan)
    erneut geprüft; bei Konflikten oder unvollständigen Scans bricht der Write ab.
- **Hartes Live-Gate:**
  - In der Main-Anwendung bleibt der Promotion-Write auf produktive DBs hart blockiert
    (`ITTOP_ALLOW_LIVE_PROMOTION !== 'true'`). Aktivierung erfordert gesondertes User-Go!

## 7c — MCP-Bridge (Terminals → Broker, read-only zuerst)

- **Transport & Prozess-Isolation:**
  - Dünner MCP-StdIO-Shim (`bin/ittop-mcp.cjs`), den Terminals/Agents als MCP-Server starten.
  - Kommunikation zu ittop-Main über gesicherten lokalen Named Pipe (Windows:
    `\\.\pipe\ittop-mcp-<session>`) bzw. Unix Domain Socket (macOS/Linux).
  - Keine Vault-Binaries, keine DB-Pfade und keine Keys in den Terminal-Kindprozessen!
  - Framing: Standard MCP/JSON-RPC 2.0, begrenzte Nachrichtengröße (1 MB), Timeouts (30s).
- **Werkzeug-Allowlist (strikt Read-Only):**
  - Erlaubt: `perseus_vault_recall` (erzwungen: `mode: 'dense'`, `reinforce: false`),
    `perseus_vault_get_entity`, `perseus_vault_history`.
  - Verboten: `remember`, `context`, `write`, `scan` (Admin-Tools bleiben im Main-Prozess).
- **Session-Lebenszyklus:**
  - Beim Starten eines Terminals in `PtyManager` wird eine Session im Broker registriert
    und Pipe-Pfad + Session-Token via Env-Vars injiziert.
  - Bei PTY-Exit/Kill wird die Session sofort widerrufen.
- **Hartes Live-Gate:**
  - Im Main-Prozess bleibt die MCP-Bridge standardmässig deaktiviert (`terminalMcpEnabled: false`).
    Aktivierung erfordert explizites Opt-In pro Workspace/User.

## 7d — Live-Wartung (beaufsichtigt)

- Pro Operation (`capture` ohne `--dry-run`, `maintain`, `decay`, `prune`)
  ZUERST beweisen: Dry-Run-Verfügbarkeit + exakte Schreibeffekte auf
  Temp-DBs. Ohne diesen Nachweis keine Operation im Screen.
- Danach: manuell aus dem Screen (Ops-Tab, Dry-Run-Vorschau + Bestätigung).
  Automatik (Intervall/Nacht) braucht eigenes Go.
- Jede Wartung: vorher Snapshot, nachher Verify, alles im Audit-Log.

## 7e — Distribution (Memory-Pakete teilen)

- Export/Import von Memory-Paketen zwischen Workspaces (expliziter
  User-Akt, kein Auto-Sync): Paket = Einträge + History + Trigger +
  Manifest mit Hashes; Import läuft durch `admit()` + Review.
- Kein Teilen nach `global` ohne Bestätigung (Global-Regel gilt weiter).
- App-Binary-Verteilung ist NICHT Teil dieser Phase (separates Thema).

## 7f — Quellen-Decommission (destruktiv, letztes Go)

- Erst wenn 6b verifiziert + Backup verifiziert + User es ausdrücklich will:
  VOLLSTÄNDIGES Archiv (alle History-Versionen inkl. der nicht migrierten
  release-workflow-V1, alle Keys/Metadaten) + Restore-Test aus dem Archiv.
  Erst nach bestandenem Restore-Test: Quelle löschen, jeder Schritt mit
  separater Bestätigung. Kein Automatismus. NIEMALS löschen aufgrund
  bloßer Recall-Ergebnisse.

## Reihenfolge und Gates

7a (isoliert) → Vertrag 7b/7c → 7b ∥ 7c (isolierte Entwicklung parallel,
zusammengeführte E2E-Prüfung) → 7d → 7e → 7f. Jedes Gate: Planreview →
isolierte Implementierung → Positiv-/Negativ-Receipts → Advisor-Abnahme →
gezieltes Live-User-Go. Kein Schritt überspringt sein Gate.

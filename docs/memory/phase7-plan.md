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

- VORAUSSETZUNG (mit 7c gemeinsam, zuerst): Session-/Grant-/Revocation-
  Vertrag festlegen (Schreib-Grants, Gültigkeit, Widerruf, Audit-Format).
- Review → Approve (mit Override-Audit) → Vault-Write durch den Broker:
  enge Grants (Home-DB only, Global nur explizit), `admit()`-Recheck gegen
  Live-State, Audit in `promotions`, Session/Tag-Caps, Kill-Switch-Flag.
- Erst Dry-Run im Screen (besteht), dann 1 echter Test-Write auf TEMP-DBs,
  dann Freigabe für echte DBs (separates Go).
- Nicht-Scope: Bulk-Imports, Auto-Promotion.

## 7c — MCP-Bridge (Terminals → Broker, read-only zuerst)

- Gemeinsamer Vertrag aus 7b gilt auch hier (zuerst festlegen).
- Bridge zunächst READ-ONLY (Recall/History durch Sessions mit opaque
  Handles, 1 Child pro DB bleibt beim Broker, explizite Freigabe pro
  Workspace). Write-Dispatch erst nach 7b-Abnahme + gemeinsamer
  End-to-End-Prüfung (eigenes Go).
- Gates vorab: Phase-0-Rest (Approval-Roundtrip), Fork-/Binary-Pin +
  Protokoll-Vertrag, transitive Lizenzen (vor Bündelung).

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

# Phase 6a — Mapping-Tabelle (Stand 2026-09-06, aus Snapshot, redigiert)

Quell-Digest: `df5fb8574f31a5634a017543625bf8b32e5b38fdaf8273816fa70dc9c71e52d7`
Inventar: 13 Zeilen (11 aktiv + 2 proposed/archiviert). History: nur
`release-workflow` (Tiefe 1). Links: keine. Telemetrie-Baseline 67/14,
nach allen 6a-Reads unverändert (67/67, 14/14, Zähler identisch).
11-vs-10-Auflösung: 10 User-Einträge + 1 agent-erstellt
(`advisor-v2-latch-loop`, aus eigener Sitzung) + 2 eigene Test-
Kontaminationen (`phase0-*`, proposed/archiviert).

Legende Ziel: WS-K = Workspace-DB `KinemationTest` (UUID löst die App zur
6b-Laufzeit aus dem Store auf), WS-I = Workspace-DB `ittop` (Tool-Wissen).
NICHTS nach `global` (kein Eintrag ist `preference`).
admit() mit Eval-Platzhalter-DB. Overrides: `by: "user"` (Mensch = User),
Gründe formuliert der Agent bei 6b.

| Key | Kat / Status | Quelle | admit | Ziel-Vorschlag |
|---|---|---|---|---|
| astar-doorways-no-links | decision / aktiv | KinemationTest | approve (1.0) | WS-K |
| astar-recast-support | decision / aktiv | KinemationTest | review → Override BESTÄTIGT (User) | WS-K |
| crawler-navigation-removed | decision / aktiv | KinemationTest | approve (1.0) | WS-K |
| door-navmesh-carver | decision / aktiv | KinemationTest | approve (1.0) | WS-K |
| doorastarsetup-baked-cut | decision / aktiv | KinemationTest | approve (1.0) | WS-K |
| net-stack | decision / aktiv | KinemationTest | approve (1.0) | WS-K |
| purrnet-door-leaf-complete | decision / aktiv | KinemationTest | approve (1.0) | WS-K |
| advisor-v2-latch-loop | gotcha / aktiv | pi-global | review → Override BESTÄTIGT (User) | WS-I |
| powershell-utf8-bom-json | gotcha / aktiv | pi-global | approve (1.0) | WS-I |
| xterm-fit-padding | gotcha / aktiv | ittop | approve (1.0) | WS-I |
| release-workflow | procedure / aktiv | ittop | approve (1.0) | WS-I (+ Sidecar: 1 Archiv-Version) |
| phase0-probe | decision / proposed+archiviert | phase0test | — (unservable) | REJECT (eigene Kontamination) |
| phase0-impl-probe | implemented / proposed+archiviert | phase0test | — (unservable) | REJECT (eigene Kontamination) |

Dry-Run 6a.4 (Temp-DBs, zielgetreu): 2 DBs (kine 7 / ittop 4 Einträge),
Payload 11/11 per Hash + alle Felder verifiziert (workspace_hash per SQL —
`get_entity` liefert es nicht), Scope-Isolation 0 Leaks, Recall 11/11.
Crash-Fenster BEWIESEN: Abort zwischen Write und Manifest → Resume
adoptiert per Hash-Abgleich OHNE Rewrite (0 Extra-History, 0 Dupes).
Trigger-GATE GESCHLOSSEN (bewiesen): Legacy-Rows haben KEINE
`recall_when`-Arrays (0/11 auswertbare aktive Bodies auf Snapshot
gemessen; 2 archivierte phase0-Probes nicht auswertbar und
ausgeschlossen) — nichts zu verlieren.
Mechanismus bewiesen: deklarierte Arrays matchen fuzzy via recallWhen
(Temp-Probes + permanenter Live-Test auf allen 11 Replay-Einträgen,
grüner Positiv-Beweis). 6b transportiert Arrays in Replay-Bodies mit.
Hints bleiben FTS-Vokabular (in den getesteten negativen Fällen kein
recall_when-Effekt; keine Allgemeinaussage).
Approval-Kette bis approve/serveable auf Temp kartiert (Registrierung,
memory.*-Capabilities, Scope-Anker=Workspace, HMAC-Key, Source-Event,
Envelope, Bind) — 6b-Designmaterial. VORSICHT (bewiesen):
`remember`-Update auf aktive Entities flippt sie zu proposed.
Override-Gründe (User-bestätigt, `by: "user"`):
1. astar-recast-support: Negation = verworfene Alternative (GridGraph),
   keine offene Arbeit; implementiert (DungeonAstarPostProcessor.cs).
2. advisor-v2-latch-loop: Negation = Design-Regel, kein unvollendeter
   Sachverhalt; Verhalten verifiziert. Beide: Snapshot-Inhalt geprüft.
Sidecar: ABGELEHNT per User-Entscheid (kein Foto vom alten Stand;
V1 bleibt nur in der unangetasteten Quelle als Backup).
